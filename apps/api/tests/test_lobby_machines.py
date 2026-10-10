"""Machines in the lobby: only the mechanic (the robot wearing a back model that makes
machines, or an admin standing in) uploads blueprints and builds and takes down machines;
uploads go up in chunks and are checked whole; a machine stands where the rules say it
fits; every change bumps the revision, and deltas say what changed."""

import base64
import hashlib
import json
import struct
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.models import MACHINE_CHUNK_BYTES
from forge_api.services import brick_rules
from forge_api.services import lobby_machines as machines_service
from forge_api.services import machine_rules as rules
from forge_api.services import members as members_service

from .conftest import AuthHeaders, FakeClock

MECHANIC = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}
ENGINE_BACK: dict[str, Any] = {"scale": 0.5, "offset": [0.0, 0.0, -0.1], "emitter": "machines"}


@pytest.fixture(autouse=True)
def lobby_on(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    app.dependency_overrides[members_service.current_time] = clock
    yield


def glb(pad: int = 0) -> bytes:
    text = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": "Block"}]}).encode()
    text += b" " * (-len(text) % 4 + pad)
    length = 12 + 8 + len(text)
    return (
        b"glTF" + struct.pack("<II", 2, length) + struct.pack("<II", len(text), 0x4E4F534A) + text
    )


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


@pytest.fixture
def mechanic(
    client: TestClient, admin_headers: dict[str, str], user_headers: dict[str, str]
) -> dict[str, str]:
    """The contributor (gh:1001) wears the El Camino engine; their headers."""
    body = {"name": "engine", "fit": "back", "data": b64(glb()), "placement": ENGINE_BACK}
    body["owner"] = MECHANIC
    assert (
        client.put("/api/avatars/heads/engine", headers=admin_headers, json=body).status_code == 200
    )
    dressed = client.put(
        f"/api/avatars/members/{MECHANIC}",
        headers=admin_headers,
        json={"colors": COLORS, "back": "engine"},
    )
    assert dressed.status_code == 200
    return user_headers


@pytest.fixture
def visitor(auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers("3003", "visitor")


def start(client: TestClient, headers: dict[str, str], raw: bytes, **extra: Any) -> Any:
    body = {
        "name": "Small-block V8",
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "parts": 26,
        "size": [2.0, 1.5, 3.0],
        **extra,
    }
    return client.post("/api/lobby/machines/blueprints", headers=headers, json=body)


def uploaded(client: TestClient, headers: dict[str, str], raw: bytes | None = None) -> str:
    """A blueprint uploaded whole; its id."""
    raw = raw if raw is not None else glb()
    started = start(client, headers, raw)
    assert started.status_code == 200, started.json()
    upload = started.json()
    for n in range(upload["chunks"]):
        piece = raw[n * upload["chunkBytes"] : (n + 1) * upload["chunkBytes"]]
        put = client.put(
            f"/api/lobby/machines/blueprints/{upload['id']}/chunks/{n}",
            headers=headers,
            json={"data": b64(piece)},
        )
        assert put.status_code == 204, put.json()
    done = client.post(f"/api/lobby/machines/blueprints/{upload['id']}/finish", headers=headers)
    assert done.status_code == 200, done.json()
    blueprint_id: str = done.json()["id"]
    return blueprint_id


def build(client: TestClient, headers: dict[str, str], blueprint: str, **at: Any) -> Any:
    body = {"blueprint": blueprint, "x": 0.0, "z": 0.0, "turn": 0, "scale": 1.0, **at}
    return client.post("/api/lobby/machines", headers=headers, json=body)


def test_me_says_who_the_mechanic_is(
    client: TestClient, mechanic: dict[str, str], visitor: dict[str, str]
) -> None:
    assert client.get("/api/lobby/machines/me", headers=mechanic).json() == {
        "memberId": MECHANIC,
        "mechanic": True,
        "canStandIn": False,
        "standIn": False,
    }
    assert client.get("/api/lobby/machines/me", headers=visitor).json()["mechanic"] is False
    assert client.get("/api/lobby/machines/me").status_code == 401


def test_a_machine_emitter_is_for_the_back_only(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    body = {"name": "hat", "fit": "accessory", "data": b64(glb()), "placement": ENGINE_BACK}
    refused = client.put("/api/avatars/heads/hat", headers=admin_headers, json=body)
    assert refused.status_code == 400
    assert refused.json()["error"] == "emitter_back_only"


def test_the_mechanic_uploads_a_blueprint_in_chunks(
    client: TestClient, mechanic: dict[str, str]
) -> None:
    raw = glb(pad=MACHINE_CHUNK_BYTES + 100)
    blueprint_id = uploaded(client, mechanic, raw)
    library = client.get("/api/lobby/machines/blueprints").json()["blueprints"]
    assert [b["id"] for b in library] == [blueprint_id]
    entry = library[0]
    assert entry["name"] == "Small-block V8" and entry["parts"] == 26
    assert entry["bytes"] == len(raw) and entry["size"] == [2.0, 1.5, 3.0]
    assert entry["uploadedBy"] == MECHANIC
    first = client.get(f"/api/lobby/machines/assets/{entry['sha256']}/0")
    second = client.get(f"/api/lobby/machines/assets/{entry['sha256']}/1")
    assert first.status_code == 200 and second.status_code == 200
    assert first.content + second.content == raw
    assert len(first.content) == MACHINE_CHUNK_BYTES
    assert first.headers["content-type"] == "application/octet-stream"
    assert "immutable" in first.headers["cache-control"]
    past = client.get(f"/api/lobby/machines/assets/{entry['sha256']}/2")
    assert past.status_code == 404


def test_an_upload_is_checked_chunk_by_chunk_and_whole(
    client: TestClient, mechanic: dict[str, str], visitor: dict[str, str]
) -> None:
    raw = glb()
    upload = start(client, mechanic, raw).json()
    base = f"/api/lobby/machines/blueprints/{upload['id']}"
    # Finishing before the chunks are in says which are missing.
    early = client.post(f"{base}/finish", headers=mechanic)
    assert early.status_code == 409 and early.json() == {
        "error": "upload_incomplete",
        "missing": [0],
    }
    # A chunk of the wrong length, out of range, or someone else's upload.
    short = client.put(f"{base}/chunks/0", headers=mechanic, json={"data": b64(raw[:-4])})
    assert short.status_code == 400 and short.json()["reason"] == "length"
    over = client.put(f"{base}/chunks/1", headers=mechanic, json={"data": b64(raw)})
    assert over.status_code == 400 and over.json()["reason"] == "range"
    theirs = client.put(f"{base}/chunks/0", headers=visitor, json={"data": b64(raw)})
    assert theirs.status_code == 403
    # A file that isn't what was promised.
    other = bytearray(raw)
    other[-1:] = b"\t"
    client.put(f"{base}/chunks/0", headers=mechanic, json={"data": b64(bytes(other))})
    wrong = client.post(f"{base}/finish", headers=mechanic)
    assert wrong.status_code == 400 and wrong.json()["reason"] == "sha256"
    # Not a model at all.
    junk = b"not a glb file at all"
    bad = start(client, mechanic, junk).json()
    client.put(
        f"/api/lobby/machines/blueprints/{bad['id']}/chunks/0",
        headers=mechanic,
        json={"data": b64(junk)},
    )
    refused = client.post(f"/api/lobby/machines/blueprints/{bad['id']}/finish", headers=mechanic)
    assert refused.status_code == 400 and refused.json()["reason"] == "not_glb"
    assert client.get("/api/lobby/machines/blueprints").json()["blueprints"] == []
    # Unknown uploads.
    assert (
        client.post(
            "/api/lobby/machines/blueprints/abcdefabcdef/finish", headers=mechanic
        ).status_code
        == 404
    )
    assert (
        client.post("/api/lobby/machines/blueprints/nope/finish", headers=mechanic).status_code
        == 404
    )


def test_only_the_mechanic_uploads_builds_and_takes_down(
    client: TestClient, mechanic: dict[str, str], visitor: dict[str, str]
) -> None:
    assert start(client, visitor, glb()).status_code == 403
    blueprint_id = uploaded(client, mechanic)
    refused = build(client, visitor, blueprint_id)
    assert refused.status_code == 403 and refused.json()["error"] == "not_the_mechanic"
    made = build(client, mechanic, blueprint_id).json()
    assert (
        client.delete(f"/api/lobby/machines/{made['machine']['id']}", headers=visitor).status_code
        == 403
    )
    assert (
        client.delete(f"/api/lobby/machines/blueprints/{blueprint_id}", headers=visitor).status_code
        == 403
    )


def test_the_mechanic_builds_a_machine_and_everyone_sees_it(
    client: TestClient, mechanic: dict[str, str], clock: FakeClock
) -> None:
    blueprint_id = uploaded(client, mechanic)
    made = build(client, mechanic, blueprint_id, x=2.5, z=-1.25, turn=3, scale=1.5)
    assert made.status_code == 200, made.json()
    machine = made.json()["machine"]
    assert made.json()["rev"] == 1
    assert machine | {"id": "", "builtAt": "", "updatedAt": "", "sha256": ""} == {
        "id": "",
        "blueprint": blueprint_id,
        "name": "Small-block V8",
        "sha256": "",
        "bytes": len(glb()),
        "parts": 26,
        "size": [2.0, 1.5, 3.0],
        "x": 2.5,
        "z": -1.25,
        "turn": 3,
        "scale": 1.5,
        "builtBy": MECHANIC,
        "builtAt": "",
        "updatedAt": "",
    }
    listed = client.get("/api/lobby/machines").json()
    assert listed["full"] is True and listed["rev"] == 1 and listed["gone"] == []
    assert [m["id"] for m in listed["machines"]] == [machine["id"]]
    assert listed["now"] == clock().isoformat()
    # Nothing new since revision 1.
    since = client.get("/api/lobby/machines?since=1").json()
    assert since == {"rev": 1, "full": False, "machines": [], "gone": [], "now": listed["now"]}


def test_a_machine_must_fit(
    client: TestClient, mechanic: dict[str, str], admin_headers: dict[str, str]
) -> None:
    blueprint_id = uploaded(client, mechanic)
    outside = build(client, mechanic, blueprint_id, x=23.9)
    assert outside.status_code == 409 and outside.json() == {
        "error": "wont_fit",
        "problem": "outside",
    }
    assert build(client, mechanic, blueprint_id).status_code == 200
    overlap = build(client, mechanic, blueprint_id, x=0.5)
    assert overlap.json() == {"error": "wont_fit", "problem": "overlap"}
    # Side by side (the first is 0.8 m wide at scale 1) fits.
    assert build(client, mechanic, blueprint_id, x=0.8).status_code == 200
    # Over a brick.
    client.put("/api/lobby/bricks/me/stand-in", headers=admin_headers, json={"on": True})
    brick = client.post(
        "/api/lobby/bricks",
        headers=admin_headers,
        json={"shape": "brick-1x1", "color": "red", "at": {"x": 20, "y": 0, "z": 0, "rot": 0}},
    )
    assert brick.status_code == 200, brick.json()
    on_brick = build(client, mechanic, blueprint_id, x=4.1)
    assert on_brick.json() == {"error": "wont_fit", "problem": "bricks"}
    # A deleted or unknown blueprint can't be built.
    assert build(client, mechanic, "abcdefabcdef").json()["error"] == "blueprint_not_found"


def test_the_cave_holds_only_so_many_machines(
    client: TestClient, mechanic: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rules, "LIMIT", 1)
    blueprint_id = uploaded(client, mechanic)
    assert build(client, mechanic, blueprint_id).status_code == 200
    full = build(client, mechanic, blueprint_id, x=5.0)
    assert full.status_code == 409 and full.json() == {"error": "machine_limit", "limit": 1}


def test_taking_a_machine_down_leaves_a_tombstone_for_a_day(
    client: TestClient, mechanic: dict[str, str], clock: FakeClock
) -> None:
    blueprint_id = uploaded(client, mechanic)
    machine_id = build(client, mechanic, blueprint_id).json()["machine"]["id"]
    down = client.delete(f"/api/lobby/machines/{machine_id}", headers=mechanic)
    assert down.status_code == 200 and down.json() == {"rev": 2}
    assert client.delete(f"/api/lobby/machines/{machine_id}", headers=mechanic).status_code == 404
    assert client.delete("/api/lobby/machines/nope", headers=mechanic).status_code == 404
    delta = client.get("/api/lobby/machines?since=1").json()
    assert delta["full"] is False and delta["gone"] == [machine_id] and delta["machines"] == []
    clock.advance(2 * 86400)
    later = client.get("/api/lobby/machines?since=1").json()
    assert later["full"] is True and later["machines"] == []


def test_deleting_a_blueprint_keeps_what_was_built_from_it(
    client: TestClient, mechanic: dict[str, str]
) -> None:
    blueprint_id = uploaded(client, mechanic)
    sha = client.get("/api/lobby/machines/blueprints").json()["blueprints"][0]["sha256"]
    machine_id = build(client, mechanic, blueprint_id).json()["machine"]["id"]
    gone = client.delete(f"/api/lobby/machines/blueprints/{blueprint_id}", headers=mechanic)
    assert gone.status_code == 204
    assert client.get("/api/lobby/machines/blueprints").json()["blueprints"] == []
    assert (
        client.delete(
            f"/api/lobby/machines/blueprints/{blueprint_id}", headers=mechanic
        ).status_code
        == 404
    )
    # The machine still stands, with its file.
    assert [m["id"] for m in client.get("/api/lobby/machines").json()["machines"]] == [machine_id]
    assert client.get(f"/api/lobby/machines/assets/{sha}/0").status_code == 200
    # Once it's taken down, nothing needs the file.
    client.delete(f"/api/lobby/machines/{machine_id}", headers=mechanic)
    assert client.get(f"/api/lobby/machines/assets/{sha}/0").status_code == 404
    assert client.get("/api/lobby/machines/assets/xyz/0").status_code == 404


def test_an_unfinished_upload_is_dropped(
    client: TestClient, mechanic: dict[str, str], clock: FakeClock
) -> None:
    upload = start(client, mechanic, glb()).json()
    # Deleted by hand…
    assert (
        client.delete(
            f"/api/lobby/machines/blueprints/{upload['id']}", headers=mechanic
        ).status_code
        == 204
    )
    # …or left an hour.
    stale = start(client, mechanic, glb()).json()
    clock.advance(2 * 3600)
    client.get("/api/lobby/machines")
    assert (
        client.post(
            f"/api/lobby/machines/blueprints/{stale['id']}/finish", headers=mechanic
        ).status_code
        == 404
    )


def test_an_admin_stands_in_as_the_mechanic_one_role_at_a_time(
    client: TestClient, admin_headers: dict[str, str], user_headers: dict[str, str]
) -> None:
    assert (
        client.put(
            "/api/lobby/machines/me/stand-in", headers=user_headers, json={"on": True}
        ).status_code
        == 403
    )
    client.put("/api/lobby/bricks/me/stand-in", headers=admin_headers, json={"on": True})
    on = client.put("/api/lobby/machines/me/stand-in", headers=admin_headers, json={"on": True})
    assert on.json()["mechanic"] is True and on.json()["standIn"] is True
    # Being the mechanic stopped being the Lego bot…
    bricks = client.get("/api/lobby/bricks/me", headers=admin_headers).json()
    assert bricks["standIn"] is False
    # …and being the Lego bot again stops being the mechanic.
    client.put("/api/lobby/bricks/me/stand-in", headers=admin_headers, json={"on": True})
    me = client.get("/api/lobby/machines/me", headers=admin_headers).json()
    assert me["standIn"] is False and me["mechanic"] is False
    client.put("/api/lobby/machines/me/stand-in", headers=admin_headers, json={"on": True})
    off = client.put("/api/lobby/machines/me/stand-in", headers=admin_headers, json={"on": False})
    assert off.json()["mechanic"] is False


def test_machines_are_off_with_the_lobby(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": False}))
    assert client.get("/api/lobby/machines").json() == {"error": "lobby-disabled"}


# The rules, held to the same answers as @forge/lobby's machine.ts (machine.test.ts).


def test_the_rules_mirror_the_lobby() -> None:
    spot = rules.Spot((2.0, 1.5, 3.0), 1.0, -2.0, 0, 1.0)
    assert rules.extent(spot.size, 1.0) == pytest.approx((0.8, 0.6, 1.2))
    box = rules.footprint(spot)
    assert (box.min_x, box.max_x, box.min_z, box.max_z) == pytest.approx((0.6, 1.4, -2.6, -1.4))
    # A quarter turn (6 steps) swaps width and depth; 3 steps (45 degrees) widens both.
    turned = rules.footprint(rules.Spot((2.0, 1.5, 3.0), 0.0, 0.0, 6, 1.0))
    assert (turned.max_x, turned.max_z) == pytest.approx((0.6, 0.4))
    slanted = rules.footprint(rules.Spot((2.0, 1.5, 3.0), 0.0, 0.0, 3, 1.0))
    assert slanted.max_x == pytest.approx(0.70710678)
    assert rules.problem(spot, [], []) is None
    assert rules.problem(rules.Spot((1.0, 1.0, 1.0), 23.5, 0.0, 0, 1.0), [], []) == "outside"
    touching = rules.Spot((2.0, 1.5, 3.0), 1.8, -2.0, 0, 1.0)
    assert rules.problem(touching, [spot], []) is None
    assert rules.problem(spot, [spot], []) == "overlap"
    brick = brick_rules.At("brick-1x1", 5, 0, -10, 0)
    assert rules.problem(spot, [], [brick]) == "bricks"
    assert machines_service.FLAG == "apps_lobby"
