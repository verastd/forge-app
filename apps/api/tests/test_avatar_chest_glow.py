"""Lobby avatars: how much an uploaded chestplate glows, saved with the robot, read back,
validated, and gone with the robot."""

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.models import AVATAR_CHEST_GLOW_DEFAULT
from forge_api.services.state import get_state_db

MEMBER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def put(client: TestClient, headers: dict[str, str], body: dict[str, Any]) -> Any:
    return client.put(f"/api/avatars/members/{MEMBER}", headers=headers, json=body)


def glows() -> list[dict[str, Any]]:
    return get_state_db().query_all("SELECT * FROM avatars_member_chest_glow")


def test_a_glow_is_saved_with_the_robot_and_read_back(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    saved = put(client, admin_headers, {"colors": COLORS, "chestGlow": 0.15})
    assert saved.status_code == 200 and saved.json()["chestGlow"] == 0.15
    assert client.get("/api/avatars").json()["avatars"][0]["chestGlow"] == 0.15
    # Saved again without one: the default (no row, nothing said).
    plain = put(client, admin_headers, {"colors": COLORS})
    assert "chestGlow" not in plain.json()
    assert glows() == []
    assert 0 < AVATAR_CHEST_GLOW_DEFAULT < 1


def test_a_glow_is_between_none_and_full(client: TestClient, admin_headers: dict[str, str]) -> None:
    for bad in (-0.1, 1.5, "bright"):
        refused = put(client, admin_headers, {"colors": COLORS, "chestGlow": bad})
        assert refused.status_code in (400, 422), bad
    for edge in (0, 1):
        assert (
            put(client, admin_headers, {"colors": COLORS, "chestGlow": edge}).json()["chestGlow"]
            == edge
        )


def test_resetting_the_robot_takes_its_glow_too(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    put(client, admin_headers, {"colors": COLORS, "chestGlow": 0.8})
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code == 204
    assert glows() == []
