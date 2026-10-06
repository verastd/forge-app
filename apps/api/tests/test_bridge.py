"""The Bridge v2 over HTTP: browse → claim → hand off → watch → iterate → settle, as real
GitHub users, with state in the database and status derived from real signals."""

import json
import re
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.models import RAILS
from forge_api.services import bridge as bridge_service
from forge_api.services import flags as flags_service
from forge_api.services.bridge import (
    DISPATCH_LIMIT,
    FixtureTaskSource,
    GitHubTaskSource,
    branch_name,
)
from forge_api.services.brief import compile_brief
from forge_api.services.state import get_state_db

from .bridge_helpers import (
    CURSOR_KEY,
    DEVIN_KEY,
    DEVIN_ORG,
    GITHUB_USER_KEY,
    JULES_KEY,
    OTHER,
    ROUTINE_TOKEN,
    ROUTINE_URL,
    USER,
    BridgeEnv,
    install_bridge,
    json_response,
)
from .conftest import AuthHeaders, FakeClock

CSV_TASK = 1  # size S  -> 48h lease
FLAGS_ADMIN_TASK = 7  # size M -> 96h lease
CSV_BRANCH = "task/1-polish-the-csv-export-in-the-data-app"

#: Plain words for people who have never used git: "pull request" and "checks" are fine.
JARGON = (" pr ", " ci ", "lease", "mcp", "branch", "commit", " diff", "merge conflict")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


@pytest.fixture
def other_headers(auth_headers: AuthHeaders) -> dict[str, str]:
    headers: dict[str, str] = auth_headers(OTHER.sub, OTHER.login)
    return headers


def task_one() -> Any:
    task = FixtureTaskSource().get_task(CSV_TASK)
    assert task is not None
    return task


def claim(client: TestClient, headers: dict[str, str], task_id: int = CSV_TASK) -> Any:
    response = client.post("/api/bridge/claim", json={"taskId": task_id}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def dispatch(
    client: TestClient, headers: dict[str, str], rail: str, **extra: Any
) -> httpx.Response:
    body = {"taskId": CSV_TASK, "rail": rail, **extra}
    return client.post("/api/bridge/dispatch", json=body, headers=headers)


def status(client: TestClient, headers: dict[str, str] | None = None) -> Any:
    response = client.get(f"/api/bridge/status/{CSV_TASK}", headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def db_bytes(path: Any) -> bytes:
    """The state database file and its WAL, as raw bytes."""
    return b"".join(item.read_bytes() for item in path.parent.glob(path.name + "*"))


def plain(text: str) -> bool:
    """No jargon in FORGE's own words. A label quoted from the task page (“…”) is the
    page's wording, so it isn't checked here."""
    padded = f" {re.sub(r'“[^”]*”', '', text).lower()} "
    return not any(term in padded for term in JARGON)


# --- browse -----------------------------------------------------------------------------


def test_task_cards_are_the_eight_starter_tasks(client: TestClient, env: BridgeEnv) -> None:
    tasks = client.get("/api/bridge/tasks").json()["tasks"]
    assert [task["id"] for task in tasks] == list(range(1, 9))
    first = tasks[0]
    assert first["status"] == "open"
    assert "claimedBy" not in first  # zod .optional(): omitted, never null
    assert "acceptanceCriteria" not in first  # extra fixture keys are stripped


def test_rails_follow_the_registry_and_start_rails_are_off_by_default(
    client: TestClient, env: BridgeEnv
) -> None:
    body = client.get("/api/bridge/rails").json()
    assert [rail["id"] for rail in body["rails"]] == list(RAILS)
    assert body["vault"] is False
    for rail in body["rails"]:
        assert rail["enabled"] is (rail["mode"] == "open")
        assert "savedCredential" not in rail  # anonymous


def test_a_start_rail_needs_both_the_flag_and_the_allowlist(
    client: TestClient, env: BridgeEnv
) -> None:
    def enabled() -> set[str]:
        rails = client.get("/api/bridge/rails").json()["rails"]
        return {rail["id"] for rail in rails if rail["enabled"] and rail["mode"] == "start"}

    env.monkeypatch.setenv("FORGE_START_RAILS", "jules, cursor,nonsense")
    assert enabled() == set()  # agent_start is off in config/flags.json
    env.flags(agent_start=True)
    assert enabled() == {"jules", "cursor"}
    env.monkeypatch.delenv("FORGE_START_RAILS")
    assert enabled() == set()


def test_saved_credential_shows_only_for_the_identified_caller(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    started = dispatch(
        client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True
    )
    assert started.status_code == 200, started.text

    mine = {
        rail["id"]: rail
        for rail in client.get("/api/bridge/rails", headers=user_headers).json()["rails"]
    }
    assert mine["jules"]["savedCredential"] is True
    assert mine["cursor"]["savedCredential"] is False
    assert "savedCredential" not in mine["claude-code"]
    theirs = client.get("/api/bridge/rails", headers=other_headers).json()["rails"]
    assert all(rail.get("savedCredential") in (False, None) for rail in theirs)
    assert client.get("/api/bridge/rails").json()["vault"] is True


def test_optional_identity_still_rejects_a_bad_header(client: TestClient, env: BridgeEnv) -> None:
    for path in (
        "/api/bridge/rails",
        f"/api/bridge/tasks/{CSV_TASK}",
        f"/api/bridge/checks/{CSV_TASK}",
    ):
        response = client.get(path, headers={"Authorization": "Bearer not-a-token"})
        assert response.status_code == 401, path
        assert response.json() == {"error": "unauthenticated"}


def test_task_detail_personalizes_the_brief(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    task = task_one()
    anonymous = client.get(f"/api/bridge/tasks/{CSV_TASK}").json()
    assert anonymous["brief"] == compile_brief(task, task.acceptanceCriteria, None)
    assert anonymous["branch"] == CSV_BRANCH
    assert anonymous["acceptanceCriteria"] == task.acceptanceCriteria
    assert anonymous["task"]["id"] == CSV_TASK
    signed_in = client.get(f"/api/bridge/tasks/{CSV_TASK}", headers=user_headers).json()
    assert signed_in["brief"] == compile_brief(task, task.acceptanceCriteria, USER.login)
    assert client.get("/api/bridge/tasks/999").status_code == 404


def test_the_brief_endpoint_is_plain_text_for_any_origin(
    client: TestClient, env: BridgeEnv
) -> None:
    task = task_one()
    response = client.get(f"/api/bridge/tasks/{CSV_TASK}/brief", params={"login": USER.login})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.text == compile_brief(task, task.acceptanceCriteria, USER.login)
    generic = compile_brief(task, task.acceptanceCriteria, None)
    for login in ("", "-bad", "a" * 40, "octo\nevil", "x y"):
        bad = client.get(f"/api/bridge/tasks/{CSV_TASK}/brief", params={"login": login})
        assert bad.text == generic
    assert client.get(f"/api/bridge/tasks/{CSV_TASK}/brief").text == generic
    assert client.get("/api/bridge/tasks/999/brief").status_code == 404


# --- claim and release ------------------------------------------------------------------


def test_claim_needs_a_signed_in_caller(client: TestClient, env: BridgeEnv) -> None:
    assert client.post("/api/bridge/claim", json={"taskId": CSV_TASK}).status_code == 401
    bad = client.post(
        "/api/bridge/claim", json={"taskId": CSV_TASK}, headers={"Authorization": "Bearer x"}
    )
    assert bad.status_code == 401


def test_claim_is_the_callers_and_repeating_it_is_idempotent(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    first = claim(client, user_headers)
    assert first["claimedBy"] == USER.login
    assert first["leaseHours"] == 48
    assert first["leaseEndsAt"] == "2026-08-12T09:00:00Z"
    env.clock.advance(60)
    assert claim(client, user_headers) == first

    taken = client.post("/api/bridge/claim", json={"taskId": CSV_TASK}, headers=other_headers)
    assert taken.status_code == 409
    assert taken.json() == {"error": "already_claimed", "claimedBy": USER.login}

    card = next(t for t in client.get("/api/bridge/tasks").json()["tasks"] if t["id"] == CSV_TASK)
    assert (card["status"], card["claimedBy"], card["leaseEndsAt"]) == (
        "claimed",
        USER.login,
        first["leaseEndsAt"],
    )
    events = status(client)["events"]
    assert [event["kind"] for event in events] == ["claimed"]  # once, not per claim call


def test_lease_hours_follow_size_class(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    # The only size M task has tier floor T1, above every account's T0 for now.
    env.monkeypatch.setattr(bridge_service, "caller_tier", lambda identity: "T1")
    assert claim(client, user_headers, FLAGS_ADMIN_TASK)["leaseHours"] == 96


def test_claim_unknown_task_is_404(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    response = client.post("/api/bridge/claim", json={"taskId": 999}, headers=user_headers)
    assert response.status_code == 404
    assert response.json() == {"error": "task_not_found", "taskId": 999}


def test_claim_limit_counts_active_leases(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    # Tasks 1, 3, 6 and 8 are the T0 ones.
    claim(client, user_headers, 1)
    claim(client, user_headers, 3)
    third = client.post("/api/bridge/claim", json={"taskId": 6}, headers=user_headers)
    assert third.status_code == 409
    assert third.json() == {"error": "claim_limit", "limit": 2}
    env.monkeypatch.setenv("FORGE_MAX_ACTIVE_CLAIMS", "3")
    claim(client, user_headers, 6)
    env.monkeypatch.setenv("FORGE_MAX_ACTIVE_CLAIMS", "nonsense")  # back to the default
    assert (
        client.post("/api/bridge/claim", json={"taskId": 8}, headers=user_headers).status_code
        == 409
    )


def test_an_expired_lease_frees_the_task(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    env.clock.advance(48 * 3600)
    expired = status(client, user_headers)
    assert expired["stage"] == "claimed"
    assert "Time ran out" in expired["detail"]
    assert "holder" not in expired and "compareUrl" not in expired
    assert claim(client, other_headers)["claimedBy"] == OTHER.login
    assert [event["kind"] for event in status(client)["events"]] == ["claimed"]  # the new lease's


def test_release_by_the_holder_opens_the_task_again(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    assert client.post(f"/api/bridge/release/{CSV_TASK}", headers=other_headers).status_code == 403
    released = client.post(f"/api/bridge/release/{CSV_TASK}", headers=user_headers)
    assert released.status_code == 200
    body = released.json()
    assert "holder" not in body
    assert [event["kind"] for event in body["events"]] == ["claimed", "released"]
    assert body["events"][-1]["message"] == f"{USER.login} let this task go."
    assert "let go" in body["detail"]
    again = client.post(f"/api/bridge/release/{CSV_TASK}", headers=user_headers)
    assert again.status_code == 409
    assert again.json() == {"error": "not_claimed", "taskId": CSV_TASK}
    assert claim(client, other_headers)["claimedBy"] == OTHER.login


# --- dispatch: open rails ---------------------------------------------------------------


def test_dispatch_needs_the_holder(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    unclaimed = dispatch(client, user_headers, "claude-code")
    assert unclaimed.status_code == 409
    assert unclaimed.json() == {"error": "not_claimed", "taskId": CSV_TASK}
    claim(client, user_headers)
    stolen = dispatch(client, other_headers, "claude-code")
    assert stolen.status_code == 403
    assert stolen.json() == {"error": "not_holder", "taskId": CSV_TASK}
    assert dispatch(client, {}, "claude-code").status_code == 401


def test_an_open_rail_records_one_opened_event(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    task = task_one()
    body = dispatch(client, user_headers, "claude-code").json()
    assert body == {
        "mode": "open",
        "rail": "claude-code",
        "brief": compile_brief(task, task.acceptanceCriteria, USER.login),
        "startedAt": "2026-08-10T09:00:00Z",
    }
    env.clock.advance(60)
    dispatch(client, user_headers, "claude-code")  # a second tap: nothing new
    seen = status(client, user_headers)
    assert [event["kind"] for event in seen["events"]] == ["claimed", "opened"]
    assert seen["events"][1]["rail"] == "claude-code"
    assert seen["stage"] == "agent_working"
    assert seen["rail"] == "claude-code"
    assert "press send" in seen["detail"]
    env.clock.advance(10 * 60)
    dispatch(client, user_headers, "claude-code")
    assert len(status(client)["events"]) == 3
    assert env.vendor.requests == []  # open rails never call a vendor


# --- dispatch: start rails --------------------------------------------------------------


def test_start_rails_are_disabled_until_switched_on(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    off = dispatch(client, user_headers, "jules", credential={"key": JULES_KEY})
    assert off.status_code == 400
    assert off.json() == {"error": "rail_disabled", "rail": "jules"}
    env.start_rails("cursor")
    assert dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}).status_code == 400
    assert env.vendor.requests == []


def test_a_start_rail_needs_a_credential(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.start_rails("jules", "copilot")
    claim(client, user_headers)
    for rail in ("jules", "copilot"):
        response = dispatch(client, user_headers, rail)
        assert response.status_code == 400
        assert response.json() == {"error": "credential_required", "rail": rail}


def test_jules_starts_and_saves_the_key_sealed(
    client: TestClient,
    env: BridgeEnv,
    user_headers: dict[str, str],
    state_db_path: Any,
) -> None:
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    response = dispatch(
        client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "start"
    assert body["sessionUrl"] == "https://jules.google.com/session/31415"
    assert body["sessionRef"] == "sessions/31415"
    assert body["credentialSaved"] is True
    created = env.vendor.requests[-1]
    assert created.headers["x-goog-api-key"] == JULES_KEY
    sent = json.loads(created.content)
    assert sent["prompt"] == body["brief"]
    assert sent["sourceContext"]["workingBranch"] == CSV_BRANCH
    assert sent["sourceContext"]["source"] == "sources/github/octo-contributor/forge-app"

    keys = client.get("/api/bridge/me/keys", headers=user_headers).json()
    assert keys == {
        "credentials": [{"rail": "jules", "hint": "…tial", "savedAt": "2026-08-10T09:00:00Z"}],
        "vault": True,
    }
    assert JULES_KEY.encode() not in db_bytes(state_db_path)  # sealed, never plain text
    seen = status(client, user_headers)
    assert seen["stage"] == "agent_working"
    assert seen["sessionUrl"] == body["sessionUrl"]
    assert "Google Jules is working on it" in seen["detail"]
    assert "sessionUrl" not in status(client)  # holder only
    assert "compareUrl" not in status(client)


def test_a_saved_key_makes_the_next_start_one_click(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    env.clock.advance(120)
    again = dispatch(client, user_headers, "jules")
    assert again.status_code == 200, again.text
    assert again.json()["credentialSaved"] is True
    assert env.vendor.requests[-1].headers["x-goog-api-key"] == JULES_KEY
    saved = client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"][0]
    assert saved["lastUsedAt"] == "2026-08-10T09:02:00Z"


def test_save_without_a_vault_is_ignored(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.start_rails("jules")
    claim(client, user_headers)
    body = dispatch(
        client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True
    ).json()
    assert body["credentialSaved"] is False
    assert client.get("/api/bridge/me/keys", headers=user_headers).json() == {
        "credentials": [],
        "vault": False,
    }
    assert dispatch(client, user_headers, "jules").json()["error"] == "credential_required"


def test_copilot_uses_the_one_time_token_and_never_saves_it(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], state_db_path: Any
) -> None:
    env.vault_on()
    env.start_rails("copilot")
    claim(client, user_headers)
    body = dispatch(
        client,
        user_headers,
        "copilot",
        credential={"key": GITHUB_USER_KEY},
        saveCredential=True,
    ).json()
    assert body["credentialSaved"] is False
    assert body["sessionUrl"].startswith("https://github.com/")
    sent = env.vendor.requests[-1]
    assert sent.url.path == "/agents/repos/octo-contributor/forge-app/tasks"
    assert sent.headers["authorization"] == f"Bearer {GITHUB_USER_KEY}"
    assert client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"] == []
    assert GITHUB_USER_KEY.encode() not in db_bytes(state_db_path)


@pytest.mark.parametrize(
    ("rail", "credential", "field"),
    [
        ("jules", {"key": "has a space"}, "key"),
        ("devin", {"key": DEVIN_KEY}, "orgId"),
        ("devin", {"key": DEVIN_KEY, "orgId": "../evil"}, "orgId"),
        ("claude-routine", {"key": ROUTINE_TOKEN}, "routineUrl"),
        (
            "claude-routine",
            {
                "key": ROUTINE_TOKEN,
                "routineUrl": "https://evil.example/v1/claude_code/routines/trig_1/fire",
            },
            "routineUrl",
        ),
    ],
)
def test_credential_shapes_are_checked_before_any_vendor_call(
    client: TestClient,
    env: BridgeEnv,
    user_headers: dict[str, str],
    rail: str,
    credential: dict[str, str],
    field: str,
) -> None:
    env.start_rails(rail)
    claim(client, user_headers)
    response = dispatch(client, user_headers, rail, credential=credential)
    assert response.status_code == 400
    assert response.json() == {"error": "credential_invalid", "rail": rail, "field": field}
    assert env.vendor.requests == []


def test_a_malformed_dispatch_body_is_never_echoed(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.start_rails("jules")
    claim(client, user_headers)
    too_long = "test-only-" + "x" * 4100
    response = dispatch(client, user_headers, "jules", credential={"key": too_long})
    assert response.status_code == 400
    assert response.json() == {
        "error": "credential_invalid",
        "fields": ["credential.key"],
        "rail": "jules",
    }
    assert "x" * 50 not in response.text
    wrong = dispatch(client, user_headers, "jules", credential={"key": 123})
    assert wrong.status_code == 400 and "123" not in wrong.text
    bad_rail = dispatch(client, user_headers, "nope")
    assert bad_rail.status_code == 422
    assert bad_rail.json() == {"error": "invalid_request", "fields": ["rail"]}
    for raw in (b"not json", b"[1, 2]", b'"test-only-loose-string"'):
        response = client.post(
            "/api/bridge/dispatch",
            content=raw,
            headers={**user_headers, "content-type": "application/json"},
        )
        assert response.status_code == 422
        assert response.json() == {"error": "invalid_request", "fields": ["body"]}
    huge = client.post(
        "/api/bridge/dispatch",
        content=b"{" + b" " * (17 * 1024) + b"}",
        headers={**user_headers, "content-type": "application/json"},
    )
    assert huge.status_code == 413


def test_a_rejected_saved_key_is_deleted(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("cursor")
    claim(client, user_headers)
    first = dispatch(
        client, user_headers, "cursor", credential={"key": CURSOR_KEY}, saveCredential=True
    )
    assert first.status_code == 200, first.text
    env.vendor.respond = lambda request: json_response(401, {"error": "Unauthorized"})
    env.clock.advance(121)  # past the two minutes in which a start answers already_started
    rejected = dispatch(client, user_headers, "cursor")
    assert rejected.status_code == 400
    assert rejected.json() == {"error": "credential_rejected", "rail": "cursor"}
    assert client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"] == []


def test_a_rejected_pasted_key_is_not_saved(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("devin")
    claim(client, user_headers)
    env.vendor.respond = lambda request: json_response(403, {"title": "Forbidden", "status": 403})
    response = dispatch(
        client,
        user_headers,
        "devin",
        credential={"key": DEVIN_KEY, "orgId": DEVIN_ORG},
        saveCredential=True,
    )
    assert response.json() == {"error": "credential_rejected", "rail": "devin"}
    assert client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"] == []


def test_setup_needed_and_vendor_failures_are_plain(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.start_rails("jules", "claude-routine")
    claim(client, user_headers)
    env.vendor.respond = lambda request: json_response(200, {"sources": []})
    setup = dispatch(client, user_headers, "jules", credential={"key": JULES_KEY})
    assert setup.status_code == 400
    body = setup.json()
    assert body["error"] == "rail_setup_needed" and body["rail"] == "jules"
    assert "octo-contributor/forge-app" in body["message"]

    env.vendor.respond = lambda request: json_response(503, {"type": "error"})
    failed = dispatch(
        client,
        user_headers,
        "claude-routine",
        credential={"key": ROUTINE_TOKEN, "routineUrl": ROUTINE_URL},
    )
    assert failed.status_code == 502
    assert failed.json() == {"error": "rail_failed", "rail": "claude-routine", "status": 503}
    assert status(client, user_headers)["stage"] == "claimed"  # failed starts aren't work


def test_vendor_calls_are_limited_per_user_per_hour(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.start_rails("openhands")
    claim(client, user_headers)
    env.vendor.respond = lambda request: json_response(500, {"detail": "boom"})
    for _ in range(DISPATCH_LIMIT):
        env.clock.advance(60)
        assert (
            dispatch(
                client, user_headers, "openhands", credential={"key": "test-only-oh"}
            ).status_code
            == 502
        )
    limited = dispatch(client, user_headers, "openhands", credential={"key": "test-only-oh"})
    assert limited.status_code == 429
    assert limited.json() == {"error": "dispatch_limit", "limit": DISPATCH_LIMIT}
    # The first call (at +1 min) leaves the hour's window 51 minutes from now (+10 min).
    assert limited.headers["retry-after"] == "3060"
    assert len(env.vendor.requests) == DISPATCH_LIMIT
    env.clock.advance(3061)
    env.vendor.respond = lambda request: json_response(200, {"id": "t", "status": "WORKING"})
    assert (
        dispatch(client, user_headers, "openhands", credential={"key": "test-only-oh"}).status_code
        == 200
    )


# --- watch --------------------------------------------------------------------------------


def test_status_is_404_before_any_claim(client: TestClient, env: BridgeEnv) -> None:
    response = client.get(f"/api/bridge/status/{CSV_TASK}")
    assert response.status_code == 404
    assert response.json() == {"error": "not_claimed", "taskId": CSV_TASK}
    assert client.get("/api/bridge/status/999").status_code == 404


def test_a_fresh_claim_is_claimed_with_a_compare_link_for_the_holder(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    mine = status(client, user_headers)
    assert mine["stage"] == "claimed"
    assert mine["holder"] == USER.login
    assert mine["leaseEndsAt"] == "2026-08-12T09:00:00Z"
    assert "for about 48 hours" in mine["detail"]
    assert mine["compareUrl"] == (
        f"https://github.com/verastd/forge-app/compare/main...{USER.login}:{CSV_BRANCH}?expand=1"
    )
    assert "compareUrl" not in status(client)


def progress(env: BridgeEnv, stage: str, message: str = "note", pr_url: str | None = None) -> Any:
    bridge = bridge_service.Bridge.for_tools(get_state_db())
    return bridge.report_progress(USER, CSV_TASK, stage, message, pr_url)  # type: ignore[arg-type]


def test_stages_follow_the_real_signals(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    progress(env, "started", "Reading AGENTS.md")
    working = status(client, user_headers)
    assert working["stage"] == "agent_working"
    assert working["events"][-1] == {
        "at": "2026-08-10T09:00:00Z",
        "kind": "progress",
        "source": "agent",
        "message": "Reading AGENTS.md",
        "stage": "started",
    }
    progress(env, "blocked", "Need the export format")
    assert "stuck" in status(client, user_headers)["detail"]

    progress(env, "pushed", "Pushed the fix")
    ready = status(client, user_headers)
    assert ready["stage"] == "ready_to_submit"
    assert "compareUrl" in ready
    # It names the compare link as the task page labels it.
    assert ready["detail"] == (
        "Your agent says the work is ready, but there's no pull request for it yet. Use “When "
        "your agent has pushed its branch: open the pull request”, or ask your agent to open it."
    )

    sha = "a" * 40
    env.github.add_pull(12, USER.login, CSV_BRANCH, sha=sha)
    env.clock.advance(61)  # past the 60 s cache
    no_checks = status(client, user_headers)
    assert no_checks["stage"] == "in_checks"
    assert no_checks["prUrl"] == "https://github.com/verastd/forge-app/pull/12"
    assert "compareUrl" not in no_checks
    assert "haven't started" in no_checks["detail"]

    env.github.set_checks(sha, ("lint", "completed", "success"), ("test", "in_progress", None))
    env.clock.advance(61)
    running = status(client, user_headers)
    assert (running["checksPassed"], running["checksTotal"]) == (1, 2)
    assert "1 of 2 checks passed" in running["detail"]

    env.github.set_checks(sha, ("lint", "completed", "success"), ("test", "completed", "failure"))
    env.clock.advance(61)
    failed = status(client, user_headers)
    assert failed["stage"] == "in_checks"
    # Nothing was started with a saved key, so there is no "Send the notes" to point at.
    assert (failed["canRelay"], failed["detail"]) == (
        False,
        "1 of 2 checks failed. Your agent can read the notes below and fix them.",
    )

    env.github.set_checks(sha, ("lint", "completed", "success"), ("test", "completed", "success"))
    env.clock.advance(61)
    review = status(client, user_headers)
    assert review["stage"] == "in_review"
    assert (review["checksPassed"], review["checksTotal"]) == (2, 2)

    env.github.pulls[0].update(state="closed", merged=True, merged_at="2026-08-11T10:00:00Z")
    env.clock.advance(61)
    shipped = status(client, user_headers)
    assert shipped["stage"] == "shipped"
    assert "checksPassed" not in shipped
    env.github.fail = 500  # a merge is remembered: GitHub isn't asked again
    env.clock.advance(61)
    assert status(client, user_headers)["stage"] == "shipped"


def test_every_stage_detail_is_plain_words(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    seen = [status(client, user_headers)["detail"]]
    dispatch(client, user_headers, "codex")
    seen.append(status(client, user_headers)["detail"])
    progress(env, "working")
    seen.append(status(client, user_headers)["detail"])
    progress(env, "done")
    seen.append(status(client, user_headers)["detail"])
    env.github.add_pull(5, USER.login, CSV_BRANCH, sha="b" * 40)
    env.clock.advance(61)
    seen.append(status(client, user_headers)["detail"])
    for detail in seen:
        assert detail and plain(detail), detail


def test_a_pull_request_from_another_fork_is_ignored(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    env.github.add_pull(40, "someone-else", "task/1-whatever")
    progress(env, "pr_opened", "Opened it", "https://github.com/verastd/forge-app/pull/40")
    seen = status(client, user_headers)
    assert seen["stage"] == "ready_to_submit"
    assert "prUrl" not in seen


def test_a_reported_pull_request_from_the_holders_fork_counts(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    # Another branch, but its title names the task: AGENTS.md rule 8's `[#<issue>]`.
    env.github.add_pull(
        41, USER.login, "cursor/some-other-name", sha="c" * 40, title="[#1] Polish the export"
    )
    progress(env, "pr_opened", "Opened it", "https://github.com/verastd/forge-app/pull/41")
    seen = status(client, user_headers)
    assert seen["stage"] == "in_checks"
    assert seen["prUrl"].endswith("/pull/41")


def test_github_trouble_degrades_status_instead_of_failing(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    progress(env, "working")
    env.github.fail = "timeout"
    env.clock.advance(61)
    seen = status(client, user_headers)
    assert seen["stage"] == "agent_working"
    assert "GitHub can't be reached right now" in seen["detail"]


def test_status_shows_at_most_fifty_events(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    for index in range(60):
        env.clock.advance(150)  # within the 30-an-hour limit on progress reports
        progress(env, "working", f"step {index}")
    events = status(client, user_headers)["events"]
    assert len(events) == 50
    assert events[-1]["message"] == "step 59"


def test_agent_text_goes_to_the_holder_only(
    client: TestClient,
    env: BridgeEnv,
    user_headers: dict[str, str],
    other_headers: dict[str, str],
) -> None:
    """Agent text on a public page is a defacement vector: events an agent sent (source
    "agent") go to the lease holder alone; everyone else gets FORGE's own events."""
    claim(client, user_headers)
    assert dispatch(client, user_headers, "claude-code").status_code == 200
    progress(env, "working", "Visit evil.example for free money")
    mine = status(client, user_headers)
    assert [(event["kind"], event["source"]) for event in mine["events"]] == [
        ("claimed", "forge"),
        ("opened", "forge"),
        ("progress", "agent"),
    ]
    for viewer in (None, other_headers):
        seen = status(client, viewer)
        assert [(event["kind"], event["source"]) for event in seen["events"]] == [
            ("claimed", "forge"),
            ("opened", "forge"),
        ]
        assert "evil.example" not in json.dumps(seen)
        assert seen["stage"] == mine["stage"] == "agent_working"  # the stage still moves


def test_everyone_else_still_gets_forges_newest_events(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    """The holder-only filter runs before the 50-event cap, so agent reports never crowd
    FORGE's own events out of what everyone else sees."""
    claim(client, user_headers)
    for index in range(60):
        env.clock.advance(150)  # within the 30-an-hour limit on progress reports
        progress(env, "working", f"step {index}")
    assert [event["kind"] for event in status(client)["events"]] == ["claimed"]
    assert len(status(client, user_headers)["events"]) == 50


def test_releasing_answers_the_holder_with_their_agents_text(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    progress(env, "blocked", "Need the export format")
    released = client.post(f"/api/bridge/release/{CSV_TASK}", headers=user_headers)
    assert released.status_code == 200
    assert [event["kind"] for event in released.json()["events"]] == [
        "claimed",
        "progress",
        "released",
    ]
    assert [event["kind"] for event in status(client)["events"]] == ["claimed", "released"]


# --- checks, feedback, submit -------------------------------------------------------------


def test_check_results_follow_the_pull_request(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    assert client.get(f"/api/bridge/checks/{CSV_TASK}").status_code == 404
    claim(client, user_headers)
    none = client.get(f"/api/bridge/checks/{CSV_TASK}").json()
    assert none["state"] == "no_pr"
    assert f"{USER.login}:{CSV_BRANCH}" in none["notes"]

    sha = "d" * 40
    env.github.add_pull(7, USER.login, CSV_BRANCH, sha=sha)
    env.github.set_checks(
        sha,
        ("gauntlet / G2.3", "completed", "failure"),
        ("lint", "completed", "success"),
        ("deploy", "queued", None),
    )
    env.clock.advance(61)
    failed = client.get(f"/api/bridge/checks/{CSV_TASK}").json()
    assert failed["state"] == "failed"
    assert failed["prUrl"] == "https://github.com/verastd/forge-app/pull/7"
    assert failed["headSha"] == sha
    assert [check["name"] for check in failed["checks"]] == ["deploy", "gauntlet / G2.3", "lint"]
    deploy = failed["checks"][0]
    assert (deploy["status"], "conclusion" in deploy) == ("queued", False)
    assert deploy["summary"] == "deploy said — details for deploy"
    notes = failed["notes"]
    assert "- gauntlet / G2.3: failure. gauntlet / G2.3 said — details for gauntlet / G2.3" in notes
    assert "https://github.com/verastd/forge-app/runs/1" in notes
    assert "lint" not in notes.split("\n", 1)[1].split("Fix the cause")[0]  # only failures
    assert CSV_BRANCH in notes

    requests = len(env.github.requests)
    client.get(f"/api/bridge/checks/{CSV_TASK}")
    assert len(env.github.requests) == requests  # cached for 60 s

    env.github.fail = 502
    env.clock.advance(61)
    down = client.get(f"/api/bridge/checks/{CSV_TASK}")
    assert down.status_code == 200
    assert down.json()["state"] == "pending"
    assert "GitHub can't be reached right now" in down.json()["notes"]


def test_check_results_notes_for_every_state(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    sha = "4" * 40
    env.github.add_pull(21, USER.login, CSV_BRANCH, sha=sha)

    def checks() -> Any:
        env.clock.advance(61)
        return client.get(f"/api/bridge/checks/{CSV_TASK}").json()

    waiting = checks()
    assert (waiting["state"], waiting["checks"]) == ("pending", [])
    assert waiting["notes"] == "The checks on pull request #21 haven't started yet."
    env.github.set_checks(sha, ("lint", "completed", "success"), ("test", "in_progress", None))
    running = checks()
    assert running["state"] == "pending" and "1 of 2 checks on pull request #21" in running["notes"]
    env.github.set_checks(sha, ("lint", "completed", "success"), ("test", "completed", "skipped"))
    passed = checks()
    assert passed["state"] == "passed"
    assert passed["notes"] == "All 2 checks passed on pull request #21. Nothing to fix."
    env.github.fail_on = "/check-runs"
    down = checks()
    assert down["state"] == "pending" and "can't be read" in down["notes"]
    assert down["prUrl"].endswith("/pull/21") and down["headSha"] == sha
    seen = status(client, user_headers)
    assert seen["stage"] == "in_checks" and "GitHub can't be reached" in seen["detail"]
    env.github.fail_on = None
    env.github.pulls[0].update(state="closed", merged=True)
    merged = checks()
    assert (merged["state"], merged["checks"]) == ("passed", [])
    assert merged["notes"] == "Pull request #21 was merged. Nothing left to fix."


def test_a_shipped_bounty_mentions_its_reward(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers, 3)  # reward class R1
    task = FixtureTaskSource().get_task(3)
    assert task is not None and task.rewardClass == "R1"
    env.github.add_pull(30, USER.login, branch_name(3, task.title), state="closed", merged=True)
    shipped = client.get("/api/bridge/status/3", headers=user_headers).json()
    assert shipped["stage"] == "shipped"
    assert "reward unlocks once it survives 14 days" in shipped["detail"]


def test_progress_reports_are_capped_per_task(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    env.monkeypatch.setattr(bridge_service, "PROGRESS_LIMIT", 2)
    progress(env, "working")
    progress(env, "working")
    with pytest.raises(bridge_service.ApiError) as caught:
        progress(env, "working")
    assert (caught.value.status_code, caught.value.payload) == (
        429,
        {"error": "progress_limit", "limit": 2},
    )
    env.clock.advance(3601)  # a limit per hour, not a cap on the task
    progress(env, "working")


def test_small_helpers_and_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    assert bridge_service.parse_pr_url(None) is None
    assert bridge_service.parse_pr_url(" https://GitHub.com/verastd/forge-app/pull/5 ") == 5
    monkeypatch.setattr(bridge_service, "_rail_client", None)
    made = bridge_service.get_rail_client()
    assert made is bridge_service.get_rail_client()
    assert made.follow_redirects is False
    assert bridge_service.max_active_claims({"FORGE_MAX_ACTIVE_CLAIMS": "0"}) == 2
    assert bridge_service.enabled_start_rails({"FORGE_START_RAILS": " JULES ,devin"}) == {
        "jules",
        "devin",
    }


def failing_pull(env: BridgeEnv) -> None:
    sha = "e" * 40
    env.github.add_pull(9, USER.login, CSV_BRANCH, sha=sha)
    env.github.set_checks(sha, ("test", "completed", "failure"))


def test_feedback_relays_failed_checks_to_a_jules_session(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    failing_pull(env)
    response = client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=user_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["relayed"] is True and body["relayedTo"] == "jules"
    sent = env.vendor.requests[-1]
    assert sent.url.path == "/v1alpha/sessions/31415:sendMessage"
    assert body["notes"] in json.loads(sent.content)["prompt"]
    assert status(client, user_headers)["events"][-1]["kind"] == "relayed"


def test_feedback_returns_the_notes_when_it_cannot_relay(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    env.start_rails("jules", "openhands")
    claim(client, user_headers)

    def feedback() -> Any:
        env.clock.advance(61)  # past the GitHub cache, so each call sees the latest checks
        response = client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=user_headers)
        assert response.status_code == 200
        return response.json()

    assert client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=other_headers).status_code == 403
    no_pull = feedback()
    assert no_pull == {"relayed": False, "notes": no_pull["notes"]}
    assert "no open pull request" in no_pull["notes"]

    failing_pull(env)
    only_opened = feedback()  # failed checks, but nothing was started for this task
    assert only_opened["relayed"] is False and "- test: failure" in only_opened["notes"]

    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY})  # key not saved
    assert feedback()["relayed"] is False
    dispatch(client, user_headers, "openhands", credential={"key": "test-only-oh"})
    env.vault_on()  # OpenHands takes no follow-ups, saved key or not
    assert feedback()["relayed"] is False
    assert not any(":sendMessage" in str(request.url) for request in env.vendor.requests)


def test_feedback_respects_the_vendor_call_limit(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    failing_pull(env)
    for _ in range(DISPATCH_LIMIT - 1):
        assert client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=user_headers).json()[
            "relayed"
        ]
    limited = client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=user_headers).json()
    assert limited["relayed"] is False and "- test: failure" in limited["notes"]


def test_feedback_drops_a_saved_key_the_vendor_rejects(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    env.vault_on()
    env.start_rails("devin")
    claim(client, user_headers)
    dispatch(
        client,
        user_headers,
        "devin",
        credential={"key": DEVIN_KEY, "orgId": DEVIN_ORG},
        saveCredential=True,
    )
    failing_pull(env)
    env.vendor.respond = lambda request: json_response(
        401, {"title": "Unauthorized", "status": 401}
    )
    body = client.post(f"/api/bridge/feedback/{CSV_TASK}", headers=user_headers).json()
    assert body["relayed"] is False
    assert client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"] == []


def test_submit_checks_the_pull_request_is_the_callers(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)

    def submit(url: str) -> httpx.Response:
        return client.post(
            f"/api/bridge/submit/{CSV_TASK}", json={"prUrl": url}, headers=user_headers
        )

    for bad in (
        "https://github.com/someone/forge-app/pull/1",
        "not a url",
        "https://github.com/verastd/forge-app/pull/0",
    ):
        response = submit(bad)
        assert response.status_code == 400
        assert response.json() == {"error": "invalid_pr_url"}
    missing = submit("https://github.com/verastd/forge-app/pull/77")
    assert missing.status_code == 404
    assert missing.json() == {"error": "pr_not_found", "prNumber": 77}
    env.github.add_pull(78, "someone-else", "task/1-x")
    theirs = submit("https://github.com/verastd/forge-app/pull/78")
    assert theirs.status_code == 403
    assert theirs.json() == {"error": "not_your_pr", "prNumber": 78}

    # Another branch, but the description links the task, as Foreman's gate reads it.
    env.github.add_pull(79, USER.login, "my-own-name", sha="f" * 40, body="Fixes #1")
    ok = submit("https://github.com/verastd/forge-app/pull/79/")
    assert ok.status_code == 200
    body = ok.json()
    assert body["stage"] == "in_checks"
    assert body["prUrl"] == "https://github.com/verastd/forge-app/pull/79"
    assert body["events"][-1]["kind"] == "submitted"
    assert body["events"][-1]["source"] == "forge"
    again = submit("https://github.com/verastd/forge-app/pull/79").json()
    assert [event["kind"] for event in again["events"]].count("submitted") == 1


def test_submit_when_github_is_down_is_503(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    claim(client, user_headers)
    env.github.fail = 500
    response = client.post(
        f"/api/bridge/submit/{CSV_TASK}",
        json={"prUrl": "https://github.com/verastd/forge-app/pull/3"},
        headers=user_headers,
    )
    assert response.status_code == 503
    assert response.json() == {"error": "github_unavailable"}


# --- settle, keys, fork ---------------------------------------------------------------------


def test_profile_is_the_callers_own(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    assert client.get("/api/bridge/profile").status_code == 401
    claim(client, user_headers)
    fresh = client.get("/api/bridge/profile", headers=user_headers).json()
    assert fresh["login"] == USER.login
    assert (fresh["tier"], fresh["merged"], fresh["survivalRate"]) == ("T0", 0, 0.0)
    assert fresh["ledger"] == [
        {"kind": "claim", "refIssue": CSV_TASK, "points": 0.0, "at": "2026-08-10T09:00:00Z"}
    ]
    env.clock.advance(3600)
    env.github.add_pull(12, USER.login, CSV_BRANCH, state="closed", merged=True)  # at 10:00
    status(client, user_headers)  # notices the merge
    shipped = client.get("/api/bridge/profile", headers=user_headers).json()
    assert shipped["merged"] == 1 and shipped["survivalRate"] == 1.0
    assert shipped["ledger"][0] == {
        "kind": "merge",
        "refPr": 12,
        "refIssue": CSV_TASK,
        "points": 1.0,
        "at": "2026-08-10T10:00:00Z",
    }


def test_saved_keys_can_be_removed(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    assert client.get("/api/bridge/me/keys").status_code == 401
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    removed = client.delete("/api/bridge/me/keys/jules", headers=user_headers)
    assert removed.status_code == 200
    assert removed.json() == {"credentials": [], "vault": True}
    assert client.delete("/api/bridge/me/keys/jules", headers=user_headers).status_code == 200
    for rail in ("copilot", "claude-code", "nope"):
        unknown = client.delete(f"/api/bridge/me/keys/{rail}", headers=user_headers)
        assert unknown.status_code == 404
        assert unknown.json() == {"error": "unknown_rail"}


def test_fork_check(client: TestClient, env: BridgeEnv, user_headers: dict[str, str]) -> None:
    assert client.get("/api/bridge/me/fork").status_code == 401
    assert client.get("/api/bridge/me/fork", headers=user_headers).json() == {"exists": False}
    env.github.add_fork(USER.login)
    assert client.get("/api/bridge/me/fork", headers=user_headers).json() == {
        "exists": False
    }  # cached
    bridge_service.get_github_reads().clear_cache()
    assert client.get("/api/bridge/me/fork", headers=user_headers).json() == {
        "exists": True,
        "url": f"https://github.com/{USER.login}/forge-app",
    }
    bridge_service.get_github_reads().clear_cache()
    env.github.fail = 500
    down = client.get("/api/bridge/me/fork", headers=user_headers)
    assert down.status_code == 503


# --- task sources ------------------------------------------------------------------------


def test_fixture_tasks_carry_their_criteria() -> None:
    tasks = FixtureTaskSource().list_tasks()
    assert len(tasks) == 8
    assert all(len(task.acceptanceCriteria) == 3 for task in tasks)
    assert all(task.url.endswith(f"/issues/{task.id}") for task in tasks)
    assert branch_name(1, tasks[0].title) == CSV_BRANCH


def test_the_github_task_source_waits_for_foreman(client: TestClient, env: BridgeEnv) -> None:
    """Issue text never reaches a brief (mcp H1/H2, B-M8/B-M9, web M7): the fixtures are
    the only tasks, whatever FORGE_TASK_SOURCE says, and GitHub's issues are never read."""
    with pytest.raises(NotImplementedError):
        GitHubTaskSource().list_tasks()
    with pytest.raises(NotImplementedError):
        GitHubTaskSource().get_task(31)
    env.monkeypatch.setenv("FORGE_TASK_SOURCE", "github")
    assert isinstance(bridge_service.get_task_source(), FixtureTaskSource)
    tasks = client.get("/api/bridge/tasks").json()["tasks"]
    assert [task["id"] for task in tasks] == list(range(1, 9))
    assert client.get("/api/bridge/tasks/31").status_code == 404
    assert not any(request.url.path.endswith("/issues") for request in env.github.requests)


# --- the kill switch ----------------------------------------------------------------------

#: Every route family under /api/bridge/*. All 404 while contribute_bridge is off, except
#: SAVED_KEY_ROUTES.
ROUTES = [
    ("get", "/api/bridge/rails", None),
    ("get", "/api/bridge/tasks", None),
    ("get", f"/api/bridge/tasks/{CSV_TASK}", None),
    ("get", f"/api/bridge/tasks/{CSV_TASK}/brief", None),
    ("post", "/api/bridge/claim", {"taskId": CSV_TASK}),
    ("post", f"/api/bridge/release/{CSV_TASK}", None),
    ("post", "/api/bridge/dispatch", {"taskId": CSV_TASK, "rail": "codex"}),
    ("get", f"/api/bridge/status/{CSV_TASK}", None),
    ("get", f"/api/bridge/checks/{CSV_TASK}", None),
    ("post", f"/api/bridge/feedback/{CSV_TASK}", None),
    ("post", f"/api/bridge/submit/{CSV_TASK}", {"prUrl": "x"}),
    ("get", "/api/bridge/profile", None),
    ("get", "/api/bridge/me/keys", None),
    ("delete", "/api/bridge/me/keys/jules", None),
    ("get", "/api/bridge/me/fork", None),
    # Phase 7: "your copy" and "Send for review".
    ("post", "/api/bridge/copy", {"taskId": CSV_TASK, "token": "test-only-token"}),
    ("post", "/api/bridge/review", {"taskId": CSV_TASK, "token": "test-only-token"}),
]
#: Seeing and removing your saved keys works whatever the switches say (web M1).
SAVED_KEY_ROUTES = {("get", "/api/bridge/me/keys"), ("delete", "/api/bridge/me/keys/jules")}


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [route for route in ROUTES if route[:2] not in SAVED_KEY_ROUTES],
)
def test_bridge_routes_are_404_when_the_kill_switch_is_off(
    client: TestClient,
    env: BridgeEnv,
    user_headers: dict[str, str],
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    env.monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"contribute_bridge": False}))
    response = client.request(method, path, json=body, headers=user_headers)
    assert response.status_code == 404
    assert response.json() == {"error": "bridge-disabled"}


def test_saved_keys_can_be_seen_and_removed_with_the_kill_switch_off(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    """web M1: an incident is exactly when people want their keys gone."""
    env.vault_on()
    env.start_rails("jules")
    claim(client, user_headers)
    dispatch(client, user_headers, "jules", credential={"key": JULES_KEY}, saveCredential=True)
    env.monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"contribute_bridge": False}))
    assert client.get("/api/bridge/rails").status_code == 404  # the rest stays closed
    listed = client.get("/api/bridge/me/keys", headers=user_headers)
    assert listed.status_code == 200
    assert [saved["rail"] for saved in listed.json()["credentials"]] == ["jules"]
    removed = client.delete("/api/bridge/me/keys/jules", headers=user_headers)
    assert removed.status_code == 200
    assert removed.json() == {"credentials": [], "vault": True}
    assert client.get("/api/bridge/me/keys").status_code == 401  # still only your own


def test_every_route_is_documented(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    documented = {
        (method, re.sub(r"\{[^}]*\}", "x", path))
        for path, operations in paths.items()
        if path.startswith("/api/bridge/")
        for method in operations
    }
    wanted = {(method, re.sub(r"/(1|jules)(/|$)", r"/x\2", path)) for method, path, _ in ROUTES}
    assert documented == wanted
    assert "credential" in json.dumps(paths["/api/bridge/dispatch"]["post"]["requestBody"])
