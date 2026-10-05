"""Cross-boundary drift guard (PRD Appendix H.1).

`packages/shared` declares every optional field with zod `.optional()`, which accepts
a missing key and *rejects* an explicit null. So no response body may contain a JSON
null anywhere — otherwise `Schema.parse(await res.json())` throws in apps/web. (The
Upland schemas are the documented exception: their wire uses explicit nulls.)

Every Bridge v2 response, and every proposals and notifications response (Phase 5), is
also read back through its pydantic model and must come out unchanged: no key the model
doesn't declare, nothing missing. The models themselves are held to the zod schemas field
by field by test_wire_models.py (tests/fixtures/wire-golden.json).
"""

from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from forge_api.models import (
    BridgeStatus,
    CheckResults,
    ClaimResponse,
    ContributorProfile,
    DispatchResult,
    FeedbackResponse,
    FlagConfig,
    ForkStatus,
    HealthResponse,
    HouseDraft,
    NotificationList,
    ProposalCommentPage,
    ProposalDetail,
    ProposalList,
    ProposalMe,
    ProposalSettings,
    RailList,
    SavedCredentialList,
    TaskDetail,
    TaskList,
)
from forge_api.services import bridge as bridge_service
from forge_api.services import house

from .bridge_helpers import JULES_KEY, OTHER, USER, BridgeEnv, has_null, install_bridge
from .conftest import AuthHeaders, FakeClock
from .house_helpers import drafted, house_on, install, make_repo, message
from .proposal_helpers import ADMIN, ALICE, BOB, CAROL, DAVE, DRAFT, Floor, make_floor

CSV_BRANCH = "task/1-polish-the-csv-export-in-the-data-app"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


def ok(response: httpx.Response) -> Any:
    assert response.status_code == 200, (response.request.url, response.text)
    return response.json()


def round_trips(model: type[BaseModel], payload: Any) -> bool:
    return model.model_validate(payload).model_dump(exclude_none=True, mode="json") == payload


def test_every_response_is_null_free_and_matches_its_model(
    client: TestClient, env: BridgeEnv, auth_headers: AuthHeaders
) -> None:
    me = auth_headers(USER.sub, USER.login)
    them = auth_headers(OTHER.sub, OTHER.login)
    env.vault_on()
    env.start_rails("jules")
    sha = "1" * 40
    env.github.add_pull(12, USER.login, CSV_BRANCH, sha=sha)
    env.github.set_checks(sha, ("test", "completed", "failure"), ("lint", "queued", None))
    env.github.add_fork(USER.login)

    seen: list[tuple[type[BaseModel], Any]] = [
        (HealthResponse, ok(client.get("/api/health"))),
        (FlagConfig, ok(client.get("/api/flags"))),
        (RailList, ok(client.get("/api/bridge/rails"))),
        (TaskList, ok(client.get("/api/bridge/tasks"))),
        (TaskDetail, ok(client.get("/api/bridge/tasks/1"))),
        (ClaimResponse, ok(client.post("/api/bridge/claim", json={"taskId": 1}, headers=me))),
        (RailList, ok(client.get("/api/bridge/rails", headers=me))),
        (TaskDetail, ok(client.get("/api/bridge/tasks/1", headers=me))),
        (TaskList, ok(client.get("/api/bridge/tasks"))),
        (
            DispatchResult,
            ok(
                client.post("/api/bridge/dispatch", json={"taskId": 1, "rail": "codex"}, headers=me)
            ),
        ),
        (
            DispatchResult,
            ok(
                client.post(
                    "/api/bridge/dispatch",
                    json={
                        "taskId": 1,
                        "rail": "jules",
                        "credential": {"key": JULES_KEY},
                        "saveCredential": True,
                    },
                    headers=me,
                )
            ),
        ),
        (BridgeStatus, ok(client.get("/api/bridge/status/1", headers=me))),
        (BridgeStatus, ok(client.get("/api/bridge/status/1"))),
        (BridgeStatus, ok(client.get("/api/bridge/status/1", headers=them))),
        (CheckResults, ok(client.get("/api/bridge/checks/1"))),
        (FeedbackResponse, ok(client.post("/api/bridge/feedback/1", headers=me))),
        (
            BridgeStatus,
            ok(
                client.post(
                    "/api/bridge/submit/1",
                    json={"prUrl": "https://github.com/verastd/forge-app/pull/12"},
                    headers=me,
                )
            ),
        ),
        (ContributorProfile, ok(client.get("/api/bridge/profile", headers=me))),
        (SavedCredentialList, ok(client.get("/api/bridge/me/keys", headers=me))),
        (ForkStatus, ok(client.get("/api/bridge/me/fork", headers=me))),
        (ForkStatus, ok(client.get("/api/bridge/me/fork", headers=them))),
        (SavedCredentialList, ok(client.delete("/api/bridge/me/keys/jules", headers=me))),
        (BridgeStatus, ok(client.post("/api/bridge/release/1", headers=me))),
        (CheckResults, ok(client.get("/api/bridge/checks/1"))),
    ]
    for model, payload in seen:
        assert not has_null(payload), (model.__name__, payload)
        assert round_trips(model, payload), (model.__name__, payload)
    feedback = seen[15][1]
    assert feedback["relayed"] is True and feedback["relayedTo"] == "jules"


def test_error_bodies_are_flat_and_null_free(
    client: TestClient, env: BridgeEnv, auth_headers: AuthHeaders
) -> None:
    me = auth_headers(USER.sub, USER.login)
    errors = [
        client.get("/api/bridge/status/1"),
        client.post("/api/bridge/claim", json={"taskId": 999}, headers=me),
        client.post("/api/bridge/dispatch", json={"taskId": 1, "rail": "codex"}, headers=me),
        client.post("/api/bridge/claim", json={"taskId": 1}),
    ]
    for response in errors:
        body = response.json()
        assert response.status_code >= 400
        assert isinstance(body.get("error"), str), body
        assert not has_null(body)


def test_the_phase_4_review_error_codes_are_flat_and_null_free(
    client: TestClient, env: BridgeEnv, auth_headers: AuthHeaders
) -> None:
    """tier_too_low, claim_cooldown, claim_rate_limit, already_started, submit_limit and
    pr_not_for_task: flat JSON, and a Retry-After header where the contract says so."""
    me = auth_headers(USER.sub, USER.login)
    env.start_rails("jules")
    env.monkeypatch.setattr(bridge_service, "CLAIM_RATE_LIMIT", 2)  # the third claim is refused

    def claim(task_id: int) -> httpx.Response:
        return client.post("/api/bridge/claim", json={"taskId": task_id}, headers=me)

    def submit(number: int) -> httpx.Response:
        return client.post(
            "/api/bridge/submit/3",
            json={"prUrl": f"https://github.com/verastd/forge-app/pull/{number}"},
            headers=me,
        )

    seen: dict[str, httpx.Response] = {"tier_too_low": claim(2)}
    ok(claim(1))
    ok(client.post("/api/bridge/release/1", headers=me))
    seen["claim_cooldown"] = claim(1)
    ok(claim(3))
    jules = {"taskId": 3, "rail": "jules", "credential": {"key": JULES_KEY}}
    ok(client.post("/api/bridge/dispatch", json=jules, headers=me))
    seen["already_started"] = client.post("/api/bridge/dispatch", json=jules, headers=me)
    seen["claim_rate_limit"] = claim(6)
    env.github.add_pull(40, USER.login, "unrelated")
    seen["pr_not_for_task"] = submit(40)
    for number in range(41, 51):
        submit(number)
    seen["submit_limit"] = submit(51)

    statuses = {code: response.status_code for code, response in seen.items()}
    assert statuses == {
        "tier_too_low": 403,
        "claim_cooldown": 409,
        "already_started": 409,
        "claim_rate_limit": 429,
        "pr_not_for_task": 400,
        "submit_limit": 429,
    }
    for code, response in seen.items():
        body = response.json()
        assert body["error"] == code and not has_null(body), body
    assert seen["tier_too_low"].json() == {"error": "tier_too_low", "tierFloor": "T1"}
    assert seen["claim_cooldown"].json()["retryAfter"] == 86400
    assert seen["already_started"].json()["sessionUrl"].startswith("https://jules.google.com/")
    for code in ("claim_cooldown", "claim_rate_limit", "submit_limit"):
        assert seen[code].headers["retry-after"].isdigit(), code


def test_required_fields_are_always_present(
    client: TestClient, env: BridgeEnv, auth_headers: AuthHeaders
) -> None:
    me = auth_headers(USER.sub, USER.login)
    card = client.get("/api/bridge/tasks").json()["tasks"][0]
    assert set(card) >= {
        "id",
        "title",
        "civilianSummary",
        "size",
        "rewardClass",
        "tierFloor",
        "status",
        "url",
        "labels",
    }
    client.post("/api/bridge/claim", json={"taskId": 1}, headers=me)
    dispatched = client.post(
        "/api/bridge/dispatch", json={"taskId": 1, "rail": "codex"}, headers=me
    ).json()
    assert set(dispatched) == {"mode", "rail", "brief", "startedAt"}
    status = client.get("/api/bridge/status/1").json()
    assert set(status) >= {"taskId", "stage", "detail", "events"}
    rails = client.get("/api/bridge/rails").json()
    assert set(rails) == {"rails", "vault"}
    assert all(
        {"id", "mode", "label", "vendor", "blurb", "setup", "enabled"} <= set(rail)
        for rail in rails["rails"]
    )


def test_history_is_gone_from_the_contract(client: TestClient) -> None:
    """v0.2 removed History: no route serves it, and no History model is left in the schema
    (its zod mirror left packages/shared in the same change)."""
    assert client.get("/api/history").status_code == 404
    assert client.get("/api/export").status_code == 404
    schema = client.get("/openapi.json").json()
    assert not {"/api/history", "/api/export"} & set(schema["paths"])
    assert not [name for name in schema["components"]["schemas"] if name.startswith("History")]


# --- Phase 5: proposals and the bell ---------------------------------------------------


def test_every_proposals_response_is_null_free_and_matches_its_model(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every proposals and notifications route, in every state a proposal can be in, as
    an anonymous reader, a member and an admin."""
    floor: Floor = make_floor(client, clock, auth_headers, monkeypatch)
    floor.hello(ALICE, BOB, CAROL, DAVE)
    seen: list[tuple[type[BaseModel], Any]] = []

    def check(model: type[BaseModel], response: httpx.Response) -> Any:
        assert response.status_code in (200, 201), (response.request.url, response.text)
        payload = response.json()
        seen.append((model, payload))
        return payload

    def every_view(proposal_id: int) -> None:
        for who in (None, ALICE, CAROL, ADMIN):
            check(ProposalDetail, floor.get(f"/api/proposals/{proposal_id}", who))

    lapsing = check(ProposalDetail, floor.move(DAVE))["proposal"]["id"]
    check(ProposalMe, floor.get("/api/proposals/me", DAVE))
    check(ProposalMe, floor.get("/api/proposals/me", ADMIN))
    voting = check(ProposalDetail, floor.move(ALICE))["proposal"]["id"]
    check(ProposalDetail, floor.edit(voting, ALICE, "A better title", "A better pitch"))
    every_view(voting)
    check(ProposalDetail, floor.second(voting, BOB))
    check(ProposalDetail, floor.consent(voting, CAROL, False))
    check(ProposalDetail, floor.comment(voting, CAROL, "Not yet.\nLet's vote."))
    every_view(voting)
    check(ProposalCommentPage, floor.comments_page(voting))
    check(ProposalSettings, floor.test_timers(True))  # the admin buttons are test tools
    check(ProposalDetail, floor.end_debate(voting))
    for who in (ALICE, BOB, CAROL):
        check(ProposalDetail, floor.vote(voting, who, "yes"))
    every_view(voting)
    check(ProposalDetail, floor.close_vote(voting))
    every_view(voting)
    check(ProposalDetail, floor.put_draft(voting, DRAFT))
    check(ProposalDetail, floor.publish(voting))
    every_view(voting)
    assert floor.floor().ship(10001) is True
    every_view(voting)
    failing = check(ProposalDetail, floor.move(CAROL))["proposal"]["id"]
    check(ProposalDetail, floor.second(failing, DAVE))
    check(ProposalDetail, floor.consent(failing, DAVE, False))
    check(ProposalDetail, floor.end_debate(failing))
    check(ProposalDetail, floor.close_vote(failing))
    every_view(failing)
    withdrawn = check(ProposalDetail, floor.move(BOB))["proposal"]["id"]
    check(ProposalDetail, floor.withdraw(withdrawn, BOB))
    floor.wait(timedelta(days=8))
    every_view(lapsing)
    every_view(withdrawn)
    check(ProposalSettings, floor.test_timers(True))
    check(ProposalList, floor.get("/api/proposals"))
    check(ProposalList, floor.get("/api/proposals?state=building"))
    check(ProposalList, floor.get(f"/api/proposals?decidedBefore={withdrawn}"))
    check(ProposalCommentPage, floor.comments_page(voting, 2))
    floor.flags(github_signin=False)  # the floor pauses: reads say so
    check(ProposalList, floor.get("/api/proposals"))
    check(ProposalDetail, floor.get(f"/api/proposals/{voting}"))
    floor.flags(github_signin=True)
    check(NotificationList, floor.get("/api/notifications", CAROL))
    check(NotificationList, floor.post("/api/notifications/read", CAROL, {"ids": [1]}))
    check(NotificationList, floor.post("/api/notifications/read", CAROL))

    states = {payload["proposal"]["state"] for model, payload in seen if model is ProposalDetail}
    paused = [payload for _, payload in seen if payload.get("floorPaused")]
    assert len(paused) == 2
    assert states == {
        "submitted",
        "debate",
        "voting",
        "passed",
        "failed",
        "building",
        "shipped",
        "lapsed",
        "withdrawn",
    }
    for model, payload in seen:
        assert not has_null(payload), (model.__name__, payload)
        assert round_trips(model, payload), (model.__name__, payload)


def test_proposals_error_bodies_are_flat_and_null_free(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    floor = make_floor(client, clock, auth_headers, monkeypatch)
    proposal_id = floor.moved(ALICE)
    errors = [
        floor.get("/api/proposals/404"),
        floor.get("/api/proposals?state=nope"),
        floor.get("/api/proposals?decidedBefore=nope"),
        floor.get(f"/api/proposals/{proposal_id}/comments?before=nope"),
        floor.move(ALICE),
        floor.second(proposal_id, ALICE),
        floor.second(proposal_id, BOB, revision=2),  # proposal_changed
        floor.edit(proposal_id, BOB, "x", "y"),
        floor.consent(proposal_id, BOB),
        floor.post("/api/proposals", ALICE, {"title": None}),
        floor.end_debate(proposal_id, BOB),
        floor.end_debate(proposal_id),  # test_mode_off
        floor.client.get("/api/notifications"),
    ]
    for response in errors:
        body = response.json()
        assert response.status_code >= 400
        assert isinstance(body.get("error"), str), body
        assert not has_null(body), body
    floor.flags(proposals=False)
    assert floor.get("/api/proposals").json() == {"error": "proposals-disabled"}


# --- Phase 6: the house model -----------------------------------------------------------


def test_the_house_responses_are_null_free_and_match_their_models(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """POST /api/proposals/{id}/admin/house-draft (202 HouseDraft and its refusals), and an
    admin's detail with the house at every status it can show."""
    floor = make_floor(client, clock, auth_headers, monkeypatch)
    house_on(monkeypatch, make_repo(tmp_path / "repo"))
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.passed(ALICE, BOB)
    path = f"/api/proposals/{proposal_id}"
    seen: list[tuple[type[BaseModel], Any]] = []
    errors: list[httpx.Response] = []

    def admin_view() -> None:
        seen.append((ProposalDetail, ok(floor.get(path, ADMIN))))

    admin_view()  # queued
    errors.append(floor.post(f"{path}/admin/house-draft", ADMIN))  # 409 house_busy
    install(monkeypatch, *drafted(), message(None, stop="refusal"))
    assert house.work(floor.db(), floor.clock) == "done"
    admin_view()
    response = floor.post(f"{path}/admin/house-draft", ADMIN)
    assert response.status_code == 202, response.text
    seen.append((HouseDraft, response.json()))
    assert house.work(floor.db(), floor.clock) == "failed"
    admin_view()  # failed, with the earlier spec
    monkeypatch.setenv(house.DAILY_LIMIT_ENV, "2")
    errors.append(floor.post(f"{path}/admin/house-draft", ADMIN))  # 429 rate_limited
    monkeypatch.delenv(house.KEY_ENV)
    admin_view()  # off
    errors.append(floor.post(f"{path}/admin/house-draft", ADMIN))  # 503 house_off

    statuses = [payload["house"]["status"] for model, payload in seen if model is ProposalDetail]
    assert statuses == ["queued", "done", "failed", "off"]
    for model, payload in seen:
        assert not has_null(payload), (model.__name__, payload)
        assert round_trips(model, payload), (model.__name__, payload)
    assert [error.status_code for error in errors] == [409, 429, 503]
    for error in errors:
        body = error.json()
        assert isinstance(body.get("error"), str), body
        assert not has_null(body), body
