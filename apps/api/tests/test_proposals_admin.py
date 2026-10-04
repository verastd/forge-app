"""Admin actions on the floor (Phase 5 contract §1, §3): End debate now, Close the vote
now, the draft task, Publish to the board (a Contribute task from 10001 up that the Bridge
lists and lets anyone claim), and the Bridge's shipped hook that moves the proposal on."""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.services import bridge as bridge_service
from forge_api.services import proposals as proposals_service
from forge_api.services.bridge import (
    PUBLISHED_TASK_FIRST_ID,
    CompositeTaskSource,
    FixtureTaskSource,
    PublishedTaskSource,
    publish_task,
)
from forge_api.services.bridge_mcp import TOOLS
from forge_api.services.brief import branch_name
from forge_api.services.identity import Identity
from forge_api.services.mcp_types import ToolContext, ToolOutput
from forge_api.services.proposals import TEST_TIMERS
from forge_api.services.state import StateDB

from .bridge_helpers import BridgeEnv
from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import (
    ADMIN,
    ALICE,
    BOB,
    CAROL,
    DAVE,
    DRAFT,
    PITCH,
    TITLE,
    Floor,
    at,
    install_board,
    make_floor,
)


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    return make_floor(client, clock, auth_headers, monkeypatch)


@pytest.fixture
def board(monkeypatch: pytest.MonkeyPatch, clock: FakeClock, floor: Floor) -> BridgeEnv:
    """The Bridge on fakes (GitHub, vendors), serving the fixtures and the published tasks."""
    return install_board(monkeypatch, clock)


def refused(response: httpx.Response, status: int, error: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    assert body["error"] == error, body
    return body


def published(floor: Floor, mover: Identity = ALICE, seconder: Identity = BOB) -> int:
    """A passed proposal with its draft finished (DRAFT) and published."""
    floor.hello(mover, seconder, CAROL)
    proposal_id = floor.passed(mover, seconder)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    response = floor.publish(proposal_id)
    assert response.status_code == 200, response.text
    return proposal_id


# --- who may ---------------------------------------------------------------------------


def test_admin_routes_need_an_admin(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    base = f"/api/proposals/{proposal_id}/admin"
    attempts: list[Callable[[Identity | None], httpx.Response]] = [
        lambda who: floor.put("/api/proposals/settings", who, {"testTimers": True}),
        lambda who: floor.post(f"{base}/end-debate", who),
        lambda who: floor.post(f"{base}/close-vote", who),
        lambda who: floor.put(f"{base}/draft-task", who, DRAFT),
        lambda who: floor.post(f"{base}/publish-task", who),
    ]
    for attempt in attempts:
        not_admin = attempt(BOB)
        assert not_admin.status_code == 403 and not_admin.json() == {"error": "admin_only"}
        nobody = attempt(None)
        assert nobody.status_code == 401 and nobody.json() == {"error": "unauthenticated"}
    assert floor.state(proposal_id) == "debate"


def test_the_settings_body_is_a_real_boolean(floor: Floor) -> None:
    for value in ("true", 1, None):
        body = refused(floor.test_timers(value), 400, "invalid_request")
        assert body["fields"] == ["testTimers"]
    assert floor.get("/api/proposals").json()["testTimers"] is False


# --- End debate now / Close the vote now ------------------------------------------------


def test_end_debate_now_with_no_objection_passes_it(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    floor.wait(timedelta(hours=5))
    floor.testing()
    detail = floor.end_debate(proposal_id).json()
    assert detail["proposal"]["state"] == "passed"
    tail = detail["events"][-4:]
    assert [(event["kind"], event["at"]) for event in tail] == [
        ("admin_ended_debate", at(floor.now())),
        ("debate_ended", at(floor.now())),
        ("passed", at(floor.now())),
        ("task_drafted", at(floor.now())),
    ]
    assert tail[0]["actor"] == "octo-operator"
    assert tail[0]["message"] == "octo-operator, an admin, ended debate now."
    assert detail["you"]["isAdmin"] is True and "draft" in detail


def test_end_debate_now_with_an_objection_opens_the_vote(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    floor.testing()
    detail = floor.end_debate(proposal_id).json()
    assert detail["proposal"]["state"] == "voting"
    # The vote opens now, under the timers in force: Test timers, so minutes.
    assert detail["proposal"]["deadline"] == at(floor.now() + TEST_TIMERS.vote)
    assert detail["turnout"] == 0
    assert "vote_opened" in floor.bell_kinds(CAROL)


def test_end_debate_only_during_debate(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    submitted = floor.moved(ALICE)
    voting = floor.voting(BOB, CAROL)
    floor.testing()
    assert refused(floor.end_debate(submitted), 409, "wrong_state")["state"] == "submitted"
    assert refused(floor.end_debate(voting), 409, "wrong_state")["state"] == "voting"
    assert refused(floor.end_debate(999), 404, "proposal_not_found")


def test_close_the_vote_now(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.voting(ALICE, BOB)
    assert floor.vote(proposal_id, ALICE, "yes").status_code == 200
    assert floor.vote(proposal_id, CAROL, "yes").status_code == 200
    floor.wait(timedelta(hours=3))
    floor.testing()
    detail = floor.close_vote(proposal_id).json()
    assert detail["proposal"]["state"] == "passed"
    assert detail["tally"] == {"yes": 2, "no": 0, "abstain": 0, "eligible": 3, "quorumMet": True}
    kinds = [event["kind"] for event in detail["events"]]
    assert kinds[-7:] == [
        "voted",
        "voted",
        "test_timers_on",
        "admin_closed_vote",
        "vote_closed",
        "passed",
        "task_drafted",
    ]
    closing = detail["events"][-4]
    assert closing["actor"] == "octo-operator" and closing["at"] == at(floor.now())
    assert detail["events"][-3]["at"] == at(floor.now())


def test_close_the_vote_now_can_fail_it(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.voting(ALICE, BOB)
    assert floor.vote(proposal_id, BOB, "no").status_code == 200
    floor.testing()
    detail = floor.close_vote(proposal_id).json()
    assert detail["proposal"]["state"] == "failed"
    assert detail["tally"]["quorumMet"] is False


def test_close_the_vote_only_while_voting(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    floor.testing()
    assert refused(floor.close_vote(proposal_id), 409, "wrong_state")["state"] == "debate"


def test_the_admin_buttons_are_test_tools(floor: Floor) -> None:
    """Review L2: an admin who moved a proposal could pass it the moment it was seconded,
    with "End debate now" and pilot timers. Both buttons now work only while Test timers
    are on: otherwise 409 test_mode_off, and nothing changes."""
    floor.hello(ALICE, BOB, CAROL, DAVE, ADMIN)
    voting = floor.voting(CAROL, DAVE)
    own = floor.moved(ADMIN, "Admins pick the next three tasks")
    assert floor.second(own, BOB).status_code == 200
    body = refused(floor.end_debate(own), 409, "test_mode_off")
    assert body == {
        "error": "test_mode_off",
        "message": "End debate now and Close the vote now work only while Test timers are on.",
    }
    refused(floor.close_vote(voting), 409, "test_mode_off")
    assert (floor.state(own), floor.state(voting)) == ("debate", "voting")
    for proposal_id in (own, voting):
        assert not {"admin_ended_debate", "admin_closed_vote"} & set(floor.kinds(proposal_id))
    refused(floor.end_debate(999), 404, "proposal_not_found")  # a missing one is still 404
    floor.testing()
    assert floor.end_debate(own).json()["proposal"]["state"] == "passed"
    assert floor.close_vote(voting).json()["proposal"]["state"] == "failed"
    assert floor.test_timers(False).status_code == 200
    refused(floor.end_debate(floor.seconded(CAROL, ALICE)), 409, "test_mode_off")


# --- the draft task -------------------------------------------------------------------


def test_a_passed_proposal_becomes_a_draft_only_admins_see(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    draft = floor.detail(proposal_id, ADMIN)["draft"]
    assert draft == {
        "title": TITLE,
        "civilianSummary": PITCH.replace("\n\n", " "),
        "acceptanceCriteria": [],
        "size": "S",
        "tierFloor": "T0",
        "rewardClass": "none",
    }
    assert "draft" not in floor.detail(proposal_id, ALICE)
    assert "draft" not in floor.detail(proposal_id)
    assert "taskId" not in floor.detail(proposal_id)


def test_an_admin_finishes_the_draft(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    body = {
        **DRAFT,
        "title": "  Dark mode​\nfor the Data app ",
        "acceptanceCriteria": ["A switch\nturns it on", "‮It remembers the choice"],
    }
    response = floor.put_draft(proposal_id, body)
    assert response.status_code == 200, response.text
    assert response.json()["draft"] == {
        **DRAFT,
        "title": "Dark mode for the Data app",
        "acceptanceCriteria": ["A switch turns it on", "It remembers the choice"],
    }
    # Editing a draft is no state change: nothing new in the public timeline.
    assert floor.kinds(proposal_id)[-1] == "task_drafted"


@pytest.mark.parametrize(
    ("change", "fields"),
    [
        ({"acceptanceCriteria": []}, ["acceptanceCriteria"]),
        ({"acceptanceCriteria": ["x"] * 11}, ["acceptanceCriteria"]),
        ({"acceptanceCriteria": ["x" * 301]}, ["acceptanceCriteria.0"]),
        ({"acceptanceCriteria": ["ok", "​"]}, ["acceptanceCriteria.1"]),
        ({"civilianSummary": "x" * 501}, ["civilianSummary"]),
        ({"civilianSummary": " ⁦ "}, ["civilianSummary"]),
        ({"title": ""}, ["title"]),
        ({"size": "XL"}, ["size"]),
        ({"tierFloor": "T3"}, ["tierFloor"]),
        ({"rewardClass": "R9"}, ["rewardClass"]),
    ],
)
def test_the_draft_is_validated(floor: Floor, change: dict[str, Any], fields: list[str]) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    body = refused(floor.put_draft(proposal_id, {**DRAFT, **change}), 400, "invalid_request")
    assert body["fields"] == fields
    assert floor.detail(proposal_id, ADMIN)["draft"]["acceptanceCriteria"] == []


def test_the_draft_only_while_passed(floor: Floor) -> None:
    in_debate = floor.seconded(ALICE, BOB)
    assert refused(floor.put_draft(in_debate, DRAFT), 409, "wrong_state")["state"] == "debate"
    done = published(floor, CAROL, DAVE)
    assert refused(floor.put_draft(done, DRAFT), 409, "wrong_state")["state"] == "building"


# --- Publish to the board --------------------------------------------------------------


def test_publish_refuses_an_unfinished_draft(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    long_pitch = "Why it matters. " * 40  # 640 characters: too long for a summary
    proposal_id = floor.moved(ALICE, TITLE, long_pitch)
    assert floor.second(proposal_id, BOB).status_code == 200
    floor.testing()
    assert floor.end_debate(proposal_id).status_code == 200
    body = refused(floor.publish(proposal_id), 400, "invalid_request")
    assert body["fields"] == ["acceptanceCriteria", "civilianSummary"]
    assert body["message"] == (
        "Finish the draft task before publishing it: check acceptanceCriteria, civilianSummary."
    )
    assert floor.state(proposal_id) == "passed"
    assert floor.get("/api/bridge/tasks").json()["tasks"][-1]["id"] < PUBLISHED_TASK_FIRST_ID


def test_publish_puts_a_task_on_the_board_and_moves_to_building(
    floor: Floor, board: BridgeEnv
) -> None:
    proposal_id = published(floor)
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["proposal"]["state"] == "building"
    assert detail["taskId"] == 10001 and detail["draft"]["taskId"] == 10001
    event = detail["events"][-1]
    assert event == {
        "at": at(floor.now()),
        "kind": "task_published",
        "actor": "octo-operator",
        "message": "octo-operator, an admin, published it to the Contribute board as task #10001.",
    }
    assert floor.detail(proposal_id)["taskId"] == 10001  # public once published
    refused(floor.publish(proposal_id), 409, "wrong_state")

    tasks = floor.get("/api/bridge/tasks").json()["tasks"]
    assert [task["id"] for task in tasks][:8] == list(range(1, 9))  # the fixtures, unchanged
    assert tasks[-1] == {
        "id": 10001,
        "title": "Dark mode for the Data app",
        "civilianSummary": "Let people switch the Data app to dark colors.",
        "size": "XS",
        "rewardClass": "R1",
        "tierFloor": "T0",
        "status": "open",
        "url": f"/propose/{proposal_id}",
        "labels": ["agent-ready", "status:open", "size:XS", "from-proposal"],
    }
    task = floor.get("/api/bridge/tasks/10001").json()
    assert task["acceptanceCriteria"] == DRAFT["acceptanceCriteria"]
    assert task["branch"] == "task/10001-dark-mode-for-the-data-app"
    assert task["brief"].startswith("FORGE task #10001: Dark mode for the Data app")
    assert task["brief"].endswith(f"Task: /propose/{proposal_id}")


def test_the_task_links_to_the_proposal_on_the_public_origin(
    floor: Floor, board: BridgeEnv
) -> None:
    floor.monkeypatch.setenv("FORGE_PUBLIC_ORIGIN", "https://forge.example/")
    proposal_id = published(floor)
    task = floor.get("/api/bridge/tasks/10001").json()
    assert task["task"]["url"] == f"https://forge.example/propose/{proposal_id}"
    assert proposals_service.task_url(7, {}) == "/propose/7"
    assert proposals_service.task_url(7, {"FORGE_PUBLIC_ORIGIN": "http://localhost:3000"}) == (
        "http://localhost:3000/propose/7"
    )
    for unusable in ("http://forge.example", "ftp://forge.example", "not a url"):
        assert proposals_service.task_url(7, {"FORGE_PUBLIC_ORIGIN": unusable}) == "/propose/7"


def test_a_published_task_is_claimable_like_any_other(floor: Floor, board: BridgeEnv) -> None:
    published(floor)
    response = floor.post("/api/bridge/claim", DAVE, {"taskId": 10001})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "taskId": 10001,
        "claimedBy": "dave-dev",
        "leaseEndsAt": at(floor.now() + timedelta(hours=48)),
        "leaseHours": 48,
    }
    card = floor.get("/api/bridge/tasks").json()["tasks"][-1]
    assert (card["status"], card["claimedBy"]) == ("claimed", "dave-dev")
    status = floor.get("/api/bridge/status/10001", DAVE).json()
    assert status["stage"] == "claimed"
    refused(floor.post("/api/bridge/claim", CAROL, {"taskId": 10001}), 409, "already_claimed")


def test_published_tasks_are_numbered_from_10001(floor: Floor) -> None:
    db = floor.db()
    first = publish_task(
        db,
        title="One",
        civilian_summary="First",
        acceptance_criteria=["a"],
        size="S",
        tier_floor="T0",
        reward_class="none",
        url="/propose/1",
        labels=["agent-ready"],
        published_by="octo-operator",
        now=floor.now(),
    )
    second = publish_task(
        db,
        title="Two",
        civilian_summary="Second",
        acceptance_criteria=["b", "c"],
        size="M",
        tier_floor="T2",
        reward_class="R3",
        url="/propose/2",
        labels=[],
        published_by="octo-operator",
        now=floor.now(),
    )
    assert (first.id, second.id) == (10001, 10002)
    source = PublishedTaskSource(db)
    assert [task.id for task in source.list_tasks()] == [10001, 10002]
    assert source.get_task(10002) == second
    assert second.acceptanceCriteria == ["b", "c"] and second.rewardUsd is None
    for missing in (1, 10000, 10003, 2**63, 2**80):
        assert source.get_task(missing) is None
    board = CompositeTaskSource(FixtureTaskSource(), source)
    assert board.get_task(1) is not None and board.get_task(10001) == first
    assert board.get_task(9999) is None
    assert [task.id for task in board.list_tasks()] == [*range(1, 9), 10001, 10002]


def test_the_default_board_serves_the_fixtures_then_the_published_tasks() -> None:
    source = bridge_service.get_task_source()
    assert isinstance(source, CompositeTaskSource)
    assert [task.id for task in source.list_tasks()] == list(range(1, 9))


# --- shipped ----------------------------------------------------------------------------


def merge(board: BridgeEnv, floor: Floor, number: int = 77) -> None:
    """DAVE claims task 10001 and his pull request for it is merged; a status read records
    the merge (the Bridge's own path)."""
    assert floor.post("/api/bridge/claim", DAVE, {"taskId": 10001}).status_code == 200
    floor.wait(timedelta(hours=1))
    branch = branch_name(10001, str(DRAFT["title"]))
    board.github.add_pull(
        number, DAVE.login, branch, state="closed", merged=True, owner_id=int(DAVE.sub)
    )
    status = floor.get("/api/bridge/status/10001", DAVE)
    assert status.status_code == 200, status.text
    assert status.json()["stage"] == "shipped"


def test_the_bridge_recording_the_merge_ships_the_proposal_once(
    floor: Floor, board: BridgeEnv
) -> None:
    proposal_id = published(floor)
    merge(board, floor)
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "shipped"
    assert detail["events"][-1] == {
        "at": at(floor.now()),
        "kind": "shipped",
        "message": "The pull request for task #10001 was merged, so it has shipped.",
    }
    # Another read of the Bridge, a tick and the hook itself again: nothing more happens.
    assert floor.get("/api/bridge/status/10001").json()["stage"] == "shipped"
    floor.tick()
    assert proposals_service.Proposals(floor.db(), floor.now()).ship(10001) is False
    assert floor.kinds(proposal_id).count("shipped") == 1


def test_a_merge_the_hook_missed_is_caught_up(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = published(floor)
    monkeypatch.setattr(bridge_service, "_shipped_hooks", [])
    merge(board, floor)
    assert floor.db().query_one(
        "SELECT state FROM proposal_motions WHERE id = ?", (proposal_id,)
    ) == {"state": "building"}
    floor.get("/api/proposals")  # a list read runs advance_all
    assert floor.state(proposal_id) == "shipped"
    assert floor.kinds(proposal_id).count("shipped") == 1


def test_a_failing_hook_never_undoes_the_merge(
    floor: Floor,
    board: BridgeEnv,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    proposal_id = published(floor)

    def broken(db: StateDB, task_id: int, now: datetime) -> None:
        db.execute("UPDATE proposal_motions SET title = 'vandalized'")
        raise RuntimeError("hook exploded")

    hooks = [broken, *bridge_service._shipped_hooks]
    monkeypatch.setattr(bridge_service, "_shipped_hooks", hooks)
    with caplog.at_level(logging.ERROR, logger="forge_api.services.bridge"):
        merge(board, floor)
    assert "A shipped hook failed for task 10001" in caplog.text
    assert floor.db().query_one("SELECT COUNT(*) AS n FROM bridge_merges") == {"n": 1}
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "shipped"  # the other hook still ran
    assert detail["proposal"]["title"] == TITLE  # the broken hook's write was undone


def test_hooks_register_once_and_ignore_tasks_without_a_proposal(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    hooks: list[bridge_service.ShippedHook] = []
    monkeypatch.setattr(bridge_service, "_shipped_hooks", hooks)

    def hook(db: StateDB, task_id: int, now: datetime) -> None:
        pass

    bridge_service.on_task_shipped(hook)
    bridge_service.on_task_shipped(hook)
    assert hooks == [hook]
    assert proposals_service.Proposals(floor.db(), floor.now()).ship(3) is False
    assert bridge_service.task_merged(floor.db(), 3) is False


TIER_NOT_OPEN = {
    "error": "tier_not_open",
    "message": "Tiers above T0 aren't open yet, so publish it as T0.",
}


@pytest.mark.parametrize("tier", ["T1", "T2"])
def test_a_draft_above_tier_t0_is_refused(floor: Floor, tier: str) -> None:
    """Review M4: every contributor is T0 until Foreman's ledger, so a draft's tier floor
    must be T0."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    response = floor.put_draft(proposal_id, {**DRAFT, "tierFloor": tier})
    assert response.status_code == 400 and response.json() == TIER_NOT_OPEN
    assert floor.detail(proposal_id, ADMIN)["draft"]["tierFloor"] == "T0"


def test_publish_refuses_a_task_nobody_could_claim(floor: Floor, board: BridgeEnv) -> None:
    """Review M4: a task published with tier floor T1 was on the board, but every claim
    was 403 tier_too_low, so its proposal sat in building forever. Publishing a draft above
    T0 (saved before the check, or written another way) is now 400 tier_not_open, and
    nothing is published."""
    floor.hello(ALICE, BOB, CAROL, ADMIN)
    proposal_id = floor.passed(ALICE, BOB)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    floor.db().execute(
        "UPDATE proposal_drafts SET tier_floor = 'T1' WHERE proposal_id = ?", (proposal_id,)
    )
    response = floor.publish(proposal_id)
    assert response.status_code == 400 and response.json() == TIER_NOT_OPEN
    assert floor.state(proposal_id) == "passed"
    assert floor.get("/api/bridge/tasks").json()["tasks"][-1]["id"] < PUBLISHED_TASK_FIRST_ID
    floor.db().execute(
        "UPDATE proposal_drafts SET tier_floor = 'T0' WHERE proposal_id = ?", (proposal_id,)
    )
    assert floor.publish(proposal_id).status_code == 200
    for who in (CAROL, BOB, ADMIN):  # anyone can take it now; the first claim wins
        response = floor.post("/api/bridge/claim", who, {"taskId": 10001})
        assert response.status_code == (200 if who == CAROL else 409), response.text


def test_publish_refuses_a_title_that_cannot_name_a_branch(floor: Floor, board: BridgeEnv) -> None:
    """Review L10: a title with no letter or digit from A to Z or 0 to 9 slugified to
    nothing, so the task's branch was `task/10001-`. Publishing it is now 400
    task_title_needs_letters."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    assert floor.put_draft(proposal_id, {**DRAFT, "title": "ダークモードを追加"}).status_code == 200
    body = refused(floor.publish(proposal_id), 400, "task_title_needs_letters")
    assert body["message"] == (
        "Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch "
        "is named after it."
    )
    assert floor.state(proposal_id) == "passed"
    assert floor.get("/api/bridge/tasks").json()["tasks"][-1]["id"] < PUBLISHED_TASK_FIRST_ID
    titled = {**DRAFT, "title": "ダークモード: dark mode"}
    assert floor.put_draft(proposal_id, titled).status_code == 200
    assert floor.publish(proposal_id).status_code == 200
    assert floor.get("/api/bridge/tasks/10001").json()["branch"] == "task/10001-dark-mode"


def test_publish_never_goes_ahead_without_a_draft(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    floor.db().execute("DELETE FROM proposal_drafts WHERE proposal_id = ?", (proposal_id,))
    body = refused(floor.publish(proposal_id), 400, "invalid_request")
    assert body["fields"] == ["draft"]
    assert floor.state(proposal_id) == "passed"


def test_the_connector_sees_published_tasks_too(floor: Floor, board: BridgeEnv) -> None:
    """The FORGE connector's tools read the same task source as the HTTP Bridge."""
    proposal_id = published(floor)
    tools = {definition.name: definition for definition in TOOLS}
    context = ToolContext(identity=DAVE, db=floor.db())
    listed = tools["list_tasks"].handler(context, {})
    assert isinstance(listed, ToolOutput) and listed.structured is not None
    assert [task["id"] for task in listed.structured["tasks"]][-1] == 10001
    task = tools["get_task"].handler(context, {"task_id": 10001})
    assert isinstance(task, ToolOutput) and task.structured is not None
    assert task.structured["issueUrl"] == f"/propose/{proposal_id}"
    assert task.structured["branch"] == "task/10001-dark-mode-for-the-data-app"
    assert task.structured["brief"].startswith("FORGE task #10001: Dark mode for the Data app")
    claimed = tools["claim_task"].handler(context, {"task_id": 10001})
    assert isinstance(claimed, ToolOutput) and claimed.structured is not None
    assert claimed.structured["claimedBy"] == "dave-dev"
