"""The house model on the floor (Phase 6 contract §1, §2, §5, §7, as amended after its
review): the job a passing proposal queues, the worker that runs it (its statuses,
retries, crash recovery, graceful stop and caps), the calls it logs, the draft it fills,
the admin's view of it, the route that asks for a new draft, and what publishing records
and closes. The fake client (house_helpers.py) stands in for the model; nothing reaches
the network."""

import asyncio
import json
import logging
import sqlite3
import threading
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api import main
from forge_api.models import DraftTaskRequest, HouseSpec
from forge_api.services import house
from forge_api.services import proposals as proposals_service
from forge_api.services.members import from_db, to_db
from forge_api.services.state import StateDB, get_state_db

from .bridge_helpers import BridgeEnv
from .conftest import AuthHeaders, FakeClock
from .house_helpers import (
    KEY,
    MODEL,
    PICK,
    WRITTEN,
    drafted,
    house_on,
    install,
    make_repo,
    message,
    status_error,
)
from .proposal_helpers import (
    ADMIN,
    ALICE,
    BOB,
    CAROL,
    DAVE,
    DRAFT,
    Floor,
    at,
    install_board,
    make_floor,
)

MINUTE = timedelta(minutes=1)
DONE_LINE = (
    "FORGE's house model drafted the task from this proposal. An admin checks it before it "
    "goes on the Contribute board."
)


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Floor:
    """The floor with the house on, reading a small repository."""
    floor = make_floor(client, clock, auth_headers, monkeypatch)
    house_on(monkeypatch, make_repo(tmp_path / "repo"))
    return floor


@pytest.fixture
def board(monkeypatch: pytest.MonkeyPatch, clock: FakeClock, floor: Floor) -> BridgeEnv:
    return install_board(monkeypatch, clock)


def passed(floor: Floor, mover: Any = ALICE, seconder: Any = BOB) -> int:
    floor.hello(mover, seconder, CAROL)
    return floor.passed(mover, seconder)


def maybe_job(floor: Floor, proposal_id: int) -> dict[str, Any] | None:
    return floor.db().query_one("SELECT * FROM house_jobs WHERE proposal_id = ?", (proposal_id,))


def job(floor: Floor, proposal_id: int) -> dict[str, Any]:
    row = maybe_job(floor, proposal_id)
    assert row is not None, f"proposal {proposal_id} has no house job"
    return row


def specs(floor: Floor, proposal_id: int) -> list[dict[str, Any]]:
    return floor.db().query_all(
        "SELECT * FROM house_specs WHERE proposal_id = ? ORDER BY id", (proposal_id,)
    )


def runs(floor: Floor) -> list[dict[str, Any]]:
    return floor.db().query_all("SELECT * FROM house_runs ORDER BY id")


def calls(floor: Floor) -> list[dict[str, Any]]:
    return floor.db().query_all("SELECT * FROM house_calls ORDER BY id")


def source(floor: Floor, proposal_id: int) -> int | None:
    row = floor.db().query_one(
        "SELECT house_spec_id FROM house_draft_sources WHERE proposal_id = ?", (proposal_id,)
    )
    return None if row is None else int(row["house_spec_id"])


def work(floor: Floor) -> str | None:
    return house.work(floor.db(), floor.clock)


def view(floor: Floor, proposal_id: int) -> Any:
    return floor.detail(proposal_id, ADMIN)["house"]


def ask(floor: Floor, proposal_id: int | str, who: Any = ADMIN) -> httpx.Response:
    return floor.post(f"/api/proposals/{proposal_id}/admin/house-draft", who)


def refused(response: httpx.Response, status: int, error: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    assert body["error"] == error, body
    return body


def set_job(floor: Floor, proposal_id: int, **values: Any) -> None:
    assignments = ", ".join(f"{name} = ?" for name in values)
    floor.db().execute(
        f"UPDATE house_jobs SET {assignments} WHERE proposal_id = ?",
        (*values.values(), proposal_id),
    )


def done(floor: Floor, monkeypatch: pytest.MonkeyPatch, proposal_id: int, **changes: Any) -> None:
    """Run the proposal's queued job to a spec."""
    install(monkeypatch, *drafted(**changes))
    assert work(floor) == "done"
    assert job(floor, proposal_id)["status"] == "done"


def publish(floor: Floor, proposal_id: int, draft: dict[str, Any] | None = None) -> None:
    """The web's publish: save the form, then publish."""
    body = draft if draft is not None else draft_body(floor, proposal_id)
    assert floor.put_draft(proposal_id, body).status_code == 200
    assert floor.publish(proposal_id).status_code == 200


def draft_body(floor: Floor, proposal_id: int) -> dict[str, Any]:
    shown = floor.detail(proposal_id, ADMIN)["draft"]
    return {key: shown[key] for key in DRAFT}


# --- queueing ---------------------------------------------------------------------------


def test_a_passing_proposal_queues_its_job(floor: Floor) -> None:
    proposal_id = passed(floor)
    queued = job(floor, proposal_id)
    decided = floor.db().query_one(
        "SELECT decided_at FROM proposal_motions WHERE id = ?", (proposal_id,)
    )
    assert queued == {
        "proposal_id": proposal_id,
        "status": "queued",
        "attempts": 0,
        "next_attempt_at": decided["decided_at"],
        "last_error": None,
        "requested_by": None,
        "requested_at": decided["decided_at"],
        "started_at": None,
        "updated_at": to_db(floor.now()),
        "run_id": None,
    }
    assert view(floor, proposal_id) == {"status": "queued"}


def test_the_job_is_queued_in_the_passing_steps_own_transaction(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When anything later in that transaction fails, neither the pass nor the job stays."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    floor.wait(timedelta(days=3))  # passes by silence on the next read
    real = proposals_service.Proposals._notify

    def notify(self: Any, subs: Any, kind: str, *args: Any, **kwargs: Any) -> None:
        if kind == "proposal_passed":
            raise RuntimeError("the bell broke")
        real(self, subs, kind, *args, **kwargs)

    monkeypatch.setattr(proposals_service.Proposals, "_notify", notify)
    with pytest.raises(RuntimeError, match="the bell broke"):
        floor.floor().advance_one(proposal_id)
    state = floor.db().query_one("SELECT state FROM proposal_motions WHERE id = ?", (proposal_id,))
    assert state == {"state": "debate"}
    assert maybe_job(floor, proposal_id) is None
    monkeypatch.setattr(proposals_service.Proposals, "_notify", real)
    assert floor.state(proposal_id) == "passed"
    assert job(floor, proposal_id)["status"] == "queued"


@pytest.mark.parametrize("switch", ["no key", "flag off"])
def test_no_job_is_queued_while_the_house_is_off(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, switch: str
) -> None:
    if switch == "no key":
        monkeypatch.delenv(house.KEY_ENV)
    else:
        floor.flags(house_spec=False)
    proposal_id = passed(floor)
    assert maybe_job(floor, proposal_id) is None
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["house"] == {
        "status": "off",
        "reason": "not_configured" if switch == "no key" else "switched_off",
    }
    assert detail["draft"] == {
        "title": "Add a dark mode to the Data app",
        "civilianSummary": "Night owls read the Data app late. A dark mode would be easier on "
        "their eyes.",
        "acceptanceCriteria": [],
        "size": "S",
        "tierFloor": "T0",
        "rewardClass": "none",
    }
    assert work(floor) is None


# --- the worker -------------------------------------------------------------------------


def test_the_worker_drafts_the_task_and_fills_a_draft_nobody_saved(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    floor.wait(MINUTE)
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    assert len(fake.calls) == 2
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["draft"] == {
        "title": WRITTEN["title"],
        "civilianSummary": WRITTEN["civilianSummary"],
        "acceptanceCriteria": WRITTEN["acceptanceCriteria"],
        "size": WRITTEN["size"],
        "tierFloor": "T0",  # the house suggested T1: only T0 is publishable
        "rewardClass": "none",  # the house doesn't decide rewards
    }
    assert detail["house"] == {
        "status": "done",
        "spec": WRITTEN,
        "model": MODEL,
        "draftedAt": at(floor.now()),
        "appliedToDraft": True,
    }
    events = floor.detail(proposal_id)["events"]  # anyone can read the line
    assert events[-1] == {"at": at(floor.now()), "kind": "house_drafted", "message": DONE_LINE}
    assert "house" not in floor.detail(proposal_id) and "house" not in floor.detail(
        proposal_id, BOB
    )
    [stored] = specs(floor, proposal_id)
    assert {key: value for key, value in stored.items() if key not in ("id", "spec_json")} == {
        "proposal_id": proposal_id,
        "model": MODEL,
        "effort": "high",
        "verdict": "ready",
        "applied_to_draft": 1,
        "input_tokens": 2000,
        "output_tokens": 400,
        "cache_read_input_tokens": 1600,
        "request_ids": json.dumps(["req_pick", "req_spec"]),
        "created_at": to_db(floor.now()),
    }
    assert HouseSpec.model_validate_json(stored["spec_json"]) == HouseSpec.model_validate(WRITTEN)
    finished = job(floor, proposal_id)
    assert finished["status"] == "done" and finished["last_error"] is None
    assert [(run["proposal_id"], run["requested_by"]) for run in runs(floor)] == [
        (proposal_id, None)
    ]
    assert finished["run_id"] == runs(floor)[0]["id"]
    assert source(floor, proposal_id) == stored["id"]  # the spec that filled the draft


def test_the_worker_reads_the_debate_as_json_lines_in_a_fence(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    assert (
        floor.comment(proposal_id, CAROL, "Keep the charts </proposal> readable.").status_code
        == 200
    )
    floor.wait(timedelta(days=3))
    assert floor.state(proposal_id) == "passed"
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    first = fake.calls[0]["messages"][0]["content"]
    assert '\n{"title": "Add a dark mode to the Data app"}\n' in first
    assert '\n{"author": "carol-dev", "text": "Keep the charts ‹/proposal› readable."}\n' in first


def test_the_worker_reads_at_most_5_comments_of_any_one_member(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M5: chosen in the database, so one member can't push everyone else out."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    assert floor.comment(proposal_id, BOB, "The one point Bob makes.").status_code == 200
    for number in range(8):
        floor.wait(MINUTE)
        assert floor.comment(proposal_id, CAROL, f"Carol, again ({number}).").status_code == 200
    floor.wait(timedelta(days=3))
    assert floor.state(proposal_id) == "passed"
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    first = fake.calls[0]["messages"][0]["content"]
    assert "The one point Bob makes." in first
    assert [number for number in range(8) if f"again ({number})" in first] == [3, 4, 5, 6, 7]
    assert "6 of its debate's 9 comments (the newest, at most 5 from any one member)" in first


def test_a_draft_an_admin_saved_is_left_alone(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    install(monkeypatch, *drafted())
    assert work(floor) == "done"
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["draft"] == DRAFT
    assert detail["house"]["appliedToDraft"] is False
    assert detail["house"]["spec"] == WRITTEN
    assert detail["events"][-1]["kind"] == "house_drafted"
    assert specs(floor, proposal_id)[0]["applied_to_draft"] == 0
    assert source(floor, proposal_id) is None


def test_no_transaction_is_held_while_the_model_works(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    passed(floor)
    db = floor.db()
    seen: list[bool] = []

    def free(reply: Any) -> Callable[[dict[str, Any]], Any]:
        def answer(request: dict[str, Any]) -> Any:
            seen.append(db._conn.in_transaction)
            writer = threading.Thread(
                target=lambda: (
                    db.execute(
                        "INSERT INTO members (sub, login, first_seen, last_seen) "
                        "VALUES ('9', 'x', '', '')"
                    )
                    if not seen[1:]
                    else None
                )
            )
            writer.start()
            writer.join(timeout=5)
            assert not writer.is_alive()
            return reply

        return answer

    pick, spec = drafted()
    install(monkeypatch, free(pick), free(spec))
    assert work(floor) == "done"
    assert seen == [False, False]


def test_jobs_run_one_at_a_time_oldest_first(floor: Floor, monkeypatch: pytest.MonkeyPatch) -> None:
    older = passed(floor, ALICE, BOB)
    floor.wait(MINUTE)
    newer = passed(floor, BOB, DAVE)
    install(monkeypatch, *drafted("The older one"), *drafted("The newer one"))
    assert work(floor) == "done"
    assert job(floor, older)["status"] == "done"
    assert job(floor, newer)["status"] == "queued"
    assert work(floor) == "done"
    assert view(floor, older)["spec"]["title"] == "The older one"
    assert view(floor, newer)["spec"]["title"] == "The newer one"
    assert work(floor) is None


def test_the_worker_does_nothing_while_the_house_is_off(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    set_job(floor, proposal_id, status="running", started_at=to_db(floor.now()))
    floor.wait(timedelta(hours=1))
    monkeypatch.delenv(house.KEY_ENV)
    assert work(floor) is None
    assert job(floor, proposal_id)["status"] == "running"
    assert view(floor, proposal_id) == {"status": "off", "reason": "not_configured"}


# --- publishing, or moving on, ends a job (M1) ------------------------------------------


def test_publishing_closes_a_queued_job_in_its_own_transaction(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M1: a job still queued when the task is published never calls the model."""
    proposal_id = passed(floor)
    publish(floor, proposal_id, DRAFT)
    assert maybe_job(floor, proposal_id) is None
    fake = install(monkeypatch, *drafted())
    assert work(floor) is None
    assert fake.calls == [] and runs(floor) == [] and calls(floor) == []
    assert "house" not in floor.detail(proposal_id, ADMIN)  # never touched (L7)


def test_publishing_while_a_job_waits_to_try_again_spends_nothing_more(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    fake = install(monkeypatch, status_error(529))
    assert work(floor) == "queued"
    publish(floor, proposal_id, DRAFT)
    floor.wait(timedelta(minutes=30))
    fake.add(*drafted())
    assert work(floor) is None
    assert len(fake.calls) == 1
    assert maybe_job(floor, proposal_id) is None


def test_a_queued_job_whose_proposal_moved_on_is_closed_with_no_call(
    floor: Floor,
    board: BridgeEnv,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """M1: the worker takes only the jobs of proposals still passed."""
    proposal_id = passed(floor)
    publish(floor, proposal_id, DRAFT)
    stamp = to_db(floor.now())  # a job left queued all the same (an older version's, say)
    floor.db().execute(
        "INSERT INTO house_jobs (proposal_id, status, attempts, next_attempt_at, requested_at, "
        "updated_at) VALUES (?, 'queued', 0, ?, ?, ?)",
        (proposal_id, stamp, stamp, stamp),
    )
    fake = install(monkeypatch, *drafted())
    with caplog.at_level(logging.INFO, logger="forge_api.services.house"):
        assert work(floor) is None
    assert fake.calls == [] and maybe_job(floor, proposal_id) is None
    assert "Closed 1 house job(s) whose proposal moved on, with no call." in caplog.text


def test_a_job_whose_proposal_is_published_mid_run_makes_no_more_calls(
    floor: Floor,
    board: BridgeEnv,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """M1: the job asks before each call whether it is still wanted."""
    proposal_id = passed(floor)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200

    def published_meanwhile(request: dict[str, Any]) -> Any:
        assert floor.publish(proposal_id).status_code == 200
        return message(PICK)

    fake = install(monkeypatch, published_meanwhile, message(WRITTEN))
    with caplog.at_level(logging.INFO, logger="forge_api.services.house"):
        assert work(floor) == "cancelled"
    assert len(fake.calls) == 1  # the spec call wasn't made
    assert maybe_job(floor, proposal_id) is None and specs(floor, proposal_id) == []
    assert f"Proposal {proposal_id} moved on while its house job ran" in caplog.text
    assert [(row["kind"], row["outcome"]) for row in calls(floor)] == [("pick", "ok")]
    assert "house" not in floor.detail(proposal_id, ADMIN)


def test_a_published_job_doesnt_take_the_days_last_slot(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, "1")
    published = passed(floor, ALICE, BOB)
    publish(floor, published, DRAFT)
    waiting = passed(floor, BOB, DAVE)
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    assert len(fake.calls) == 2
    assert view(floor, waiting)["status"] == "done"


def test_a_redraft_queued_when_the_task_is_published_leaves_the_earlier_spec_done(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    floor.wait(MINUTE)
    assert ask(floor, proposal_id).status_code == 202
    publish(floor, proposal_id)
    assert maybe_job(floor, proposal_id) is None
    assert view(floor, proposal_id)["status"] == "done"
    assert view(floor, proposal_id)["spec"] == WRITTEN


# --- switching the house off mid-job (L4) -----------------------------------------------


def test_switching_the_house_off_mid_job_stops_it_before_its_next_call(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L4: the job waits in the queue, with no failed run counted, and runs once the house
    is back on, as the same run."""
    proposal_id = passed(floor)

    def switched_off_meanwhile(request: dict[str, Any]) -> Any:
        floor.flags(house_spec=False)
        return message(PICK)

    fake = install(monkeypatch, switched_off_meanwhile, message(WRITTEN))
    assert work(floor) == "paused"
    assert len(fake.calls) == 1
    queued = job(floor, proposal_id)
    assert (queued["status"], queued["attempts"], queued["started_at"]) == ("queued", 0, None)
    assert view(floor, proposal_id) == {"status": "off", "reason": "switched_off"}
    assert "house_drafted" not in floor.kinds(proposal_id)
    monkeypatch.delenv("FORGE_FLAGS_JSON")
    fake.add(*drafted())
    assert work(floor) == "done"
    assert len(runs(floor)) == 1


def test_a_spec_that_lands_after_the_house_was_switched_off_fills_nothing(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L4: it is kept, but neither fills the draft nor goes on the timeline."""
    proposal_id = passed(floor)
    pick, spec = drafted()

    def switched_off_during_the_call(request: dict[str, Any]) -> Any:
        floor.flags(house_spec=False)
        return spec

    install(monkeypatch, pick, switched_off_during_the_call)
    assert work(floor) == "done"
    assert specs(floor, proposal_id)[0]["applied_to_draft"] == 0
    assert "house_drafted" not in floor.kinds(proposal_id)
    assert floor.detail(proposal_id, ADMIN)["draft"]["acceptanceCriteria"] == []
    monkeypatch.delenv("FORGE_FLAGS_JSON")
    assert view(floor, proposal_id)["appliedToDraft"] is False
    assert source(floor, proposal_id) is None


# --- failures ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "replies,reason",
    [
        ([message(None, stop="refusal")], "refused"),
        ([message(PICK), message(text="{"), message(text="nope")], "invalid_output"),
        ([status_error(413)], "too_large"),
        ([status_error(401)], "bad_request"),
    ],
)
def test_a_permanent_failure_fails_the_job_at_once_and_privately(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, replies: list[Any], reason: str
) -> None:
    proposal_id = passed(floor)
    before = floor.kinds(proposal_id)
    install(monkeypatch, *replies)
    assert work(floor) == "failed"
    failed = job(floor, proposal_id)
    assert (failed["status"], failed["last_error"], failed["attempts"]) == ("failed", reason, 0)
    assert view(floor, proposal_id) == {"status": "failed", "reason": reason}
    assert floor.kinds(proposal_id) == before  # failures are not public
    assert specs(floor, proposal_id) == []
    assert floor.detail(proposal_id, ADMIN)["draft"]["acceptanceCriteria"] == []


def test_a_job_with_no_protected_list_fails_with_no_call(
    floor: Floor,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """M3: it fails closed, as bad_request, logged as an error."""
    bare = make_repo(tmp_path / "bare", {"AGENTS.md": "# AGENTS.md\n"})
    monkeypatch.setenv(house.ROOT_ENV, str(bare))
    proposal_id = passed(floor)
    fake = install(monkeypatch, *drafted())
    with caplog.at_level(logging.ERROR, logger="forge_api.services.house"):
        assert work(floor) == "failed"
    assert fake.calls == []
    assert view(floor, proposal_id) == {"status": "failed", "reason": "bad_request"}
    assert "No readable protectedPaths list in .github/forge-protocol.json" in caplog.text


def test_a_transient_failure_backs_off_1_5_30_minutes_then_fails(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    install(monkeypatch, *(status_error(529) for _ in range(4)))
    for attempts, wait in ((1, 1), (2, 5), (3, 30)):
        assert work(floor) == "queued"
        queued = job(floor, proposal_id)
        assert (queued["status"], queued["attempts"], queued["last_error"]) == (
            "queued",
            attempts,
            "unavailable",
        )
        assert from_db(queued["next_attempt_at"]) == floor.now() + timedelta(minutes=wait)
        assert view(floor, proposal_id) == {"status": "queued"}
        floor.wait(timedelta(minutes=wait) - timedelta(microseconds=1))
        assert work(floor) is None  # not due yet
        floor.wait(timedelta(microseconds=1))
    assert work(floor) == "failed"
    failed = job(floor, proposal_id)
    assert (failed["attempts"], failed["last_error"]) == (4, "unavailable")
    assert view(floor, proposal_id) == {"status": "failed", "reason": "unavailable"}
    assert len(runs(floor)) == 1  # a retry is the same job
    assert [row["attempt"] for row in calls(floor)] == [1, 2, 3, 4]


def test_a_retry_that_works_drafts_the_task(floor: Floor, monkeypatch: pytest.MonkeyPatch) -> None:
    proposal_id = passed(floor)
    install(monkeypatch, status_error(500), *drafted())
    assert work(floor) == "queued"
    floor.wait(MINUTE)
    assert work(floor) == "done"
    finished = job(floor, proposal_id)
    assert finished["last_error"] is None and finished["attempts"] == 1
    assert view(floor, proposal_id)["status"] == "done"


def test_an_unexpected_error_counts_as_a_failed_run_and_logs_only_its_kind(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """L6: an exception's text can carry member or model text; only DEBUG has it."""
    proposal_id = passed(floor)
    install(monkeypatch, RuntimeError("a bug quoting Night owls read the Data app late"))
    with caplog.at_level(logging.INFO, logger="forge_api.services.house"):
        assert work(floor) == "queued"
    assert f"The house's job for proposal {proposal_id} broke (RuntimeError)" in caplog.text
    assert "Night owls" not in caplog.text
    assert job(floor, proposal_id)["attempts"] == 1
    caplog.clear()
    floor.wait(MINUTE)
    install(monkeypatch, RuntimeError("a bug quoting Night owls read the Data app late"))
    with caplog.at_level(logging.DEBUG, logger="forge_api.services.house"):
        assert work(floor) == "queued"
    assert "Night owls" in caplog.text  # the traceback, at DEBUG


def test_a_result_that_cant_be_stored_is_logged_as_lost(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """L1: a database error while storing loses a paid result: it is said, and the job
    counts a failed run (it used to sit running for 15 minutes)."""
    proposal_id = passed(floor)
    install(monkeypatch, *drafted())

    def broken(*args: Any) -> Any:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(house, "_store", broken)
    with caplog.at_level(logging.INFO, logger="forge_api.services.house"):
        assert work(floor) == "queued"
    assert (
        f"Proposal {proposal_id}'s house draft was lost: storing it failed (OperationalError); "
        "it counts as a failed run."
    ) in caplog.text
    assert "database is locked" not in caplog.text
    queued = job(floor, proposal_id)
    assert (queued["status"], queued["attempts"]) == ("queued", 1)


# --- a restart mid-call -----------------------------------------------------------------


def test_a_job_left_running_goes_back_to_the_queue_after_15_minutes(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    proposal_id = passed(floor)
    started = floor.now()
    set_job(floor, proposal_id, status="running", started_at=to_db(started))
    floor.wait(timedelta(minutes=15))
    assert house.recover(floor.db(), floor.now()) == 0
    assert work(floor) is None
    floor.wait(timedelta(microseconds=1))
    with caplog.at_level(logging.WARNING, logger="forge_api.services.house"):
        assert work(floor) is None  # recovered, and due a minute from now
    assert f"Proposal {proposal_id}'s house job was left running" in caplog.text
    queued = job(floor, proposal_id)
    assert (queued["status"], queued["attempts"], queued["last_error"]) == (
        "queued",
        1,
        "unavailable",
    )
    assert from_db(queued["next_attempt_at"]) == floor.now() + MINUTE
    floor.wait(MINUTE)
    install(monkeypatch, *drafted())
    assert work(floor) == "done"


def test_a_job_cut_off_on_its_last_run_fails(floor: Floor) -> None:
    proposal_id = passed(floor)
    set_job(floor, proposal_id, status="running", started_at=to_db(floor.now()), attempts=3)
    floor.wait(timedelta(minutes=16))
    assert house.recover(floor.db(), floor.now()) == 1
    failed = job(floor, proposal_id)
    assert (failed["status"], failed["attempts"]) == ("failed", 4)
    assert view(floor, proposal_id) == {"status": "failed", "reason": "unavailable"}


@pytest.mark.parametrize(
    "outcome",
    [
        lambda request: message(WRITTEN),
        lambda request: message(None, stop="refusal"),
        lambda request: status_error(503),
    ],
)
def test_a_run_recovered_meanwhile_keeps_nothing_of_its_result(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, outcome: Callable[[Any], Any]
) -> None:
    """Another process found the job running too long and ran it again: the late run's
    result is dropped, whatever it was."""
    proposal_id = passed(floor)

    def recovered_meanwhile(request: dict[str, Any]) -> Any:
        set_job(floor, proposal_id, started_at=to_db(floor.now() + MINUTE))
        return outcome(request)

    install(monkeypatch, message(PICK), recovered_meanwhile)
    before = floor.kinds(proposal_id)
    assert work(floor) == "stale"
    assert job(floor, proposal_id)["status"] == "running"
    assert specs(floor, proposal_id) == []
    assert floor.kinds(proposal_id) == before


def test_a_run_taken_back_meanwhile_makes_no_more_calls(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L2: before each call the run checks the job is still its own."""
    proposal_id = passed(floor)

    def taken_back_meanwhile(request: dict[str, Any]) -> Any:
        set_job(floor, proposal_id, started_at=to_db(floor.now() + MINUTE))
        return message(PICK)

    fake = install(monkeypatch, taken_back_meanwhile, message(WRITTEN))
    assert work(floor) == "stale"
    assert len(fake.calls) == 1


def test_stopping_the_api_mid_call_hands_the_job_back(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """L1: on a graceful stop the claimed job goes back to the queue, due now, with no
    failed run counted; whatever the cut-off thread finishes afterwards is dropped."""
    proposal_id = passed(floor)
    calling = threading.Event()
    release = threading.Event()

    def slow(request: dict[str, Any]) -> Any:
        calling.set()
        release.wait(10)
        return message(PICK)

    fake = install(monkeypatch, slow, message(WRITTEN))
    seen: dict[str, Any] = {}

    async def run() -> None:
        task = asyncio.create_task(house.run_worker(0.001, db_fn=get_state_db, now_fn=floor.clock))
        while not calling.is_set():
            await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        seen.update(job(floor, proposal_id))
        release.set()

    with caplog.at_level(logging.INFO, logger="forge_api.services.house"):
        asyncio.run(asyncio.wait_for(run(), timeout=10))
    assert (seen["status"], seen["attempts"], seen["started_at"]) == ("queued", 0, None)
    assert f"The API is stopping: proposal {proposal_id}'s house job goes back" in caplog.text
    assert len(fake.calls) == 1  # the thread, once released, made no further call
    assert job(floor, proposal_id)["status"] == "queued"
    assert specs(floor, proposal_id) == []
    fake.add(*drafted())
    assert work(floor) == "done"
    assert len(runs(floor)) == 1  # still one job's run: the caps count it once


@pytest.mark.parametrize("reason", ["moved_on", "off"])
def test_a_run_stopped_after_its_job_was_taken_back_changes_nothing(
    floor: Floor, reason: house.NotWantedReason
) -> None:
    """The job was recovered (or finished) between the question and the answer: the
    compare-and-set leaves it as it is."""
    proposal_id = passed(floor)
    before = job(floor, proposal_id)
    taken = house._Job(proposal_id, 0, "2026-01-01T00:00:00.000000Z", "T", "P", 0)
    assert house._not_wanted(floor.db(), taken, floor.now(), reason) == "stale"
    assert job(floor, proposal_id) == before


def test_a_job_that_finished_before_the_stop_keeps_its_result(floor: Floor) -> None:
    proposal_id = passed(floor)
    job_ = house._Job(proposal_id, 0, "2026-01-01T00:00:00.000000Z", "T", "P", 0)
    assert house.give_back(floor.db(), job_, floor.now()) is False
    assert job(floor, proposal_id)["status"] == "queued"


def test_a_spec_that_lands_after_publishing_fills_nothing(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An admin published the task while the house was still writing: the spec is kept and
    shown, but the published draft stays as it was and the timeline says nothing."""
    proposal_id = passed(floor)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    pick, spec = drafted()

    def published_meanwhile(request: dict[str, Any]) -> Any:
        assert floor.publish(proposal_id).status_code == 200
        return spec

    install(monkeypatch, pick, published_meanwhile)
    assert work(floor) == "done"
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["proposal"]["state"] == "building"
    assert detail["draft"] == {**DRAFT, "taskId": 10001}
    assert detail["house"]["appliedToDraft"] is False
    assert "house_drafted" not in floor.kinds(proposal_id)
    assert specs(floor, proposal_id)[0]["applied_to_draft"] == 0
    assert floor.db().query_all("SELECT * FROM house_publishes") == []


# --- what each call cost (L3) -----------------------------------------------------------


def test_every_call_is_logged_with_what_it_cost_and_how_long_it_took(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L3: one house_calls row per call, success or failure, with its run and attempt."""
    seconds = [0.0]
    monkeypatch.setattr(house, "monotonic", lambda: seconds[0])
    proposal_id = passed(floor)
    iterations = [
        {
            "type": "message",
            "model": MODEL,
            "input_tokens": 900,
            "output_tokens": 40,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 600,
        },
        {
            "type": "fallback_message",
            "model": "fallback-model",
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_read_input_tokens": 800,
            "cache_creation_input_tokens": 0,
        },
    ]
    fake = install(
        monkeypatch,
        status_error(529),
        message(PICK, request_id="req_pick", cache_write=600, iterations=iterations),
        message(text="{", request_id="req_bad"),
        message(WRITTEN, request_id="req_spec", model="fallback-model"),
    )

    def half_a_second() -> None:  # each event of a stream
        seconds[0] += 0.5

    fake.messages.each_event = half_a_second
    assert work(floor) == "queued"
    floor.wait(MINUTE)
    assert work(floor) == "done"
    rows = calls(floor)
    [run] = runs(floor)
    assert [
        (row["run_id"], row["attempt"], row["kind"], row["outcome"], row["request_id"])
        for row in rows
    ] == [
        (run["id"], 1, "pick", "unavailable", "req_529"),
        (run["id"], 2, "pick", "ok", "req_pick"),
        (run["id"], 2, "spec", "unusable", "req_bad"),
        (run["id"], 2, "spec", "ok", "req_spec"),
    ]
    assert {key: rows[1][key] for key in rows[1] if key not in ("id", "run_id")} == {
        "proposal_id": proposal_id,
        "attempt": 2,
        "kind": "pick",
        "model": MODEL,
        "served_by": MODEL,
        "outcome": "ok",
        "stop_reason": "end_turn",
        "input_tokens": 1000,
        "output_tokens": 200,
        "cache_read_input_tokens": 800,
        "cache_creation_input_tokens": 600,
        "iterations_input_tokens": 1900,
        "iterations_output_tokens": 240,
        "request_id": "req_pick",
        "duration_ms": 1500,
        "called_at": to_db(floor.now()),
    }
    assert (rows[0]["served_by"], rows[0]["input_tokens"], rows[0]["stop_reason"]) == (
        None,
        0,
        None,
    )
    assert rows[3]["served_by"] == "fallback-model"
    assert rows[3]["iterations_input_tokens"] is None


def test_a_failed_job_keeps_what_its_calls_cost(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L3: it used to keep nothing at all."""
    passed(floor)
    install(monkeypatch, message(PICK, output_tokens=500), message(None, stop="refusal"))
    assert work(floor) == "failed"
    assert [(row["kind"], row["outcome"], row["output_tokens"]) for row in calls(floor)] == [
        ("pick", "ok", 500),
        ("spec", "refused", 200),
    ]


# --- the daily limit --------------------------------------------------------------------


def test_a_job_past_the_daily_limit_fails_and_can_be_asked_for_tomorrow(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, "1")
    first = passed(floor, ALICE, BOB)
    second = passed(floor, BOB, DAVE)
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    assert work(floor) is None  # the second job fails before any call
    assert len(fake.calls) == 2
    assert job(floor, second)["last_error"] == "daily_limit"
    assert view(floor, second) == {"status": "failed", "reason": "daily_limit"}
    assert view(floor, first)["status"] == "done"
    midnight = datetime(2026, 8, 11, tzinfo=floor.now().tzinfo)
    body = refused(ask(floor, second), 429, "rate_limited")
    wait = int((midnight - floor.now()).total_seconds())
    assert (body["retryAfter"], body["limit"], body["scope"]) == (wait, 1, "daily")
    floor.wait(midnight - floor.now())
    assert ask(floor, second).status_code == 202
    fake.add(*drafted())
    assert work(floor) == "done"


def test_a_retry_runs_past_the_daily_limit(floor: Floor, monkeypatch: pytest.MonkeyPatch) -> None:
    """A retry was counted when its job first ran."""
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, "1")
    first = passed(floor, ALICE, BOB)
    install(monkeypatch, status_error(500), *drafted())
    assert work(floor) == "queued"
    floor.wait(MINUTE)
    assert work(floor) == "done"
    assert view(floor, first)["status"] == "done"
    assert len(runs(floor)) == 1


@pytest.mark.parametrize("limit", ["0", "0 # paused", "off", "-1"])
def test_a_daily_limit_of_zero_or_nonsense_runs_nothing(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, limit: str
) -> None:
    """M7: an unreadable limit pauses the house: it used to mean 30 a day."""
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, limit)
    proposal_id = passed(floor)
    assert work(floor) is None
    assert view(floor, proposal_id) == {"status": "failed", "reason": "daily_limit"}


def test_an_unknown_effort_runs_at_the_cheapest(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M7: it used to mean high."""
    monkeypatch.setenv(house.EFFORT_ENV, "minimal")
    passed(floor)
    fake = install(monkeypatch, *drafted())
    assert work(floor) == "done"
    assert {call["output_config"]["effort"] for call in fake.calls} == {"low"}


# --- what the admin sees ----------------------------------------------------------------


def test_the_house_shows_to_admins_from_the_pass_on(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    floor.hello(ALICE, BOB, CAROL)
    debating = floor.seconded(ALICE, BOB)
    assert "house" not in floor.detail(debating, ADMIN)
    proposal_id = floor.passed(BOB, CAROL)
    done(floor, monkeypatch, proposal_id)
    passed_view = view(floor, proposal_id)
    assert passed_view["status"] == "done"
    assert floor.publish(proposal_id).status_code == 200
    assert view(floor, proposal_id) == passed_view  # building
    assert floor.floor().ship(10001) is True
    assert view(floor, proposal_id) == passed_view  # shipped
    for who in (None, ALICE, BOB):
        assert "house" not in floor.detail(proposal_id, who)


def test_a_proposal_that_passed_while_the_house_was_off_can_be_drafted(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(house.KEY_ENV)
    proposal_id = passed(floor)
    monkeypatch.setenv(house.KEY_ENV, KEY)
    assert view(floor, proposal_id) == {"status": "failed"}  # nothing drafted it yet
    assert ask(floor, proposal_id).status_code == 202
    done(floor, monkeypatch, proposal_id)
    assert view(floor, proposal_id)["appliedToDraft"] is True


def test_a_published_proposal_the_house_never_touched_has_no_house(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L7: one from before Phase 6 (or passed while the house was off) used to read as
    failed, building and shipped ones included."""
    monkeypatch.delenv(house.KEY_ENV)
    proposal_id = passed(floor)
    monkeypatch.setenv(house.KEY_ENV, KEY)
    assert view(floor, proposal_id) == {"status": "failed"}  # passed: "hasn't drafted it yet"
    publish(floor, proposal_id, DRAFT)
    assert "house" not in floor.detail(proposal_id, ADMIN)  # building
    assert floor.floor().ship(10001) is True
    assert "house" not in floor.detail(proposal_id, ADMIN)  # shipped
    monkeypatch.delenv(house.KEY_ENV)
    assert "house" not in floor.detail(proposal_id, ADMIN)  # off makes no difference


def test_the_latest_spec_shows_whatever_happened_since(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    first = view(floor, proposal_id)
    shown = {key: first[key] for key in ("spec", "model", "draftedAt", "appliedToDraft")}
    floor.wait(MINUTE)
    assert ask(floor, proposal_id).json() == {"status": "queued", **shown}
    set_job(floor, proposal_id, status="running", started_at=to_db(floor.now()))
    assert view(floor, proposal_id) == {"status": "running", **shown}
    set_job(floor, proposal_id, status="queued", started_at=None)
    install(monkeypatch, message(None, stop="refusal"))
    assert work(floor) == "failed"
    assert view(floor, proposal_id) == {"status": "failed", "reason": "refused", **shown}
    monkeypatch.delenv(house.KEY_ENV)
    assert view(floor, proposal_id) == {"status": "off", "reason": "not_configured", **shown}


def test_a_timeline_event_of_a_kind_this_version_doesnt_know_is_left_out(
    floor: Floor, caplog: pytest.LogCaptureFixture
) -> None:
    """M8: a later version's event kind, left behind by a revert, used to fail every read
    of its proposal (a 500)."""
    proposal_id = passed(floor)
    for kind in ("house_reviewed_x1", "house_reviewed_x1", "house_reviewed_x2"):
        floor.db().execute(
            "INSERT INTO proposal_events (proposal_id, at, kind, actor, message) "
            "VALUES (?, ?, ?, NULL, 'A later version wrote this.')",
            (proposal_id, to_db(floor.now()), kind),
        )
    with caplog.at_level(logging.WARNING, logger="forge_api.services.proposals"):
        for _ in range(2):
            response = floor.get(f"/api/proposals/{proposal_id}")
            assert response.status_code == 200, response.text
            kinds = [event["kind"] for event in response.json()["events"]]
            assert not any(kind.startswith("house_reviewed") for kind in kinds)
    assert caplog.text.count("Timeline events of a kind this version doesn't know") == 2
    assert caplog.text.count("'house_reviewed_x1'") == 1


# --- asking for a new draft -------------------------------------------------------------


def test_a_new_draft_fills_a_draft_nobody_saved(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    floor.wait(timedelta(hours=1))
    response = ask(floor, proposal_id)
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "queued"
    queued = job(floor, proposal_id)
    assert (queued["requested_by"], queued["attempts"], queued["started_at"], queued["run_id"]) == (
        ADMIN.sub,
        0,
        None,
        None,
    )
    assert queued["requested_at"] == queued["next_attempt_at"] == to_db(floor.now())
    done(floor, monkeypatch, proposal_id, title="A better title")
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["draft"]["title"] == "A better title"
    assert detail["house"]["spec"]["title"] == "A better title"
    assert [row["applied_to_draft"] for row in specs(floor, proposal_id)] == [1, 1]
    assert floor.kinds(proposal_id).count("house_drafted") == 2
    assert [run["requested_by"] for run in runs(floor)] == [None, ADMIN.sub]
    assert source(floor, proposal_id) == specs(floor, proposal_id)[1]["id"]


def test_a_new_draft_leaves_a_saved_draft_alone(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    assert ask(floor, proposal_id).status_code == 202
    done(floor, monkeypatch, proposal_id, title="A better title")
    detail = floor.detail(proposal_id, ADMIN)
    assert detail["draft"] == DRAFT
    assert detail["house"]["spec"]["title"] == "A better title"
    assert detail["house"]["appliedToDraft"] is False


def test_only_a_passed_proposal_gets_a_new_draft(floor: Floor, board: BridgeEnv) -> None:
    floor.hello(ALICE, BOB, CAROL)
    debating = floor.seconded(ALICE, BOB)
    body = refused(ask(floor, debating), 409, "wrong_state")
    assert body["state"] == "debate"
    published = floor.passed(BOB, CAROL)
    assert floor.put_draft(published, DRAFT).status_code == 200
    assert floor.publish(published).status_code == 200
    assert refused(ask(floor, published), 409, "wrong_state")["state"] == "building"
    refused(ask(floor, 404), 404, "proposal_not_found")
    refused(ask(floor, "abc"), 404, "proposal_not_found")


def test_the_route_is_an_admin_route_behind_the_proposals_flag(floor: Floor) -> None:
    proposal_id = passed(floor)
    assert ask(floor, proposal_id, BOB).json() == {"error": "admin_only"}
    assert ask(floor, proposal_id, BOB).status_code == 403
    assert ask(floor, proposal_id, None).status_code == 401
    floor.flags(proposals=False)
    assert ask(floor, proposal_id).json() == {"error": "proposals-disabled"}


@pytest.mark.parametrize("switch", ["no key", "flag off"])
def test_the_route_says_when_the_house_is_off(
    floor: Floor, monkeypatch: pytest.MonkeyPatch, switch: str
) -> None:
    proposal_id = passed(floor)
    if switch == "no key":
        monkeypatch.delenv(house.KEY_ENV)
    else:
        floor.flags(house_spec=False)
    body = refused(ask(floor, proposal_id), 503, "house_off")
    assert body == {
        "error": "house_off",
        "message": "The house model is off, so it can't draft this task. Write the draft yourself.",
        "reason": "not_configured" if switch == "no key" else "switched_off",
    }


def test_the_route_refuses_while_a_job_is_queued_or_running(floor: Floor) -> None:
    proposal_id = passed(floor)
    assert refused(ask(floor, proposal_id), 409, "house_busy")["message"].startswith(
        "The house model is drafting this task already."
    )
    set_job(floor, proposal_id, status="running", started_at=to_db(floor.now()))
    refused(ask(floor, proposal_id), 409, "house_busy")


def test_one_proposal_gets_at_most_5_drafts_a_day(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    first_run = floor.now()
    done(floor, monkeypatch, proposal_id)
    for _ in range(4):
        floor.wait(timedelta(hours=1))
        assert ask(floor, proposal_id).status_code == 202
        done(floor, monkeypatch, proposal_id)
    floor.wait(timedelta(hours=1))
    response = ask(floor, proposal_id)
    body = refused(response, 429, "rate_limited")
    wait = int((first_run + timedelta(hours=24) - floor.now()).total_seconds())
    assert body == {
        "error": "rate_limited",
        "message": "The house model drafts one task at most 5 times in 24 hours. Try again later.",
        "retryAfter": wait,
        "limit": 5,
        "scope": "proposal",
    }
    assert response.headers["retry-after"] == str(wait)
    floor.wait(timedelta(seconds=wait))
    assert ask(floor, proposal_id).status_code == 202


def started(floor: Floor, proposal_id: int, count: int) -> None:
    """`count` more runs of the proposal's jobs, started a minute ago."""
    for _ in range(count):
        floor.db().execute(
            "INSERT INTO house_runs (proposal_id, requested_by, started_at) VALUES (?, NULL, ?)",
            (proposal_id, to_db(floor.now() - MINUTE)),
        )


def test_the_two_429s_say_which_cap_they_are(floor: Floor, monkeypatch: pytest.MonkeyPatch) -> None:
    """The 429 carries `scope`, so a page needn't guess from `limit`: here the daily limit
    is 5, the per-proposal cap's own number."""
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, "5")
    first = passed(floor, ALICE, BOB)
    done(floor, monkeypatch, first)
    second = passed(floor, BOB, DAVE)
    started(floor, second, 4)  # five jobs started today, one of them first's
    response = ask(floor, first)
    body = refused(response, 429, "rate_limited")
    assert (body["limit"], body["scope"]) == (5, "daily")
    assert body["message"] == (
        "The house model has drafted as many tasks today as it may (5). Try again tomorrow."
    )
    assert response.headers["retry-after"] == str(body["retryAfter"])
    started(floor, first, 4)  # and now five of first's own in 24 hours
    body = refused(ask(floor, first), 429, "rate_limited")
    assert (body["limit"], body["scope"]) == (5, "proposal")


# --- what publishing records (M6) -------------------------------------------------------


def publishes(floor: Floor) -> list[dict[str, Any]]:
    return floor.db().query_all("SELECT * FROM house_publishes ORDER BY proposal_id")


def test_publishing_without_a_house_spec_records_nothing(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(house.KEY_ENV)
    proposal_id = passed(floor)
    publish(floor, proposal_id, DRAFT)
    assert publishes(floor) == []


def test_publishing_the_house_draft_as_it_is_records_no_change(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    floor.wait(MINUTE)
    assert floor.publish(proposal_id).status_code == 200
    [row] = publishes(floor)
    spec_id = specs(floor, proposal_id)[0]["id"]
    assert row == {
        "proposal_id": proposal_id,
        "compared_spec_id": spec_id,
        "latest_spec_id": spec_id,
        "changed_fields_json": json.dumps(
            {"changed": [], "acceptanceCriteria": {"kept": 2, "added": 0, "removed": 0}}
        ),
        "published_at": to_db(floor.now()),
    }


def test_publishing_records_what_the_admin_changed(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    edited = {
        **DRAFT,
        "civilianSummary": WRITTEN["civilianSummary"],
        "acceptanceCriteria": [WRITTEN["acceptanceCriteria"][1], "A test covers the switch"],
    }
    publish(floor, proposal_id, edited)
    [row] = publishes(floor)
    assert json.loads(row["changed_fields_json"]) == {
        "changed": ["title", "acceptanceCriteria"],
        "acceptanceCriteria": {"kept": 1, "added": 1, "removed": 1},
    }
    assert DRAFT["size"] == WRITTEN["size"]


def test_publishing_compares_with_the_spec_the_draft_came_from(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M6 (the review's p4): S1 fills the draft, the admin saves it as it is, asks for
    another draft (S2 lands, unused), and publishes S1 untouched. It used to be compared
    with S2, and read as changed."""
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id, title="Spec one title", acceptanceCriteria=["One"])
    assert floor.put_draft(proposal_id, draft_body(floor, proposal_id)).status_code == 200
    assert ask(floor, proposal_id).status_code == 202
    done(floor, monkeypatch, proposal_id, title="Spec two title", acceptanceCriteria=["Two"])
    assert floor.publish(proposal_id).status_code == 200
    first, second = (row["id"] for row in specs(floor, proposal_id))
    [row] = publishes(floor)
    assert (row["compared_spec_id"], row["latest_spec_id"]) == (first, second)
    assert json.loads(row["changed_fields_json"]) == {
        "changed": [],
        "acceptanceCriteria": {"kept": 1, "added": 0, "removed": 0},
    }


def test_a_draft_saved_as_a_spec_word_for_word_comes_from_that_spec(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M6: "Use the house draft" puts a spec in the form; saved as it is, that spec becomes
    the draft's source. A save that matches no spec leaves the source as it was."""
    proposal_id = passed(floor)
    done(floor, monkeypatch, proposal_id)
    first = specs(floor, proposal_id)[0]["id"]
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    assert source(floor, proposal_id) == first
    assert ask(floor, proposal_id).status_code == 202
    done(floor, monkeypatch, proposal_id, title="Spec two title", size="M")
    second = specs(floor, proposal_id)[1]["id"]
    assert source(floor, proposal_id) == first  # S2 wasn't applied: the draft was saved
    used = {
        **DRAFT,
        **{key: view(floor, proposal_id)["spec"][key] for key in house.COMPARED_FIELDS},
    }
    publish(floor, proposal_id, used)
    assert source(floor, proposal_id) == second
    [row] = publishes(floor)
    assert row["compared_spec_id"] == row["latest_spec_id"] == second
    assert json.loads(row["changed_fields_json"])["changed"] == []


def test_without_a_source_publishing_compares_with_the_best_matching_spec(
    floor: Floor, board: BridgeEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M6: the same title first, then the most criteria in common, then the latest."""
    proposal_id = passed(floor)
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200  # saved first: no source
    done(floor, monkeypatch, proposal_id, title="One", acceptanceCriteria=["a", "b", "c"])
    floor.wait(MINUTE)
    assert ask(floor, proposal_id).status_code == 202
    done(floor, monkeypatch, proposal_id, title="Two", acceptanceCriteria=["a"])
    first, second = (row["id"] for row in specs(floor, proposal_id))
    assert source(floor, proposal_id) is None
    publish(floor, proposal_id, {**DRAFT, "title": "Three", "acceptanceCriteria": ["a", "b"]})
    assert publishes(floor)[0]["compared_spec_id"] == first  # more criteria in common
    published = DraftTaskRequest.model_validate({**DRAFT, "title": "Two"})
    floor.db().execute("DELETE FROM house_publishes")
    assert house.record_publish(floor.db(), proposal_id, published, floor.now()) is True
    assert publishes(floor)[0]["compared_spec_id"] == second  # the same title wins
    assert publishes(floor)[0]["latest_spec_id"] == second


def test_criteria_are_counted_as_written_repeats_included() -> None:
    spec = HouseSpec.model_validate({**WRITTEN, "acceptanceCriteria": ["a", "a", "b", "c"]})
    published = DraftTaskRequest.model_validate(
        {**DRAFT, "acceptanceCriteria": ["a", "b", "b", "d", "e"]}
    )
    assert house.changed_fields(spec, published)["acceptanceCriteria"] == {
        "kept": 2,
        "added": 3,
        "removed": 2,
    }
    same = DraftTaskRequest.model_validate(
        {**DRAFT, **{key: WRITTEN[key] for key in house.COMPARED_FIELDS}}
    )
    reordered = same.model_copy(update={"acceptanceCriteria": WRITTEN["acceptanceCriteria"][::-1]})
    assert house.changed_fields(HouseSpec.model_validate(WRITTEN), same)["changed"] == []
    assert house.changed_fields(HouseSpec.model_validate(WRITTEN), reordered) == {
        "changed": ["acceptanceCriteria"],
        "acceptanceCriteria": {"kept": 2, "added": 0, "removed": 0},
    }


# --- the worker loop --------------------------------------------------------------------


def test_the_worker_runs_a_beat_in_a_thread(floor: Floor, monkeypatch: pytest.MonkeyPatch) -> None:
    proposal_id = passed(floor)
    install(monkeypatch, *drafted())
    beats = threading.Event()

    def now_fn() -> datetime:
        beats.set()
        return floor.now()

    async def run() -> None:
        task = asyncio.create_task(house.run_worker(0.001, db_fn=get_state_db, now_fn=now_fn))
        while job(floor, proposal_id)["status"] != "done":
            await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(asyncio.wait_for(run(), timeout=10))
    assert beats.is_set()


def test_the_worker_survives_a_failing_beat_and_stops_when_cancelled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """L6: the error's kind at ERROR; its text (which could quote anything) only at
    DEBUG."""
    beats: list[int] = []
    done_event = threading.Event()

    def db_fn() -> StateDB:
        beats.append(1)
        if len(beats) == 1:
            raise RuntimeError("the disk is full")
        if len(beats) >= 3:
            done_event.set()
        return get_state_db()

    async def run() -> None:
        task = asyncio.create_task(house.run_worker(0.001, db_fn=db_fn))
        while not done_event.is_set():
            await asyncio.sleep(0.005)
        task.cancel()
        results = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)

    with caplog.at_level(logging.DEBUG, logger="forge_api.services.house"):
        asyncio.run(asyncio.wait_for(run(), timeout=10))
    assert len(beats) >= 3
    [error] = [record for record in caplog.records if record.levelname == "ERROR"]
    assert error.getMessage() == (
        "A house worker beat failed (RuntimeError); the next one tries again."
    )
    assert error.exc_info is None
    [debug] = [record for record in caplog.records if record.levelname == "DEBUG"]
    assert debug.exc_info is not None and "the disk is full" in caplog.text


def test_the_real_worker_waits_10_seconds_before_its_first_beat() -> None:
    assert house.WAKE_SECONDS == 10.0

    async def run() -> None:
        task = asyncio.create_task(house.run_worker())
        await asyncio.sleep(0.01)
        assert not task.done()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


def loops(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The lifespan's loops, replaced by ones that say when they start and stop."""
    seen: list[str] = []

    def loop(name: str) -> Callable[[], Any]:
        async def run() -> None:
            seen.append(f"{name} started")
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                seen.append(f"{name} cancelled")
                raise

        return run

    monkeypatch.setattr(proposals_service, "run_ticker", loop("ticker"))
    monkeypatch.setattr(house, "run_worker", loop("worker"))
    return seen


def test_the_lifespan_runs_the_worker_and_cancels_it_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """In production FORGE_HOUSE_WORKER is unset, so the worker runs."""
    monkeypatch.delenv(house.WORKER_ENV)
    seen = loops(monkeypatch)
    with TestClient(main.app) as client:
        assert client.get("/api/health").status_code == 200
        assert sorted(seen) == ["ticker started", "worker started"]
    assert sorted(seen) == [
        "ticker cancelled",
        "ticker started",
        "worker cancelled",
        "worker started",
    ]


def test_the_tests_start_the_app_with_no_house_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    """L2: conftest switches it off (FORGE_HOUSE_WORKER=off): a real worker on the real
    clock would claim and recover the tests' jobs."""
    seen = loops(monkeypatch)
    with TestClient(main.app) as client:
        assert client.get("/api/health").status_code == 200
    assert sorted(seen) == ["ticker cancelled", "ticker started"]
