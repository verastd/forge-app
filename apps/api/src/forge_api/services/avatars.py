"""Lobby avatars (behind `lobby_avatars`): every member is a robot in the Apps lobby.

An admin paints a member's robot (four colours), gives it a chestplate image and picks its
head from a library of GLB heads they upload: a head that replaces the robot's own, or a
face accessory worn over it (a mask over the eyes, a visor, a helmet). A member nobody has
dressed has no row here and wears the default the lobby derives from their id
(@forge/lobby's `defaultColors`).

Files (chest images and heads) are stored once each, by their sha256, in `avatars_assets`
and served from `GET /api/avatars/assets/{sha256}` forever-cacheable: a new upload is a new
hash, so a cached copy is never stale. A file nothing uses any more is deleted with the
change that let it go.

Nothing an upload says about itself is trusted: an image's type and size are read from its
own bytes, and a head must be a self-contained binary glTF 2.0 (no external URIs, so a
head can't make every viewer's browser fetch from somewhere else).
"""

import base64
import binascii
import hashlib
import json
import re
import struct
from collections.abc import Iterable
from datetime import datetime
from typing import Any, Final

from forge_api.models import (
    AVATAR_CHEST_MAX_BYTES,
    AVATAR_CHEST_MAX_PIXELS,
    AVATAR_CHEST_VIDEO_MAX_BYTES,
    AVATAR_EYE_NODES,
    AVATAR_HEAD_MAX_BYTES,
    AVATAR_PLACEMENT_AS_IS,
    Avatar,
    AvatarAccess,
    AvatarCape,
    AvatarChestUpload,
    AvatarColors,
    AvatarHead,
    AvatarHeadPlacement,
    AvatarHeadUpload,
    AvatarList,
    AvatarMember,
    AvatarMemberList,
    AvatarUpdate,
)
from forge_api.services import members as members_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity, is_admin
from forge_api.services.state import StateDB, register_schema

FLAG: Final = "lobby_avatars"
GLB_TYPE: Final = "model/gltf-binary"

register_schema(
    "avatars",
    [
        """CREATE TABLE IF NOT EXISTS avatars_assets (
            sha256 TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            data BLOB NOT NULL,
            created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS avatars_heads (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sha256 TEXT NOT NULL REFERENCES avatars_assets (sha256),
            bytes INTEGER NOT NULL,
            fit TEXT NOT NULL,
            eyes INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS avatars_members (
            member_id TEXT PRIMARY KEY,
            shell TEXT NOT NULL,
            trim TEXT NOT NULL,
            accent TEXT NOT NULL,
            eye TEXT NOT NULL,
            head_id TEXT REFERENCES avatars_heads (id),
            chest_sha256 TEXT REFERENCES avatars_assets (sha256),
            updated_at TEXT NOT NULL
        )""",
        # How a head is worn, apart from its row so a database from before fitting
        # existed gains it by CREATE alone. No row: worn as its file says.
        """CREATE TABLE IF NOT EXISTS avatars_head_placements (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            scale REAL NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            z REAL NOT NULL,
            eyes TEXT
        )""",
        # A fitted head's eye angles, in a table of their own so a database made by the
        # first fitting release (whose placements table predates them) gains them by
        # CREATE alone. No row: eyes straight ahead.
        """CREATE TABLE IF NOT EXISTS avatars_head_eye_angles (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            slant REAL NOT NULL,
            turn REAL NOT NULL,
            pitch REAL NOT NULL
        )""",
        # A robot's face accessory, worn over whichever head it has. No row: none.
        """CREATE TABLE IF NOT EXISTS avatars_member_accessories (
            member_id TEXT PRIMARY KEY REFERENCES avatars_members (member_id),
            head_id TEXT NOT NULL REFERENCES avatars_heads (id)
        )""",
        # A robot's right eye (when it differs from the left) and its finish. No row: one eye
        # colour, painted.
        """CREATE TABLE IF NOT EXISTS avatars_member_looks (
            member_id TEXT PRIMARY KEY REFERENCES avatars_members (member_id),
            eye_right TEXT,
            finish TEXT
        )""",
        # What a robot wears on its back: a library model (fit `back`) or the built-in cape
        # (its two colours). No row: nothing.
        """CREATE TABLE IF NOT EXISTS avatars_member_backs (
            member_id TEXT PRIMARY KEY REFERENCES avatars_members (member_id),
            head_id TEXT REFERENCES avatars_heads (id),
            cape_outer TEXT,
            cape_lining TEXT
        )""",
        # Retired: an uploaded chestplate's glow (before blend modes). Kept defined, never read,
        # so its rows (which reference avatars_members) can be cleared when a robot is saved
        # or reset.
        """CREATE TABLE IF NOT EXISTS avatars_member_chest_glow (
            member_id TEXT PRIMARY KEY REFERENCES avatars_members (member_id),
            glow REAL NOT NULL
        )""",
        # How a robot's uploaded chestplate blends over the armour (a CSS mix-blend-mode) and its
        # opacity. No row: normal, fully opaque.
        """CREATE TABLE IF NOT EXISTS avatars_member_chest_blends (
            member_id TEXT PRIMARY KEY REFERENCES avatars_members (member_id),
            blend TEXT NOT NULL,
            opacity REAL NOT NULL
        )""",
        # Who a head was made for: only they can wear it. No row: nobody yet.
        """CREATE TABLE IF NOT EXISTS avatars_head_owners (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            member_id TEXT NOT NULL
        )""",
        # A fitted head's eye size and whether its model's own eyes are hidden. No row:
        # eyes their own size, the model's eyes shown.
        """CREATE TABLE IF NOT EXISTS avatars_head_eye_looks (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            eye_scale REAL,
            screen TEXT
        )""",
        # How a fitted model is angled as a whole (tilt, turn, slant, radians). No row: upright.
        """CREATE TABLE IF NOT EXISTS avatars_head_angles (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            tilt REAL NOT NULL,
            turn REAL NOT NULL,
            slant REAL NOT NULL
        )""",
        # What flies over a head (a helicopter). No row: nothing.
        """CREATE TABLE IF NOT EXISTS avatars_head_flyers (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            flyer TEXT NOT NULL
        )""",
        # What a back model makes for its wearer (bricks). No row: nothing.
        """CREATE TABLE IF NOT EXISTS avatars_head_emitters (
            head_id TEXT PRIMARY KEY REFERENCES avatars_heads (id),
            emitter TEXT NOT NULL
        )""",
    ],
)

#: A head with how it is worn (the placement's columns are NULL when it has none).
_HEAD_SELECT: Final = (
    "SELECT h.*, p.scale AS p_scale, p.x AS p_x, p.y AS p_y, p.z AS p_z, p.eyes AS p_eyes, "
    "a.slant AS a_slant, a.turn AS a_turn, a.pitch AS a_pitch, "
    "o.member_id AS o_member, l.eye_scale AS l_eye_scale, l.screen AS l_screen, "
    "r.tilt AS r_tilt, r.turn AS r_turn, r.slant AS r_slant, f.flyer AS f_flyer, "
    "e.emitter AS e_emitter "
    "FROM avatars_heads h LEFT JOIN avatars_head_placements p ON p.head_id = h.id "
    "LEFT JOIN avatars_head_eye_angles a ON a.head_id = h.id "
    "LEFT JOIN avatars_head_owners o ON o.head_id = h.id "
    "LEFT JOIN avatars_head_eye_looks l ON l.head_id = h.id "
    "LEFT JOIN avatars_head_angles r ON r.head_id = h.id "
    "LEFT JOIN avatars_head_flyers f ON f.head_id = h.id "
    "LEFT JOIN avatars_head_emitters e ON e.head_id = h.id"
)


def _invalid(field: str, reason: str) -> ApiError:
    return ApiError(400, {"error": "invalid_request", "fields": [field], "reason": reason})


def decode_base64(data: str, limit: int, field: str = "data") -> bytes:
    """Strict base64 (the standard alphabet, padded), no larger than `limit` decoded.
    The size is checked before decoding, so an oversized upload costs nothing."""
    if len(data) > 4 * ((limit + 2) // 3):
        raise ApiError(413, {"error": "file_too_large", "limit": limit})
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise _invalid(field, "not_base64") from None
    if not raw:
        raise _invalid(field, "empty")
    if len(raw) > limit:
        raise ApiError(413, {"error": "file_too_large", "limit": limit})
    return raw


# ---------------------------------------------------------------------------
# What a file really is
# ---------------------------------------------------------------------------


def _png_size(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", raw[16:24])
    return width, height


# JPEG start-of-frame markers (every SOFn except DHT, JPG and DAC).
_SOF: Final = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)


def _jpeg_size(raw: bytes) -> tuple[int, int] | None:
    if raw[:3] != b"\xff\xd8\xff":
        return None
    i = 2
    while i + 4 <= len(raw):
        if raw[i] != 0xFF:
            return None
        marker = raw[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # no length
            i += 2
            continue
        (length,) = struct.unpack(">H", raw[i + 2 : i + 4])
        if length < 2:
            return None
        if marker in _SOF:
            if i + 9 > len(raw):
                return None
            height, width = struct.unpack(">HH", raw[i + 5 : i + 9])
            return width, height
        i += 2 + length
    return None


def _webp_size(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 30 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        return None
    chunk = raw[12:16]
    if chunk == b"VP8 " and raw[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", raw[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and raw[20] == 0x2F:
        bits = int.from_bytes(raw[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        width = int.from_bytes(raw[24:27], "little") + 1
        height = int.from_bytes(raw[27:30], "little") + 1
        return width, height
    return None


_SNIFFERS: Final = {"image/png": _png_size, "image/jpeg": _jpeg_size, "image/webp": _webp_size}


def _is_mp4(raw: bytes) -> bool:
    # An ISO media file opens with its `ftyp` box; QuickTime's own brand plays unreliably in
    # browsers, so a .mov renamed is refused.
    return len(raw) >= 12 and raw[4:8] == b"ftyp" and raw[8:12] != b"qt  "


def _is_webm(raw: bytes) -> bool:
    # An EBML document whose header names the `webm` doctype (Matroska's is `matroska`).
    return raw[:4] == b"\x1a\x45\xdf\xa3" and b"webm" in raw[:64]


_VIDEO_SNIFFERS: Final = {"video/mp4": _is_mp4, "video/webm": _is_webm}


def check_video(raw: bytes, claimed: str) -> None:
    """Nothing when the clip's bytes are the type it claims; 400 invalid_request otherwise.
    (Its length and size are the editor's to check: the browser plays it there first.)"""
    if not _VIDEO_SNIFFERS[claimed](raw):
        raise _invalid("data", "not_" + claimed.split("/")[1])


def check_image(raw: bytes, claimed: str) -> tuple[int, int]:
    """The image's (width, height), when its bytes are the type it claims and it is no
    bigger than AVATAR_CHEST_MAX_PIXELS either way; 400 invalid_request otherwise."""
    size = _SNIFFERS[claimed](raw)
    if size is None:
        raise _invalid("data", "not_" + claimed.split("/")[1])
    width, height = size
    if not (0 < width <= AVATAR_CHEST_MAX_PIXELS and 0 < height <= AVATAR_CHEST_MAX_PIXELS):
        raise _invalid("data", "too_many_pixels")
    return width, height


def _has_uri(value: Any) -> bool:
    """Whether any object in a glTF JSON tree names a `uri`."""
    if isinstance(value, dict):
        return "uri" in value or any(_has_uri(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_uri(v) for v in value)
    return False


#: An image embedded in the JSON itself: drawn through <img>, which fetches nothing.
_DATA_IMAGE: Final = re.compile(r"^data:image/(?:png|jpeg|webp);base64,", re.IGNORECASE)
_GLTF_VERSION: Final = re.compile(r"^2\.[0-9]+$")


def _uri_problem(document: dict[str, Any]) -> str | None:
    """Why a head's URIs would reach outside it, or None. A buffer must be the GLB's own
    BIN chunk: a `data:` buffer is fetched, which the lobby's CSP (connect-src) forbids,
    so it would never load. An image may be a `data:image/...` URI. Any other `uri`, here
    or in an extension, names something outside the file."""
    buffers = document.get("buffers")
    if isinstance(buffers, list) and any(isinstance(b, dict) and "uri" in b for b in buffers):
        uris = [b["uri"] for b in buffers if isinstance(b, dict) and "uri" in b]
        return "buffer_uri" if all(str(u).startswith("data:") for u in uris) else "external_uri"
    rest = {key: value for key, value in document.items() if key not in ("buffers", "images")}
    images = document.get("images")
    for image in images if isinstance(images, list) else []:
        if not isinstance(image, dict):
            continue
        uri = image.get("uri")
        if uri is not None and not (isinstance(uri, str) and _DATA_IMAGE.match(uri)):
            return "external_uri"
        if _has_uri({key: value for key, value in image.items() if key != "uri"}):
            return "external_uri"
    if isinstance(buffers, list) and _has_uri(buffers):
        return "external_uri"
    return "external_uri" if _has_uri(rest) else None


def check_glb(raw: bytes) -> bool:
    """Checks a head is a self-contained binary glTF 2.0; answers whether it carries both
    eye empties (AVATAR_EYE_NODES). 400 invalid_request for anything else."""
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise _invalid("data", "not_glb")
    version, length = struct.unpack("<II", raw[4:12])
    if version != 2 or length != len(raw):
        raise _invalid("data", "not_glb")
    chunk_length, chunk_type = struct.unpack("<II", raw[12:20])
    if chunk_type != 0x4E4F534A or 20 + chunk_length > len(raw):  # "JSON"
        raise _invalid("data", "not_glb")
    try:
        document = json.loads(raw[20 : 20 + chunk_length].decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise _invalid("data", "not_glb") from None
    if not isinstance(document, dict) or not isinstance(document.get("asset"), dict):
        raise _invalid("data", "not_glb")
    # GLTFLoader reads the JSON's own asset.version (and minVersion), not the container's.
    asset = document["asset"]
    if not _GLTF_VERSION.match(str(asset.get("version", ""))) or (
        "minVersion" in asset and not _GLTF_VERSION.match(str(asset["minVersion"]))
    ):
        raise _invalid("data", "not_gltf2")
    problem = _uri_problem(document)
    if problem is not None:
        raise _invalid("data", problem)
    if document.get("extensionsRequired"):
        # Draco, meshopt and the like need decoders the lobby doesn't load.
        raise _invalid("data", "extension_required")
    nodes = document.get("nodes")
    names = (
        {node.get("name") for node in nodes if isinstance(node, dict)}
        if isinstance(nodes, list)
        else set()
    )
    return all(eye in names for eye in AVATAR_EYE_NODES)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _put_asset(db: StateDB, raw: bytes, content_type: str, now: datetime) -> str:
    sha = hashlib.sha256(raw).hexdigest()
    db.execute(
        "INSERT INTO avatars_assets (sha256, content_type, data, created_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (sha256) DO NOTHING",
        (sha, content_type, raw, members_service.to_db(now)),
    )
    return sha


def _drop_unused_assets(db: StateDB, candidates: Iterable[str | None]) -> None:
    for sha in {c for c in candidates if c}:
        db.execute(
            "DELETE FROM avatars_assets WHERE sha256 = ? "
            "AND NOT EXISTS (SELECT 1 FROM avatars_heads WHERE sha256 = ?) "
            "AND NOT EXISTS (SELECT 1 FROM avatars_members WHERE chest_sha256 = ?)",
            (sha, sha, sha),
        )


def asset(db: StateDB, sha: str) -> tuple[str, bytes]:
    """A stored file's (content type, bytes); 404 asset_not_found."""
    row = db.query_one("SELECT content_type, data FROM avatars_assets WHERE sha256 = ?", (sha,))
    if row is None:
        raise ApiError(404, {"error": "asset_not_found"})
    return str(row["content_type"]), bytes(row["data"])


def _avatar(row: dict[str, Any]) -> Avatar:
    return Avatar(
        memberId=row["member_id"],
        colors=AvatarColors(
            shell=row["shell"],
            trim=row["trim"],
            accent=row["accent"],
            eye=row["eye"],
            eyeRight=row["l_eye_right"],
        ),
        head=row["head_id"],
        accessory=row["x_accessory"],
        chest=row["chest_sha256"],
        chestType=row["c_chest_type"],
        finish=row["l_finish"],
        back=row["b_back"],
        cape=(
            AvatarCape(outer=row["b_cape_outer"], lining=row["b_cape_lining"])
            if row["b_cape_outer"] is not None
            else None
        ),
        chestBlend=None if row["g_blend"] in (None, "normal") else row["g_blend"],
        chestOpacity=None if row["g_opacity"] in (None, 1) else row["g_opacity"],
        updatedAt=members_service.from_db(row["updated_at"]).isoformat(),
    )


def _head(row: dict[str, Any]) -> AvatarHead:
    return AvatarHead(
        id=row["id"],
        name=row["name"],
        sha256=row["sha256"],
        bytes=row["bytes"],
        fit=row["fit"],
        eyes=bool(row["eyes"]),
        placement=_placement(row),
        owner=row["o_member"],
        updatedAt=members_service.from_db(row["updated_at"]).isoformat(),
    )


def _placement(row: dict[str, Any]) -> AvatarHeadPlacement:
    if row["p_scale"] is None:
        return AVATAR_PLACEMENT_AS_IS
    eyes = json.loads(row["p_eyes"]) if row["p_eyes"] is not None else None
    angles = (row["a_slant"], row["a_turn"], row["a_pitch"]) if row["a_slant"] is not None else None
    screen = json.loads(row["l_screen"]) if row["l_screen"] is not None else None
    turned = (row["r_tilt"], row["r_turn"], row["r_slant"]) if row["r_tilt"] is not None else None
    return AvatarHeadPlacement(
        scale=row["p_scale"],
        offset=(row["p_x"], row["p_y"], row["p_z"]),
        eyes=eyes,
        eyeAngles=angles,
        angles=turned,
        eyeScale=row["l_eye_scale"],
        screen=screen,
        flyer=row["f_flyer"],
        emitter=row["e_emitter"],
    )


def _check_emitter(fit: str, placement: AvatarHeadPlacement | None) -> None:
    """Only a model worn on the back makes anything (400 emitter_back_only)."""
    if placement is not None and placement.emitter is not None and fit != "back":
        raise ApiError(400, {"error": "emitter_back_only", "fields": ["placement.emitter"]})


def is_brick_maker(db: StateDB, member_id: str) -> bool:
    """Whether `member_id`'s robot wears a back model that makes bricks."""
    row = db.query_one(
        "SELECT 1 FROM avatars_member_backs b "
        "JOIN avatars_head_emitters e ON e.head_id = b.head_id "
        "WHERE b.member_id = ? AND e.emitter = 'bricks'",
        (member_id,),
    )
    return row is not None


def _store_placement(db: StateDB, head_id: str, placement: AvatarHeadPlacement | None) -> None:
    db.execute("DELETE FROM avatars_head_placements WHERE head_id = ?", (head_id,))
    db.execute("DELETE FROM avatars_head_eye_angles WHERE head_id = ?", (head_id,))
    db.execute("DELETE FROM avatars_head_eye_looks WHERE head_id = ?", (head_id,))
    db.execute("DELETE FROM avatars_head_angles WHERE head_id = ?", (head_id,))
    db.execute("DELETE FROM avatars_head_flyers WHERE head_id = ?", (head_id,))
    db.execute("DELETE FROM avatars_head_emitters WHERE head_id = ?", (head_id,))
    if placement is None:
        return
    if placement.emitter is not None:
        db.execute(
            "INSERT INTO avatars_head_emitters (head_id, emitter) VALUES (?, ?)",
            (head_id, placement.emitter),
        )
    if placement.flyer is not None:
        db.execute(
            "INSERT INTO avatars_head_flyers (head_id, flyer) VALUES (?, ?)",
            (head_id, placement.flyer),
        )
    if placement.angles is not None:
        db.execute(
            "INSERT INTO avatars_head_angles (head_id, tilt, turn, slant) VALUES (?, ?, ?, ?)",
            (head_id, *placement.angles),
        )
    if placement.eyeScale is not None or placement.screen is not None:
        screen = None if placement.screen is None else placement.screen.model_dump_json()
        db.execute(
            "INSERT INTO avatars_head_eye_looks (head_id, eye_scale, screen) VALUES (?, ?, ?)",
            (head_id, placement.eyeScale, screen),
        )
    if placement.eyeAngles is not None:
        db.execute(
            "INSERT INTO avatars_head_eye_angles (head_id, slant, turn, pitch) VALUES (?, ?, ?, ?)",
            (head_id, *placement.eyeAngles),
        )
    eyes = None if placement.eyes is None else json.dumps([list(eye) for eye in placement.eyes])
    db.execute(
        "INSERT INTO avatars_head_placements (head_id, scale, x, y, z, eyes) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (head_id, placement.scale, *placement.offset, eyes),
    )


def _store_owner(db: StateDB, head_id: str, owner: str | None) -> None:
    """Gives a head to `owner` (None: nobody); whoever else wore it goes back to their own."""
    db.execute("DELETE FROM avatars_head_owners WHERE head_id = ?", (head_id,))
    if owner is not None:
        db.execute(
            "INSERT INTO avatars_head_owners (head_id, member_id) VALUES (?, ?)", (head_id, owner)
        )
    db.execute(
        "UPDATE avatars_members SET head_id = NULL WHERE head_id = ? AND member_id IS NOT ?",
        (head_id, owner),
    )
    db.execute(
        "DELETE FROM avatars_member_accessories WHERE head_id = ? AND member_id IS NOT ?",
        (head_id, owner),
    )
    db.execute(
        "DELETE FROM avatars_member_backs WHERE head_id = ? AND member_id IS NOT ?",
        (head_id, owner),
    )


def _head_row(db: StateDB, head_id: str) -> dict[str, Any] | None:
    return db.query_one(f"{_HEAD_SELECT} WHERE h.id = ?", (head_id,))


#: A dressed robot with its face accessory, right eye and finish (NULL when it has none).
_MEMBER_SELECT: Final = (
    "SELECT m.*, x.head_id AS x_accessory, l.eye_right AS l_eye_right, l.finish AS l_finish, "
    "b.head_id AS b_back, b.cape_outer AS b_cape_outer, b.cape_lining AS b_cape_lining, "
    "c.content_type AS c_chest_type, g.blend AS g_blend, g.opacity AS g_opacity "
    "FROM avatars_members m "
    "LEFT JOIN avatars_member_accessories x ON x.member_id = m.member_id "
    "LEFT JOIN avatars_member_looks l ON l.member_id = m.member_id "
    "LEFT JOIN avatars_member_backs b ON b.member_id = m.member_id "
    "LEFT JOIN avatars_assets c ON c.sha256 = m.chest_sha256 "
    "LEFT JOIN avatars_member_chest_blends g ON g.member_id = m.member_id"
)


def _avatar_row(db: StateDB, member_id: str) -> dict[str, Any] | None:
    return db.query_one(f"{_MEMBER_SELECT} WHERE m.member_id = ?", (member_id,))


def access(identity: Identity) -> AvatarAccess:
    """What `identity` may do with avatars: edit them when an admin. The editor's own routes
    check the same rule on every call (`AdminMember`); this only tells the web whether to
    offer the editor."""
    return AvatarAccess(canEdit=is_admin(identity))


def list_all(db: StateDB) -> AvatarList:
    """Every dressed robot and the head library, each in a stable order."""
    avatars = db.query_all(f"{_MEMBER_SELECT} ORDER BY m.member_id")
    heads = db.query_all(f"{_HEAD_SELECT} ORDER BY h.name, h.id")
    return AvatarList(avatars=[_avatar(r) for r in avatars], heads=[_head(r) for r in heads])


def list_members(db: StateDB) -> AvatarMemberList:
    """Every member, for the editor: oldest first, as gh:<id>."""
    return AvatarMemberList(
        members=[
            AvatarMember(memberId=f"gh:{m.sub}", login=m.login)
            for m in members_service.all_members(db)
        ]
    )


def set_avatar(db: StateDB, member_id: str, update: AvatarUpdate, now: datetime) -> Avatar:
    """Paints a member's robot and picks its head (none: its own), its face accessory
    (none: none), worn over that head, and what it wears on its back (a model or the cape,
    not both). Keeps its chestplate."""
    if update.back is not None and update.cape is not None:
        raise ApiError(400, {"error": "one_back", "fields": ["back", "cape"]})
    with db.transaction():
        slots = (("head", update.head), ("accessory", update.accessory), ("back", update.back))
        for field, wanted in slots:
            if wanted is None:
                continue
            head = _head_row(db, wanted)
            if head is None:
                raise ApiError(400, {"error": "unknown_head", "fields": [field]})
            # A head is made for one member: nobody else can wear it.
            if head["o_member"] != member_id:
                raise ApiError(400, {"error": "head_not_theirs", "fields": [field]})
            if field == "accessory" and head["fit"] != "accessory":
                raise ApiError(400, {"error": "not_an_accessory", "fields": [field]})
            # A back model is only for the back, and only a back model goes there.
            if (field == "back") != (head["fit"] == "back"):
                error = "not_a_back" if field == "back" else "back_model"
                raise ApiError(400, {"error": error, "fields": [field]})
        c = update.colors
        db.execute(
            "INSERT INTO avatars_members "
            "(member_id, shell, trim, accent, eye, head_id, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET "
            "shell = excluded.shell, trim = excluded.trim, accent = excluded.accent, "
            "eye = excluded.eye, head_id = excluded.head_id, updated_at = excluded.updated_at",
            (member_id, c.shell, c.trim, c.accent, c.eye, update.head, members_service.to_db(now)),
        )
        db.execute("DELETE FROM avatars_member_accessories WHERE member_id = ?", (member_id,))
        if update.accessory is not None:
            db.execute(
                "INSERT INTO avatars_member_accessories (member_id, head_id) VALUES (?, ?)",
                (member_id, update.accessory),
            )
        db.execute("DELETE FROM avatars_member_backs WHERE member_id = ?", (member_id,))
        if update.back is not None or update.cape is not None:
            cape = update.cape
            db.execute(
                "INSERT INTO avatars_member_backs (member_id, head_id, cape_outer, cape_lining) "
                "VALUES (?, ?, ?, ?)",
                (
                    member_id,
                    update.back,
                    cape.outer if cape else None,
                    cape.lining if cape else None,
                ),
            )
        # Paint is the default: kept as no finish at all, so every painted robot reads the same.
        finish = None if update.finish == "paint" else update.finish
        db.execute("DELETE FROM avatars_member_looks WHERE member_id = ?", (member_id,))
        if c.eyeRight is not None or finish is not None:
            db.execute(
                "INSERT INTO avatars_member_looks (member_id, eye_right, finish) VALUES (?, ?, ?)",
                (member_id, c.eyeRight, finish),
            )
        db.execute("DELETE FROM avatars_member_chest_blends WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_member_chest_glow WHERE member_id = ?", (member_id,))
        blend = update.chestBlend or "normal"
        opacity = 1.0 if update.chestOpacity is None else update.chestOpacity
        if blend != "normal" or opacity != 1:
            db.execute(
                "INSERT INTO avatars_member_chest_blends (member_id, blend, opacity) "
                "VALUES (?, ?, ?)",
                (member_id, blend, opacity),
            )
        row = _avatar_row(db, member_id)
    assert row is not None
    return _avatar(row)


def reset_avatar(db: StateDB, member_id: str) -> None:
    """Back to the default look (and no chestplate). Idempotent."""
    with db.transaction():
        row = _avatar_row(db, member_id)
        db.execute("DELETE FROM avatars_member_accessories WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_member_looks WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_member_backs WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_member_chest_blends WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_member_chest_glow WHERE member_id = ?", (member_id,))
        db.execute("DELETE FROM avatars_members WHERE member_id = ?", (member_id,))
        _drop_unused_assets(db, [row["chest_sha256"] if row else None])


def set_chest(db: StateDB, member_id: str, upload: AvatarChestUpload, now: datetime) -> Avatar:
    """Gives a dressed robot its chestplate image; 404 avatar_not_found for an undressed one
    (the editor saves the colours first)."""
    if upload.contentType in _VIDEO_SNIFFERS:
        raw = decode_base64(upload.data, AVATAR_CHEST_VIDEO_MAX_BYTES)
        check_video(raw, upload.contentType)
    else:
        raw = decode_base64(upload.data, AVATAR_CHEST_MAX_BYTES)
        check_image(raw, upload.contentType)
    with db.transaction():
        row = _avatar_row(db, member_id)
        if row is None:
            raise ApiError(404, {"error": "avatar_not_found"})
        sha = _put_asset(db, raw, upload.contentType, now)
        db.execute(
            "UPDATE avatars_members SET chest_sha256 = ?, updated_at = ? WHERE member_id = ?",
            (sha, members_service.to_db(now), member_id),
        )
        _drop_unused_assets(db, [row["chest_sha256"]])
        updated = _avatar_row(db, member_id)
    assert updated is not None
    return _avatar(updated)


def clear_chest(db: StateDB, member_id: str, now: datetime) -> Avatar:
    """Takes a robot's chestplate image away (back to its emblem)."""
    with db.transaction():
        row = _avatar_row(db, member_id)
        if row is None:
            raise ApiError(404, {"error": "avatar_not_found"})
        db.execute(
            "UPDATE avatars_members SET chest_sha256 = NULL, updated_at = ? WHERE member_id = ?",
            (members_service.to_db(now), member_id),
        )
        _drop_unused_assets(db, [row["chest_sha256"]])
        updated = _avatar_row(db, member_id)
    assert updated is not None
    return _avatar(updated)


def put_head(db: StateDB, head_id: str, upload: AvatarHeadUpload, now: datetime) -> AvatarHead:
    """Adds a head to the library, or replaces one (every robot wearing it gets the new one)."""
    name = upload.name.strip()
    if not name:
        raise _invalid("name", "blank")
    _check_emitter(upload.fit, upload.placement)
    raw = decode_base64(upload.data, AVATAR_HEAD_MAX_BYTES)
    eyes = check_glb(raw)
    with db.transaction():
        old = db.query_one("SELECT sha256 FROM avatars_heads WHERE id = ?", (head_id,))
        sha = _put_asset(db, raw, GLB_TYPE, now)
        db.execute(
            "INSERT INTO avatars_heads (id, name, sha256, bytes, fit, eyes, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, "
            "sha256 = excluded.sha256, bytes = excluded.bytes, fit = excluded.fit, "
            "eyes = excluded.eyes, updated_at = excluded.updated_at",
            (head_id, name, sha, len(raw), upload.fit, int(eyes), members_service.to_db(now)),
        )
        _store_placement(db, head_id, upload.placement)
        if upload.owner is not None:
            _store_owner(db, head_id, upload.owner)
        _drop_unused_assets(db, [old["sha256"] if old else None])
        row = _head_row(db, head_id)
    assert row is not None
    return _head(row)


def refit_head(
    db: StateDB, head_id: str, placement: AvatarHeadPlacement, now: datetime
) -> AvatarHead:
    """Changes how a library head is worn, keeping its file. 404 head_not_found."""
    with db.transaction():
        head = db.query_one("SELECT fit FROM avatars_heads WHERE id = ?", (head_id,))
        if head is None:
            raise ApiError(404, {"error": "head_not_found"})
        _check_emitter(head["fit"], placement)
        _store_placement(db, head_id, placement)
        db.execute(
            "UPDATE avatars_heads SET updated_at = ? WHERE id = ?",
            (members_service.to_db(now), head_id),
        )
        row = _head_row(db, head_id)
    assert row is not None
    return _head(row)


def set_head_owner(db: StateDB, head_id: str, owner: str | None, now: datetime) -> AvatarHead:
    """Gives a head to a member, or to nobody; anyone else wearing it goes back to their own
    head. 404 head_not_found."""
    with db.transaction():
        if db.query_one("SELECT 1 FROM avatars_heads WHERE id = ?", (head_id,)) is None:
            raise ApiError(404, {"error": "head_not_found"})
        _store_owner(db, head_id, owner)
        db.execute(
            "UPDATE avatars_heads SET updated_at = ? WHERE id = ?",
            (members_service.to_db(now), head_id),
        )
        row = _head_row(db, head_id)
    assert row is not None
    return _head(row)


def delete_head(db: StateDB, head_id: str) -> None:
    """Takes a head out of the library: robots wearing it go back to their own. 404
    head_not_found."""
    with db.transaction():
        row = db.query_one("SELECT sha256 FROM avatars_heads WHERE id = ?", (head_id,))
        if row is None:
            raise ApiError(404, {"error": "head_not_found"})
        db.execute("UPDATE avatars_members SET head_id = NULL WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_member_accessories WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_member_backs WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_placements WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_eye_angles WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_eye_looks WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_angles WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_flyers WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_emitters WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_head_owners WHERE head_id = ?", (head_id,))
        db.execute("DELETE FROM avatars_heads WHERE id = ?", (head_id,))
        _drop_unused_assets(db, [row["sha256"]])
