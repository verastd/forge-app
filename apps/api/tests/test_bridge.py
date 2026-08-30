"""The Bridge loop: browse → claim → dispatch → watch → iterate → settle (PRD Appendix I)."""

import json

import pytest
from fastapi.testclient import TestClient

from forge_api.services import flags as flags_service
from forge_api.services.bridge import (
    SECONDS_PER_STAGE,
    STAGES,
    FixtureTaskSource,
    GitHubTaskSource,
)

from .conftest import FakeClock

CSV_TASK = 1  # size S  -> 48h lease
FLAGS_ADMIN_TASK = 7  # size M -> 96h lease


def test_task_cards_are_the_eight_starter_tasks(client: TestClient) -> None:
    tasks = client.get("/api/bridge/tasks").json()["tasks"]
    assert len(tasks) == 8
    assert [task["id"] for task in tasks] == list(range(1, 9))
    first = tasks[0]
    assert first["status"] == "open"
    assert "claimedBy" not in first  # zod .optional(): omitted, never null
    assert "agent-ready" in first["labels"]
    assert "acceptanceCriteria" not in first  # extra fixture keys are stripped


def test_claim_returns_a_lease_and_repeat_is_409(client: TestClient) -> None:
    first = client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    assert first.status_code == 200
    body = first.json()
    assert body["taskId"] == CSV_TASK
    assert body["claimedBy"] == "you"
    assert body["leaseHours"] == 48
    assert body["leaseEndsAt"].endswith("Z")

    repeat = client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    assert repeat.status_code == 409
    assert repeat.json() == {"error": "already_claimed", "claimedBy": "you"}


def test_claim_lease_hours_follow_size_class(client: TestClient) -> None:
    medium = client.post("/api/bridge/claim", json={"taskId": FLAGS_ADMIN_TASK}).json()
    assert medium["leaseHours"] == 96


def test_claim_unknown_task_is_404(client: TestClient) -> None:
    response = client.post("/api/bridge/claim", json={"taskId": 999})
    assert response.status_code == 404
    assert response.json()["error"] == "task_not_found"


def test_claimed_task_card_shows_live_lease_state(client: TestClient) -> None:
    claim = client.post("/api/bridge/claim", json={"taskId": CSV_TASK}).json()
    card = next(
        task
        for task in client.get("/api/bridge/tasks").json()["tasks"]
        if task["id"] == CSV_TASK
    )
    assert card["status"] == "claimed"
    assert card["claimedBy"] == "you"
    assert card["leaseEndsAt"] == claim["leaseEndsAt"]


def test_dispatch_without_a_claim_is_409(client: TestClient) -> None:
    response = client.post("/api/bridge/dispatch", json={"taskId": CSV_TASK, "rail": "copilot"})
    assert response.status_code == 409
    assert response.json() == {"error": "not_claimed", "taskId": CSV_TASK}


@pytest.mark.parametrize("rail", ["copilot", "jules", "cursor", "devin", "openhands"])
def test_dispatch_api_rails(client: TestClient, rail: str) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    body = client.post("/api/bridge/dispatch", json={"taskId": CSV_TASK, "rail": rail}).json()
    assert body["mode"] == "api"
    assert body["sessionRef"] == f"stub-{rail}-{CSV_TASK}"
    assert "deepLink" not in body
    assert len(body["instructions"]) == 3


@pytest.mark.parametrize(
    ("rail", "deep_link"),
    [("claude-code", "https://claude.ai/code"), ("codex", "https://chatgpt.com/codex")],
)
def test_dispatch_handoff_rails(client: TestClient, rail: str, deep_link: str) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    body = client.post("/api/bridge/dispatch", json={"taskId": CSV_TASK, "rail": rail}).json()
    assert body["mode"] == "handoff"
    assert body["deepLink"] == deep_link
    assert "sessionRef" not in body
    assert len(body["instructions"]) == 3  # copy prompt -> open agent -> paste


#: PRD §4.9 / I.2: Bridge copy is written for someone who has never seen GitHub.
#: The compiled prompt is exempt — it is addressed to the agent, not the human.
GIT_JARGON = ("pull request", " pr ", "fork", "branch", " ci ", "diff", "commit", "merge conflict")


@pytest.mark.parametrize(
    "rail", ["copilot", "jules", "cursor", "devin", "openhands", "claude-code", "codex"]
)
def test_instructions_carry_no_git_jargon(client: TestClient, rail: str) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    body = client.post("/api/bridge/dispatch", json={"taskId": CSV_TASK, "rail": rail}).json()
    for line in body["instructions"]:
        padded = f" {line.lower()} "
        assert not any(term in padded for term in GIT_JARGON), line


def test_status_details_carry_no_git_jargon(client: TestClient, clock: FakeClock) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    seen: set[str] = set()
    for _ in range(len(STAGES)):
        body = client.get(f"/api/bridge/status/{CSV_TASK}").json()
        seen.add(body["stage"])
        padded = f" {body['detail'].lower()} "
        assert not any(term in padded for term in GIT_JARGON), body["detail"]
        clock.advance(SECONDS_PER_STAGE)
    assert seen == set(STAGES)  # every stage's copy was checked


def test_compiled_prompt_is_identical_across_rails(client: TestClient) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    prompts = {
        client.post("/api/bridge/dispatch", json={"taskId": CSV_TASK, "rail": rail}).json()[
            "compiledPrompt"
        ]
        for rail in ("copilot", "jules", "cursor", "devin", "openhands", "claude-code", "codex")
    }
    assert len(prompts) == 1
    prompt = prompts.pop()
    assert "Polish the CSV export on the history page" in prompt
    assert "Let people download their activity history as a spreadsheet file." in prompt
    assert "GET /api/export returns text/csv with columns [ts, type, amount]" in prompt
    assert "Read AGENTS.md at repo root first." in prompt
    assert f"branch task/{CSV_TASK}-polish-the-csv-export" in prompt
    assert "Do not modify .github/, acceptance tests, or files outside the task scope." in prompt


def test_status_is_404_before_any_claim(client: TestClient) -> None:
    response = client.get(f"/api/bridge/status/{CSV_TASK}")
    assert response.status_code == 404
    assert response.json() == {"error": "not_claimed", "taskId": CSV_TASK}


def test_status_progresses_on_the_injected_clock(client: TestClient, clock: FakeClock) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})

    at_claim = client.get(f"/api/bridge/status/{CSV_TASK}").json()
    assert at_claim["stage"] == "claimed"
    assert "checksPassed" not in at_claim
    assert at_claim["detail"]

    clock.advance(50)
    assert client.get(f"/api/bridge/status/{CSV_TASK}").json()["stage"] == "agent_working"

    clock.advance(100)  # 150s in — stage 3 of 7, the Gauntlet is running
    in_checks = client.get(f"/api/bridge/status/{CSV_TASK}").json()
    assert in_checks["stage"] == "in_checks"
    assert (in_checks["checksPassed"], in_checks["checksTotal"]) == (3, 5)
    assert "3 of 5 checks passed" in in_checks["detail"]

    clock.advance(300)  # 485s in: past the last stage, and it stays there
    shipped = client.get(f"/api/bridge/status/{CSV_TASK}").json()
    assert shipped["stage"] == "shipped"
    assert "checksPassed" not in shipped


def test_status_at_exactly_300_seconds_is_shipped(client: TestClient, clock: FakeClock) -> None:
    client.post("/api/bridge/claim", json={"taskId": CSV_TASK})
    clock.advance(300)
    assert client.get(f"/api/bridge/status/{CSV_TASK}").json()["stage"] == "shipped"


def test_feedback_relays_the_machine_readable_failure(client: TestClient) -> None:
    body = client.post(f"/api/bridge/feedback/{CSV_TASK}").json()
    assert body["relayed"] is True
    assert "gauntlet: FAIL" in body["prompt"]
    assert "issue-1/test_csv_export.py::test_headers" in body["prompt"]
    assert "do not modify the acceptance tests" in body["prompt"]


def test_profile_shape(client: TestClient) -> None:
    profile = client.get("/api/bridge/profile").json()
    assert profile["login"] == "you"
    assert profile["tier"] == "T0"
    assert profile["merged"] == 1
    assert profile["survivalRate"] == 1.0
    assert len(profile["pendingRewards"]) == 1
    reward = profile["pendingRewards"][0]
    assert reward["rewardClass"] == "R1"
    assert reward["usdEquivalent"] == 50.0
    assert reward["survivalEndsAt"].startswith("2026-08-22")
    assert len(profile["ledger"]) == 3
    assert {event["kind"] for event in profile["ledger"]} == {
        "claim",
        "merge",
        "reward_pending",
    }


def test_fixture_source_carries_acceptance_criteria() -> None:
    tasks = FixtureTaskSource().list_tasks()
    assert len(tasks) == 8
    assert all(len(task.acceptanceCriteria) == 3 for task in tasks)
    assert all(task.url.endswith(f"/issues/{task.id}") for task in tasks)


def test_github_task_source_is_a_phase_3_stub() -> None:
    with pytest.raises(NotImplementedError):
        GitHubTaskSource().list_tasks()
    with pytest.raises(NotImplementedError):
        GitHubTaskSource().get_task(1)


#: The Bridge kill switch (PRD Appendix H.2): every route family under
#: /api/bridge/* must 404 while contribute_bridge is off, not just some of
#: them. "enabled" behavior is already covered by every test above — this
#: only needs to prove the disabled state actually blocks each route.
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/api/bridge/tasks", None),
        ("post", "/api/bridge/claim", {"taskId": CSV_TASK}),
        ("post", "/api/bridge/dispatch", {"taskId": CSV_TASK, "rail": "copilot"}),
        ("get", f"/api/bridge/status/{CSV_TASK}", None),
        ("post", f"/api/bridge/feedback/{CSV_TASK}", None),
        ("get", "/api/bridge/profile", None),
    ],
)
def test_bridge_routes_are_404_when_the_kill_switch_is_off(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"contribute_bridge": False}))
    response = client.request(method, path, json=body)
    assert response.status_code == 404
    assert response.json() == {"error": "bridge-disabled"}
