"""The app's wiring in main.py: health, CORS, and how request errors are rendered."""

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from forge_api.main import (
    DEFAULT_CORS_ORIGINS,
    MAX_BODY_DEPTH,
    allowed_origins,
    invalid_fields,
    nested_deeper_than,
)

from .bridge_helpers import BridgeEnv, has_null, install_bridge
from .conftest import FakeClock
from .oauth_helpers import use_connector


def test_health_reports_ok_and_version(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.2.0"}


@pytest.mark.parametrize("origin", ["http://localhost:3000", "http://localhost:3100"])
def test_cors_allows_the_dev_and_playwright_origins(client: TestClient, origin: str) -> None:
    """3000 is `next dev`, 3100 is the Playwright web server — both must pass CORS."""
    response = client.get("/api/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_cors_origins_are_configurable_via_env() -> None:
    assert allowed_origins({}) == DEFAULT_CORS_ORIGINS.split(",")
    assert allowed_origins({"FORGE_CORS_ORIGINS": ""}) == DEFAULT_CORS_ORIGINS.split(",")
    assert allowed_origins({"FORGE_CORS_ORIGINS": "https://forge.example"}) == [
        "https://forge.example"
    ]
    assert allowed_origins({"FORGE_CORS_ORIGINS": " https://a.example , https://b.example ,"}) == [
        "https://a.example",
        "https://b.example",
    ]


# --- request errors on the Bridge and the consent API (B-low) ---------------------------

#: A value no answer may repeat back.
MARKER = "test-only-echo-marker-0123456789"
INVALID_BODY = {"error": "invalid_request", "fields": ["body"]}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


def nested(depth: int) -> bytes:
    return b"[" * depth + b"]" * depth


def post_json(client: TestClient, path: str, body: bytes, headers: dict[str, str]) -> Response:
    return client.post(path, content=body, headers={**headers, "content-type": "application/json"})


@pytest.mark.parametrize(
    ("path", "body", "fields"),
    [
        ("/api/bridge/claim", b"", ["body"]),
        ("/api/bridge/claim", b"null", ["body"]),
        ("/api/bridge/claim", b"{not json", ["body"]),
        ("/api/bridge/claim", b'{"taskId": null}', ["taskId"]),
        ("/api/bridge/claim", json.dumps({"taskId": MARKER}).encode(), ["taskId"]),
        ("/api/bridge/claim", nested(MAX_BODY_DEPTH), ["body"]),
        ("/api/bridge/submit/1", b"{}", ["prUrl"]),
        ("/api/bridge/submit/1", json.dumps({"prUrl": [MARKER]}).encode(), ["prUrl"]),
    ],
)
def test_a_bridge_request_that_fails_validation_names_the_fields_only(
    env: BridgeEnv,
    client: TestClient,
    user_headers: dict[str, str],
    path: str,
    body: bytes,
    fields: list[str],
) -> None:
    """The review's B-low probe, inverted: FastAPI's own 422 echoed the input back, a JSON
    null included, nested under "detail" where the web doesn't look."""
    response = post_json(client, path, body, user_headers)
    assert response.status_code == 422
    assert response.json() == {"error": "invalid_request", "fields": fields}
    assert not has_null(response.json()) and MARKER not in response.text


def test_a_bad_path_parameter_is_named_too(env: BridgeEnv, client: TestClient) -> None:
    response = client.get(f"/api/bridge/status/{MARKER}")
    assert (response.status_code, response.json()) == (
        422,
        {"error": "invalid_request", "fields": ["task_id"]},
    )


@pytest.mark.parametrize("depth", [MAX_BODY_DEPTH + 1, 8_000, 100_000])
@pytest.mark.parametrize("path", ["/api/bridge/claim", "/api/bridge/submit/1"])
def test_a_deeply_nested_body_is_a_400_never_a_500(
    env: BridgeEnv, client: TestClient, user_headers: dict[str, str], path: str, depth: int
) -> None:
    """B-low: 8,000 nested arrays (16 KB) made FastAPI's 422 recurse while echoing them,
    a 500. 100,000 are past the JSON parser's own limit, where FastAPI answered a bare
    400 {"detail"}. Both are 400 invalid_request now."""
    response = post_json(client, path, nested(depth), user_headers)
    assert (response.status_code, response.json()) == (400, INVALID_BODY)


def test_the_consent_api_answers_the_same_way(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_connector(monkeypatch)
    missing = client.post("/api/oauth/authorize/check", json={"clientId": MARKER})
    assert missing.status_code == 422
    assert (
        missing.json()["error"] == "invalid_request" and "redirectUri" in missing.json()["fields"]
    )
    assert MARKER not in missing.text and not has_null(missing.json())
    deep = post_json(client, "/api/oauth/authorize/check", nested(8_000), {})
    assert (deep.status_code, deep.json()) == (400, INVALID_BODY)
    deeper = post_json(client, "/api/oauth/authorize/check", nested(100_000), {})
    assert (deeper.status_code, deeper.json()) == (400, INVALID_BODY)


def test_other_routes_keep_fastapis_own_answers(
    client: TestClient, user_headers: dict[str, str]
) -> None:
    upland = client.get("/api/upland/actions?limit=0", headers=user_headers)
    assert upland.status_code == 422 and upland.json()["detail"][0]["loc"] == ["query", "limit"]
    unknown = client.get("/api/bridge/no-such-route")
    assert (unknown.status_code, unknown.json()) == (404, {"detail": "Not Found"})


def test_the_error_helpers() -> None:
    errors: list[Any] = [
        {"type": "missing", "loc": ("body",)},
        {"type": "int_type", "loc": ("body", "credential", "key")},
        {"type": "json_invalid", "loc": ("body", 7)},
        {"type": "int_parsing", "loc": ("path", "task_id")},
        "not an error dict",
    ]
    assert invalid_fields(errors) == ["body", "credential.key", "task_id"]
    assert nested_deeper_than("[[[[", 1) is False  # a string is not nesting
    assert nested_deeper_than({"a": [{"b": []}]}, 4) is False
    assert nested_deeper_than({"a": [{"b": []}]}, 3) is True
