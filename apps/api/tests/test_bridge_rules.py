"""The Bridge's rules from the Phase 4 review: a lease that outlives its clock while its
pull request is open, which pull request counts, merges counted once, claim limits,
GitHub outages, hand-ins, progress reports, and relays. Each test names the finding it
holds to (scratchpad/phase4/review-{bridge,mcp,creds,web}.md)."""

import threading
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.models import Credential, DispatchRequest
from forge_api.services import bridge as bridge_service
from forge_api.services.bridge import (
    DISPATCH_LIMIT,
    MAX_EVENTS_KEPT,
    PROGRESS_LIMIT,
    Bridge,
    FixtureTaskSource,
    clean_text,
)
from forge_api.services.bridge_mcp import TOOLS
from forge_api.services.mcp_types import ToolContext, ToolError, ToolOutput
from forge_api.services.state import get_state_db

from .bridge_helpers import (
    DEVIN_KEY,
    DEVIN_ORG,
    JULES_KEY,
    OTHER,
    TEST_TASKS,
    USER,
    BridgeEnv,
    github_time,
    install_bridge,
    json_response,
    vendor_ok,
)
from .conftest import AuthHeaders, FakeClock

CSV_BRANCH = "task/1-polish-the-csv-export-in-the-data-app"
CLI_BRANCH = "task/3-polish-the-forge-cli-output-and-error-messages"
OTHER_JULES_KEY = "test-only-jules-work-account"


def pull_link(number: int) -> str:
    return f"https://github.com/verastd/forge-app/pull/{number}"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


@pytest.fixture
def me(auth_headers: AuthHeaders) -> dict[str, str]:
    headers: dict[str, str] = auth_headers(USER.sub, USER.login)
    return headers


@pytest.fixture
def them(auth_headers: AuthHeaders) -> dict[str, str]:
    headers: dict[str, str] = auth_headers(OTHER.sub, OTHER.login)
    return headers


def claim(client: TestClient, headers: dict[str, str], task_id: int = 1) -> httpx.Response:
    return client.post("/api/bridge/claim", json={"taskId": task_id}, headers=headers)


def claimed(client: TestClient, headers: dict[str, str], task_id: int = 1) -> Any:
    response = claim(client, headers, task_id)
    assert response.status_code == 200, response.text
    return response.json()


def status(client: TestClient, headers: dict[str, str] | None = None, task_id: int = 1) -> Any:
    response = client.get(f"/api/bridge/status/{task_id}", headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def checks(client: TestClient, task_id: int = 1) -> Any:
    response = client.get(f"/api/bridge/checks/{task_id}")
    assert response.status_code == 200, response.text
    return response.json()


def submit(
    client: TestClient, headers: dict[str, str], number: int, task_id: int = 1
) -> httpx.Response:
    return client.post(
        f"/api/bridge/submit/{task_id}", json={"prUrl": pull_link(number)}, headers=headers
    )


def card(client: TestClient, task_id: int) -> Any:
    tasks = client.get("/api/bridge/tasks").json()["tasks"]
    return next(task for task in tasks if task["id"] == task_id)


def profile(client: TestClient, headers: dict[str, str]) -> Any:
    response = client.get("/api/bridge/profile", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def dispatch(
    client: TestClient, headers: dict[str, str], rail: str, **extra: Any
) -> httpx.Response:
    return client.post(
        "/api/bridge/dispatch", json={"taskId": 1, "rail": rail, **extra}, headers=headers
    )


def tool(name: str, args: dict[str, Any], who: Any = USER) -> ToolOutput:
    definition = next(item for item in TOOLS if item.name == name)
    return definition.handler(ToolContext(identity=who, db=get_state_db()), args)


def refused(name: str, args: dict[str, Any], who: Any = USER) -> str:
    with pytest.raises(ToolError) as caught:
        tool(name, args, who)
    return str(caught.value)


def count(sql: str) -> int:
    row = get_state_db().query_one(sql)
    assert row is not None
    return int(row["n"])


def failing_checks(env: BridgeEnv, number: int = 9, branch: str = CSV_BRANCH) -> None:
    sha = f"{number:040x}"
    env.github.add_pull(number, USER.login, branch, sha=sha)
    env.github.set_checks(sha, ("test", "completed", "failure"))


# --- a lease and its pull request (B-H1, web M4, B-M3, B-M2) -----------------------------


def test_an_open_pull_request_holds_the_lease_past_its_clock(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """B-H1, web M4: review takes longer than the 48 h clock."""
    claimed(client, me, 1)
    pull = env.github.add_pull(10, USER.login, CSV_BRANCH)
    env.github.set_checks(pull["head"]["sha"], ("gauntlet", "completed", "success"))
    assert status(client, me)["stage"] == "in_review"
    env.clock.advance(49 * 3600)  # 2026-08-12T10:00, an hour past the clock

    held = card(client, 1)
    assert (held["status"], held["claimedBy"]) == ("claimed", USER.login)
    assert held["leaseEndsAt"] == "2026-08-13T10:00:00Z"  # never less than a day away
    taken = claim(client, them, 1)
    assert taken.status_code == 409
    assert taken.json() == {"error": "already_claimed", "claimedBy": USER.login}
    mine = status(client, me)
    assert (mine["stage"], mine["holder"], mine["prUrl"]) == (
        "in_review",
        USER.login,
        pull_link(10),
    )
    assert mine["leaseEndsAt"] == "2026-08-13T10:00:00Z"
    # Every holder right stays: feedback, and handing the task to an agent.
    assert client.post("/api/bridge/feedback/1", headers=me).status_code == 200
    assert dispatch(client, me, "codex").status_code == 200

    pull.update(state="closed", merged=True, merged_at=github_time(env.clock()))
    env.clock.advance(61)
    assert status(client)["stage"] == "shipped"
    assert profile(client, me)["merged"] == 1


def test_a_pull_request_opened_in_time_holds_the_lease_even_if_nobody_looked(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """B-H1: the agent opened it at hour 40 and nobody read the status before hour 48."""
    claimed(client, me, 1)
    env.clock.advance(40 * 3600)
    env.github.add_pull(10, USER.login, CSV_BRANCH)
    env.clock.advance(9 * 3600)
    taken = claim(client, them, 1)
    assert (taken.status_code, taken.json()["error"]) == (409, "already_claimed")
    assert status(client, me)["prUrl"] == pull_link(10)

    # One opened after the clock ran out doesn't bring a lease back.
    claimed(client, me, 3)
    env.clock.advance(49 * 3600)
    env.github.add_pull(11, USER.login, CLI_BRANCH)
    assert claimed(client, them, 3)["claimedBy"] == OTHER.login


def test_a_pull_request_closed_without_merging_is_noted_and_the_clock_runs_on(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M3: the contributor is told, and gets at least a day from the close."""
    claimed(client, me, 1)
    pull = env.github.add_pull(12, USER.login, CSV_BRANCH)
    env.github.set_checks(pull["head"]["sha"], ("hygiene", "completed", "failure"))
    assert status(client, me)["stage"] == "in_checks"
    env.clock.advance(47 * 3600)  # one hour left on the clock: 2026-08-12T08:00
    pull.update(state="closed", closed_at=github_time(env.clock()))
    env.clock.advance(61)

    seen = status(client, me)
    assert seen["stage"] == "agent_working"
    assert seen["detail"] == "Your pull request was closed without merging."
    assert seen["prUrl"] == pull_link(12) and "compareUrl" not in seen
    assert seen["leaseEndsAt"] == "2026-08-13T08:00:00Z"  # the close + 24 h
    closed = "Pull request #12 was closed without being merged."
    assert seen["events"][-1] == {
        "at": "2026-08-12T08:01:01Z",
        "kind": "submitted",
        "source": "forge",
        "message": closed,
    }
    assert [event["message"] for event in status(client)["events"]].count(closed) == 1
    notes = checks(client)
    assert (notes["state"], notes["prUrl"]) == ("no_pr", pull_link(12))
    assert notes["notes"].startswith(closed)

    env.clock.advance(23 * 3600)
    assert status(client, me)["holder"] == USER.login
    env.clock.advance(3600)  # a day after the close
    assert "Time ran out" in status(client, me)["detail"]


def test_a_new_pull_request_after_a_close_counts(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M3: after a close the contributor opens a new one and the checks follow it."""
    claimed(client, me, 1)
    pull = env.github.add_pull(12, USER.login, CSV_BRANCH)
    status(client, me)
    pull.update(state="closed")
    env.clock.advance(61)
    assert status(client, me)["stage"] == "agent_working"
    env.github.add_pull(13, USER.login, CSV_BRANCH)
    env.clock.advance(61)
    seen = status(client, me)
    assert (seen["stage"], seen["prUrl"]) == ("in_checks", pull_link(13))


def test_a_merged_task_stays_done_and_frees_the_claim_limit(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """B-M2: shipping stops counting toward the limit, and the task stays off the open
    board after its clock."""
    claimed(client, me, 1)
    claimed(client, me, 3)
    env.github.add_pull(11, USER.login, CSV_BRANCH, state="closed", merged=True)
    assert status(client, me)["stage"] == "shipped"
    claimed(client, me, 6)  # the limit is 2: the shipped task doesn't count
    env.clock.advance(49 * 3600)

    done = card(client, 1)
    assert (done["status"], done["claimedBy"]) == ("claimed", USER.login)
    assert "leaseEndsAt" not in done
    refused_claim = claim(client, them, 1)
    assert refused_claim.status_code == 409
    assert refused_claim.json() == {"error": "already_claimed", "claimedBy": USER.login}
    assert status(client)["stage"] == "shipped"
    listed = tool("list_tasks", {}).structured
    assert listed is not None and 1 not in [task["id"] for task in listed["tasks"]]
    mine = tool("get_task", {"task_id": 1}).structured
    assert mine is not None and mine["lease"] == {"state": "yours", "holder": USER.login}
    theirs = tool("get_task", {"task_id": 1}, who=OTHER)
    assert theirs.structured is not None and theirs.structured["lease"]["state"] == "taken"
    assert "was merged" in theirs.text

    # Shipped work can't be let go, so it can't be reopened that way either.
    released = client.post("/api/bridge/release/1", headers=me)
    assert (released.status_code, released.json()["error"]) == (409, "already_shipped")
    assert card(client, 1)["status"] == "claimed"
    assert claim(client, them, 1).json() == {"error": "already_claimed", "claimedBy": USER.login}
    assert status(client)["stage"] == "shipped"


def test_shipped_work_takes_no_more_holder_actions(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """Review on #18: once its pull request merged, the former holder (and their agent)
    can't start more agent sessions, send notes, hand in another pull request, report
    progress or let the task go; the lease only keeps shipped work off the board."""
    claimed(client, me, 1)
    env.github.add_pull(11, USER.login, CSV_BRANCH, state="closed", merged=True)
    assert status(client, me)["stage"] == "shipped"

    for response in (
        dispatch(client, me, "codex"),
        client.post("/api/bridge/feedback/1", headers=me),
        submit(client, me, 11),
        client.post("/api/bridge/release/1", headers=me),
    ):
        assert (response.status_code, response.json()) == (
            409,
            {"error": "already_shipped", "taskId": 1},
        )
    for name, args in (
        ("report_progress", {"task_id": 1, "stage": "working", "message": "More."}),
        ("submit_task", {"task_id": 1, "pr_url": pull_link(11)}),
        ("release_task", {"task_id": 1}),
    ):
        assert "already shipped" in refused(name, args)
    assert status(client, me)["stage"] == "shipped"


def test_an_agent_after_the_clock_is_still_the_holder_when_its_pull_request_is_open(
    env: BridgeEnv,
) -> None:
    """B-H1: the holder's own agent is the first to act after hour 48; the pull request it
    opened at hour 40 was never seen, and it still holds the task."""
    tool("claim_task", {"task_id": 1})
    env.clock.advance(40 * 3600)
    env.github.add_pull(10, USER.login, CSV_BRANCH)
    env.clock.advance(9 * 3600)
    reported = tool("report_progress", {"task_id": 1, "stage": "working", "message": "Fixing."})
    assert reported.structured is not None
    assert (reported.structured["stage"], reported.structured["prUrl"]) == (
        "in_checks",
        pull_link(10),
    )


def test_a_hinted_pull_request_is_skipped_while_github_is_down(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """mcp M1: report_progress's pr_url is checked before it counts; when it can't be
    checked, the report still lands and the hint waits."""
    tool("claim_task", {"task_id": 1})
    env.github.fail = 503
    hint = {"task_id": 1, "stage": "pr_opened", "message": "Opened it.", "pr_url": pull_link(5)}
    reported = tool("report_progress", hint)
    assert reported.structured is not None and reported.structured["stage"] == "ready_to_submit"
    assert "can't be reached" in reported.text
    lease = env.store.latest(1)
    assert lease is not None and lease.pr_number is None


def test_recording_a_pull_request_never_takes_another_leases(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """B-M1: one pull request, one task, even when two leases race to record it."""
    claimed(client, me, 1)
    claimed(client, them, 3)
    pull = env.github.add_pull(80, USER.login, CSV_BRANCH)
    assert status(client, me)["prUrl"] == pull_link(80)
    mine, theirs = env.store.latest(1), env.store.latest(3)
    assert mine is not None and theirs is not None
    found = env.github.reads().pull(80)
    assert found is not None
    assert env.store.record_pull(theirs, found).pr_number is None  # recorded on lease 1
    # A race the first check can't see: the unique index refuses it, quietly.
    env.monkeypatch.setattr(env.store, "pull_taken", lambda number, lease_id: False)
    assert env.store.record_pull(theirs, found).pr_number is None
    released = env.store.release(mine, USER.login)
    pull["head"]["sha"] = "f" * 40
    pushed = env.github.reads().pull(80)
    assert pushed is not None and pushed.head_sha == "f" * 40
    assert env.store.record_pull(released, pushed).pr_head_sha == f"{80:040x}"  # settled


# --- which pull request counts (B-M1, mcp M1, mcp L2, mcp L3) ------------------------------


def test_each_merged_pull_request_counts_once(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """mcp M1: reads never credit a merge twice, and one merge never ships two tasks."""
    claimed(client, me, 1)
    env.github.add_pull(
        41, USER.login, CSV_BRANCH, state="closed", merged=True, body="Closes #1, closes #3"
    )
    for _ in range(3):
        assert status(client, me)["stage"] == "shipped"
        assert checks(client)["state"] == "passed"
        tool("get_check_results", {"task_id": 1})
        env.clock.advance(61)
    claimed(client, me, 3)
    handed = submit(client, me, 41, task_id=3)
    assert (handed.status_code, handed.json()) == (
        400,
        {"error": "pr_not_for_task", "prNumber": 41},
    )
    hint = {"task_id": 3, "stage": "started", "message": "Starting.", "pr_url": pull_link(41)}
    assert tool("report_progress", hint).structured["stage"] == "agent_working"  # type: ignore[index]
    mine = profile(client, me)
    assert mine["merged"] == 1
    merges = [(event["refIssue"], event["refPr"]) for event in mine["ledger"] if "refPr" in event]
    assert merges == [(1, 41)]
    assert count("SELECT COUNT(*) AS n FROM bridge_merges") == 1


def test_a_pull_request_opened_before_the_claim_never_counts(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M1, mcp M1: a year-old merged pull request can't ship a fresh claim."""
    env.github.add_pull(
        3,
        USER.login,
        "docs-typo",
        state="closed",
        merged=True,
        created_at="2025-09-01T00:00:00Z",
        title="[#1] Fix a typo",
    )
    claimed(client, me, 1)
    handed = submit(client, me, 3)
    assert (handed.status_code, handed.json()) == (400, {"error": "pr_not_for_task", "prNumber": 3})
    assert status(client, me)["stage"] == "claimed"
    assert profile(client, me)["merged"] == 0


def test_only_this_tasks_work_from_the_holders_fork_counts(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M1, mcp L2: verastd/forge-app, the holder's GitHub id, opened after the claim, and
    the task named (its branch, `[#1]` in the title or "Closes #1" in the description)."""
    claimed(client, me, 1)
    not_for_task: dict[int, dict[str, Any]] = {
        51: {"branch": "fix-typo-in-readme"},  # names no task
        52: {"branch": CSV_BRANCH, "base": "someone/forge-app"},
        53: {"branch": CSV_BRANCH, "created_at": "2026-08-10T08:59:59Z"},
        54: {"branch": "elsewhere", "body": "Closes #11"},  # another task
    }
    for number, shape in not_for_task.items():
        env.github.add_pull(number, USER.login, shape.pop("branch"), **shape)
        handed = submit(client, me, number)
        assert (handed.status_code, handed.json()) == (
            400,
            {"error": "pr_not_for_task", "prNumber": number},
        )
    # Renamed on GitHub: another login, the same id. It counts.
    env.github.add_pull(55, "octo-renamed", "elsewhere", owner_id=1001, title="[#1] Export")
    handed = submit(client, me, 55)
    assert handed.status_code == 200 and handed.json()["prUrl"] == pull_link(55)
    # Whoever took over the old login: the same login, another id. It doesn't.
    env.github.add_pull(56, USER.login, CSV_BRANCH, owner_id=9999)
    squatted = submit(client, me, 56)
    assert (squatted.status_code, squatted.json()) == (
        403,
        {"error": "not_your_pr", "prNumber": 56},
    )


def test_status_never_follows_a_pull_request_from_the_holders_old_login(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """mcp L2: the head lookup goes by login, the match by GitHub id."""
    claimed(client, me, 1)
    env.github.add_pull(62, USER.login, CSV_BRANCH, owner_id=9999)
    env.github.set_checks(f"{62:040x}", ("lint", "completed", "failure"))
    seen = status(client, me)
    assert seen["stage"] == "claimed" and "prUrl" not in seen
    assert checks(client)["state"] == "no_pr"


def test_a_pull_request_belongs_to_one_task_at_most(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M1: one pull request naming two tasks is handed in for the first only."""
    claimed(client, me, 1)
    claimed(client, me, 3)
    env.github.add_pull(70, USER.login, "two-tasks", title="[#1] [#3] Both at once")
    assert submit(client, me, 70, task_id=1).status_code == 200
    second = submit(client, me, 70, task_id=3)
    assert (second.status_code, second.json()) == (
        400,
        {"error": "pr_not_for_task", "prNumber": 70},
    )
    assert "prUrl" not in status(client, me, task_id=3)


def test_after_a_release_nobody_sees_the_former_holders_pull_request(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """mcp L3: the next holder's agent never reads someone else's check output."""
    claimed(client, them, 1)
    sha = "7" * 40
    env.github.add_pull(77, OTHER.login, CSV_BRANCH, sha=sha)
    env.github.set_checks(sha, ("former-holders-check", "completed", "failure"))
    assert status(client, them)["stage"] == "in_checks"
    assert client.post("/api/bridge/release/1", headers=them).status_code == 200

    assert checks(client) == {
        "taskId": 1,
        "state": "no_pr",
        "checks": [],
        "notes": "Nobody holds this task right now, so there are no checks to read.",
    }
    after = status(client)
    assert after["stage"] == "claimed" and "prUrl" not in after
    claimed(client, me, 1)
    mine = tool("get_check_results", {"task_id": 1})
    assert mine.structured is not None and mine.structured["state"] == "no_pr"
    assert "former-holders-check" not in mine.text


# --- pull requests on other branches (B-M11, web M5) ---------------------------------------


def test_a_pull_request_on_another_branch_is_found_by_what_it_names(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M11, web M5: vendors push to branches of their own."""
    claimed(client, me, 1)
    env.github.add_pull(20, USER.login, "cursor/agent-branch", body="Fixes #1")
    seen = status(client, me)
    assert (seen["stage"], seen["prUrl"]) == ("in_checks", pull_link(20))
    searches = [request for request in env.github.requests if request.url.path == "/search/issues"]
    assert len(searches) == 1
    assert searches[0].url.params["q"] == (
        "repo:verastd/forge-app is:pr author:octo-contributor created:>=2026-08-10T09:00:00+00:00"
    )


def test_the_search_is_cached_for_a_minute(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M11: one search a minute per lease, however often the page polls."""
    claimed(client, me, 1)

    def searches() -> int:
        return sum(1 for request in env.github.requests if request.url.path == "/search/issues")

    status(client, me)
    status(client, me)
    assert searches() == 1
    env.clock.advance(61)
    status(client, me)
    assert searches() == 2


# --- GitHub trouble (B-M6, mcp M3, B-M7) ------------------------------------------------------


def test_status_stops_asking_a_failing_github(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M6: a failed read is remembered for a minute, and after five failures in a row
    polls answer at once without asking GitHub."""
    claimed(client, me, 1)
    claimed(client, me, 3)
    env.github.fail = 500
    status(client, me)
    status(client, me)  # the failure is remembered: GitHub isn't asked again
    assert len(env.github.requests) == 1
    for _ in range(4):
        env.clock.advance(61)
        status(client, me)
    before = len(env.github.requests)
    assert before == 5
    seen = status(client, me, task_id=3)  # nothing about task 3 is cached
    assert len(env.github.requests) == before
    assert "GitHub can't be reached right now" in seen["detail"]
    env.github.fail = None
    env.clock.advance(61)
    assert "can't be reached" not in status(client, me, task_id=3)["detail"]
    assert len(env.github.requests) > before


def test_hand_ins_read_through_the_cache_and_are_limited(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M7, mcp M3: ten a minute per contributor, and the same number twice costs GitHub
    one read."""
    claimed(client, me, 1)
    before = len(env.github.requests)
    for number in range(1, 11):
        assert submit(client, me, number).status_code == 404
    assert len(env.github.requests) == before + 10
    limited = submit(client, me, 11)
    assert (limited.status_code, limited.json()) == (429, {"error": "submit_limit", "limit": 10})
    assert limited.headers["retry-after"] == "60"
    assert "handed in 10 pull requests" in refused(
        "submit_task", {"task_id": 1, "pr_url": pull_link(12)}
    )
    env.clock.advance(61)
    before = len(env.github.requests)
    assert submit(client, me, 1).status_code == 404
    assert submit(client, me, 1).status_code == 404
    assert len(env.github.requests) == before + 1


# --- claims (B-M5, mcp L4, mcp L5, B-M4, B-M10) -------------------------------------------------


def test_a_task_above_t0_answers_tier_too_low(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M5, mcp L4: every account is T0 for now."""
    for task_id, floor in ((2, "T1"), (4, "T2"), (5, "T1"), (7, "T1")):
        response = claim(client, me, task_id)
        assert (response.status_code, response.json()) == (
            403,
            {"error": "tier_too_low", "tierFloor": floor},
        )
    assert "needs contributor tier T1" in refused("claim_task", {"task_id": 7})
    assert claim(client, me, 1).status_code == 200


def test_the_agents_md_task_is_for_maintainers_only() -> None:
    """mcp L5: task 4 edits a protected path by nature; its text stays as it is."""
    task = FixtureTaskSource(TEST_TASKS).get_task(4)
    assert task is not None
    assert (task.title, task.tierFloor) == ("Improve AGENTS.md build and scope instructions", "T2")


def test_your_own_task_cools_down_for_a_day_after_you_let_it_go(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """B-M4: release and re-claim no longer resets the clock."""
    claimed(client, me, 1)
    env.clock.advance(3600)
    assert client.post("/api/bridge/release/1", headers=me).status_code == 200
    again = claim(client, me, 1)
    assert (again.status_code, again.json()) == (
        409,
        {"error": "claim_cooldown", "retryAfter": 86400},
    )
    assert again.headers["retry-after"] == "86400"
    assert "less than a day ago" in refused("claim_task", {"task_id": 1})
    env.clock.advance(86399)
    assert claim(client, me, 1).json()["retryAfter"] == 1
    assert claimed(client, them, 1)["claimedBy"] == OTHER.login  # anyone else, at once


def test_your_own_task_cools_down_for_a_day_after_it_ran_out(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-M4: waiting out the clock and claiming again doesn't work either."""
    claimed(client, me, 1)
    env.clock.advance(48 * 3600)
    again = claim(client, me, 1)
    assert (again.status_code, again.json()["error"]) == (409, "claim_cooldown")
    assert again.json()["retryAfter"] == 86400
    env.clock.advance(86400)
    assert claimed(client, me, 1)["leaseEndsAt"] == "2026-08-15T09:00:00Z"


def test_claims_are_limited_per_day(client: TestClient, env: BridgeEnv, me: dict[str, str]) -> None:
    """B-M10: churn is capped (20 a day; 3 here, to stay within the fixture tasks)."""
    env.monkeypatch.setattr(bridge_service, "CLAIM_RATE_LIMIT", 3)
    for task_id in (1, 3, 6):
        claimed(client, me, task_id)
        assert client.post(f"/api/bridge/release/{task_id}", headers=me).status_code == 200
        env.clock.advance(3600)
    limited = claim(client, me, 8)
    assert (limited.status_code, limited.json()) == (
        429,
        {"error": "claim_rate_limit", "limit": 3},
    )
    assert limited.headers["retry-after"] == str(21 * 3600)  # when the first claim ages out
    assert "the most allowed" in refused("claim_task", {"task_id": 8})
    env.clock.advance(21 * 3600)
    assert claim(client, me, 8).status_code == 200


def test_the_board_reads_one_lease_per_task(env: BridgeEnv) -> None:
    """B-M10: the public board never scans every lease ever written."""
    db = get_state_db()
    db.execute(
        "INSERT INTO bridge_leases (task_id, holder_sub, holder_login, claimed_at, "
        "lease_hours, ends_at, released_at) VALUES (1, '1001', 'octo-contributor', "
        "'2026-08-01T09:00:00.000000Z', 48, '2026-08-03T09:00:00.000000Z', "
        "'2026-08-01T10:00:00.000000Z')"
    )
    statements: list[str] = []
    db._conn.set_trace_callback(statements.append)  # noqa: SLF001
    try:
        tasks = Bridge.for_tools(db).list_tasks().tasks
    finally:
        db._conn.set_trace_callback(None)  # noqa: SLF001
    assert [task.status for task in tasks] == ["open"] * 8
    reads = [sql for sql in statements if "bridge_leases" in sql]
    assert reads
    for sql in reads:
        plan = [row["detail"] for row in db.query_all("EXPLAIN QUERY PLAN " + sql)]
        assert not any(step.startswith("SCAN bridge_leases") for step in plan), (sql, plan)


# --- progress reports (mcp M2, mcp L7) ----------------------------------------------------------


def test_progress_reports_are_limited_per_task_per_hour(env: BridgeEnv) -> None:
    """mcp M2: 30 an hour per task, whoever holds it."""
    tool("claim_task", {"task_id": 1})
    report = {"task_id": 1, "stage": "working", "message": "Still going."}
    for _ in range(PROGRESS_LIMIT):
        tool("report_progress", report)
    assert refused("report_progress", report) == (
        "Task #1 has had 30 progress reports in the last hour, the most it takes. Report only "
        "milestones: started, pushed, pr_opened, blocked, done."
    )
    tool("release_task", {"task_id": 1})
    tool("claim_task", {"task_id": 1}, who=OTHER)
    assert "30 progress reports" in refused("report_progress", report, who=OTHER)
    env.clock.advance(3601)
    tool("report_progress", report, who=OTHER)


def test_a_task_keeps_its_newest_events(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """mcp M2: at most the newest 200 events per task are stored."""
    tool("claim_task", {"task_id": 1})
    for index in range(MAX_EVENTS_KEPT + 50):
        env.clock.advance(125)  # under 30 an hour
        tool("report_progress", {"task_id": 1, "stage": "working", "message": f"step {index}"})
    assert count("SELECT COUNT(*) AS n FROM bridge_events") == MAX_EVENTS_KEPT
    assert status(client, me)["events"][-1]["message"] == f"step {MAX_EVENTS_KEPT + 49}"


def test_agent_text_loses_variation_selectors_and_mark_stacks(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """mcp L7: invisible variation selectors (a hidden byte stream) and "Zalgo" stacks."""
    hidden = "OK" + "".join(chr(0xE0100 + byte) for byte in b"hidden") + " done️"
    assert clean_text(hidden) == "OK done"
    zalgo = "a" + "̶̷̸⃒" * 30 + "b"
    assert clean_text(zalgo) == "a̶̷b"
    assert clean_text("café निं") == "café निं"
    tool("claim_task", {"task_id": 1})
    tool("report_progress", {"task_id": 1, "stage": "working", "message": hidden + zalgo})
    stored = status(client, me)["events"][-1]["message"]
    assert stored == "OK donea̶̷b"


# --- dispatch and relays (B-low, web L7, CR-12, CR-4, web M8) ----------------------------------


def test_a_deeply_nested_dispatch_body_is_a_400_never_a_500(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """B-low (422): /dispatch reads its own body, so it refuses nesting past 32 the same
    way main.py does for the other Bridge routes, before parsing."""

    def send(depth: int) -> httpx.Response:
        nested = "[" * depth + "]" * depth
        return client.post(
            "/api/bridge/dispatch",
            content=f'{{"taskId": 1, "rail": "codex", "extra": {nested}}}'.encode(),
            headers={**me, "content-type": "application/json"},
        )

    claimed(client, me, 1)
    for depth in (32, 8000):  # 33 deep with the outer object; ~16 KB
        response = send(depth)
        assert (response.status_code, response.json()) == (
            400,
            {"error": "invalid_request", "fields": ["body"]},
        )
    assert send(31).status_code == 200  # 32 deep: still fine


def test_a_second_start_within_two_minutes_answers_already_started(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """web L7, CR-3: a retried click starts no second paid session."""
    env.start_rails("jules")
    claimed(client, me, 1)
    first = dispatch(client, me, "jules", credential={"key": JULES_KEY})
    assert first.status_code == 200, first.text

    def sessions() -> int:
        return sum(1 for request in env.vendor.requests if request.url.path == "/v1alpha/sessions")

    assert sessions() == 1
    again = dispatch(client, me, "jules", credential={"key": JULES_KEY})
    assert (again.status_code, again.json()) == (
        409,
        {
            "error": "already_started",
            "rail": "jules",
            "sessionUrl": "https://jules.google.com/session/31415",
        },
    )
    assert sessions() == 1
    env.clock.advance(121)
    assert dispatch(client, me, "jules", credential={"key": JULES_KEY}).status_code == 200
    assert sessions() == 2


def test_a_start_still_on_its_way_answers_already_started(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """web L7: a start the browser gave up on is still on its way to the vendor."""
    env.start_rails("jules")
    claimed(client, me, 1)
    lease = env.store.latest(1)
    assert lease is not None
    env.store.record_dispatch(lease, USER.sub, "jules", "start", "pending")
    again = dispatch(client, me, "jules", credential={"key": JULES_KEY})
    assert (again.status_code, again.json()) == (409, {"error": "already_started", "rail": "jules"})
    assert env.vendor.requests == []


def test_the_vendor_call_limit_holds_under_concurrent_relays(env: BridgeEnv) -> None:
    """CR-12, B-L1: the count and the record are one transaction."""
    env.vault_on()
    env.start_rails("jules")
    bridge = Bridge(
        env.store,
        FixtureTaskSource(TEST_TASKS),
        bridge_service.get_github_reads(),
        env.vendor.client(),
    )
    bridge.claim(USER, 1)
    bridge.dispatch(
        USER,
        DispatchRequest(
            taskId=1, rail="jules", credential=Credential(key=JULES_KEY), saveCredential=True
        ),
    )
    failing_checks(env)
    gate = threading.Barrier(30)
    relayed: list[bool] = []

    def relay() -> None:
        gate.wait()
        relayed.append(bridge.feedback(USER, 1).relayed)

    workers = [threading.Thread(target=relay) for _ in range(30)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    notes = [
        request for request in env.vendor.requests if request.url.path.endswith(":sendMessage")
    ]
    assert len(relayed) == 30
    assert relayed.count(True) == len(notes) == DISPATCH_LIMIT - 1  # one start, nine relays


def test_notes_go_only_with_the_key_that_started_the_session(
    client: TestClient, env: BridgeEnv, me: dict[str, str], them: dict[str, str]
) -> None:
    """CR-4, web M8: a session started with another key gets no notes with the saved one,
    and the holder's status says so (canRelay). Only then does the detail suggest sending
    the notes (web L3)."""
    read_them = "1 of 1 checks failed. Your agent can read the notes below and fix them."
    env.vault_on()
    env.start_rails("jules")
    claimed(client, me, 1)
    pasted = dispatch(client, me, "jules", credential={"key": OTHER_JULES_KEY})
    assert pasted.status_code == 200
    assert status(client, me)["canRelay"] is False  # nothing saved to send notes with
    env.clock.advance(121)
    saved = dispatch(client, me, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    assert saved.status_code == 200
    env.clock.advance(121)
    work = dispatch(client, me, "jules", credential={"key": OTHER_JULES_KEY})
    assert work.status_code == 200 and work.json()["credentialSaved"] is False
    failing_checks(env)

    mine = status(client, me)
    assert (mine["canRelay"], mine["detail"]) == (False, read_them)
    for seen in (status(client), status(client, them)):
        assert "canRelay" not in seen and seen["detail"] == read_them
    answer = client.post("/api/bridge/feedback/1", headers=me).json()
    assert answer["relayed"] is False
    assert not any(":sendMessage" in str(request.url) for request in env.vendor.requests)
    keys = client.get("/api/bridge/me/keys", headers=me).json()["credentials"]
    assert [key["rail"] for key in keys] == ["jules"]  # the saved key is untouched

    env.clock.advance(121)
    assert dispatch(client, me, "jules").status_code == 200  # the saved key starts one
    mine = status(client, me)
    assert (mine["canRelay"], mine["detail"]) == (
        True,
        "1 of 1 checks failed. Send the notes to your agent so it can fix them.",
    )
    assert status(client, them)["detail"] == read_them  # only the holder can send them
    assert client.post("/api/bridge/feedback/1", headers=me).json()["relayed"] is True


def test_only_a_401_on_a_relay_removes_the_saved_key(
    client: TestClient, env: BridgeEnv, me: dict[str, str]
) -> None:
    """CR-4: a 403 may only mean the session isn't that account's; the key stays."""
    env.vault_on()
    env.start_rails("devin")
    claimed(client, me, 1)
    started = dispatch(
        client,
        me,
        "devin",
        credential={"key": DEVIN_KEY, "orgId": DEVIN_ORG},
        saveCredential=True,
    )
    assert started.status_code == 200
    failing_checks(env)

    def refuse(code: int) -> None:
        env.vendor.respond = lambda request: (
            json_response(code, {"detail": "no"})
            if request.url.path.endswith("/messages")
            else vendor_ok(request)
        )

    refuse(403)
    assert client.post("/api/bridge/feedback/1", headers=me).json()["relayed"] is False
    assert len(client.get("/api/bridge/me/keys", headers=me).json()["credentials"]) == 1
    refuse(401)
    assert client.post("/api/bridge/feedback/1", headers=me).json()["relayed"] is False
    assert client.get("/api/bridge/me/keys", headers=me).json()["credentials"] == []
