"""Lobby avatars: the routes (flag, auth, validation, round trips), what an upload must
really be, the files' lifetime, and the zod mirror field for field."""

import base64
import json
import re
import struct
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from forge_api import models
from forge_api.services import avatars as avatars_service
from forge_api.services.errors import ApiError
from forge_api.services.state import get_state_db

from .conftest import ADMIN_LOGIN, ADMIN_SUB, AuthHeaders

MEMBER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}
SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "index.ts"


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


# ---------------------------------------------------------------------------
# Files that are what they say they are
# ---------------------------------------------------------------------------


def png(width: int = 64, height: int = 32) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\0" * 20


def jpeg(width: int = 40, height: int = 30, *, fill: bool = False) -> bytes:
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\0" + b"\0" * 9
    sof = b"\xff\xc0" + struct.pack(">HBHH", 11, 8, height, width) + b"\x01\x11\x00"
    return b"\xff\xd8" + (b"\xff" if fill else b"") + app0 + b"\xff\x01" + sof + b"\xff\xd9"


def webp_lossy(width: int = 50, height: int = 20) -> bytes:
    body = (
        b"VP8 "
        + struct.pack("<I", 10)
        + b"\0\0\0"
        + b"\x9d\x01\x2a"
        + struct.pack("<HH", width, height)
    )
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def webp_lossless(width: int = 7, height: int = 9) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    body = b"VP8L" + struct.pack("<I", 5) + b"\x2f" + bits.to_bytes(4, "little") + b"\0" * 5
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def webp_extended(width: int = 300, height: int = 200) -> bytes:
    body = (
        b"VP8X"
        + struct.pack("<I", 10)
        + b"\0" * 4
        + (width - 1).to_bytes(3, "little")
        + (height - 1).to_bytes(3, "little")
    )
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def glb(document: dict[str, Any] | None = None, *, eyes: bool = True) -> bytes:
    doc = document or {
        "asset": {"version": "2.0"},
        "nodes": [{"name": "Head"}] + ([{"name": "EyeL"}, {"name": "EyeR"}] if eyes else []),
    }
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    length = 12 + 8 + len(text)
    return (
        b"glTF" + struct.pack("<II", 2, length) + struct.pack("<II", len(text), 0x4E4F534A) + text
    )


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


@pytest.mark.parametrize(
    ("raw", "kind", "size"),
    [
        (png(), "image/png", (64, 32)),
        (jpeg(), "image/jpeg", (40, 30)),
        (jpeg(fill=True), "image/jpeg", (40, 30)),
        (webp_lossy(), "image/webp", (50, 20)),
        (webp_lossless(), "image/webp", (7, 9)),
        (webp_extended(), "image/webp", (300, 200)),
    ],
)
def test_check_image_reads_the_size_from_the_bytes(
    raw: bytes, kind: str, size: tuple[int, int]
) -> None:
    assert avatars_service.check_image(raw, kind) == size


@pytest.mark.parametrize(
    ("raw", "kind", "reason"),
    [
        (png(), "image/jpeg", "not_jpeg"),
        (jpeg(), "image/png", "not_png"),
        (b"RIFF\0\0\0\0WEBPVP8 " + b"\0" * 20, "image/webp", "not_webp"),
        (b"\xff\xd8\xff\xe0\x00\x01", "image/jpeg", "not_jpeg"),  # a length under 2
        (b"\xff\xd8\xff\xc0\x00\x11\x08", "image/jpeg", "not_jpeg"),  # SOF cut short
        (b"\xff\xd8\x00\x00\x00\x00", "image/jpeg", "not_jpeg"),  # not a marker
        (b"\xff\xd8\xff\xd9", "image/jpeg", "not_jpeg"),  # no frame at all
        (png(4096, 10), "image/png", "too_many_pixels"),
        (png(0, 10), "image/png", "too_many_pixels"),
    ],
)
def test_check_image_refuses_what_it_cannot_prove(raw: bytes, kind: str, reason: str) -> None:
    with pytest.raises(ApiError) as caught:
        avatars_service.check_image(raw, kind)
    assert caught.value.status_code == 400
    assert caught.value.payload["reason"] == reason


def test_check_glb_answers_whether_the_head_carries_both_eyes() -> None:
    assert avatars_service.check_glb(glb()) is True
    assert avatars_service.check_glb(glb(eyes=False)) is False
    assert avatars_service.check_glb(glb({"asset": {"version": "2.0"}, "nodes": "x"})) is False


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        (b"nope", "not_glb"),
        (b"glTF" + struct.pack("<II", 1, 20) + b"\0" * 8, "not_glb"),
        (glb()[:-4], "not_glb"),
        (
            b"glTF" + struct.pack("<II", 2, 24) + struct.pack("<II", 4, 0x004E4942) + b"\0" * 4,
            "not_glb",
        ),
        (
            b"glTF" + struct.pack("<II", 2, 24) + struct.pack("<II", 4, 0x4E4F534A) + b"\xff\xfe{}",
            "not_glb",
        ),
        (glb({"nodes": []}), "not_glb"),
        (glb({"asset": {}, "buffers": [{"uri": "https://example.test/a.bin"}]}), "external_uri"),
        (glb({"asset": {}, "images": [[{"uri": "x.png"}]]}), "external_uri"),
        (
            glb({"asset": {}, "extensionsRequired": ["KHR_draco_mesh_compression"]}),
            "extension_required",
        ),
    ],
)
def test_check_glb_refuses_anything_but_a_self_contained_gltf_2(raw: bytes, reason: str) -> None:
    with pytest.raises(ApiError) as caught:
        avatars_service.check_glb(raw)
    assert caught.value.payload["reason"] == reason


def test_decode_base64_is_strict_and_capped() -> None:
    assert avatars_service.decode_base64(b64(b"abc"), 10) == b"abc"
    for bad, reason in (("@@@@", "not_base64"), ("====", "not_base64")):
        with pytest.raises(ApiError) as caught:
            avatars_service.decode_base64(bad, 10)
        assert caught.value.payload["reason"] == reason
    with pytest.raises(ApiError) as caught:
        avatars_service.decode_base64(b64(b"x" * 11), 10)
    assert caught.value.status_code == 413
    with pytest.raises(ApiError) as caught:
        avatars_service.decode_base64(b64(b"x" * 12), 10)
    assert caught.value.status_code == 413


def test_decode_base64_refuses_nothing() -> None:
    with pytest.raises(ApiError) as caught:
        avatars_service.decode_base64("", 10)
    assert caught.value.payload["reason"] == "empty"


# ---------------------------------------------------------------------------
# The routes
# ---------------------------------------------------------------------------


def test_every_route_404s_while_the_flag_is_off(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"lobby_avatars": False}))
    for method, path in (
        ("GET", "/api/avatars"),
        ("GET", "/api/avatars/members"),
        ("PUT", f"/api/avatars/members/{MEMBER}"),
        ("GET", "/api/avatars/assets/" + "0" * 64),
    ):
        response = client.request(method, path, headers=admin_headers, json={})
        assert response.status_code == 404, path
        assert response.json() == {"error": "avatars-disabled"}


def test_the_list_is_public_and_starts_empty(client: TestClient) -> None:
    response = client.get("/api/avatars")
    assert response.status_code == 200
    assert response.json() == {"avatars": [], "heads": []}


def test_changes_need_an_admin(
    client: TestClient, user_headers: dict[str, str], admin_headers: dict[str, str]
) -> None:
    assert client.get("/api/avatars/members").status_code == 401
    assert client.put(f"/api/avatars/members/{MEMBER}", json={"colors": COLORS}).status_code == 401
    del admin_headers  # FORGE_ADMIN_IDS is set, and this caller isn't on it
    for method, path in (
        ("GET", "/api/avatars/members"),
        ("PUT", f"/api/avatars/members/{MEMBER}"),
        ("DELETE", f"/api/avatars/members/{MEMBER}"),
        ("PUT", f"/api/avatars/members/{MEMBER}/chest"),
        ("DELETE", f"/api/avatars/members/{MEMBER}/chest"),
        ("PUT", "/api/avatars/heads/bolt"),
        ("DELETE", "/api/avatars/heads/bolt"),
    ):
        response = client.request(method, path, headers=user_headers, json={"colors": COLORS})
        assert response.status_code == 403, (method, path)
        assert response.json() == {"error": "admin_only"}


def test_an_admin_lists_members_as_lobby_ids(
    client: TestClient, admin_headers: dict[str, str], user_headers: dict[str, str]
) -> None:
    client.post("/api/members/hello", headers=user_headers)
    response = client.get("/api/avatars/members", headers=admin_headers)
    assert response.status_code == 200
    members = response.json()["members"]
    assert {"memberId": "gh:1001", "login": "octo-contributor"} in members
    assert {"memberId": f"gh:{ADMIN_SUB}", "login": ADMIN_LOGIN} in members


def test_paint_a_robot_then_read_it_back(client: TestClient, admin_headers: dict[str, str]) -> None:
    response = client.put(
        f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": COLORS}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["memberId"] == MEMBER and body["colors"] == COLORS
    assert "head" not in body and "chest" not in body
    listed = client.get("/api/avatars").json()
    assert listed["avatars"] == [body]

    repainted = {**COLORS, "shell": "#000000"}
    again = client.put(
        f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": repainted}
    )
    assert again.json()["colors"]["shell"] == "#000000"
    assert len(client.get("/api/avatars").json()["avatars"]) == 1


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"colors": {**COLORS, "shell": "red"}}, "colors.shell"),
        ({"colors": {**COLORS, "eye": "#ABCDEF"}}, "colors.eye"),
        ({"colors": {k: v for k, v in COLORS.items() if k != "trim"}}, "colors.trim"),
        ({"colors": COLORS, "head": "Bad Head"}, "head"),
        ({"colors": COLORS, "extra": 1}, "extra"),
        ({}, "colors"),
    ],
)
def test_bad_paint_is_400_naming_the_field(
    client: TestClient, admin_headers: dict[str, str], body: dict[str, Any], field: str
) -> None:
    response = client.put(f"/api/avatars/members/{MEMBER}", headers=admin_headers, json=body)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
    assert field in response.json()["fields"]


def test_a_bad_member_id_is_404(client: TestClient, admin_headers: dict[str, str]) -> None:
    for bad in ("1001", "gh:abc", "gl:1"):
        response = client.put(
            f"/api/avatars/members/{bad}", headers=admin_headers, json={"colors": COLORS}
        )
        assert response.status_code == 404
        assert response.json() == {"error": "member_not_found"}


def test_a_head_must_be_in_the_library(client: TestClient, admin_headers: dict[str, str]) -> None:
    response = client.put(
        f"/api/avatars/members/{MEMBER}",
        headers=admin_headers,
        json={"colors": COLORS, "head": "bolt"},
    )
    assert response.status_code == 400
    assert response.json() == {"error": "unknown_head", "fields": ["head"]}


def test_heads_go_into_the_library_and_onto_robots(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    raw = glb()
    response = client.put(
        "/api/avatars/heads/bolt",
        headers=admin_headers,
        json={"name": "  Bolt ", "fit": "replace", "data": b64(raw)},
    )
    assert response.status_code == 200
    head = response.json()
    assert head["id"] == "bolt" and head["name"] == "Bolt" and head["eyes"] is True
    assert head["bytes"] == len(raw)

    asset = client.get(f"/api/avatars/assets/{head['sha256']}")
    assert asset.status_code == 200
    assert asset.content == raw
    assert asset.headers["content-type"] == "model/gltf-binary"
    assert "immutable" in asset.headers["cache-control"]
    assert asset.headers["etag"] == f'"{head["sha256"]}"'

    worn = client.put(
        f"/api/avatars/members/{MEMBER}",
        headers=admin_headers,
        json={"colors": COLORS, "head": "bolt"},
    )
    assert worn.json()["head"] == "bolt"
    assert client.get("/api/avatars").json()["heads"] == [head]


def test_replacing_a_head_keeps_its_wearers_and_drops_the_old_file(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    first = client.put(
        "/api/avatars/heads/bolt",
        headers=admin_headers,
        json={"name": "Bolt", "fit": "replace", "data": b64(glb())},
    ).json()
    client.put(
        f"/api/avatars/members/{MEMBER}",
        headers=admin_headers,
        json={"colors": COLORS, "head": "bolt"},
    )
    second = client.put(
        "/api/avatars/heads/bolt",
        headers=admin_headers,
        json={"name": "Bolt 2", "fit": "accessory", "data": b64(glb(eyes=False))},
    ).json()
    assert second["sha256"] != first["sha256"] and second["eyes"] is False
    assert first["fit"] == "replace" and second["fit"] == "accessory"
    assert client.get(f"/api/avatars/assets/{first['sha256']}").status_code == 404
    assert client.get("/api/avatars").json()["avatars"][0]["head"] == "bolt"


def test_deleting_a_head_puts_its_wearers_back_in_their_own(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    head = client.put(
        "/api/avatars/heads/bolt",
        headers=admin_headers,
        json={"name": "Bolt", "fit": "replace", "data": b64(glb())},
    ).json()
    client.put(
        f"/api/avatars/members/{MEMBER}",
        headers=admin_headers,
        json={"colors": COLORS, "head": "bolt"},
    )
    assert client.delete("/api/avatars/heads/bolt", headers=admin_headers).status_code == 204
    listed = client.get("/api/avatars").json()
    assert listed["heads"] == [] and "head" not in listed["avatars"][0]
    assert client.get(f"/api/avatars/assets/{head['sha256']}").status_code == 404
    again = client.delete("/api/avatars/heads/bolt", headers=admin_headers)
    assert again.status_code == 404 and again.json() == {"error": "head_not_found"}


def test_head_uploads_are_checked(client: TestClient, admin_headers: dict[str, str]) -> None:
    cases: list[tuple[str, dict[str, Any], int, str]] = [
        (
            "bolt",
            {"name": "Bolt", "fit": "replace", "data": b64(b"not a glb")},
            400,
            "invalid_request",
        ),
        ("bolt", {"name": "   ", "fit": "replace", "data": b64(glb())}, 400, "invalid_request"),
        ("bolt", {"name": "x" * 41, "fit": "replace", "data": b64(glb())}, 400, "invalid_request"),
        ("Bolt", {"name": "Bolt", "fit": "replace", "data": b64(glb())}, 404, "head_not_found"),
        ("bolt", {"name": "Bolt", "fit": "overlay", "data": b64(glb())}, 400, "invalid_request"),
        ("bolt", {"name": "Bolt", "data": b64(glb())}, 400, "invalid_request"),
        (
            "bolt",
            {
                "name": "Bolt",
                "fit": "replace",
                "data": "A" * (4 * (models.AVATAR_HEAD_MAX_BYTES // 3) + 8),
            },
            413,
            "file_too_large",
        ),
    ]
    for head_id, body, status, error in cases:
        response = client.put(f"/api/avatars/heads/{head_id}", headers=admin_headers, json=body)
        assert response.status_code == status, (head_id, body.get("name"))
        assert response.json()["error"] == error


def test_a_body_past_the_cap_is_413_before_it_is_parsed(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    huge = "A" * (4 * (models.AVATAR_CHEST_MAX_BYTES // 3) + 8192)
    response = client.put(
        f"/api/avatars/members/{MEMBER}/chest",
        headers=admin_headers,
        json={"contentType": "image/png", "data": huge},
    )
    assert response.status_code == 413
    assert response.json()["error"] == "body_too_large"


def test_a_chestplate_goes_on_a_painted_robot_and_comes_off_again(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload = {"contentType": "image/png", "data": b64(png())}
    undressed = client.put(
        f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers, json=upload
    )
    assert undressed.status_code == 404 and undressed.json() == {"error": "avatar_not_found"}

    client.put(f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": COLORS})
    dressed = client.put(f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers, json=upload)
    assert dressed.status_code == 200
    sha = dressed.json()["chest"]
    served = client.get(f"/api/avatars/assets/{sha}")
    assert served.content == png() and served.headers["content-type"] == "image/png"

    # Repainting keeps the chestplate.
    client.put(f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": COLORS})
    assert client.get("/api/avatars").json()["avatars"][0]["chest"] == sha

    # A new image replaces the old, which goes.
    newer = client.put(
        f"/api/avatars/members/{MEMBER}/chest",
        headers=admin_headers,
        json={"contentType": "image/webp", "data": b64(webp_lossy())},
    ).json()["chest"]
    assert newer != sha and client.get(f"/api/avatars/assets/{sha}").status_code == 404

    cleared = client.delete(f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers)
    assert cleared.status_code == 200 and "chest" not in cleared.json()
    assert client.get(f"/api/avatars/assets/{newer}").status_code == 404


def test_two_robots_can_share_one_chest_image(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload = {"contentType": "image/png", "data": b64(png())}
    for member in (MEMBER, "gh:1003"):
        client.put(f"/api/avatars/members/{member}", headers=admin_headers, json={"colors": COLORS})
        sha = client.put(
            f"/api/avatars/members/{member}/chest", headers=admin_headers, json=upload
        ).json()["chest"]
    client.delete(f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers)
    assert client.get(f"/api/avatars/assets/{sha}").status_code == 200


def test_chest_uploads_are_checked(client: TestClient, admin_headers: dict[str, str]) -> None:
    client.put(f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": COLORS})
    for body in (
        {"contentType": "image/gif", "data": b64(png())},
        {"contentType": "image/png", "data": b64(jpeg())},
        {"contentType": "image/png", "data": "not base64!"},
    ):
        response = client.put(
            f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers, json=body
        )
        assert response.status_code == 400, body["contentType"]
    missing = client.delete("/api/avatars/members/gh:9/chest", headers=admin_headers)
    assert missing.status_code == 404 and missing.json() == {"error": "avatar_not_found"}


def test_resetting_a_robot_forgets_it_and_its_chestplate(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    client.put(f"/api/avatars/members/{MEMBER}", headers=admin_headers, json={"colors": COLORS})
    sha = client.put(
        f"/api/avatars/members/{MEMBER}/chest",
        headers=admin_headers,
        json={"contentType": "image/png", "data": b64(png())},
    ).json()["chest"]
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code == 204
    assert client.get("/api/avatars").json()["avatars"] == []
    assert client.get(f"/api/avatars/assets/{sha}").status_code == 404
    # Resetting an undressed robot is fine too.
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code == 204


def test_an_unknown_or_malformed_asset_is_404(client: TestClient) -> None:
    for sha in ("0" * 64, "nope", "A" * 64):
        response = client.get(f"/api/avatars/assets/{sha}")
        assert response.status_code == 404
        assert response.json() == {"error": "asset_not_found"}


def test_the_tables_exist_once_the_database_opens() -> None:
    db = get_state_db()
    names = {r["name"] for r in db.query_all("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"avatars_assets", "avatars_heads", "avatars_members"} <= names


def test_assertions_round_trip_for_the_editor(auth_headers: AuthHeaders) -> None:
    # The editor speaks as the admin through the BFF: the same assertion as any route.
    assert auth_headers(ADMIN_SUB, ADMIN_LOGIN)["Authorization"].startswith("Bearer ")


# ---------------------------------------------------------------------------
# The zod mirror
# ---------------------------------------------------------------------------


def zod_fields(name: str) -> list[str]:
    """The keys of `export const <name>Schema = z.object({...})` in packages/shared."""
    source = SHARED.read_text(encoding="utf-8")
    match = re.search(rf"export const {name}Schema = z\.object\(\{{\n(.*?)\n\}}\);", source, re.S)
    assert match is not None, name
    return re.findall(r"^  (\w+):", match.group(1), re.M)


@pytest.mark.parametrize(
    "model",
    [
        models.AvatarColors,
        models.Avatar,
        models.AvatarHead,
        models.AvatarList,
        models.AvatarUpdate,
        models.AvatarChestUpload,
        models.AvatarHeadUpload,
        models.AvatarMember,
        models.AvatarMemberList,
    ],
)
def test_every_avatar_model_matches_its_zod_schema_field_for_field(model: type[BaseModel]) -> None:
    assert zod_fields(model.__name__) == list(model.model_fields)


def test_the_limits_match_the_zod_side() -> None:
    source = SHARED.read_text(encoding="utf-8")
    for name in (
        "AVATAR_HEAD_NAME_MAX",
        "AVATAR_CHEST_MAX_BYTES",
        "AVATAR_CHEST_MAX_PIXELS",
        "AVATAR_HEAD_MAX_BYTES",
    ):
        match = re.search(rf"export const {name} = ([0-9 *]+);", source)
        assert match is not None, name
        assert eval(match.group(1)) == getattr(models, name), name  # noqa: S307 - digits and *
    for name in ("AVATAR_MEMBER_ID", "AVATAR_HEAD_ID", "AVATAR_SHA256"):
        match = re.search(rf"export const {name} = /(.*)/;", source)
        assert match is not None and match.group(1) == getattr(models, name), name
    fits = re.search(r"export const AVATAR_HEAD_FITS = \[(.*)\] as const;", source)
    assert fits is not None
    assert re.findall(r"'([^']+)'", fits.group(1)) == list(models.AvatarHeadFit.__args__)
    types = re.search(r"export const AVATAR_CHEST_TYPES = \[(.*)\] as const;", source)
    assert types is not None
    assert re.findall(r"'([^']+)'", types.group(1)) == list(models.AvatarChestType.__args__)
