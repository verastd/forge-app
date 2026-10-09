"""Lobby avatars: a robot's right eye (when it differs) and its finish (paint, chrome,
ice): saved, read back, validated, and cleared with the robot."""

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.services.state import get_state_db

MEMBER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def put(client: TestClient, headers: dict[str, str], body: dict[str, Any]) -> Any:
    return client.put(f"/api/avatars/members/{MEMBER}", headers=headers, json=body)


def test_a_right_eye_and_a_finish_are_saved_and_read_back(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    colors = {**COLORS, "eyeRight": "#ff2d55"}
    response = put(client, admin_headers, {"colors": colors, "finish": "ice"})
    assert response.status_code == 200
    body = response.json()
    assert body["colors"] == colors
    assert body["finish"] == "ice"
    assert client.get("/api/avatars").json()["avatars"] == [body]


def test_one_eye_colour_and_paint_read_as_they_always_did(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    put(client, admin_headers, {"colors": {**COLORS, "eyeRight": "#ff2d55"}, "finish": "chrome"})
    # Saved again without them: back to one eye colour, painted (and paint is kept as no finish).
    body = put(client, admin_headers, {"colors": COLORS, "finish": "paint"}).json()
    assert body["colors"] == COLORS
    assert "finish" not in body
    rows = get_state_db().query_all("SELECT * FROM avatars_member_looks")
    assert rows == []


def test_a_finish_alone_or_a_right_eye_alone_is_kept(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    chrome = put(client, admin_headers, {"colors": COLORS, "finish": "chrome"}).json()
    assert chrome["finish"] == "chrome" and "eyeRight" not in chrome["colors"]
    eyed = put(client, admin_headers, {"colors": {**COLORS, "eyeRight": "#00ff00"}}).json()
    assert eyed["colors"]["eyeRight"] == "#00ff00" and "finish" not in eyed


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"colors": COLORS, "finish": "gold"}, "finish"),
        ({"colors": COLORS, "finish": 1}, "finish"),
        ({"colors": {**COLORS, "eyeRight": "red"}}, "colors.eyeRight"),
        ({"colors": {**COLORS, "eyeRight": "#ABCDEF"}}, "colors.eyeRight"),
    ],
)
def test_a_bad_right_eye_or_finish_is_400_naming_the_field(
    client: TestClient, admin_headers: dict[str, str], body: dict[str, Any], field: str
) -> None:
    response = put(client, admin_headers, body)
    assert response.status_code == 400
    assert field in response.json()["fields"]


def test_reset_clears_them_too(client: TestClient, admin_headers: dict[str, str]) -> None:
    put(client, admin_headers, {"colors": {**COLORS, "eyeRight": "#ff2d55"}, "finish": "ice"})
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code in (
        200,
        204,
    )
    assert client.get("/api/avatars").json()["avatars"] == []
    assert get_state_db().query_all("SELECT * FROM avatars_member_looks") == []
