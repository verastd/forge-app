"""The proposal rules (Phase 5 contract §1) as the pure `advance` sees them, then the same
deadlines over HTTP on an injected clock, both sides of every boundary; the Test timers
switch; advance_all, the ticker and the lifespan that runs it; and concurrent readers."""

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from forge_api import main
from forge_api.models import PROPOSAL_STATES, ProposalState
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError
from forge_api.services.proposals import (
    PILOT_TIMERS,
    TEST_TIMERS,
    Advance,
    ProposalFacts,
    Proposals,
    advance,
    advance_all,
    quorum_met,
    tick,
)
from forge_api.services.state import StateDB, get_state_db

from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import (
    ALICE,
    BOB,
    CAROL,
    DAVE,
    ERIN,
    SECOND,
    Floor,
    at,
    make_floor,
)

T = datetime(2026, 8, 10, 9, 0, 0, tzinfo=UTC)
TICK = timedelta(microseconds=1)
YEAR = timedelta(days=365)
HOUR = timedelta(hours=1)


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    return make_floor(client, clock, auth_headers, monkeypatch)


def facts(state: str, deadline: datetime | None = T, /, **counts: int) -> ProposalFacts:
    return ProposalFacts(
        id=1,
        state=cast(ProposalState, state),
        version=0,
        deadline=deadline,
        eligible=counts.get("eligible", 0),
        consents=counts.get("consents", 0),
        objections=counts.get("objections", 0),
        yes=counts.get("yes", 0),
        no=counts.get("no", 0),
        abstain=counts.get("abstain", 0),
    )


def kinds(result: Advance) -> list[str]:
    return [step.kind for step in result.steps]


# --- advance, pure --------------------------------------------------------------------


def test_nothing_is_due_before_a_deadline() -> None:
    for state in ("submitted", "debate", "voting"):
        result = advance(facts(state, eligible=3, consents=1, yes=2), T - TICK)
        assert result == Advance(state, T), state


def test_a_proposal_nobody_seconds_lapses_at_its_deadline() -> None:
    for now in (T, T + timedelta(days=30)):
        result = advance(facts("submitted"), now)
        assert (result.state, result.deadline, kinds(result)) == ("lapsed", None, ["lapsed"])
        assert result.steps[0].at == T  # dated at the deadline, however late it was applied


def test_debate_with_no_objection_passes_by_silence_at_its_deadline() -> None:
    result = advance(facts("debate", eligible=5, consents=2), T)
    assert (result.state, kinds(result)) == ("passed", ["debate_ended", "passed"])
    assert all(step.at == T for step in result.steps)
    assert "no objection" in result.steps[1].message


def test_unanimous_consent_passes_at_once() -> None:
    now = T - timedelta(days=1)
    result = advance(facts("debate", eligible=3, consents=3), now)
    assert (result.state, kinds(result), result.steps[0].at) == ("passed", ["passed"], now)
    assert "consented" in result.steps[0].message
    assert advance(facts("debate", eligible=3, consents=2), now).steps == ()


def test_one_objection_ends_both_fast_paths() -> None:
    early = T - timedelta(days=1)
    assert advance(facts("debate", eligible=3, consents=3, objections=1), early).steps == ()
    result = advance(facts("debate", eligible=3, consents=2, objections=1), T)
    assert (result.state, kinds(result)) == ("voting", ["debate_ended", "vote_opened"])
    assert result.deadline == T + PILOT_TIMERS.vote
    assert "3 members" in result.steps[1].message


def test_the_vote_deadline_comes_from_the_timers_in_force() -> None:
    result = advance(facts("debate", eligible=3, objections=1), T, TEST_TIMERS)
    assert result.deadline == T + timedelta(minutes=5)


def test_a_late_read_chains_debate_vote_and_close() -> None:
    result = advance(facts("debate", eligible=4, objections=1), T + PILOT_TIMERS.vote)
    assert kinds(result) == ["debate_ended", "vote_opened", "vote_closed", "failed"]
    assert result.state == "failed" and result.deadline is None
    closed = T + PILOT_TIMERS.vote
    assert [step.at for step in result.steps] == [T, T, closed, closed]
    assert "no quorum" in result.steps[3].message


@pytest.mark.parametrize(
    ("ballots", "outcome", "quorum"),
    [
        ({"yes": 3}, "passed", True),
        ({"yes": 2, "no": 1}, "passed", True),
        ({"yes": 2, "no": 2}, "failed", True),  # a tie fails
        ({"yes": 1, "no": 2}, "failed", True),
        ({"yes": 1, "abstain": 2}, "passed", True),  # abstain counts toward quorum
        ({"abstain": 3}, "failed", True),
        ({"yes": 2}, "failed", False),  # 2 of 5 is no majority
        ({}, "failed", False),
    ],
)
def test_the_close_needs_quorum_and_more_yes_than_no(
    ballots: dict[str, int], outcome: str, quorum: bool
) -> None:
    result = advance(facts("voting", eligible=5, **ballots), T)
    assert (result.state, kinds(result)) == (outcome, ["vote_closed", outcome])
    assert ("quorum was met" in result.steps[0].message) is quorum


def test_quorum_is_a_strict_majority_of_the_eligible_set() -> None:
    assert [quorum_met(ballots, 4) for ballots in range(5)] == [False, False, False, True, True]
    assert [quorum_met(ballots, 5) for ballots in range(6)] == [
        False,
        False,
        False,
        True,
        True,
        True,
    ]


def test_decided_proposals_never_move() -> None:
    for state in set(PROPOSAL_STATES) - {"submitted", "debate", "voting"}:
        assert advance(facts(state, eligible=3, consents=3, yes=3), T + YEAR).steps == ()


def test_advance_reads_nothing_but_its_arguments() -> None:
    proposal = facts("debate", eligible=2, consents=2)
    assert advance(proposal, T - YEAR) == advance(replace(proposal), T - YEAR)


# --- the same deadlines over HTTP, with an injected clock ------------------------------


def test_lapse_both_sides_of_the_deadline(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    deadline = floor.now() + timedelta(days=7)
    assert floor.detail(proposal_id)["proposal"]["deadline"] == at(deadline)
    floor.wait(timedelta(days=7) - SECOND)
    assert floor.state(proposal_id) == "submitted"
    floor.wait(SECOND)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "lapsed" and "deadline" not in detail["proposal"]
    assert detail["events"][-1] == {
        "at": at(deadline),
        "kind": "lapsed",
        "message": "Nobody seconded it in time, so it lapsed.",
    }


def test_debate_both_sides_of_the_deadline(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded()
    deadline = floor.now() + timedelta(days=3)
    assert floor.detail(proposal_id)["proposal"]["deadline"] == at(deadline)
    floor.wait(timedelta(days=3) - SECOND)
    assert floor.state(proposal_id) == "debate"
    floor.wait(SECOND)
    assert floor.state(proposal_id) == "passed"
    assert floor.kinds(proposal_id)[-3:] == ["debate_ended", "passed", "task_drafted"]


def test_vote_both_sides_of_the_deadline(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded()
    debate_end = floor.now() + timedelta(days=3)
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    floor.wait(timedelta(days=3) - SECOND)
    assert floor.state(proposal_id) == "debate"
    floor.wait(SECOND)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "voting"
    assert detail["proposal"]["deadline"] == at(debate_end + timedelta(days=2))
    floor.wait(timedelta(days=2) - SECOND)
    assert floor.state(proposal_id) == "voting"
    floor.wait(SECOND)
    assert floor.state(proposal_id) == "failed"  # nobody voted: no quorum


def test_test_timers_shorten_only_deadlines_set_afterwards(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    before = floor.moved(ALICE)
    lapse_before = floor.detail(before)["proposal"]["deadline"]
    assert floor.test_timers(True).json() == {"testTimers": True}
    # The proposal already moved keeps its seven days.
    assert floor.detail(before)["proposal"]["deadline"] == lapse_before
    after = floor.moved(BOB)
    assert floor.detail(after)["proposal"]["deadline"] == at(floor.now() + timedelta(minutes=10))
    # Seconding the older one now sets a debate deadline under the new timers.
    assert floor.second(before, CAROL).status_code == 200
    assert floor.detail(before)["proposal"]["deadline"] == at(floor.now() + timedelta(minutes=5))
    assert floor.consent(before, DAVE, False).status_code == 200
    floor.wait(timedelta(minutes=5))
    assert floor.detail(before)["proposal"]["deadline"] == at(floor.now() + timedelta(minutes=5))
    # Switching back changes nothing already set.
    assert floor.test_timers(False).json() == {"testTimers": False}
    assert floor.detail(before)["proposal"]["deadline"] == at(floor.now() + timedelta(minutes=5))
    floor.wait(timedelta(minutes=10))
    assert floor.state(after) == "lapsed"
    assert floor.state(before) == "failed"


def test_test_timers_are_lines_in_every_active_timeline(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    active = floor.moved(ALICE)
    gone = floor.moved(CAROL)
    assert floor.withdraw(gone, CAROL).status_code == 200
    assert floor.test_timers(True).status_code == 200
    assert floor.test_timers(True).status_code == 200  # no change: no second line
    assert floor.kinds(active) == ["moved", "test_timers_on"]
    assert floor.kinds(gone) == ["moved", "withdrawn"]
    on = floor.detail(active)["events"][-1]
    assert on["actor"] == "octo-operator" and "minutes, not days" in on["message"]
    assert floor.test_timers(False).status_code == 200
    assert floor.kinds(active) == ["moved", "test_timers_on", "test_timers_off"]
    listing = floor.get("/api/proposals").json()
    assert listing["testTimers"] is False


# --- advance_all and the ticker --------------------------------------------------------


def test_advance_all_applies_every_due_deadline_once(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE, ERIN)
    lapsing = floor.moved(ALICE)
    debating = floor.seconded(BOB, CAROL)
    voting = floor.seconded(DAVE, ERIN)
    assert floor.consent(voting, ALICE, False).status_code == 200
    assert floor.tick() == 0
    floor.wait(timedelta(days=3))
    # debate -> passed (2 steps); objected debate -> voting (2 steps)
    assert floor.tick() == 4
    assert floor.tick() == 0
    floor.wait(timedelta(days=4))
    # lapse (1 step); the vote closes and fails (2 steps)
    assert floor.tick() == 3
    states = [floor.state(proposal) for proposal in (lapsing, debating, voting)]
    assert states == ["lapsed", "passed", "failed"]


def test_the_ticker_does_nothing_while_proposals_are_off(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(days=8))
    floor.flags(proposals=False)
    assert tick(floor.db(), floor.now()) == 0
    row = floor.db().query_one("SELECT state FROM proposal_motions WHERE id = ?", (proposal_id,))
    assert row == {"state": "submitted"}
    floor.flags(proposals=True)
    assert tick(floor.db(), floor.now()) == 1


# --- the floor pauses while members can't act (review M1) -------------------------------

PAUSED = (
    "The floor closed, so nobody can act on it for now. Its deadlines wait until it opens again."
)


def test_the_floor_pauses_while_proposals_are_off(floor: Floor) -> None:
    """Review M1, the kill switch: with `proposals` off nobody can object, yet the first
    read after it came back passed the debate by silence, dated at its deadline. Now the
    deadline waits: it moves later by the time the floor was closed."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    deadline = floor.now() + timedelta(days=3)
    floor.wait(timedelta(days=2, hours=20))  # 4 hours before the deadline
    floor.flags(proposals=False)
    closed_at = floor.now()
    assert floor.consent(proposal_id, CAROL, False).status_code == 404
    assert tick(floor.db(), floor.now()) == 0  # the beat records that the floor closed
    floor.wait(HOUR * 6)  # 2 hours past the old deadline
    assert tick(floor.db(), floor.now()) == 0
    floor.flags(proposals=True)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "debate"
    assert detail["proposal"]["deadline"] == at(deadline + HOUR * 6)
    assert "floorPaused" not in detail
    assert [(event["kind"], event["at"], event["message"]) for event in detail["events"][-2:]] == [
        ("floor_paused", at(closed_at), PAUSED),
        (
            "floor_resumed",
            at(floor.now()),
            "The floor was closed for 6 h; deadlines moved by that.",
        ),
    ]
    # Carol has the 4 hours she had left, to the second.
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    floor.wait(HOUR * 4 - SECOND)
    assert floor.state(proposal_id) == "debate"
    floor.wait(SECOND)
    assert floor.state(proposal_id) == "voting"


def test_a_vote_waits_while_the_floor_is_closed(floor: Floor) -> None:
    """Review M1: a vote that ran out while nobody could vote closed without quorum."""
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.voting(ALICE, BOB)
    deadline = floor.now() + timedelta(days=2)
    assert floor.vote(proposal_id, ALICE, "yes").status_code == 200
    floor.wait(timedelta(days=1, hours=20))
    floor.flags(proposals=False)
    assert floor.tick() == 0
    floor.wait(HOUR * 6)
    assert floor.tick() == 0
    floor.flags(proposals=True)
    for who in (BOB, CAROL, DAVE):
        assert floor.vote(proposal_id, who, "yes").status_code == 200
    assert floor.detail(proposal_id)["proposal"]["deadline"] == at(deadline + HOUR * 6)
    floor.wait(HOUR * 4)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "passed"
    assert detail["tally"] == {"yes": 4, "no": 0, "abstain": 0, "eligible": 4, "quorumMet": True}


def test_a_refused_request_records_the_closure_before_any_beat(floor: Floor) -> None:
    """Review M1, the probe's second case: no beat ran while `proposals` was off, so the
    vote closed without quorum on the first read after. The first request refused by the
    kill switch now records that the floor closed, so the vote waits however late the
    ticker's next beat is."""
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.voting(ALICE, BOB)
    deadline = floor.now() + timedelta(days=2)
    assert floor.vote(proposal_id, ALICE, "yes").status_code == 200
    floor.wait(timedelta(days=1, hours=20))
    floor.flags(proposals=False)
    for who in (BOB, CAROL, DAVE):
        assert floor.vote(proposal_id, who, "yes").status_code == 404
    floor.wait(HOUR * 6)
    floor.flags(proposals=True)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "voting"
    assert detail["proposal"]["deadline"] == at(deadline + HOUR * 6)
    assert floor.kinds(proposal_id)[-2:] == ["floor_paused", "floor_resumed"]


def test_recording_the_closure_never_turns_the_refusal_into_an_error(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    proposal_id = floor.moved(ALICE)
    floor.flags(proposals=False)

    def unreachable() -> StateDB:
        raise RuntimeError("the disk is gone")

    monkeypatch.setattr(proposals_service, "get_state_db", unreachable)
    with caplog.at_level(logging.ERROR, logger="forge_api.services.proposals"):
        response = floor.get(f"/api/proposals/{proposal_id}")
    assert response.status_code == 404 and response.json() == {"error": "proposals-disabled"}
    assert "Couldn't record that the floor closed" in caplog.text


def test_the_floor_pauses_while_sign_in_is_off(floor: Floor) -> None:
    """Review M1, with `github_signin` off and `proposals` on: every write was 401, yet the
    ticker kept deciding. Now nothing moves; public reads say the floor is paused."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    deadline = floor.now() + timedelta(days=3)
    floor.wait(timedelta(days=2, hours=20))
    floor.flags(github_signin=False)
    assert floor.consent(proposal_id, CAROL, False).status_code == 401
    assert tick(floor.db(), floor.now()) == 0
    floor.wait(HOUR * 6)
    assert tick(floor.db(), floor.now()) == 0  # used to apply 2 steps and pass it
    paused = floor.detail(proposal_id)
    assert paused["proposal"]["state"] == "debate" and paused["floorPaused"] is True
    assert paused["proposal"]["deadline"] == at(deadline)  # it moves when the floor opens
    assert floor.get("/api/proposals").json()["floorPaused"] is True
    assert floor.kinds(proposal_id).count("floor_paused") == 1  # however often it is read
    floor.flags(github_signin=True)
    assert tick(floor.db(), floor.now()) == 0  # the floor opens; nothing is due yet
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["deadline"] == at(deadline + HOUR * 6)
    assert "floorPaused" not in detail
    assert "floorPaused" not in floor.get("/api/proposals").json()
    floor.wait(HOUR)
    assert floor.detail(proposal_id)["proposal"]["deadline"] == at(deadline + HOUR * 6)
    assert floor.kinds(proposal_id)[-2:] == ["floor_paused", "floor_resumed"]


def test_flags_that_fail_closed_pause_the_floor(floor: Floor) -> None:
    """Review M1: a malformed FORGE_FLAGS_JSON fails every flag closed, so members can't
    act, and a proposal must not lapse meanwhile."""
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(days=6))
    floor.monkeypatch.setenv("FORGE_FLAGS_JSON", "{not json")
    assert proposals_service.members_can_act() is False
    assert tick(floor.db(), floor.now()) == 0
    floor.wait(timedelta(days=2))  # past the old lapse deadline
    assert tick(floor.db(), floor.now()) == 0
    floor.monkeypatch.delenv("FORGE_FLAGS_JSON")
    assert tick(floor.db(), floor.now()) == 0  # opens: one day left, as before
    assert floor.state(proposal_id) == "submitted"
    floor.wait(timedelta(days=1) - SECOND)
    assert floor.state(proposal_id) == "submitted"
    floor.wait(SECOND)
    assert floor.state(proposal_id) == "lapsed"


@pytest.mark.parametrize(
    ("flags", "can_act"),
    [
        ({}, True),
        ({"proposals": False}, False),
        ({"github_signin": False}, False),
        ({"proposals": False, "github_signin": False}, False),
    ],
)
def test_members_can_act_only_with_both_flags_on(
    floor: Floor, flags: dict[str, bool], can_act: bool
) -> None:
    floor.flags(**flags)
    assert proposals_service.members_can_act() is can_act


def test_opening_comes_first_and_leaves_overdue_deadlines_where_they_were(floor: Floor) -> None:
    """When the floor opens, every running deadline moves before any transition applies;
    one that had passed before it closed was due already, so it is applied at once, dated
    at itself, ahead of the pause in the timeline."""
    overdue = floor.moved(ALICE)
    overdue_deadline = floor.now() + timedelta(days=7)
    floor.wait(timedelta(days=6))
    running = floor.moved(BOB)
    running_deadline = floor.now() + timedelta(days=7)
    floor.wait(timedelta(days=1, hours=1))  # nobody read the overdue one since
    floor.flags(proposals=False)
    assert floor.tick() == 0
    floor.wait(timedelta(days=10))
    floor.flags(proposals=True)
    assert floor.tick() == 1  # the overdue lapse, after the deadlines moved
    late = floor.detail(overdue)
    assert late["proposal"]["state"] == "lapsed"
    assert [(event["kind"], event["at"]) for event in late["events"]][1:3] == [
        ("lapsed", at(overdue_deadline)),
        ("floor_paused", at(overdue_deadline + HOUR)),
    ]
    assert late["events"][-1]["message"] == "The floor was closed for 10 d."
    detail = floor.detail(running)
    assert detail["proposal"]["state"] == "submitted"
    assert detail["proposal"]["deadline"] == at(running_deadline + timedelta(days=10))


def test_a_floor_already_open_or_already_paused_writes_nothing(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    assert floor.tick() == 0
    assert floor.db().query_one("SELECT COUNT(*) AS n FROM proposal_floor") == {"n": 0}
    floor.flags(proposals=False)
    for _ in range(3):
        assert floor.tick() == 0
        floor.wait(HOUR)
    row = floor.db().query_one("SELECT closed_since FROM proposal_floor")
    assert row is not None and row["closed_since"] is not None
    floor.flags(proposals=True)
    assert floor.kinds(proposal_id) == ["moved", "floor_paused", "floor_resumed"]
    assert floor.detail(proposal_id)["events"][-1]["message"] == (
        "The floor was closed for 3 h; deadlines moved by that."
    )
    assert floor.db().query_one("SELECT closed_since FROM proposal_floor") == {"closed_since": None}


@pytest.mark.parametrize(
    ("span", "words"),
    [
        (timedelta(hours=2, minutes=10), "2 h 10 min"),
        (timedelta(days=3, seconds=5), "3 d 5 s"),
        (timedelta(days=1, hours=1, minutes=1, seconds=1), "1 d 1 h 1 min 1 s"),
        (timedelta(milliseconds=400), "under a second"),
        (timedelta(seconds=-5), "under a second"),
    ],
)
def test_how_long_the_floor_was_closed_reads(span: timedelta, words: str) -> None:
    assert proposals_service.duration_words(span) == words


def test_the_ticker_survives_a_failing_beat_and_stops_when_cancelled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    beats: list[datetime] = []
    done = threading.Event()

    def db_fn() -> StateDB:
        if not beats:
            beats.append(T)
            raise RuntimeError("the disk is full")
        return get_state_db()

    def now_fn() -> datetime:
        beats.append(T)
        if len(beats) >= 3:
            done.set()
        return T

    async def run() -> None:
        task = asyncio.create_task(proposals_service.run_ticker(0.001, db_fn=db_fn, now_fn=now_fn))
        while not done.is_set():
            await asyncio.sleep(0.005)
        task.cancel()
        results = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)

    with caplog.at_level(logging.ERROR, logger="forge_api.services.proposals"):
        asyncio.run(asyncio.wait_for(run(), timeout=10))
    assert len(beats) >= 3  # the failing beat, then beats that worked
    assert "ticker beat failed" in caplog.text
    assert "the disk is full" in caplog.text


def test_the_lifespan_runs_the_ticker_and_cancels_it_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    async def fake_ticker() -> None:
        seen.append("started")
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            seen.append("cancelled")
            raise

    monkeypatch.setattr(proposals_service, "run_ticker", fake_ticker)
    with TestClient(main.app) as client:
        assert client.get("/api/health").status_code == 200
        assert seen == ["started"]
    assert seen == ["started", "cancelled"]


def test_the_real_ticker_waits_a_minute_before_its_first_beat() -> None:
    assert proposals_service.TICK_SECONDS == 60.0

    async def run() -> None:
        task = asyncio.create_task(proposals_service.run_ticker())
        await asyncio.sleep(0.01)
        assert not task.done()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


# --- concurrent readers and the ticker ------------------------------------------------


def _race(workers: list[Callable[[], object]]) -> list[BaseException]:
    start = threading.Barrier(len(workers))
    failures: list[BaseException] = []

    def run(work: Callable[[], object]) -> None:
        start.wait()
        try:
            work()
        except BaseException as exc:  # noqa: BLE001 - reported below
            failures.append(exc)

    threads = [threading.Thread(target=run, args=(work,)) for work in workers]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return failures


def test_concurrent_ticks_and_reads_apply_a_transition_once(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    lapsing = floor.moved(ALICE)
    closing = floor.voting(BOB, CAROL)
    for choice, who in (("yes", ALICE), ("yes", BOB), ("no", CAROL)):
        assert floor.vote(closing, who, choice).status_code == 200
    floor.wait(timedelta(days=7))
    db, now = floor.db(), floor.now()
    workers: list[Callable[[], object]] = []
    for _ in range(4):
        workers.append(lambda: advance_all(db, now))
        workers.append(lambda: Proposals(db, now).detail(lapsing))
        workers.append(lambda: Proposals(db, now).detail(closing, ALICE))
        workers.append(lambda: Proposals(db, now).list_proposals())
    assert _race(workers) == []
    assert floor.kinds(lapsing).count("lapsed") == 1
    closed = floor.kinds(closing)
    assert closed.count("vote_closed") == 1 and closed.count("passed") == 1
    assert closed.count("voted") == 3 and closed.count("task_drafted") == 1
    assert floor.bell_kinds(ALICE).count("proposal_lapsed") == 1
    assert floor.bell_kinds(CAROL).count("proposal_passed") == 1


def test_two_connections_never_apply_a_transition_twice(floor: Floor, state_db_path: Path) -> None:
    """Two StateDB objects on one file, as two API processes would have: BEGIN IMMEDIATE
    and the compare-and-set keep the second from applying what the first did."""
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(days=7))
    first, second = get_state_db(), StateDB(state_db_path)
    try:
        second.apply_schemas()
        now = floor.now()
        workers: list[Callable[[], object]] = []
        for _ in range(3):
            workers.append(lambda: advance_all(first, now))
            workers.append(lambda: advance_all(second, now))
            workers.append(lambda: Proposals(second, now).detail(proposal_id))
        assert _race(workers) == []
    finally:
        second.close()
    assert floor.kinds(proposal_id) == ["moved", "lapsed"]
    version = floor.db().query_one(
        "SELECT version FROM proposal_motions WHERE id = ?", (proposal_id,)
    )
    assert version == {"version": 1}


def test_a_stale_write_is_refused_by_the_compare_and_set(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    stale = floor.db().query_one("SELECT * FROM proposal_motions WHERE id = ?", (proposal_id,))
    assert stale is not None
    assert floor.edit(proposal_id, ALICE, "A newer title", "A newer pitch").status_code == 200
    with pytest.raises(ApiError) as refused:
        with floor.db().transaction():
            floor.floor()._update(stale, "title = ?", ("Lost update",))
    assert refused.value.status_code == 409
    assert refused.value.payload["error"] == "wrong_state"
    assert floor.detail(proposal_id)["proposal"]["title"] == "A newer title"


def test_advance_one_rereads_inside_its_transaction(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The quick check runs without the write lock; inside the transaction the proposal is
    read again, and one that is gone by then is left alone."""
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(days=7))
    real_load = Proposals._load
    calls: list[int] = []

    def gone_on_the_second_read(self: Proposals, wanted: int) -> dict[str, object] | None:
        calls.append(wanted)
        return real_load(self, wanted) if len(calls) == 1 else None

    monkeypatch.setattr(Proposals, "_load", gone_on_the_second_read)
    assert floor.floor().advance_one(proposal_id) == 0
    monkeypatch.setattr(Proposals, "_load", real_load)
    assert calls == [proposal_id, proposal_id]
    row = floor.db().query_one("SELECT state FROM proposal_motions WHERE id = ?", (proposal_id,))
    assert row == {"state": "submitted"}


def test_the_compare_and_set_skips_a_stale_snapshot(floor: Floor) -> None:
    """A transition worked out from a snapshot that is no longer current writes nothing:
    whoever changed the proposal since applied it already."""
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(days=7))
    current = floor.floor()
    stale = current._load(proposal_id)
    assert stale is not None
    assert current.advance_one(proposal_id) == 1
    with floor.db().transaction():
        result = advance(proposals_service._facts(stale), floor.now())
        assert result.state == "lapsed"
        assert current._apply(stale, result) == 0
    assert floor.kinds(proposal_id) == ["moved", "lapsed"]
    assert floor.bell_kinds(ALICE) == ["proposal_lapsed"]
