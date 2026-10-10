"""Lobby avatars: a chestplate that is a short clip (MP4 or WebM) instead of an image:
checked to be what it claims, up to its own size limit, served as it came, and said to be a
clip (`chestType`) so the lobby plays it."""

import base64
import json
import struct
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.models import AVATAR_CHEST_MAX_BYTES, AVATAR_CHEST_VIDEO_MAX_BYTES

MEMBER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def mp4(brand: bytes = b"isom", pad: int = 64) -> bytes:
    return struct.pack(">I", 24) + b"ftyp" + brand + b"\0\0\0\0" + b"isomavc1" + b"\0" * pad


def webm(doctype: bytes = b"webm", pad: int = 64) -> bytes:
    return b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84" + doctype + b"\0" * pad


def png() -> bytes:
    ihdr = struct.pack(">IIBBBBB", 64, 32, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\0" * 20


def dress(client: TestClient, headers: dict[str, str]) -> None:
    client.put(f"/api/avatars/members/{MEMBER}", headers=headers, json={"colors": COLORS})


def chest(client: TestClient, headers: dict[str, str], content_type: str, raw: bytes) -> Any:
    body = {"contentType": content_type, "data": b64(raw)}
    return client.put(f"/api/avatars/members/{MEMBER}/chest", headers=headers, json=body)


@pytest.mark.parametrize(("content_type", "raw"), [("video/mp4", mp4()), ("video/webm", webm())])
def test_a_clip_goes_on_the_chest_and_says_it_is_one(
    client: TestClient, admin_headers: dict[str, str], content_type: str, raw: bytes
) -> None:
    dress(client, admin_headers)
    response = chest(client, admin_headers, content_type, raw)
    assert response.status_code == 200
    body = response.json()
    assert body["chestType"] == content_type
    served = client.get(f"/api/avatars/assets/{body['chest']}")
    assert served.content == raw and served.headers["content-type"] == content_type
    assert client.get("/api/avatars").json()["avatars"][0]["chestType"] == content_type


def test_an_image_after_a_clip_is_an_image_again_and_none_is_none(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    dress(client, admin_headers)
    chest(client, admin_headers, "video/mp4", mp4())
    image = chest(client, admin_headers, "image/png", png()).json()
    assert image["chestType"] == "image/png"
    cleared = client.delete(f"/api/avatars/members/{MEMBER}/chest", headers=admin_headers).json()
    assert "chest" not in cleared and "chestType" not in cleared


@pytest.mark.parametrize(
    ("content_type", "raw", "reason"),
    [
        ("video/mp4", webm(), "not_mp4"),
        ("video/mp4", mp4(brand=b"qt  "), "not_mp4"),
        ("video/mp4", b"\0\0\0\x18ftyp", "not_mp4"),
        ("video/webm", mp4(), "not_webm"),
        ("video/webm", webm(doctype=b"matroska"), "not_webm"),
        ("video/webm", b"just some bytes, not a video at all", "not_webm"),
    ],
)
def test_a_clip_must_be_what_it_says(
    client: TestClient, admin_headers: dict[str, str], content_type: str, raw: bytes, reason: str
) -> None:
    dress(client, admin_headers)
    response = chest(client, admin_headers, content_type, raw)
    assert response.status_code == 400
    assert response.json()["reason"] == reason
    assert "chest" not in client.get("/api/avatars").json()["avatars"][0]


def test_a_clip_may_weigh_more_than_an_image_but_not_without_end(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    dress(client, admin_headers)
    # Bigger than an image may be, within a clip's limit: fine.
    roomy = mp4(pad=AVATAR_CHEST_MAX_BYTES + 1024)
    assert chest(client, admin_headers, "video/mp4", roomy).status_code == 200
    too_big = mp4(pad=AVATAR_CHEST_VIDEO_MAX_BYTES)
    assert chest(client, admin_headers, "video/mp4", too_big).status_code == 413
    # An image keeps its own, smaller limit.
    big_png = png() + b"\0" * AVATAR_CHEST_MAX_BYTES
    assert chest(client, admin_headers, "image/png", big_png).status_code == 413
