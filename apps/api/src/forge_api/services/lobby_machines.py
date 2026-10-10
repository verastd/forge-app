"""Machines in the Apps lobby (behind `apps_lobby`): what the mechanic builds, there for
everyone until he takes it down.

The mechanic is the robot wearing a back model that makes machines (services/avatars.py
`is_machine_maker`), or an admin who switched on "Be the mechanic" to test (which stops
their "Be the Lego bot": one role at a time). He keeps a library of blueprints (binary
glTF models, uploaded in chunks because a request carries at most a few megabytes) and
builds them on the floor where services/machine_rules.py says they fit.

Every change bumps the cave's machine revision and stamps it on the row, so a browser
asks only for what changed since the revision it has; a machine taken down leaves a
tombstone for a day so those deltas can say so.
"""

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any, Final

from forge_api.models import (
    MACHINE_CHUNK_BYTES,
    Machine,
    MachineBlueprint,
    MachineBlueprintList,
    MachineBuild,
    MachineChange,
    MachineList,
    MachineMe,
    MachineUpload,
    MachineUploadStart,
)
from forge_api.services import avatars as avatars_service
from forge_api.services import brick_rules
from forge_api.services import machine_rules as rules
from forge_api.services import members as members_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity, is_admin
from forge_api.services.state import StateDB, register_schema

FLAG: Final = "apps_lobby"
#: How long a taken-down machine's tombstone is kept for deltas.
TOMBSTONE_KEEP: Final = timedelta(days=1)
#: How long an unfinished upload is kept.
UPLOAD_KEEP: Final = timedelta(hours=1)
GLB_TYPE: Final = "model/gltf-binary"

register_schema(
    "lobby_machines",
    [
        # Blueprint files, by content (a blueprint and the machines built from it share one).
        """CREATE TABLE IF NOT EXISTS lobby_machine_assets (
            sha256 TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            created_at TEXT NOT NULL
        )""",
        # The library. `ready` once its file is in; `gone` once deleted (machines built
        # from it stay, so the row and its file do too).
        """CREATE TABLE IF NOT EXISTS lobby_machine_blueprints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            parts INTEGER NOT NULL,
            size_x REAL NOT NULL,
            size_y REAL NOT NULL,
            size_z REAL NOT NULL,
            uploaded_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ready INTEGER NOT NULL,
            gone INTEGER NOT NULL
        )""",
        # An upload's chunks until it's finished.
        """CREATE TABLE IF NOT EXISTS lobby_machine_chunks (
            blueprint_id TEXT NOT NULL,
            n INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (blueprint_id, n)
        )""",
        """CREATE TABLE IF NOT EXISTS lobby_machines (
            id TEXT PRIMARY KEY,
            blueprint_id TEXT NOT NULL,
            x REAL NOT NULL,
            z REAL NOT NULL,
            turn INTEGER NOT NULL,
            scale REAL NOT NULL,
            built_by TEXT NOT NULL,
            built_at TEXT NOT NULL,
            gone INTEGER NOT NULL,
            rev INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS lobby_machines_rev ON lobby_machines (rev)",
        """CREATE TABLE IF NOT EXISTS lobby_machines_meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        )""",
        # Admins testing as the mechanic ("Be the mechanic").
        """CREATE TABLE IF NOT EXISTS lobby_machines_stand_ins (
            member_id TEXT PRIMARY KEY,
            since TEXT NOT NULL
        )""",
    ],
)

_MACHINE_SELECT: Final = (
    "SELECT m.*, b.name AS b_name, b.sha256 AS b_sha256, b.bytes AS b_bytes, b.parts AS b_parts, "
    "b.size_x AS b_size_x, b.size_y AS b_size_y, b.size_z AS b_size_z "
    "FROM lobby_machines m JOIN lobby_machine_blueprints b ON b.id = m.blueprint_id"
)


def _meta(db: StateDB, key: str) -> int:
    row = db.query_one("SELECT value FROM lobby_machines_meta WHERE key = ?", (key,))
    return int(row["value"]) if row else 0


def _set_meta(db: StateDB, key: str, value: int) -> None:
    db.execute(
        "INSERT INTO lobby_machines_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _bump(db: StateDB) -> int:
    rev = _meta(db, "rev") + 1
    _set_meta(db, "rev", rev)
    return rev


def _member(user: Identity) -> str:
    return f"gh:{user.sub}"


def _stamp(value: str) -> str:
    return members_service.from_db(value).isoformat()


def _size(row: dict[str, Any], prefix: str = "") -> tuple[float, float, float]:
    return (
        float(row[f"{prefix}size_x"]),
        float(row[f"{prefix}size_y"]),
        float(row[f"{prefix}size_z"]),
    )


def _machine(row: dict[str, Any]) -> Machine:
    return Machine(
        id=row["id"],
        blueprint=row["blueprint_id"],
        name=row["b_name"],
        sha256=row["b_sha256"],
        bytes=row["b_bytes"],
        parts=row["b_parts"],
        size=_size(row, "b_"),
        x=row["x"],
        z=row["z"],
        turn=row["turn"],
        scale=row["scale"],
        builtBy=row["built_by"],
        builtAt=_stamp(row["built_at"]),
        updatedAt=_stamp(row["updated_at"]),
    )


def _blueprint(row: dict[str, Any]) -> MachineBlueprint:
    return MachineBlueprint(
        id=row["id"],
        name=row["name"],
        sha256=row["sha256"],
        bytes=row["bytes"],
        parts=row["parts"],
        size=_size(row),
        uploadedBy=row["uploaded_by"],
        createdAt=_stamp(row["created_at"]),
    )


def _spot(row: dict[str, Any]) -> rules.Spot:
    return rules.Spot(_size(row, "b_"), row["x"], row["z"], row["turn"], row["scale"])


def _purge(db: StateDB, now: datetime) -> None:
    """Forgets old tombstones (deltas from before them get everything) and stale uploads."""
    cutoff = members_service.to_db(now - TOMBSTONE_KEEP)
    old = db.query_one(
        "SELECT MAX(rev) AS rev FROM lobby_machines WHERE gone = 1 AND updated_at < ?", (cutoff,)
    )
    if old is not None and old["rev"] is not None:
        db.execute("DELETE FROM lobby_machines WHERE gone = 1 AND updated_at < ?", (cutoff,))
        _set_meta(db, "floor", max(_meta(db, "floor"), int(old["rev"])))
    stale = members_service.to_db(now - UPLOAD_KEEP)
    db.execute(
        "DELETE FROM lobby_machine_chunks WHERE blueprint_id IN "
        "(SELECT id FROM lobby_machine_blueprints WHERE ready = 0 AND created_at < ?)",
        (stale,),
    )
    db.execute("DELETE FROM lobby_machine_blueprints WHERE ready = 0 AND created_at < ?", (stale,))


def list_machines(db: StateDB, since: int | None, now: datetime) -> MachineList:
    """Every machine, or only what changed after revision `since` (when it can say)."""
    clock = now.isoformat()
    with db.transaction():
        _purge(db, now)
        rev = _meta(db, "rev")
        if since is None or since < _meta(db, "floor") or since > rev:
            rows = db.query_all(f"{_MACHINE_SELECT} WHERE m.gone = 0 ORDER BY m.rev")
            return MachineList(
                rev=rev, full=True, machines=[_machine(r) for r in rows], gone=[], now=clock
            )
        rows = db.query_all(f"{_MACHINE_SELECT} WHERE m.rev > ? ORDER BY m.rev", (since,))
    return MachineList(
        rev=rev,
        full=False,
        machines=[_machine(r) for r in rows if not r["gone"]],
        gone=[r["id"] for r in rows if r["gone"]],
        now=clock,
    )


def _standing_in(db: StateDB, user: Identity) -> bool:
    row = db.query_one(
        "SELECT 1 FROM lobby_machines_stand_ins WHERE member_id = ?", (_member(user),)
    )
    return row is not None


def _is_mechanic(db: StateDB, user: Identity) -> bool:
    if avatars_service.is_machine_maker(db, _member(user)):
        return True
    return is_admin(user) and _standing_in(db, user)


def me(db: StateDB, user: Identity) -> MachineMe:
    """Whether the caller is the mechanic (the browser's keys and panel follow it; every
    mechanic-only call still checks)."""
    admin = is_admin(user)
    return MachineMe(
        memberId=_member(user),
        mechanic=_is_mechanic(db, user),
        canStandIn=admin,
        standIn=admin and _standing_in(db, user),
    )


def stand_in(db: StateDB, user: Identity, on: bool, now: datetime) -> MachineMe:
    """An admin takes over the mechanic's powers to test them (and stops being the Lego
    bot), or gives them back. 403 admin_only."""
    if not is_admin(user):
        raise ApiError(403, {"error": "admin_only"})
    member_id = _member(user)
    with db.transaction():
        if on:
            db.execute(
                "INSERT INTO lobby_machines_stand_ins (member_id, since) VALUES (?, ?) "
                "ON CONFLICT (member_id) DO NOTHING",
                (member_id, members_service.to_db(now)),
            )
            db.execute("DELETE FROM lobby_bricks_stand_ins WHERE member_id = ?", (member_id,))
        else:
            db.execute("DELETE FROM lobby_machines_stand_ins WHERE member_id = ?", (member_id,))
        return me(db, user)


def _require_mechanic(db: StateDB, user: Identity) -> None:
    if not _is_mechanic(db, user):
        raise ApiError(403, {"error": "not_the_mechanic"})


# ---------------------------------------------------------------------------
# The library
# ---------------------------------------------------------------------------


def list_blueprints(db: StateDB) -> MachineBlueprintList:
    rows = db.query_all(
        "SELECT * FROM lobby_machine_blueprints WHERE ready = 1 AND gone = 0 "
        "ORDER BY created_at DESC, id"
    )
    return MachineBlueprintList(blueprints=[_blueprint(r) for r in rows])


def _chunks(size: int) -> int:
    return -(-size // MACHINE_CHUNK_BYTES)


def start_upload(
    db: StateDB, user: Identity, body: MachineUploadStart, now: datetime
) -> MachineUpload:
    """Starts a blueprint upload (the mechanic only). 403 not_the_mechanic."""
    with db.transaction():
        _purge(db, now)
        _require_mechanic(db, user)
        blueprint_id = secrets.token_hex(6)
        db.execute(
            "INSERT INTO lobby_machine_blueprints (id, name, sha256, bytes, parts, size_x, "
            "size_y, size_z, uploaded_by, created_at, ready, gone) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
            (
                blueprint_id,
                body.name.strip() or "Blueprint",
                body.sha256,
                body.bytes,
                body.parts,
                *body.size,
                _member(user),
                members_service.to_db(now),
            ),
        )
    return MachineUpload(
        id=blueprint_id, chunkBytes=MACHINE_CHUNK_BYTES, chunks=_chunks(body.bytes)
    )


def _upload_row(db: StateDB, user: Identity, blueprint_id: str) -> dict[str, Any]:
    row = db.query_one(
        "SELECT * FROM lobby_machine_blueprints WHERE id = ? AND ready = 0 AND uploaded_by = ?",
        (blueprint_id, _member(user)),
    )
    if row is None:
        raise ApiError(404, {"error": "upload_not_found"})
    return row


def put_chunk(db: StateDB, user: Identity, blueprint_id: str, n: int, data: str) -> None:
    """One chunk of an upload (its last may be short). 403 not_the_mechanic;
    404 upload_not_found; 400 invalid_request (not base64, or the wrong length)."""
    raw = avatars_service.decode_base64(data, MACHINE_CHUNK_BYTES)
    with db.transaction():
        _require_mechanic(db, user)
        row = _upload_row(db, user, blueprint_id)
        total = int(row["bytes"])
        count = _chunks(total)
        if n >= count:
            raise ApiError(400, {"error": "invalid_request", "fields": ["n"], "reason": "range"})
        expected = MACHINE_CHUNK_BYTES if n < count - 1 else total - MACHINE_CHUNK_BYTES * n
        if len(raw) != expected:
            raise ApiError(
                400, {"error": "invalid_request", "fields": ["data"], "reason": "length"}
            )
        db.execute(
            "INSERT INTO lobby_machine_chunks (blueprint_id, n, data) VALUES (?, ?, ?) "
            "ON CONFLICT (blueprint_id, n) DO UPDATE SET data = excluded.data",
            (blueprint_id, n, raw),
        )


def finish_upload(
    db: StateDB, user: Identity, blueprint_id: str, now: datetime
) -> MachineBlueprint:
    """Puts an upload's chunks together and checks the file: every chunk in, its sha256 as
    promised, a self-contained binary glTF 2.0. 403 not_the_mechanic; 404 upload_not_found;
    409 upload_incomplete (with the chunks missing); 400 invalid_request."""
    with db.transaction():
        _require_mechanic(db, user)
        row = _upload_row(db, user, blueprint_id)
        count = _chunks(int(row["bytes"]))
        chunks = db.query_all(
            "SELECT n, data FROM lobby_machine_chunks WHERE blueprint_id = ? ORDER BY n",
            (blueprint_id,),
        )
        have = {int(c["n"]) for c in chunks}
        missing = [n for n in range(count) if n not in have]
        if missing:
            raise ApiError(409, {"error": "upload_incomplete", "missing": missing})
        raw = b"".join(bytes(c["data"]) for c in chunks)
        if hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ApiError(
                400, {"error": "invalid_request", "fields": ["data"], "reason": "sha256"}
            )
        avatars_service.check_glb(raw)
        db.execute(
            "INSERT INTO lobby_machine_assets (sha256, data, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT (sha256) DO NOTHING",
            (row["sha256"], raw, members_service.to_db(now)),
        )
        db.execute("DELETE FROM lobby_machine_chunks WHERE blueprint_id = ?", (blueprint_id,))
        db.execute(
            "UPDATE lobby_machine_blueprints SET ready = 1, created_at = ? WHERE id = ?",
            (members_service.to_db(now), blueprint_id),
        )
        done = db.query_one("SELECT * FROM lobby_machine_blueprints WHERE id = ?", (blueprint_id,))
    assert done is not None
    return _blueprint(done)


def delete_blueprint(db: StateDB, user: Identity, blueprint_id: str) -> None:
    """Takes a blueprint out of the library (machines built from it stay). An unfinished
    upload is dropped. 403 not_the_mechanic; 404 blueprint_not_found."""
    with db.transaction():
        _require_mechanic(db, user)
        row = db.query_one(
            "SELECT * FROM lobby_machine_blueprints WHERE id = ? AND gone = 0", (blueprint_id,)
        )
        if row is None:
            raise ApiError(404, {"error": "blueprint_not_found"})
        db.execute("DELETE FROM lobby_machine_chunks WHERE blueprint_id = ?", (blueprint_id,))
        if not row["ready"]:
            db.execute("DELETE FROM lobby_machine_blueprints WHERE id = ?", (blueprint_id,))
            return
        db.execute("UPDATE lobby_machine_blueprints SET gone = 1 WHERE id = ?", (blueprint_id,))
        _drop_unused(db, row["sha256"])


def _drop_unused(db: StateDB, sha: str) -> None:
    """Deletes a file nothing uses any more: no blueprint in the library, no machine standing."""
    db.execute(
        "DELETE FROM lobby_machine_assets WHERE sha256 = ? AND NOT EXISTS ("
        "SELECT 1 FROM lobby_machine_blueprints b WHERE b.sha256 = ? AND (b.gone = 0 OR "
        "EXISTS (SELECT 1 FROM lobby_machines m WHERE m.blueprint_id = b.id AND m.gone = 0)))",
        (sha, sha),
    )


def asset_chunk(db: StateDB, sha: str, n: int) -> bytes:
    """Chunk `n` of a blueprint's file (MACHINE_CHUNK_BYTES each, the last may be short);
    404 asset_not_found (no such file, or past its end)."""
    row = db.query_one(
        "SELECT substr(data, ?, ?) AS piece FROM lobby_machine_assets WHERE sha256 = ?",
        (n * MACHINE_CHUNK_BYTES + 1, MACHINE_CHUNK_BYTES, sha),
    )
    if row is None or not row["piece"]:
        raise ApiError(404, {"error": "asset_not_found"})
    return bytes(row["piece"])


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


def _placed_bricks(db: StateDB) -> list[brick_rules.At]:
    rows = db.query_all(
        "SELECT shape, x, y, z, rot FROM lobby_bricks WHERE gone = 0 AND holder IS NULL"
    )
    return [brick_rules.At(r["shape"], r["x"], r["y"], r["z"], r["rot"]) for r in rows]


def build(db: StateDB, user: Identity, body: MachineBuild, now: datetime) -> MachineChange:
    """Builds a blueprint on the floor where it's placed (the mechanic only).
    403 not_the_mechanic; 404 blueprint_not_found; 409 machine_limit, wont_fit (with the
    rule's `problem`)."""
    with db.transaction():
        _purge(db, now)
        _require_mechanic(db, user)
        blueprint = db.query_one(
            "SELECT * FROM lobby_machine_blueprints WHERE id = ? AND ready = 1 AND gone = 0",
            (body.blueprint,),
        )
        if blueprint is None:
            raise ApiError(404, {"error": "blueprint_not_found"})
        standing = db.query_all(f"{_MACHINE_SELECT} WHERE m.gone = 0")
        if len(standing) >= rules.LIMIT:
            raise ApiError(409, {"error": "machine_limit", "limit": rules.LIMIT})
        spot = rules.Spot(_size(blueprint), body.x, body.z, body.turn, body.scale)
        problem = rules.problem(spot, [_spot(r) for r in standing], _placed_bricks(db))
        if problem is not None:
            raise ApiError(409, {"error": "wont_fit", "problem": problem})
        machine_id = secrets.token_hex(6)
        rev = _bump(db)
        stamp = members_service.to_db(now)
        db.execute(
            "INSERT INTO lobby_machines (id, blueprint_id, x, z, turn, scale, built_by, "
            "built_at, gone, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (
                machine_id,
                body.blueprint,
                body.x,
                body.z,
                body.turn,
                body.scale,
                _member(user),
                stamp,
                rev,
                stamp,
            ),
        )
        row = db.query_one(f"{_MACHINE_SELECT} WHERE m.id = ?", (machine_id,))
    assert row is not None
    return MachineChange(rev=rev, machine=_machine(row))


def take_down(db: StateDB, user: Identity, machine_id: str, now: datetime) -> MachineChange:
    """Takes a machine out of the cave (the mechanic only). 403 not_the_mechanic;
    404 machine_not_found."""
    with db.transaction():
        _require_mechanic(db, user)
        row = db.query_one(f"{_MACHINE_SELECT} WHERE m.id = ? AND m.gone = 0", (machine_id,))
        if row is None:
            raise ApiError(404, {"error": "machine_not_found"})
        rev = _bump(db)
        db.execute(
            "UPDATE lobby_machines SET gone = 1, rev = ?, updated_at = ? WHERE id = ?",
            (rev, members_service.to_db(now), machine_id),
        )
        _drop_unused(db, row["b_sha256"])
    return MachineChange(rev=rev)
