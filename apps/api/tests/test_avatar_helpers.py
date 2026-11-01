"""Lobby avatars: the cave's helper bots are dressed like members. They're listed first in the
editor, can be painted, given a chestplate and a head made for them, and only the bots the
cave has (HELPER_BOTS, mirrored from @forge/lobby) can be."""

import base64
import json
import re
import struct
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from forge_api import models
from forge_api.services import avatars as avatars_service

BOT = "bot:helper"
COLORS = {"shell": "#34353b", "trim": "#ff9a1f", "accent": "#ffb627", "eye": "#ffc83d"}
ROOT = Path(__file__).resolve().parents[3]
LOBBY_HELPERS = ROOT / "packages" / "lobby" / "src" / "helpers.ts"
SHARED = ROOT / "packages" / "shared" / "src" / "index.ts"
HELPER_HEAD = ROOT / "apps" / "web" / "public" / "lobby" / "helper-head.glb"


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def glb() -> bytes:
    text = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": "Head"}]}).encode()
    text += b" " * (-len(text) % 4)
    length = 12 + 8 + len(text)
    return (
        b"glTF" + struct.pack("<II", 2, length) + struct.pack("<II", len(text), 0x4E4F534A) + text
    )


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def png() -> bytes:
    ihdr = struct.pack(">IIBBBBB", 64, 32, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\0" * 20


def test_the_bots_are_the_lobbys_own_and_match_its_ids() -> None:
    source = LOBBY_HELPERS.read_text(encoding="utf-8")
    ids = re.findall(r"id: '(bot:[a-z0-9-]+)'", source)
    assert ids == [bot.memberId for bot in avatars_service.HELPER_BOTS]
    for bot in avatars_service.HELPER_BOTS:
        assert re.fullmatch(models.AVATAR_ROBOT_ID, bot.memberId)
        assert re.fullmatch(models.AVATAR_MEMBER_ID, bot.memberId) is None
    zod = re.search(r"export const AVATAR_ROBOT_ID = /(.*)/;", SHARED.read_text(encoding="utf-8"))
    assert zod is not None and zod.group(1) == models.AVATAR_ROBOT_ID


def test_is_robot_takes_members_and_the_cave_s_bots_only() -> None:
    assert avatars_service.is_robot("gh:1001")
    assert avatars_service.is_robot(BOT)
    for other in ("bot:nobody", "bot:", "gh:abc", "helper", "BOT:helper"):
        assert not avatars_service.is_robot(other), other


def test_the_editor_lists_the_bots_before_the_members(
    client: TestClient, admin_headers: dict[str, str], user_headers: dict[str, str]
) -> None:
    client.post("/api/members/hello", headers=user_headers)
    members = client.get("/api/avatars/members", headers=admin_headers).json()["members"]
    assert members[0] == {"memberId": BOT, "login": "helper-bot"}
    assert {"memberId": "gh:1001", "login": "octo-contributor"} in members[1:]


def test_a_bot_is_painted_and_given_a_chestplate_like_a_member(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    painted = client.put(
        f"/api/avatars/members/{BOT}", headers=admin_headers, json={"colors": COLORS}
    )
    assert painted.status_code == 200 and painted.json()["memberId"] == BOT
    chest = client.put(
        f"/api/avatars/members/{BOT}/chest",
        headers=admin_headers,
        json={"contentType": "image/png", "data": b64(png())},
    )
    assert chest.status_code == 200
    listed = client.get("/api/avatars").json()["avatars"]
    assert listed == [chest.json()] and listed[0]["chest"] == chest.json()["chest"]
    assert client.delete(f"/api/avatars/members/{BOT}", headers=admin_headers).status_code == 204
    assert client.get("/api/avatars").json()["avatars"] == []


def test_a_head_is_made_for_a_bot_and_worn_by_it(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    made = client.put(
        "/api/avatars/heads/beacon",
        headers=admin_headers,
        json={"name": "Beacon", "fit": "replace", "data": b64(glb()), "owner": BOT},
    )
    assert made.status_code == 200 and made.json()["owner"] == BOT
    worn = client.put(
        f"/api/avatars/members/{BOT}",
        headers=admin_headers,
        json={"colors": COLORS, "head": "beacon"},
    )
    assert worn.status_code == 200 and worn.json()["head"] == "beacon"
    # A member can't wear the bot's head.
    taken = client.put(
        "/api/avatars/members/gh:1001",
        headers=admin_headers,
        json={"colors": COLORS, "head": "beacon"},
    )
    assert taken.status_code == 400 and taken.json()["error"] == "head_not_theirs"


def test_only_the_cave_s_bots_can_be_dressed_or_given_a_head(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    for path in ("/api/avatars/members/bot:nobody", "/api/avatars/members/bot:nobody/chest"):
        response = client.put(path, headers=admin_headers, json={"colors": COLORS})
        assert response.status_code == 404 and response.json() == {"error": "member_not_found"}
    client.put(
        "/api/avatars/heads/beacon",
        headers=admin_headers,
        json={"name": "Beacon", "fit": "replace", "data": b64(glb())},
    )
    given = client.put(
        "/api/avatars/heads/beacon/owner", headers=admin_headers, json={"owner": "bot:nobody"}
    )
    assert given.status_code == 400
    assert given.json() == {"error": "unknown_owner", "fields": ["owner"]}
    uploaded = client.put(
        "/api/avatars/heads/beacon",
        headers=admin_headers,
        json={"name": "Beacon", "fit": "replace", "data": b64(glb()), "owner": "bot:nobody"},
    )
    assert uploaded.status_code == 400 and uploaded.json()["error"] == "unknown_owner"


def test_the_head_the_bot_ships_with_could_be_uploaded_as_it_is() -> None:
    # The lobby wears it from its own file; the same file through the editor passes every check.
    raw = HELPER_HEAD.read_bytes()
    assert len(raw) <= models.AVATAR_HEAD_MAX_BYTES
    assert avatars_service.check_glb(raw) is False  # no EyeL/EyeR: its placement puts the eyes
