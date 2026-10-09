"""Shared helpers for the Phase 5 tests (proposals, notifications, members): a cast of
members, a fake clock on every proposals route, and one call per action. Kept out of
conftest.py on purpose, as bridge_helpers.py is; test modules import what they need."""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services import bridge as bridge_service
from forge_api.services import identity as identity_service
from forge_api.services import members as members_service
from forge_api.services.bridge import CompositeTaskSource, FixtureTaskSource, PublishedTaskSource
from forge_api.services.identity import Identity
from forge_api.services.proposals import Proposals, advance_all
from forge_api.services.state import StateDB, get_state_db

from .bridge_helpers import TEST_TASKS, BridgeEnv, install_bridge
from .conftest import AuthHeaders, FakeClock

ALICE = Identity(sub="1001", login="octo-contributor")
ADMIN = Identity(sub="1002", login="octo-operator")
BOB = Identity(sub="1003", login="other-dev")
CAROL = Identity(sub="1004", login="carol-dev")
DAVE = Identity(sub="1005", login="dave-dev")
ERIN = Identity(sub="1006", login="erin-dev")

TITLE = "Add a dark mode to the Data app"
PITCH = "Night owls read the Data app late.\n\nA dark mode would be easier on their eyes."
#: Every environment variable the floor reads; tests start with none of them set.
FLOOR_ENV = ("FORGE_FLAGS_JSON", "FORGE_FLAGS_PATH", "FORGE_PUBLIC_ORIGIN")

DAY = timedelta(days=1)
SECOND = timedelta(seconds=1)


def at(moment: datetime) -> str:
    """A time as the API writes it."""
    return bridge_service.iso(moment)


@dataclass
class Floor:
    """The proposals API as members use it, on a fake clock."""

    client: TestClient
    clock: FakeClock
    auth: AuthHeaders
    monkeypatch: pytest.MonkeyPatch

    # time and switches

    def now(self) -> datetime:
        return self.clock()

    def wait(self, delta: timedelta) -> None:
        self.clock.moment += delta

    def flags(self, **overrides: bool) -> None:
        self.monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps(overrides))

    def db(self) -> StateDB:
        return get_state_db()

    def floor(self) -> Proposals:
        return Proposals(self.db(), self.now())

    def tick(self) -> int:
        return advance_all(self.db(), self.now())

    # requests

    def headers(self, who: Identity | None) -> dict[str, str]:
        return {} if who is None else self.auth(who.sub, who.login)

    def get(self, path: str, who: Identity | None = None) -> httpx.Response:
        response: httpx.Response = self.client.get(path, headers=self.headers(who))
        return response

    def post(self, path: str, who: Identity | None, body: Any = None) -> httpx.Response:
        response: httpx.Response
        if body is None:
            response = self.client.post(path, headers=self.headers(who))
        else:
            response = self.client.post(path, json=body, headers=self.headers(who))
        return response

    def put(self, path: str, who: Identity | None, body: Any) -> httpx.Response:
        response: httpx.Response = self.client.put(path, json=body, headers=self.headers(who))
        return response

    def hello(self, *who: Identity) -> None:
        for member in who:
            response = self.post("/api/members/hello", member)
            assert response.status_code == 204, response.text

    def move(self, who: Identity, title: str = TITLE, pitch: str = PITCH) -> httpx.Response:
        return self.post("/api/proposals", who, {"title": title, "pitch": pitch})

    def moved(self, who: Identity, title: str = TITLE, pitch: str = PITCH) -> int:
        response = self.move(who, title, pitch)
        assert response.status_code == 201, response.text
        return int(response.json()["proposal"]["id"])

    def edit(self, proposal_id: int, who: Identity, title: str, pitch: str) -> httpx.Response:
        response: httpx.Response = self.client.patch(
            f"/api/proposals/{proposal_id}",
            json={"title": title, "pitch": pitch},
            headers=self.headers(who),
        )
        return response

    def detail(self, proposal_id: int, who: Identity | None = None) -> Any:
        response = self.get(f"/api/proposals/{proposal_id}", who)
        assert response.status_code == 200, response.text
        return response.json()

    def state(self, proposal_id: int) -> str:
        return str(self.detail(proposal_id)["proposal"]["state"])

    def kinds(self, proposal_id: int) -> list[str]:
        return [event["kind"] for event in self.detail(proposal_id)["events"]]

    def revision(self, proposal_id: int) -> int:
        """The revision a reader sees now (1 when the proposal can't be read)."""
        response = self.get(f"/api/proposals/{proposal_id}")
        return int(response.json()["revision"]) if response.status_code == 200 else 1

    def second(
        self, proposal_id: int, who: Identity, revision: int | None = None
    ) -> httpx.Response:
        """Second it, sending `revision`: by default the one a fresh read shows, as a member
        who has just opened the page would."""
        seen = self.revision(proposal_id) if revision is None else revision
        return self.post(f"/api/proposals/{proposal_id}/second", who, {"revision": seen})

    def comments_page(self, proposal_id: int, before: int | None = None) -> httpx.Response:
        query = "" if before is None else f"?before={before}"
        return self.get(f"/api/proposals/{proposal_id}/comments{query}")

    def withdraw(self, proposal_id: int, who: Identity) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/withdraw", who)

    def consent(self, proposal_id: int, who: Identity, consent: Any = True) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/consent", who, {"consent": consent})

    def comment(self, proposal_id: int, who: Identity, text: str) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/comments", who, {"text": text})

    def vote(self, proposal_id: int, who: Identity, choice: str) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/vote", who, {"choice": choice})

    def end_debate(self, proposal_id: int, who: Identity = ADMIN) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/admin/end-debate", who)

    def close_vote(self, proposal_id: int, who: Identity = ADMIN) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/admin/close-vote", who)

    def put_draft(self, proposal_id: int, body: Any, who: Identity = ADMIN) -> httpx.Response:
        return self.put(f"/api/proposals/{proposal_id}/admin/draft-task", who, body)

    def publish(self, proposal_id: int, who: Identity = ADMIN) -> httpx.Response:
        return self.post(f"/api/proposals/{proposal_id}/admin/publish-task", who)

    def test_timers(self, on: Any, who: Identity = ADMIN) -> httpx.Response:
        return self.put("/api/proposals/settings", who, {"testTimers": on})

    def testing(self) -> None:
        """Test timers on: the admin buttons (End debate now, Close the vote now) work only
        then."""
        response = self.test_timers(True)
        assert response.status_code == 200, response.text

    def bell(self, who: Identity) -> Any:
        response = self.get("/api/notifications", who)
        assert response.status_code == 200, response.text
        return response.json()

    def bell_kinds(self, who: Identity) -> list[str]:
        return [item["kind"] for item in self.bell(who)["notifications"]]

    # whole steps of the process

    def seconded(self, mover: Identity = ALICE, seconder: Identity = BOB) -> int:
        """A proposal by `mover`, seconded by `seconder`: in debate."""
        proposal_id = self.moved(mover)
        response = self.second(proposal_id, seconder)
        assert response.status_code == 200, response.text
        return proposal_id

    def voting(self, mover: Identity = ALICE, seconder: Identity = BOB) -> int:
        """In a vote: the seconder objected, and debate ran out."""
        proposal_id = self.seconded(mover, seconder)
        assert self.consent(proposal_id, seconder, False).status_code == 200
        self.wait(timedelta(days=3))
        assert self.state(proposal_id) == "voting"
        return proposal_id

    def passed(self, mover: Identity = ALICE, seconder: Identity = BOB) -> int:
        """Passed by unanimous consent (every member of the eligible set consented)."""
        proposal_id = self.seconded(mover, seconder)
        for member in self.detail_eligible(proposal_id):
            if member != mover.sub:
                login = next(person.login for person in CAST if person.sub == member)
                response = self.consent(proposal_id, Identity(member, login))
                assert response.status_code == 200, response.text
        assert self.state(proposal_id) == "passed"
        return proposal_id

    def detail_eligible(self, proposal_id: int) -> list[str]:
        rows = self.db().query_all(
            "SELECT sub FROM proposal_eligible WHERE proposal_id = ? ORDER BY sub", (proposal_id,)
        )
        return [row["sub"] for row in rows]


CAST = (ALICE, ADMIN, BOB, CAROL, DAVE, ERIN)

#: A finished draft task (DraftTaskRequest).
DRAFT = {
    "title": "Dark mode for the Data app",
    "civilianSummary": "Let people switch the Data app to dark colors.",
    "acceptanceCriteria": ["A switch in the Data app turns dark mode on and off"],
    "size": "XS",
    "tierFloor": "T0",
    "rewardClass": "R1",
}


def make_floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    """The floor on the test's clock, with ADMIN on the admin allowlist and no flag,
    origin or path settings from the environment (config/flags.json has proposals on)."""
    for name in FLOOR_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(identity_service.ADMIN_IDS_ENV, ADMIN.sub)
    app.dependency_overrides[members_service.current_time] = clock
    return Floor(client=client, clock=clock, auth=auth_headers, monkeypatch=monkeypatch)


def install_board(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    """bridge_helpers.install_bridge, with the production board: the fixtures, then the
    tasks published from proposals."""
    env = install_bridge(monkeypatch, clock)
    monkeypatch.setattr(
        bridge_service,
        "_source",
        CompositeTaskSource(FixtureTaskSource(TEST_TASKS), PublishedTaskSource()),
    )
    return env
