"""Building bricks in the lobby: only the brick maker (the robot wearing a back model
that makes bricks) makes and takes away bricks; anyone signed in picks up a loose brick
and places it; a brick something is fastened to is frozen for all but the maker; holds
lapse; every change bumps the revision, and deltas say what changed."""

import base64
import json
import re
import struct
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.models import BRICK_COLOR_IDS, BRICK_SHAPE_IDS
from forge_api.services import brick_rules as rules
from forge_api.services import members as members_service
from forge_api.services.state import get_state_db

from .conftest import AuthHeaders, FakeClock

MAKER = "gh:1001"
COLORS = {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}
BACKPACK: dict[str, Any] = {"scale": 0.5, "offset": [0.0, 0.0, -0.1], "emitter": "bricks"}


@pytest.fixture(autouse=True)
def lobby_on(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> Iterator[None]:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": True, "lobby_avatars": True}))
    app.dependency_overrides[members_service.current_time] = clock
    yield


def glb() -> bytes:
    text = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": "Pack"}]}).encode()
    text += b" " * (-len(text) % 4)
    length = 12 + 8 + len(text)
    return (
        b"glTF" + struct.pack("<II", 2, length) + struct.pack("<II", len(text), 0x4E4F534A) + text
    )


def upload(
    client: TestClient, headers: dict[str, str], head_id: str, fit: str, **extra: Any
) -> Any:
    body = {"name": head_id, "fit": fit, "data": base64.b64encode(glb()).decode(), **extra}
    return client.put(f"/api/avatars/heads/{head_id}", headers=headers, json=body)


@pytest.fixture
def maker(client: TestClient, admin_headers: dict[str, str], user_headers: dict[str, str]) -> Any:
    """The contributor (gh:1001) wears the brick-making backpack; their headers."""
    packed = upload(client, admin_headers, "pack", "back", placement=BACKPACK, owner=MAKER)
    assert packed.status_code == 200
    dressed = client.put(
        f"/api/avatars/members/{MAKER}",
        headers=admin_headers,
        json={"colors": COLORS, "back": "pack"},
    )
    assert dressed.status_code == 200
    return user_headers


@pytest.fixture
def visitor(auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers("3003", "visitor")


def make(client: TestClient, headers: dict[str, str], shape: str = "brick-2x4") -> Any:
    return client.post("/api/lobby/bricks", headers=headers, json={"shape": shape, "color": "red"})


def place(client: TestClient, headers: dict[str, str], brick_id: str, **at: int) -> Any:
    body = {"x": 0, "y": 0, "z": 0, "rot": 0, **at}
    return client.put(f"/api/lobby/bricks/{brick_id}/place", headers=headers, json=body)


def pick(client: TestClient, headers: dict[str, str], brick_id: str) -> Any:
    return client.put(f"/api/lobby/bricks/{brick_id}/pick", headers=headers)


def built(client: TestClient, headers: dict[str, str], **at: int) -> str:
    """A brick the maker made and placed; its id."""
    made = make(client, headers)
    assert made.status_code == 200, made.json()
    brick_id: str = made.json()["brick"]["id"]
    assert place(client, headers, brick_id, **at).status_code == 200
    return brick_id


def everything(client: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = client.get("/api/lobby/bricks").json()
    return body


def test_the_maker_makes_a_brick_into_their_hand_and_places_it(
    client: TestClient, maker: dict[str, str]
) -> None:
    made = make(client, maker)
    assert made.status_code == 200
    brick = made.json()["brick"]
    assert brick["holder"] == MAKER and brick["shape"] == "brick-2x4"
    assert made.json()["rev"] == 1
    placed = place(client, maker, brick["id"], x=3, z=-2, rot=1)
    assert placed.status_code == 200
    assert placed.json()["rev"] == 2
    assert "holder" not in placed.json()["brick"]
    listed = everything(client)
    assert listed["full"] is True and listed["rev"] == 2 and listed["gone"] == []
    assert listed["bricks"][0] | {"updatedAt": ""} == {
        "id": brick["id"],
        "shape": "brick-2x4",
        "color": "red",
        "x": 3,
        "y": 0,
        "z": -2,
        "rot": 1,
        "updatedAt": "",
    }


def test_me_says_who_makes_bricks(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str]
) -> None:
    assert client.get("/api/lobby/bricks/me", headers=maker).json() == {
        "memberId": MAKER,
        "maker": True,
        "canStandIn": False,
        "standIn": False,
    }
    assert client.get("/api/lobby/bricks/me", headers=visitor).json() == {
        "memberId": "gh:3003",
        "maker": False,
        "canStandIn": False,
        "standIn": False,
    }
    assert client.get("/api/lobby/bricks/me").status_code == 401


def test_only_the_maker_makes_or_takes_away(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str]
) -> None:
    assert make(client, visitor).json() == {"error": "not_the_maker"}
    assert make(client, visitor).status_code == 403
    brick_id = built(client, maker)
    gone = client.delete(f"/api/lobby/bricks/{brick_id}", headers=visitor)
    assert gone.status_code == 403
    removed = client.delete(f"/api/lobby/bricks/{brick_id}", headers=maker)
    assert removed.status_code == 200 and "brick" not in removed.json()
    assert everything(client)["bricks"] == []
    assert client.delete(f"/api/lobby/bricks/{brick_id}", headers=maker).status_code == 404


def test_signed_out_callers_only_look(client: TestClient, maker: dict[str, str]) -> None:
    brick_id = built(client, maker)
    assert client.get("/api/lobby/bricks").status_code == 200
    assert (
        client.post("/api/lobby/bricks", json={"shape": "brick-1x1", "color": "red"}).status_code
        == 401
    )
    assert client.put(f"/api/lobby/bricks/{brick_id}/pick").status_code == 401


def test_anyone_picks_up_a_loose_brick_and_builds_on_another(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str]
) -> None:
    base = built(client, maker)
    loose = built(client, maker, x=10)
    picked = pick(client, visitor, loose)
    assert picked.status_code == 200 and picked.json()["brick"]["holder"] == "gh:3003"
    # Its old spot is kept while it's held.
    assert picked.json()["brick"]["x"] == 10
    stacked = place(client, visitor, loose, y=3)
    assert stacked.status_code == 200 and stacked.json()["brick"]["y"] == 3
    # Fastened together, both are part of the build now.
    assert pick(client, visitor, base).json() == {"error": "frozen"}
    assert pick(client, visitor, loose).json() == {"error": "frozen"}
    # The maker can still pull one out.
    assert pick(client, maker, loose).status_code == 200


def test_two_hands_one_brick(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str], auth_headers: AuthHeaders
) -> None:
    loose = built(client, maker)
    assert pick(client, visitor, loose).status_code == 200
    # Picking it again is a no-op; someone else gets turned away.
    assert pick(client, visitor, loose).status_code == 200
    late = pick(client, auth_headers("4004", "late"), loose)
    assert late.status_code == 409 and late.json() == {"error": "taken"}
    assert place(client, maker, loose).json() == {"error": "not_holding"}


def test_one_brick_in_hand_at_a_time(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str]
) -> None:
    first = built(client, maker)
    second = built(client, maker, x=10)
    assert pick(client, visitor, first).status_code == 200
    full = pick(client, visitor, second)
    assert full.status_code == 409 and full.json() == {"error": "hands_full", "brick": first}
    assert make(client, maker).status_code == 200
    assert make(client, maker).json()["error"] == "hands_full"


def test_a_brick_must_fit(client: TestClient, maker: dict[str, str]) -> None:
    built(client, maker)
    held = make(client, maker).json()["brick"]["id"]
    for at, problem in (
        ({"x": 1}, "overlap"),
        ({"x": 20, "y": 6}, "floating"),
        ({"x": 200}, "outside"),
        ({"y": rules.MAX_PLATES}, "outside"),
    ):
        refused = place(client, maker, held, **at)
        assert refused.status_code == 409
        assert refused.json() == {"error": "wont_fit", "problem": problem}
    bad = place(client, maker, held, rot=4)
    assert bad.status_code in (400, 422)


def test_unknown_bricks_and_bad_bodies(client: TestClient, maker: dict[str, str]) -> None:
    assert pick(client, maker, "nope").status_code == 404
    assert pick(client, maker, "0123456789ab").status_code == 404
    odd = client.post(
        "/api/lobby/bricks", headers=maker, json={"shape": "brick-9x9", "color": "red"}
    )
    assert odd.status_code in (400, 422)
    assert client.get("/api/lobby/bricks?since=-1").status_code in (400, 422)


def test_deltas_say_what_changed_since_a_revision(
    client: TestClient, maker: dict[str, str]
) -> None:
    first = built(client, maker)
    rev = everything(client)["rev"]
    second = built(client, maker, x=10)
    client.delete(f"/api/lobby/bricks/{first}", headers=maker)
    delta = client.get(f"/api/lobby/bricks?since={rev}").json()
    assert delta["full"] is False
    assert [b["id"] for b in delta["bricks"]] == [second]
    assert delta["gone"] == [first]
    assert delta["rev"] == rev + 3
    # Caught up: nothing new. From the future (a reset cave): everything.
    assert client.get(f"/api/lobby/bricks?since={delta['rev']}").json()["bricks"] == []
    assert client.get("/api/lobby/bricks?since=999").json()["full"] is True


def test_old_tombstones_are_forgotten_and_old_deltas_get_everything(
    client: TestClient, maker: dict[str, str], clock: FakeClock
) -> None:
    first = built(client, maker)
    client.delete(f"/api/lobby/bricks/{first}", headers=maker)
    clock.advance(2 * 86400)
    second = built(client, maker)
    stale = client.get("/api/lobby/bricks?since=1").json()
    assert stale["full"] is True and [b["id"] for b in stale["bricks"]] == [second]
    rows = get_state_db().query_all("SELECT id FROM lobby_bricks")
    assert [r["id"] for r in rows] == [second]


def test_a_lapsed_hold_goes_back_or_away(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str], clock: FakeClock
) -> None:
    home = built(client, maker, x=5)
    assert pick(client, visitor, home).status_code == 200
    fresh = make(client, maker).json()["brick"]["id"]
    clock.advance(6 * 60)
    listed = everything(client)
    assert [(b["id"], b["x"], "holder" in b) for b in listed["bricks"]] == [(home, 5, False)]
    assert fresh not in [b["id"] for b in listed["bricks"]]


def test_a_lapsed_hold_whose_spot_was_taken_lands_nearby(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str], clock: FakeClock
) -> None:
    home = built(client, maker, x=5)
    assert pick(client, visitor, home).status_code == 200
    built(client, maker, x=5)
    clock.advance(6 * 60)
    back = next(b for b in everything(client)["bricks"] if b["id"] == home)
    assert back["y"] == 0 and (back["x"], back["z"]) != (5, 0)


def test_a_lapsed_hold_with_nowhere_to_go_is_taken_away(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str], clock: FakeClock
) -> None:
    home = built(client, maker, x=5)
    assert pick(client, visitor, home).status_code == 200
    # Fill its spot and every floor spot around it.
    db = get_state_db()
    with db.transaction():
        for x in range(-20, 30):
            for z in range(-20, 20):
                db.execute(
                    "INSERT INTO lobby_bricks (id, shape, color, x, y, z, rot, holder, held_at, "
                    "has_home, gone, rev, updated_at) VALUES (?, 'brick-1x1', 'red', ?, 0, ?, 0, "
                    "NULL, NULL, 1, 0, 1, '2026-08-10T09:00:00.000000Z')",
                    (f"{(x + 50) * 100 + z + 50:012x}", x, z),
                )
    clock.advance(6 * 60)
    assert home not in [b["id"] for b in everything(client)["bricks"]]


def test_the_cave_holds_only_so_many(
    client: TestClient, maker: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rules, "LIMIT", 1)
    built(client, maker)
    full = make(client, maker)
    assert full.status_code == 409 and full.json() == {"error": "brick_limit", "limit": 1}


def test_off_with_the_lobby(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps({"apps_lobby": False}))
    off = client.get("/api/lobby/bricks")
    assert off.status_code == 404 and off.json() == {"error": "lobby-disabled"}


def test_only_a_back_model_makes_anything(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    refused = upload(client, admin_headers, "mask", "replace", placement=BACKPACK)
    assert refused.status_code == 400 and refused.json()["error"] == "emitter_back_only"
    assert upload(client, admin_headers, "mask", "replace").status_code == 200
    refit = client.put(
        "/api/avatars/heads/mask/placement", headers=admin_headers, json={"placement": BACKPACK}
    )
    assert refit.status_code == 400
    assert (
        client.put(
            "/api/avatars/heads/nope/placement", headers=admin_headers, json={"placement": BACKPACK}
        ).status_code
        == 404
    )


def test_the_emitter_is_kept_with_the_fit_and_goes_with_the_model(
    client: TestClient, maker: dict[str, str], admin_headers: dict[str, str]
) -> None:
    heads = client.get("/api/avatars").json()["heads"]
    assert heads[0]["placement"]["emitter"] == "bricks"
    assert make(client, maker).status_code == 200
    # Refit without it: no longer the maker.
    plain = {k: v for k, v in BACKPACK.items() if k != "emitter"}
    client.put(
        "/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": plain}
    )
    assert get_state_db().query_all("SELECT * FROM avatars_head_emitters") == []
    client.put(
        "/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": BACKPACK}
    )
    assert client.delete("/api/avatars/heads/pack", headers=admin_headers).status_code == 204
    assert get_state_db().query_all("SELECT * FROM avatars_head_emitters") == []


def test_rules_mirror_the_lobby() -> None:
    """The same answers as @forge/lobby's bricks.test.ts for the same bricks."""
    at = rules.At
    base = at("brick-2x4", 0, 0, 0, 0)
    assert sorted(rules.cells(at("brick-1x2", 0, 0, 0, 1))) == [(0, 0), (0, 1)]
    for rot in range(4):
        assert len(rules.cells(at("brick-2x4", 5, 0, 5, rot))) == 8
        assert len(rules.studs(at("slope-2x2", 0, 0, 0, rot))) == 2
    assert rules.cells(at("nope", 0, 0, 0, 0)) == [] and rules.height(at("nope", 0, 0, 0, 0)) == 0
    assert rules.connected(base, at("brick-1x1", 3, 3, 1, 0))
    assert rules.connected(at("brick-1x1", 3, 3, 1, 0), base)
    assert not rules.connected(base, at("brick-1x1", 4, 3, 1, 0))
    assert not rules.connected(at("slope-2x2", 0, 0, 0, 0), at("brick-1x1", 0, 3, 1, 0))
    assert rules.problem(at("plate-2x2", 0, 2, 0, 0), [at("brick-2x2", 0, 3, 0, 0)]) is None
    assert rules.problem(at("nope", 0, 0, 0, 0), []) == "shape"
    assert rules.problem(at("brick-1x1", 0, -1, 0, 0), []) == "outside"
    top = at("brick-2x2", 0, 3, 0, 0)
    assert rules.frozen(base, [base, top]) and not rules.frozen(base, [base])
    assert rules.floor_spot("brick-1x1", 0, 999, 999, []) is None


def test_shapes_and_colours_match_the_lobby_and_the_contract() -> None:
    """The same shapes (sizes included) and colours as @forge/lobby and @forge/shared."""
    root = Path(__file__).resolve().parents[3]
    lobby = (root / "packages/lobby/src/bricks.ts").read_text()
    shared = (root / "packages/shared/src/index.ts").read_text()
    shapes = re.findall(
        r"\{ id: '([a-z0-9-]+)', label: '[^']+', sx: (\d), sz: (\d), h: (\d)", lobby
    )
    assert [s[0] for s in shapes] == list(BRICK_SHAPE_IDS) == list(rules.SHAPES)
    for name, sx, sz, h in shapes:
        shape = rules.SHAPES[name]
        assert (shape.sx, shape.sz, shape.h) == (int(sx), int(sz), int(h))
        assert shape.slope == name.startswith("slope")
    colours = re.findall(r"\{ id: '([a-z]+)', label: '[^']+', hex:", lobby)
    assert colours == list(BRICK_COLOR_IDS)
    for listed in (BRICK_SHAPE_IDS, BRICK_COLOR_IDS):
        for name in listed:
            assert f"'{name}'" in shared
    assert f"stud: {rules.STUD}," in lobby and f"limit: {rules.LIMIT}," in lobby
    assert f"radius: {int(rules.RADIUS)}," in lobby and f"maxPlates: {rules.MAX_PLATES}," in lobby


def stand_in(client: TestClient, headers: dict[str, str], on: bool) -> Any:
    return client.put("/api/lobby/bricks/me/stand-in", headers=headers, json={"on": on})


def test_an_admin_can_be_the_lego_bot_to_test_and_stop(
    client: TestClient,
    maker: dict[str, str],
    admin_headers: dict[str, str],
    visitor: dict[str, str],
) -> None:
    admin = admin_headers
    assert client.get("/api/lobby/bricks/me", headers=admin).json() == {
        "memberId": "gh:1002",
        "maker": False,
        "canStandIn": True,
        "standIn": False,
    }
    assert make(client, admin).json() == {"error": "not_the_maker"}
    # A brick of the real Lego bot's, built on: frozen for the admin until they take over.
    base = built(client, maker)
    top = built(client, maker, y=3)
    assert pick(client, admin, top).json() == {"error": "frozen"}

    on = stand_in(client, admin, True)
    assert on.status_code == 200 and on.json()["maker"] is True and on.json()["standIn"] is True
    # Twice is the same as once.
    assert stand_in(client, admin, True).json()["standIn"] is True
    assert pick(client, admin, top).status_code == 200
    assert client.delete(f"/api/lobby/bricks/{top}", headers=admin).status_code == 200
    made = make(client, admin)
    assert made.status_code == 200 and made.json()["brick"]["holder"] == "gh:1002"
    # The real Lego bot still is one.
    assert client.get("/api/lobby/bricks/me", headers=maker).json()["maker"] is True
    assert client.delete(f"/api/lobby/bricks/{base}", headers=maker).status_code == 200

    off = stand_in(client, admin, False)
    assert off.json() == {
        "memberId": "gh:1002",
        "maker": False,
        "canStandIn": True,
        "standIn": False,
    }
    assert client.delete(
        f"/api/lobby/bricks/{made.json()['brick']['id']}", headers=admin
    ).json() == {"error": "not_the_maker"}

    refused = stand_in(client, visitor, True)
    assert refused.status_code == 403 and refused.json() == {"error": "admin_only"}
    assert client.put("/api/lobby/bricks/me/stand-in", json={"on": True}).status_code == 401
    assert client.put(
        "/api/lobby/bricks/me/stand-in", headers=admin, json={"on": "yes"}
    ).status_code in (400, 422)


def test_no_longer_an_admin_no_longer_the_lego_bot(
    client: TestClient,
    admin_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert stand_in(client, admin_headers, True).json()["maker"] is True
    monkeypatch.setenv("FORGE_ADMIN_IDS", "999")
    assert client.get("/api/lobby/bricks/me", headers=admin_headers).json() == {
        "memberId": "gh:1002",
        "maker": False,
        "canStandIn": False,
        "standIn": False,
    }
    assert make(client, admin_headers).json() == {"error": "not_the_maker"}


def piece(shape: str, x: int, y: int, z: int, rot: int = 0, color: str = "blue") -> dict[str, Any]:
    return {"shape": shape, "color": color, "x": x, "y": y, "z": z, "rot": rot}


def build(client: TestClient, headers: dict[str, str], *pieces: dict[str, Any]) -> Any:
    return client.post(
        "/api/lobby/bricks/build", headers=headers, json={"name": "Tower", "bricks": list(pieces)}
    )


TOWER = (
    piece("brick-2x4", 10, 0, 10),
    piece("brick-2x2", 11, 3, 10),
    piece("plate-2x2", 11, 6, 10),
)


def test_the_maker_builds_a_blueprint_all_at_once(
    client: TestClient, maker: dict[str, str]
) -> None:
    rev = everything(client)["rev"]
    built = build(client, maker, *TOWER)
    assert built.status_code == 200
    answer = built.json()
    assert answer == {"rev": rev + 1, "built": 3, "build": answer["build"]}
    assert re.fullmatch(r"[0-9a-f]{12}", answer["build"])
    listed = everything(client)
    assert len(listed["bricks"]) == 3 and all("holder" not in b for b in listed["bricks"])
    # Every brick of it says which build it came from.
    assert {b["build"] for b in listed["bricks"]} == {answer["build"]}
    assert {b["shape"] for b in listed["bricks"]} == {"brick-2x4", "brick-2x2", "plate-2x2"}
    # One delta brings every brick of it.
    assert len(client.get(f"/api/lobby/bricks?since={rev}").json()["bricks"]) == 3
    # Built on: the build's bricks are frozen like any build's.
    top = next(b for b in listed["bricks"] if b["shape"] == "plate-2x2")
    assert pick(client, maker, top["id"]).status_code == 200


def test_a_build_fits_whole_or_not_at_all(client: TestClient, maker: dict[str, str]) -> None:
    built(client, maker, x=10, z=10)
    clash = build(client, maker, *TOWER)
    assert clash.status_code == 409
    assert clash.json() == {"error": "wont_fit", "problem": "overlap", "index": 0}
    far = build(client, maker, piece("brick-1x1", 200, 0, 0))
    assert far.json()["problem"] == "outside"
    # Nothing of a refused build was built.
    assert len(everything(client)["bricks"]) == 1
    # A blueprint needs no support: bricks in the air (their support a part we skip) are built.
    island = build(client, maker, piece("brick-2x2", 0, 6, 0), piece("brick-1x1", 0, 9, 0))
    assert island.status_code == 200 and island.json()["built"] == 2
    # Resting on a placed brick is fine.
    assert build(client, maker, piece("brick-2x2", 10, 3, 10)).status_code == 200


def test_a_whole_build_comes_down_at_once(
    client: TestClient, maker: dict[str, str], visitor: dict[str, str]
) -> None:
    by_hand = built(client, maker, x=-20, z=-20)
    assert "build" not in everything(client)["bricks"][0]
    first = build(client, maker, *TOWER).json()["build"]
    second = build(client, maker, piece("brick-1x1", -10, 0, -10)).json()["build"]
    # A brick of it moved away, or in someone's hand, still goes with it.
    tower = [b for b in everything(client)["bricks"] if b.get("build") == first]
    top = next(b for b in tower if b["shape"] == "plate-2x2")
    assert pick(client, maker, top["id"]).status_code == 200
    assert place(client, maker, top["id"], x=15, y=0, z=15).status_code == 200
    held = next(b for b in tower if b["shape"] == "brick-2x2")
    assert pick(client, maker, held["id"]).status_code == 200
    rev = everything(client)["rev"]
    assert client.delete(f"/api/lobby/bricks/builds/{first}", headers=visitor).status_code == 403
    gone = client.delete(f"/api/lobby/bricks/builds/{first}", headers=maker)
    assert gone.status_code == 200
    assert gone.json() == {"rev": rev + 1, "removed": 3}
    left = {b["id"] for b in everything(client)["bricks"]}
    assert by_hand in left and len(left) == 2
    # One delta says all of it went.
    delta = client.get(f"/api/lobby/bricks?since={rev}").json()
    assert sorted(delta["gone"]) == sorted(b["id"] for b in tower) and delta["bricks"] == []
    # Gone already, never built, or not an id.
    for missing in (first, "abcdefabcdef", "nope"):
        nothing = client.delete(f"/api/lobby/bricks/builds/{missing}", headers=maker)
        assert nothing.status_code == 404 and nothing.json() == {"error": "build_not_found"}
    assert client.delete(f"/api/lobby/bricks/builds/{second}", headers=maker).status_code == 200


def test_builds_made_before_builds_were_tagged_still_come_down_whole(
    client: TestClient, maker: dict[str, str], clock: FakeClock
) -> None:
    db = get_state_db()
    by_hand = built(client, maker, x=-20, z=-20)
    build(client, maker, *TOWER)
    build(client, maker, piece("brick-1x1", -10, 0, -10))
    # As the cave was before: no tags, and never tagged.
    db.execute("DELETE FROM lobby_bricks_builds")
    db.execute("DELETE FROM lobby_bricks_meta WHERE key = 'builds_tagged'")
    listed = everything(client)["bricks"]
    tower = {b["build"] for b in listed if b["shape"] != "brick-1x1" and b["id"] != by_hand}
    assert len(tower) == 1
    # A build of one brick, and a brick made by hand, aren't builds.
    assert all("build" not in b for b in listed if b["shape"] == "brick-1x1" or b["id"] == by_hand)
    gone = client.delete(f"/api/lobby/bricks/builds/{tower.pop()}", headers=maker)
    assert gone.json()["removed"] == 3
    # The tags go with the tombstones.
    clock.advance(2 * 86400)
    everything(client)
    assert db.query_all("SELECT * FROM lobby_bricks_builds") == []


def test_only_the_maker_builds_and_within_the_cap(
    client: TestClient,
    maker: dict[str, str],
    visitor: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert build(client, visitor, *TOWER).json() == {"error": "not_the_maker"}
    monkeypatch.setattr(rules, "LIMIT", 2)
    full = build(client, maker, *TOWER)
    assert full.status_code == 409
    assert full.json() == {"error": "brick_limit", "limit": 2, "room": 2}


def test_a_build_is_checked_before_it_is_read(client: TestClient, maker: dict[str, str]) -> None:
    empty = client.post("/api/lobby/bricks/build", headers=maker, json={"name": "x", "bricks": []})
    assert empty.status_code in (400, 422)
    many = [piece("brick-1x1", i % 40, 0, i // 40) for i in range(1001)]
    assert build(client, maker, *many).status_code in (400, 422)
    odd = build(client, maker, {**piece("brick-1x1", 0, 0, 0), "color": "purple"})
    assert odd.status_code in (400, 422)
    huge = client.post(
        "/api/lobby/bricks/build",
        headers={**maker, "content-type": "application/json"},
        content=b'{"name":"x","bricks":[' + b" " * (200 * 1024) + b"]}",
    )
    assert huge.status_code == 413


def test_build_rules_mirror_the_lobby() -> None:
    """The same answers as @forge/lobby's blueprint.test.ts `blueprintProblems`."""
    at = rules.At
    assert rules.blueprint_problems(
        [at("brick-2x4", 0, 0, 0, 0), at("brick-2x2", 1, 3, 0, 0)], []
    ) == [
        None,
        None,
    ]
    bridge = [at("brick-1x1", 0, 0, 0, 0), at("brick-1x4", 0, 3, 0, 0), at("plate-1x2", 2, 2, 0, 0)]
    assert rules.blueprint_problems(bridge, []) == [None, None, None]
    assert rules.blueprint_problems(
        [at("brick-2x2", 0, 0, 0, 0), at("brick-2x2", 1, 0, 1, 0)], []
    ) == ["overlap", "overlap"]
    assert rules.blueprint_problems(
        [at("brick-1x1", 0, 0, 0, 0)], [at("brick-2x2", 0, 0, 0, 0)]
    ) == ["overlap"]
    assert rules.blueprint_problems(
        [at("brick-2x2", 0, 6, 0, 0), at("brick-1x1", 0, 9, 0, 0)], []
    ) == [None, None]
    assert rules.blueprint_problems(
        [at("nope", 0, 0, 0, 0), at("brick-1x1", 500, 0, 0, 0), at("brick-1x1", 0, -3, 0, 0)], []
    ) == ["shape", "outside", "outside"]
    assert rules.blueprint_problems([at("brick-1x1", 0, 0, 0, 7)], []) == ["shape"]
    stacked = [at("brick-2x2", 0, 3, 0, 0), at("brick-1x1", 0, 6, 0, 0)]
    assert rules.blueprint_problems(stacked, [at("brick-2x4", 0, 0, 0, 0)]) == [None, None]


def test_a_made_brick_can_drop_loose_on_the_floor(
    client: TestClient, maker: dict[str, str]
) -> None:
    body = {"shape": "brick-2x4", "color": "red", "at": {"x": 4, "y": 0, "z": -6, "rot": 1}}
    dropped = client.post("/api/lobby/bricks", headers=maker, json=body)
    assert dropped.status_code == 200
    brick = dropped.json()["brick"]
    assert "holder" not in brick and (brick["x"], brick["y"], brick["z"], brick["rot"]) == (
        4,
        0,
        -6,
        1,
    )
    # The maker's hands stay free: another drops beside it, and one still comes to hand.
    beside = {**body, "at": {"x": 10, "y": 0, "z": -6, "rot": 0}}
    assert client.post("/api/lobby/bricks", headers=maker, json=beside).status_code == 200
    assert make(client, maker).json()["brick"]["holder"] == MAKER
    # Where it would drop must be free.
    clash = client.post("/api/lobby/bricks", headers=maker, json=body)
    assert clash.status_code == 409
    assert clash.json() == {"error": "wont_fit", "problem": "overlap"}


def test_a_ramp_is_kept_with_a_back_models_fit(
    client: TestClient, maker: dict[str, str], admin_headers: dict[str, str]
) -> None:
    ramp = {**BACKPACK, "spout": [0.5, 0.1, 0.0]}
    refit = client.put(
        "/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": ramp}
    )
    assert refit.status_code == 200 and refit.json()["placement"]["spout"] == [0.5, 0.1, 0.0]
    assert client.get("/api/avatars").json()["heads"][0]["placement"]["spout"] == [0.5, 0.1, 0.0]
    bad = {**BACKPACK, "spout": [0.5, 1.5, 0.0]}
    assert client.put(
        "/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": bad}
    ).status_code in (400, 422)
    client.put(
        "/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": BACKPACK}
    )
    assert get_state_db().query_all("SELECT * FROM avatars_head_spouts") == []
    client.put("/api/avatars/heads/pack/placement", headers=admin_headers, json={"placement": ramp})
    assert client.delete("/api/avatars/heads/pack", headers=admin_headers).status_code == 204
    assert get_state_db().query_all("SELECT * FROM avatars_head_spouts") == []
