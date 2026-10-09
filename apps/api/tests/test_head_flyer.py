"""Lobby avatars: what flies over a head (a helicopter), kept with its fit: saved, read
back, validated, cleared with the fit and with the head."""

import base64
import json
import struct
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.services.state import get_state_db

FITTED: dict[str, Any] = {"scale": 0.5, "offset": [0.0, 0.02, 0.0]}
FLOWN: dict[str, Any] = {**FITTED, "flyer": "helicopter"}


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


def upload(client: TestClient, headers: dict[str, str], **extra: Any) -> Any:
    data = base64.b64encode(glb()).decode()
    body = {"name": "City", "fit": "replace", "data": data, **extra}
    return client.put("/api/avatars/heads/city", headers=headers, json=body)


def refit(client: TestClient, headers: dict[str, str], placement: dict[str, Any]) -> Any:
    return client.put(
        "/api/avatars/heads/city/placement", headers=headers, json={"placement": placement}
    )


def flyers() -> list[dict[str, Any]]:
    return get_state_db().query_all("SELECT * FROM avatars_head_flyers")


def test_a_helicopter_is_kept_with_the_fit_and_read_back(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload(client, admin_headers)
    response = refit(client, admin_headers, FLOWN)
    assert response.status_code == 200
    assert response.json()["placement"] == FLOWN
    assert client.get("/api/avatars").json()["heads"][0]["placement"] == FLOWN


def test_refitting_without_it_takes_the_helicopter_away(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload(client, admin_headers)
    refit(client, admin_headers, FLOWN)
    plain = refit(client, admin_headers, FITTED).json()
    assert plain["placement"] == FITTED
    assert flyers() == []


def test_a_head_uploaded_with_a_helicopter_has_one(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    head = upload(client, admin_headers, placement=FLOWN).json()
    assert head["placement"] == FLOWN


@pytest.mark.parametrize("flyer", ["blimp", "", 3, True])
def test_only_a_known_flyer_is_taken(
    client: TestClient, admin_headers: dict[str, str], flyer: object
) -> None:
    upload(client, admin_headers)
    response = refit(client, admin_headers, {**FITTED, "flyer": flyer})
    assert response.status_code == 400
    assert flyers() == []


def test_the_helicopter_goes_with_the_head(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    upload(client, admin_headers, placement=FLOWN)
    assert client.delete("/api/avatars/heads/city", headers=admin_headers).status_code == 204
    assert flyers() == []
    again = upload(client, admin_headers).json()
    assert "flyer" not in again["placement"]
