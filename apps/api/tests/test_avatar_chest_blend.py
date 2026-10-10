"""Lobby avatars: how an uploaded chestplate blends over the armour (a CSS mix-blend-mode)
and its opacity, saved with the robot, read back, validated, and gone with the robot."""

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.models import AVATAR_CHEST_BLENDS
from forge_api.services.state import get_state_db

MEMBER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def put(client: TestClient, headers: dict[str, str], body: dict[str, Any]) -> Any:
    return client.put(f"/api/avatars/members/{MEMBER}", headers=headers, json=body)


def blends() -> list[dict[str, Any]]:
    return get_state_db().query_all("SELECT * FROM avatars_member_chest_blends")


def test_every_css_blend_mode_is_offered() -> None:
    assert AVATAR_CHEST_BLENDS[:4] == ("normal", "multiply", "screen", "overlay")
    assert len(AVATAR_CHEST_BLENDS) == 16


def test_a_blend_and_opacity_are_saved_with_the_robot_and_read_back(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    saved = put(
        client, admin_headers, {"colors": COLORS, "chestBlend": "multiply", "chestOpacity": 0.6}
    )
    assert saved.status_code == 200
    assert (saved.json()["chestBlend"], saved.json()["chestOpacity"]) == ("multiply", 0.6)
    robot = client.get("/api/avatars").json()["avatars"][0]
    assert (robot["chestBlend"], robot["chestOpacity"]) == ("multiply", 0.6)
    # Just one of them: the other reads as its default.
    screen = put(client, admin_headers, {"colors": COLORS, "chestBlend": "screen"}).json()
    assert screen["chestBlend"] == "screen" and "chestOpacity" not in screen
    faded = put(client, admin_headers, {"colors": COLORS, "chestOpacity": 0.25}).json()
    assert faded["chestOpacity"] == 0.25 and "chestBlend" not in faded
    # Saved without either (or as the defaults): no row, nothing said.
    plain = put(
        client, admin_headers, {"colors": COLORS, "chestBlend": "normal", "chestOpacity": 1}
    ).json()
    assert "chestBlend" not in plain and "chestOpacity" not in plain
    assert blends() == []


def test_only_css_modes_and_opacities_between_none_and_full(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    for bad in (
        {"chestBlend": "glow"},
        {"chestOpacity": 1.5},
        {"chestOpacity": -0.1},
        {"chestGlow": 0.4},
    ):
        refused = put(client, admin_headers, {"colors": COLORS, **bad})
        assert refused.status_code in (400, 422), bad


def test_resetting_the_robot_takes_its_blend_too(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    put(client, admin_headers, {"colors": COLORS, "chestBlend": "overlay"})
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code == 204
    assert blends() == []
