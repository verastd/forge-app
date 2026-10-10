"""Lobby avatars: what a robot wears on its back, a library model (fit `back`) or the
built-in cape: saved, read back, validated, and cleared with the robot, the model, or
the model given to someone else."""

import base64
import json
import struct
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.services.state import get_state_db

MEMBER = "gh:1001"
OTHER = "gh:2002"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}
CAPE = {"outer": "#111114", "lining": "#9b1020"}


@pytest.fixture(autouse=True)
def avatars_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    yield


def glb() -> bytes:
    text = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": "Wings"}]}).encode()
    text += b" " * (-len(text) % 4)
    length = 12 + 8 + len(text)
    return (
        b"glTF" + struct.pack("<II", 2, length) + struct.pack("<II", len(text), 0x4E4F534A) + text
    )


def add(client: TestClient, headers: dict[str, str], head_id: str, fit: str) -> Any:
    data = base64.b64encode(glb()).decode()
    body = {"name": head_id, "fit": fit, "data": data, "owner": MEMBER}
    return client.put(f"/api/avatars/heads/{head_id}", headers=headers, json=body)


def put(client: TestClient, headers: dict[str, str], body: dict[str, Any]) -> Any:
    return client.put(f"/api/avatars/members/{MEMBER}", headers=headers, json=body)


def backs() -> list[dict[str, Any]]:
    return get_state_db().query_all("SELECT * FROM avatars_member_backs")


def worn(client: TestClient) -> dict[str, Any]:
    avatars = client.get("/api/avatars").json()["avatars"]
    return avatars[0] if avatars else {}


def test_a_cape_is_saved_and_read_back(client: TestClient, admin_headers: dict[str, str]) -> None:
    response = put(client, admin_headers, {"colors": COLORS, "cape": CAPE})
    assert response.status_code == 200
    assert response.json()["cape"] == CAPE
    assert "back" not in response.json()
    assert worn(client)["cape"] == CAPE


def test_a_back_model_is_worn_and_uploads_take_the_back_fit(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload = add(client, admin_headers, "wings", "back")
    assert upload.status_code == 200 and upload.json()["fit"] == "back"
    body = put(client, admin_headers, {"colors": COLORS, "back": "wings"}).json()
    assert body["back"] == "wings" and "cape" not in body
    assert worn(client)["back"] == "wings"


def test_saved_without_one_the_back_is_bare(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    put(client, admin_headers, {"colors": COLORS, "cape": CAPE})
    body = put(client, admin_headers, {"colors": COLORS}).json()
    assert "cape" not in body and "back" not in body
    assert backs() == []


def test_a_cape_and_a_model_together_are_refused(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    add(client, admin_headers, "wings", "back")
    response = put(client, admin_headers, {"colors": COLORS, "back": "wings", "cape": CAPE})
    assert response.status_code == 400
    assert response.json()["error"] == "one_back"


@pytest.mark.parametrize(
    ("fit", "slot", "error"),
    [
        ("replace", "back", "not_a_back"),
        ("accessory", "back", "not_a_back"),
        ("back", "head", "back_model"),
        ("back", "accessory", "not_an_accessory"),
    ],
)
def test_a_back_model_goes_only_on_the_back(
    client: TestClient, admin_headers: dict[str, str], fit: str, slot: str, error: str
) -> None:
    add(client, admin_headers, "thing", fit)
    response = put(client, admin_headers, {"colors": COLORS, slot: "thing"})
    assert response.status_code == 400
    assert response.json()["error"] == error
    assert backs() == []


def test_a_back_model_must_exist_and_be_theirs(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    missing = put(client, admin_headers, {"colors": COLORS, "back": "ghost"})
    assert missing.status_code == 400 and missing.json()["error"] == "unknown_head"
    add(client, admin_headers, "wings", "back")
    client.put("/api/avatars/heads/wings/owner", headers=admin_headers, json={"owner": OTHER})
    theirs = put(client, admin_headers, {"colors": COLORS, "back": "wings"})
    assert theirs.status_code == 400 and theirs.json()["error"] == "head_not_theirs"


@pytest.mark.parametrize(
    "cape",
    [
        {"outer": "black", "lining": "#9b1020"},
        {"outer": "#111114"},
        {"outer": "#111114", "lining": "#9b1020", "trim": "#ffffff"},
    ],
)
def test_a_cape_needs_two_colours(
    client: TestClient, admin_headers: dict[str, str], cape: dict[str, str]
) -> None:
    response = put(client, admin_headers, {"colors": COLORS, "cape": cape})
    assert response.status_code == 400
    assert backs() == []


def test_the_back_goes_with_the_robot_the_model_or_the_model_given_away(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    def wear() -> None:
        add(client, admin_headers, "wings", "back")
        assert put(client, admin_headers, {"colors": COLORS, "back": "wings"}).status_code == 200

    wear()
    client.put("/api/avatars/heads/wings/owner", headers=admin_headers, json={"owner": OTHER})
    assert "back" not in worn(client)
    client.put("/api/avatars/heads/wings/owner", headers=admin_headers, json={"owner": MEMBER})
    wear()
    assert client.delete("/api/avatars/heads/wings", headers=admin_headers).status_code == 204
    assert "back" not in worn(client)
    put(client, admin_headers, {"colors": COLORS, "cape": CAPE})
    assert client.delete(f"/api/avatars/members/{MEMBER}", headers=admin_headers).status_code == 204
    assert backs() == []
