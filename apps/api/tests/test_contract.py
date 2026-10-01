"""Cross-boundary drift guard (PRD Appendix H.1).

`packages/shared` declares every optional field with zod `.optional()`, which accepts
a missing key and *rejects* an explicit null. So no response body may contain a JSON
null anywhere — otherwise `Schema.parse(await res.json())` throws in apps/web. (The
Upland schemas are the documented exception: their wire uses explicit nulls.)

Every Bridge v2 response is also read back through its pydantic model and must come out
unchanged: no key the model doesn't declare, nothing missing. The models themselves are
held to the zod schemas field by field by test_wire_models.py (tests/fixtures/wire-golden.json).
"""

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
    RailList,
    SavedCredentialList,
    TaskDetail,
    TaskList,
)

from .bridge_helpers import JULES_KEY, OTHER, USER, BridgeEnv, has_null, install_bridge
from .conftest import AuthHeaders, FakeClock

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
