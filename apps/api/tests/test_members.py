"""Members (Phase 5 contract §3): `touch_member`, `POST /api/members/hello`, and every
identity-bearing proposals and notifications route recording its caller."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from forge_api.services.identity import Identity
from forge_api.services.members import (
    Member,
    all_members,
    current_time,
    member_subs,
    recent_members,
    touch_member,
)

from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import ADMIN, ALICE, BOB, CAROL, Floor, make_floor


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    return make_floor(client, clock, auth_headers, monkeypatch)


def rows(floor: Floor) -> list[dict[str, str]]:
    return floor.db().query_all("SELECT * FROM members ORDER BY first_seen, sub")


def test_touch_member_records_and_refreshes(floor: Floor) -> None:
    db, start = floor.db(), floor.now()
    touch_member(db, ALICE, start)
    touch_member(db, Identity(sub=ALICE.sub, login="renamed"), start + timedelta(hours=1))
    touch_member(db, ALICE, start - timedelta(hours=1))  # an older clock never goes back
    touch_member(db, BOB, start + timedelta(minutes=5))
    assert rows(floor) == [
        {
            "sub": ALICE.sub,
            "login": "octo-contributor",
            "first_seen": "2026-08-10T09:00:00.000000Z",
            "last_seen": "2026-08-10T10:00:00.000000Z",
        },
        {
            "sub": BOB.sub,
            "login": "other-dev",
            "first_seen": "2026-08-10T09:05:00.000000Z",
            "last_seen": "2026-08-10T09:05:00.000000Z",
        },
    ]
    assert all_members(db) == [Member(ALICE.sub, ALICE.login), Member(BOB.sub, BOB.login)]
    assert member_subs(db) == [ALICE.sub, BOB.sub]


def test_hello_records_the_caller(floor: Floor) -> None:
    response = floor.post("/api/members/hello", ALICE)
    assert response.status_code == 204 and response.content == b""
    assert [row["sub"] for row in rows(floor)] == [ALICE.sub]
    floor.flags(proposals=False)  # behind no flag
    assert floor.post("/api/members/hello", BOB).status_code == 204
    assert [row["sub"] for row in rows(floor)] == [ALICE.sub, BOB.sub]


def test_hello_needs_an_identity(floor: Floor) -> None:
    nobody = floor.client.post("/api/members/hello")
    assert nobody.status_code == 401 and nobody.json() == {"error": "unauthenticated"}
    floor.flags(github_signin=False)
    assert floor.post("/api/members/hello", ALICE).status_code == 401
    assert rows(floor) == []


def test_identity_bearing_routes_record_their_caller(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    floor.detail(proposal_id)  # anonymous: nobody to record
    floor.get("/api/proposals")
    assert [row["sub"] for row in rows(floor)] == [ALICE.sub]
    floor.detail(proposal_id, BOB)
    floor.get("/api/proposals/me", CAROL)
    floor.bell(ADMIN)
    assert sorted(row["sub"] for row in rows(floor)) == sorted(
        [ALICE.sub, BOB.sub, CAROL.sub, ADMIN.sub]
    )


def test_a_refused_caller_is_not_recorded(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    response = floor.client.post(
        f"/api/proposals/{proposal_id}/second", headers={"Authorization": "Bearer forged"}
    )
    assert response.status_code == 401
    assert [row["sub"] for row in rows(floor)] == [ALICE.sub]


def test_the_request_clock_is_utc_now() -> None:
    before = datetime.now(UTC)
    now = current_time()
    assert now.tzinfo is UTC and before <= now <= datetime.now(UTC)


def test_recent_members_are_those_seen_after_a_moment(floor: Floor) -> None:
    """The eligible set's source (review M3): last_seen later than the moment given."""
    db, start = floor.db(), floor.now()
    touch_member(db, ALICE, start)
    touch_member(db, BOB, start + timedelta(days=1))
    assert recent_members(db, start - timedelta(microseconds=1)) == [
        Member(ALICE.sub, ALICE.login),
        Member(BOB.sub, BOB.login),
    ]
    assert recent_members(db, start) == [Member(BOB.sub, BOB.login)]
    assert recent_members(db, start + timedelta(days=1)) == []
