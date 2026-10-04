"""The FORGE connector's MCP endpoint (services/mcp_server.py, routers/mcp.py): the
transport checks (Origin, bearer challenge, protocol version, body), JSON-RPC (single
messages, notifications, batches), the methods, tool and prompt results, the rate limit,
CORS for the connector paths, and one run against the real Bridge tools when they exist.
The tools here are fakes (tests/oauth_helpers.FAKE_REGISTRY)."""

import json
import logging
from collections.abc import Callable, Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api import __version__
from forge_api.main import app
from forge_api.services import mcp_server
from forge_api.services import oauth as oauth_service
from forge_api.services.mcp_server import McpRegistry, RateLimiter

from .oauth_helpers import (
    FAKE_REGISTRY,
    ORIGIN,
    RESOURCE_METADATA,
    USER,
    EpochClock,
    bearer,
    connect,
    refresh,
    rpc,
    tool,
    use_connector,
)

AuthHeaders = Callable[..., dict[str, str]]
CHALLENGE = f'Bearer resource_metadata="{RESOURCE_METADATA}", scope="forge.tasks"'
INVALID_TOKEN_CHALLENGE = CHALLENGE + ', error="invalid_token"'


class Overrides:
    """What a test may swap: the tools on offer and the rate limiter."""

    def __init__(self) -> None:
        self.registry: McpRegistry = FAKE_REGISTRY
        self.limiter = RateLimiter()


@pytest.fixture
def oauth_clock() -> EpochClock:
    return EpochClock()


@pytest.fixture
def overrides() -> Overrides:
    return Overrides()


@pytest.fixture
def api(
    monkeypatch: pytest.MonkeyPatch,
    oauth_clock: EpochClock,
    overrides: Overrides,
    assertion_secret: str,
) -> Iterator[TestClient]:
    use_connector(monkeypatch)
    app.dependency_overrides[oauth_service.get_clock] = lambda: oauth_clock
    app.dependency_overrides[mcp_server.get_mcp_registry] = lambda: overrides.registry
    app.dependency_overrides[mcp_server.get_rate_limiter] = lambda: overrides.limiter
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def token(api: TestClient, auth_headers: AuthHeaders) -> str:
    """A live access token for the default test user."""
    return connect(api, auth_headers(*USER)).access_token


def post(api: TestClient, token: str, payload: Any, **headers: str) -> Any:
    return api.post(
        "/mcp",
        content=json.dumps(payload),
        headers={**bearer(token), "Content-Type": "application/json", **headers},
    )


def result_of(
    api: TestClient, token: str, method: str, params: dict[str, Any] | None = None
) -> Any:
    response = rpc(api, token, method, params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body, body
    return body["result"]


def error_of(api: TestClient, token: str, method: str, params: Any = None) -> dict[str, Any]:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": 7, "method": method}
    if params is not None:
        message["params"] = params
    response = post(api, token, message)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert body["id"] == 7
    error: dict[str, Any] = body["error"]
    return error


def call_tool(api: TestClient, token: str, name: str, arguments: Any = None) -> dict[str, Any]:
    params: dict[str, Any] = {"name": name}
    if arguments is not None:
        params["arguments"] = arguments
    result: dict[str, Any] = result_of(api, token, "tools/call", params)
    return result


# --- lifecycle -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("requested", "answered"),
    [
        ("2025-11-25", "2025-11-25"),
        ("2025-06-18", "2025-06-18"),
        ("2025-03-26", "2025-03-26"),
        ("2024-11-05", "2025-11-25"),
        ("2026-07-28", "2025-11-25"),
        ("not-a-version", "2025-11-25"),
    ],
)
def test_initialize_negotiates_the_version(
    api: TestClient, token: str, requested: str, answered: str
) -> None:
    params = {
        "protocolVersion": requested,
        "capabilities": {"roots": {"listChanged": True}},
        "clientInfo": {"name": "test-client", "version": "1.0"},
    }
    result = result_of(api, token, "initialize", params)
    assert result == {
        "protocolVersion": answered,
        "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
        "serverInfo": {"name": "forge", "title": "FORGE", "version": __version__},
        "instructions": FAKE_REGISTRY.instructions,
    }


def test_initialize_without_instructions_omits_them(
    api: TestClient, token: str, overrides: Overrides
) -> None:
    overrides.registry = McpRegistry(tools=FAKE_REGISTRY.tools)
    result = result_of(api, token, "initialize", {"protocolVersion": "2025-11-25"})
    assert "instructions" not in result


@pytest.mark.parametrize(
    "params", [None, {}, {"protocolVersion": 20251125}, {"protocolVersion": ""}]
)
def test_initialize_needs_a_protocol_version(api: TestClient, token: str, params: Any) -> None:
    error = error_of(api, token, "initialize", params)
    assert error["code"] == -32602


def test_a_stateless_server_mints_no_session(api: TestClient, token: str) -> None:
    response = rpc(api, token, "initialize", {"protocolVersion": "2025-11-25"})
    assert "mcp-session-id" not in response.headers
    assert response.headers["content-type"] == "application/json"
    followup = rpc(api, token, "ping", headers={"Mcp-Session-Id": "ignored"})
    assert followup.json() == {"jsonrpc": "2.0", "id": 1, "result": {}}


@pytest.mark.parametrize("version", ["2025-11-25", "2025-06-18", "2025-03-26"])
def test_supported_protocol_version_headers_pass(api: TestClient, token: str, version: str) -> None:
    response = rpc(api, token, "ping", headers={"MCP-Protocol-Version": version})
    assert response.status_code == 200


@pytest.mark.parametrize("version", ["2026-07-28", "2024-11-05", "garbage", ""])
def test_unsupported_protocol_version_headers_are_400(
    api: TestClient, token: str, version: str
) -> None:
    response = rpc(api, token, "server/discover", headers={"MCP-Protocol-Version": version})
    assert response.status_code == 400
    body = response.json()
    # Not one of 2026-07-28's "modern" errors (-32020..-32022): a dual-era client reads this
    # as a legacy server and falls back to initialize.
    assert body["error"]["code"] == -32600
    assert body["id"] is None
    assert "2025-11-25, 2025-06-18, 2025-03-26" in body["error"]["message"]


# --- notifications and JSON-RPC shapes -------------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}},
        {"jsonrpc": "2.0", "method": "notifications/whatever"},
        {"jsonrpc": "2.0", "id": 9, "result": {}},
        {"jsonrpc": "2.0", "id": 9, "error": {"code": -1, "message": "no"}},
    ],
)
def test_notifications_and_responses_are_accepted_silently(
    api: TestClient, token: str, message: dict[str, Any]
) -> None:
    response = post(api, token, message)
    assert response.status_code == 202
    assert response.content == b""


@pytest.mark.parametrize(
    "method", ["no/such/method", "notifications/initialized", "logging/setLevel"]
)
def test_unknown_methods_are_32601(api: TestClient, token: str, method: str) -> None:
    error = error_of(api, token, method, {})
    assert error["code"] == -32601
    assert method in error["message"]


def test_long_method_names_are_clipped_in_errors(api: TestClient, token: str) -> None:
    error = error_of(api, token, "x" * 500, {})
    assert len(error["message"]) < 150


def test_string_ids_are_echoed(api: TestClient, token: str) -> None:
    response = rpc(api, token, "ping", request_id="abc-1")
    assert response.json() == {"jsonrpc": "2.0", "id": "abc-1", "result": {}}


@pytest.mark.parametrize(
    "payload",
    [
        5,
        "text",
        None,
        {"jsonrpc": "2.0"},
        {"jsonrpc": "1.0", "id": 1, "method": "ping"},
        {"id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "id": 1, "method": 5},
        {"jsonrpc": "2.0", "id": None, "method": "ping"},
        {"jsonrpc": "2.0", "id": 1.5, "method": "ping"},
        {"jsonrpc": "2.0", "id": True, "method": "ping"},
        {"jsonrpc": "2.0", "id": 1},
    ],
    ids=repr,
)
def test_invalid_messages_are_400_invalid_request(
    api: TestClient, token: str, payload: Any
) -> None:
    response = post(api, token, payload)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32600


def test_invalid_request_echoes_a_valid_id(api: TestClient, token: str) -> None:
    response = post(api, token, {"jsonrpc": "2.0", "id": 4, "method": 7})
    assert response.json()["id"] == 4


@pytest.mark.parametrize(
    ("method", "params", "fragment"),
    [
        ("ping", [1, 2], "params must be an object"),
        ("ping", "x", "params must be an object"),
        ("tools/call", {}, "params.name"),
        ("tools/call", {"name": 5}, "params.name"),
        ("tools/call", {"name": "nope"}, "Unknown tool: nope"),
        ("tools/call", {"name": "echo", "arguments": ["hi"]}, "arguments must be an object"),
        ("tools/list", {"cursor": "abc"}, "Invalid cursor"),
        ("prompts/list", {"cursor": "abc"}, "Invalid cursor"),
        ("resources/list", {"cursor": "abc"}, "Invalid cursor"),
        ("resources/templates/list", {"cursor": 1}, "Invalid cursor"),
        ("prompts/get", {}, "params.name"),
        ("prompts/get", {"name": "nope"}, "Unknown prompt: nope"),
        ("prompts/get", {"name": "forge_task"}, "Missing required argument: task_id"),
        ("prompts/get", {"name": "forge_task", "arguments": {"task_id": 3}}, "strings"),
        ("prompts/get", {"name": "forge_task", "arguments": "3"}, "strings"),
    ],
)
def test_bad_params_are_32602(
    api: TestClient, token: str, method: str, params: Any, fragment: str
) -> None:
    error = error_of(api, token, method, params)
    assert error["code"] == -32602
    assert fragment in error["message"]


def test_null_params_mean_none(api: TestClient, token: str) -> None:
    response = post(api, token, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": None})
    assert len(response.json()["result"]["tools"]) == len(FAKE_REGISTRY.tools)


def test_simple_methods(api: TestClient, token: str) -> None:
    assert result_of(api, token, "ping") == {}
    assert result_of(api, token, "resources/list") == {"resources": []}
    assert result_of(api, token, "resources/templates/list", {}) == {"resourceTemplates": []}
    assert result_of(api, token, "tools/list", {"cursor": None})["tools"]


# --- tools -----------------------------------------------------------------------------


def test_tools_list_describes_each_tool(api: TestClient, token: str) -> None:
    tools = result_of(api, token, "tools/list")["tools"]
    assert [entry["name"] for entry in tools] == [
        "echo",
        "plain",
        "refuse",
        "crash",
        "not_output",
        "not_json",
    ]
    echo, plain = tools[0], tools[1]
    assert echo == {
        "name": "echo",
        "title": "Echo",
        "description": "The echo test tool.",
        "inputSchema": FAKE_REGISTRY.tools[0].input_schema,
        "outputSchema": FAKE_REGISTRY.tools[0].output_schema,
        "annotations": {"readOnlyHint": True},
    }
    assert "outputSchema" not in plain  # only when the tool declares one
    assert "annotations" not in plain  # none declared


def test_a_tool_result_carries_text_and_structured_content(api: TestClient, token: str) -> None:
    result = call_tool(api, token, "echo", {"text": "hi", "times": 2})
    assert result == {
        "content": [{"type": "text", "text": f"{USER[1]} said hihi"}],
        "structuredContent": {"text": "hihi", "login": USER[1]},
        "isError": False,
    }


def test_a_tool_without_structured_output(api: TestClient, token: str) -> None:
    no_arguments: tuple[dict[str, Any] | None, ...] = (None, {})
    for arguments in no_arguments:
        result = call_tool(api, token, "plain", arguments)
        assert result == {"content": [{"type": "text", "text": "plain answer"}], "isError": False}


def test_a_tool_error_is_an_is_error_result(api: TestClient, token: str) -> None:
    result = call_tool(api, token, "refuse")
    assert result == {
        "content": [{"type": "text", "text": "Task #9 isn't claimed by you."}],
        "isError": True,
    }


def test_a_crash_is_a_generic_is_error_result_logged_without_arguments(
    api: TestClient, token: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger=mcp_server.__name__):
        result = call_tool(api, token, "crash", {"private": "argument-value-1234"})
    assert result == {
        "content": [{"type": "text", "text": mcp_server.TOOL_CRASHED}],
        "isError": True,
    }
    assert "'crash'" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "argument-value-1234" not in caplog.text


@pytest.mark.parametrize("name", ["not_output", "not_json"])
def test_a_tool_that_breaks_the_seam_is_a_generic_error(
    api: TestClient, token: str, name: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger=mcp_server.__name__):
        result = call_tool(api, token, name)
    assert result["isError"] is True
    assert result["content"][0]["text"] == mcp_server.TOOL_CRASHED
    assert name in caplog.text


@pytest.mark.parametrize(
    ("arguments", "fragment"),
    [
        ({}, "text is required"),
        ({"text": "hi", "extra": 1}, "extra is not one of its arguments"),
        ({"text": 5}, "text must be string"),
        ({"text": "hi", "times": "3"}, "times must be integer"),
        ({"text": "hi", "times": True}, "times must be integer"),
        ({"text": "hi", "times": 1.5}, "times must be integer"),
        ({"text": "hi", "mood": "angry"}, 'mood must be one of "calm", "loud"'),
    ],
)
def test_invalid_arguments_are_is_error_results(
    api: TestClient, token: str, arguments: dict[str, Any], fragment: str
) -> None:
    result = call_tool(api, token, "echo", arguments)
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert text.startswith("Invalid arguments for echo: ")
    assert fragment in text


def test_argument_checks_skip_what_they_dont_understand() -> None:
    schema = {
        "type": "object",
        "properties": {
            "union": {"type": ["integer", "string"]},
            "anything": {"description": "no type"},
            "odd": {"type": "frobnicate"},
            "nested": "not a dict",
            "flag": {"type": "boolean", "enum": [True]},
            "number": {"type": "number"},
            "list": {"type": "array"},
            "maybe": {"type": "null"},
        },
        "required": ["union", 7],
    }
    good = {"union": "x", "anything": [1], "odd": 1, "nested": 1, "flag": True, "number": 2.5}
    assert mcp_server.argument_problem(schema, {**good, "list": [], "maybe": None}) is None
    assert mcp_server.argument_problem(schema, {**good, "union": 2}) is None
    assert mcp_server.argument_problem(schema, {**good, "union": 2.5}) == (
        "union must be integer or string"
    )
    assert mcp_server.argument_problem(schema, {**good, "flag": 1}) == "flag must be boolean"
    assert mcp_server.argument_problem({"properties": "x", "required": "x"}, {"a": 1}) is None


# --- prompts ---------------------------------------------------------------------------


def test_prompts_list_and_get(api: TestClient, token: str) -> None:
    prompts = result_of(api, token, "prompts/list")["prompts"]
    assert prompts == [
        {
            "name": "forge_task",
            "title": "Start a FORGE task",
            "description": "Starts work on one FORGE task.",
            "arguments": [{"name": "task_id", "description": "The task number", "required": True}],
        }
    ]
    got = result_of(
        api, token, "prompts/get", {"name": "forge_task", "arguments": {"task_id": "12"}}
    )
    assert got == {
        "description": "Starts work on one FORGE task.",
        "messages": [
            {
                "role": "user",
                "content": {"type": "text", "text": f"Start FORGE task #12 as {USER[1]}."},
            }
        ],
    }


@pytest.mark.parametrize(
    ("task_id", "code", "message"),
    [
        ("404", -32602, "There is no FORGE task #404."),
        ("500", -32603, "Internal error"),
        ("bad", -32603, "Internal error"),
    ],
)
def test_prompt_failures(
    api: TestClient, token: str, task_id: str, code: int, message: str
) -> None:
    error = error_of(
        api, token, "prompts/get", {"name": "forge_task", "arguments": {"task_id": task_id}}
    )
    assert error == {"code": code, "message": message}


# --- authorization ---------------------------------------------------------------------


def test_no_token_is_401_with_the_discovery_challenge(api: TestClient) -> None:
    response = rpc(api, None, "initialize", {"protocolVersion": "2025-11-25"})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == CHALLENGE
    assert response.json()["error"] == "unauthorized"
    assert f"{ORIGIN}/connect" in response.json()["error_description"]


@pytest.mark.parametrize(
    "authorization",
    [
        "Bearer forge_at_unknown",
        "Bearer not-even-forge",
        "Bearer ",
        "Bearer",
        "Basic dXNlcjpwYXNz",
        "forge_at_unknown",
    ],
)
def test_a_bad_token_is_401_invalid_token(api: TestClient, authorization: str) -> None:
    response = api.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": authorization},
    )
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == INVALID_TOKEN_CHALLENGE
    assert response.json()["error"] == "invalid_token"


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER"])
def test_the_bearer_scheme_is_case_insensitive(api: TestClient, token: str, scheme: str) -> None:
    response = api.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"{scheme} {token}"},
    )
    assert response.status_code == 200


def test_a_token_for_another_resource_is_401(
    api: TestClient, token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert rpc(api, token, "ping").status_code == 200
    monkeypatch.setenv(oauth_service.ORIGIN_ENV, "https://forge-moved.example")
    response = rpc(api, token, "ping")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == (
        'Bearer resource_metadata="https://forge-moved.example/.well-known/'
        'oauth-protected-resource/mcp", scope="forge.tasks", error="invalid_token"'
    )


def test_a_revoked_grant_stops_mcp_calls(api: TestClient, auth_headers: AuthHeaders) -> None:
    user = auth_headers(*USER)
    connection = connect(api, user)
    assert rpc(api, connection.access_token, "ping").status_code == 200
    agent_id = api.get("/api/oauth/grants", headers=user).json()["agents"][0]["id"]
    api.delete(f"/api/oauth/grants/{agent_id}", headers=user)
    assert rpc(api, connection.access_token, "ping").status_code == 401


def test_the_token_names_the_caller(api: TestClient, auth_headers: AuthHeaders) -> None:
    other = connect(api, auth_headers("1003", "octo-other")).access_token
    assert (
        call_tool(api, other, "echo", {"text": "x"})["structuredContent"]["login"] == "octo-other"
    )


# --- Origin ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "null",
        "https://forge.example.evil",
        # Lookalikes of the hosted clients' origins (oauth.HOSTED_CLIENT_ORIGINS).
        "https://claude.ai.evil.example",
        "http://claude.ai",
        "https://claude.ai:8443",
        "https://gist.github.com",
        "https://evilchatgpt.com",
    ],
)
def test_a_foreign_origin_is_403(api: TestClient, token: str, origin: str) -> None:
    response = rpc(api, token, "ping", headers={"Origin": origin})
    assert response.status_code == 403
    assert response.json()["id"] is None
    assert response.json()["error"]["code"] == -32600
    unauthenticated = rpc(api, None, "ping", headers={"Origin": origin})
    assert unauthenticated.status_code == 403  # before the token is even looked at


def test_allowed_origins_pass(api: TestClient, token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    assert rpc(api, token, "ping", headers={"Origin": ORIGIN}).status_code == 200
    assert rpc(api, token, "ping", headers={"Origin": "https://FORGE.example"}).status_code == 200
    monkeypatch.setenv(oauth_service.ALLOWED_ORIGINS_ENV, "http://localhost:6274")
    assert rpc(api, token, "ping", headers={"Origin": "http://localhost:6274"}).status_code == 200


@pytest.mark.parametrize("origin", sorted(oauth_service.HOSTED_CLIENT_ORIGINS))
def test_hosted_clients_origins_pass_without_any_setting(
    api: TestClient, token: str, origin: str
) -> None:
    """A hosted client's backend that sends its `Origin` is not locked out, with
    FORGE_MCP_ALLOWED_ORIGINS unset (use_connector clears it). The token still decides."""
    assert rpc(api, token, "ping", headers={"Origin": origin}).status_code == 200
    assert rpc(api, token, "ping", headers={"Origin": origin.upper() + "/"}).status_code == 200
    unauthenticated = rpc(api, None, "ping", headers={"Origin": origin})
    assert unauthenticated.status_code == 401


# --- the HTTP envelope -----------------------------------------------------------------


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_get_and_delete_are_405(api: TestClient, token: str, method: str) -> None:
    response = api.request(method, "/mcp", headers=bearer(token))
    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert response.json()["error"]["code"] == -32600


@pytest.mark.parametrize("content_type", ["text/plain", "application/x-www-form-urlencoded", None])
def test_the_body_must_be_json(api: TestClient, token: str, content_type: str | None) -> None:
    headers = {**bearer(token)}
    if content_type:
        headers["Content-Type"] = content_type
    response = api.post(
        "/mcp", content=b'{"jsonrpc":"2.0","id":1,"method":"ping"}', headers=headers
    )
    assert response.status_code == 415


@pytest.mark.parametrize(
    "content_type", ["application/json; charset=utf-8", "application/vnd.x+json"]
)
def test_json_media_types_pass(api: TestClient, token: str, content_type: str) -> None:
    response = api.post(
        "/mcp",
        content=b'{"jsonrpc":"2.0","id":1,"method":"ping"}',
        headers={**bearer(token), "Content-Type": content_type},
    )
    assert response.status_code == 200


@pytest.mark.parametrize("body", [b"{not json", b"", b"[" * 3000, b"\xff\xfe"])
def test_unparseable_bodies_are_parse_errors(api: TestClient, token: str, body: bytes) -> None:
    response = api.post(
        "/mcp", content=body, headers={**bearer(token), "Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json() == {
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": -32700, "message": "Parse error"},
    }


def test_oversized_bodies_are_413(api: TestClient, token: str) -> None:
    padding = "x" * mcp_server.MAX_BODY_BYTES
    response = rpc(api, token, "ping", {"padding": padding})
    assert response.status_code == 413


def test_oversized_chunked_bodies_are_413(api: TestClient, token: str) -> None:
    """No Content-Length to check up front: the stream is cut off past the limit."""
    chunk = b" " * 65536

    def body() -> Iterator[bytes]:
        yield b'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"'
        for _ in range(5):
            yield chunk
        yield b'"}}'

    response = api.post(
        "/mcp", content=body(), headers={**bearer(token), "Content-Type": "application/json"}
    )
    assert "content-length" not in response.request.headers
    assert response.status_code == 413


# --- batches ---------------------------------------------------------------------------


def test_a_batch_is_answered_element_by_element(api: TestClient, token: str) -> None:
    batch = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26"},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": "two", "method": "tools/call", "params": {"name": "refuse"}},
        {"jsonrpc": "2.0", "id": 3, "method": "nope"},
        {"jsonrpc": "2.0", "id": 4, "result": {}},
        7,
    ]
    response = post(api, token, batch)
    assert response.status_code == 200
    replies = response.json()
    assert [reply.get("id") for reply in replies] == [1, "two", 3, None]
    assert replies[0]["result"]["protocolVersion"] == "2025-03-26"
    assert replies[1]["result"]["isError"] is True
    assert replies[2]["error"]["code"] == -32601
    assert replies[3]["error"]["code"] == -32600


def test_a_batch_of_notifications_is_202(api: TestClient, token: str) -> None:
    batch = [
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 1, "result": {}},
    ]
    response = post(api, token, batch)
    assert response.status_code == 202
    assert response.content == b""


def test_empty_and_oversized_batches_are_400(api: TestClient, token: str) -> None:
    assert post(api, token, []).status_code == 400
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    too_many = post(api, token, [ping] * (mcp_server.MAX_BATCH + 1))
    assert too_many.status_code == 400
    assert "at most 32" in too_many.json()["error"]["message"]
    assert post(api, token, [ping] * mcp_server.MAX_BATCH).status_code == 200


# --- lone surrogates (JSON can carry one; UTF-8, and so a reply, can't) ---------------


def post_text(api: TestClient, token: str, body: str) -> Any:
    headers = {**bearer(token), "Content-Type": "application/json", "Origin": ORIGIN}
    return api.post("/mcp", content=body, headers=headers)


@pytest.mark.parametrize(
    ("message", "status", "code", "request_id"),
    [
        ('"id":"\\ud800","method":"ping"', 400, -32600, None),
        ('"id":1,"method":"\\ud800"', 400, -32600, 1),
        ('"id":1,"method":"tools/call","params":{"name":"\\udfff"}', 200, -32602, 1),
        ('"id":1,"method":"prompts/get","params":{"name":"\\udfff"}', 200, -32602, 1),
    ],
)
def test_lone_surrogates_get_json_rpc_errors_never_a_bare_500(
    api: TestClient, token: str, message: str, status: int, code: int, request_id: int | None
) -> None:
    """Review mcp L1: in the id, the method or a tool's name, a proper JSON-RPC error with
    the connector's CORS headers, in valid UTF-8."""
    response = post_text(api, token, '{"jsonrpc":"2.0",' + message + "}")
    assert response.status_code == status
    assert response.headers["access-control-allow-origin"] == "*"
    reply = json.loads(response.content.decode("utf-8"))
    assert reply["error"]["code"] == code
    assert reply["id"] == request_id


def test_lone_surrogates_a_tool_echoes_come_back_replaced(api: TestClient, token: str) -> None:
    named = post_text(
        api,
        token,
        '{"jsonrpc":"2.0","id":1,"method":"tools/call",'
        '"params":{"name":"echo","arguments":{"text":"hi","\\ud800":1}}}',
    )
    assert named.json()["result"]["content"][0]["text"] == (
        "Invalid arguments for echo: ? is not one of its arguments."
    )
    echoed = post_text(
        api,
        token,
        '{"jsonrpc":"2.0","id":2,"method":"tools/call",'
        '"params":{"name":"echo","arguments":{"text":"a\\udc00b"}}}',
    )
    assert echoed.json()["result"]["structuredContent"] == {"text": "a?b", "login": USER[1]}


def test_a_bad_element_leaves_the_rest_of_the_batch_alone(api: TestClient, token: str) -> None:
    body = (
        '[{"jsonrpc":"2.0","id":1,"method":"tools/call",'
        '"params":{"name":"echo","arguments":{"text":"hi"}}},'
        '{"jsonrpc":"2.0","id":"\\udc00","method":"ping"},'
        '{"jsonrpc":"2.0","id":3,"method":"ping"}]'
    )
    response = post_text(api, token, body)
    assert response.status_code == 200
    replies = response.json()
    assert replies[0]["result"]["structuredContent"] == {"text": "hi", "login": USER[1]}
    assert (replies[1]["id"], replies[1]["error"]["code"]) == (None, -32600)
    assert replies[2] == {"jsonrpc": "2.0", "id": 3, "result": {}}


# --- rate limit ------------------------------------------------------------------------


def test_requests_per_grant_are_rate_limited(
    api: TestClient,
    token: str,
    overrides: Overrides,
    oauth_clock: EpochClock,
    auth_headers: AuthHeaders,
) -> None:
    overrides.limiter = RateLimiter(limit=3, window=60)
    for _ in range(3):
        assert rpc(api, token, "ping").json()["result"] == {}
    assert (
        post(api, token, {"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code
        == 202
    )
    limited = rpc(api, token, "ping").json()
    assert limited["error"] == {"code": -32000, "message": "rate limited"}
    other = connect(api, auth_headers("1003", "octo-other")).access_token
    assert rpc(api, other, "ping").json()["result"] == {}  # every grant has its own budget
    oauth_clock.advance(60)
    assert rpc(api, token, "ping").json()["result"] == {}
    batch = [{"jsonrpc": "2.0", "id": n, "method": "ping"} for n in range(3)]
    replies = post(api, token, batch).json()
    assert ["result" in reply for reply in replies] == [True, True, False]


def test_refreshing_buys_no_fresh_budget(
    api: TestClient, overrides: Overrides, oauth_clock: EpochClock, auth_headers: AuthHeaders
) -> None:
    """Review M2: the budget is the grant's, so a refreshed token (and the retry's, and the
    old token, still live for its hour) share it. Another connection is another grant."""
    overrides.limiter = RateLimiter(limit=3, window=60)
    user = auth_headers(*USER)
    connection = connect(api, user)
    for _ in range(3):
        assert rpc(api, connection.access_token, "ping").json()["result"] == {}
    renewed = refresh(api, connection.registration, connection.refresh_token).json()
    oauth_clock.advance(1)
    retried = refresh(api, connection.registration, connection.refresh_token).json()
    for access in (renewed["access_token"], retried["access_token"], connection.access_token):
        assert rpc(api, access, "ping").json()["error"]["code"] == -32000
    another = connect(api, user).access_token  # a new registration: its own grant
    assert rpc(api, another, "ping").json()["result"] == {}
    oauth_clock.advance(60)
    assert rpc(api, renewed["access_token"], "ping").json()["result"] == {}


def test_the_default_limit_is_120_a_minute() -> None:
    limiter = RateLimiter()
    assert (limiter.limit, limiter.window) == (120, 60.0)
    assert all(limiter.allow("k", 1000.0 + n * 0.1) for n in range(120))
    assert not limiter.allow("k", 1012.0)
    assert limiter.allow("k", 1060.05)  # the first request left the window


def test_idle_keys_are_forgotten(monkeypatch: pytest.MonkeyPatch) -> None:
    limiter = RateLimiter(limit=5, window=10)
    monkeypatch.setattr(limiter, "MAX_KEYS", 2)
    assert limiter.allow("a", 0)
    assert limiter.allow("b", 5)
    assert limiter.allow("c", 12)  # "a" idled out of its window and is dropped to make room
    assert set(limiter._hits) == {"b", "c"}


# --- CORS ------------------------------------------------------------------------------

EVIL = "https://evil.example"
PREFLIGHT_HEADERS = {
    "Origin": EVIL,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
}


@pytest.mark.parametrize(
    "path",
    [
        "/mcp",
        "/oauth/token",
        "/oauth/register",
        "/oauth/revoke",
        "/token",  # the MCP 2025-03-26 fallback aliases
        "/register",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource/mcp",
    ],
)
def test_connector_preflights_allow_any_origin(api: TestClient, path: str) -> None:
    response = api.options(path, headers=PREFLIGHT_HEADERS)
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers
    allowed = response.headers["access-control-allow-headers"]
    for header in ("Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Session-Id"):
        assert header in allowed
    assert "POST" in response.headers["access-control-allow-methods"]


def test_connector_responses_carry_star_and_expose_the_challenge(api: TestClient) -> None:
    unauthenticated = api.post("/mcp", json={}, headers={"Origin": "http://localhost:3000"})
    assert unauthenticated.status_code == 403  # an allowed web origin is still not FORGE's
    challenged = api.post("/mcp", json={})
    assert challenged.status_code == 401
    for response in (unauthenticated, challenged):
        assert response.headers["access-control-allow-origin"] == "*"
        assert response.headers["access-control-expose-headers"] == "WWW-Authenticate"
        assert "access-control-allow-credentials" not in response.headers
    token_error = api.post("/oauth/token", data={}, headers={"Origin": "http://localhost:3000"})
    assert token_error.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in token_error.headers
    metadata = api.get("/.well-known/oauth-authorization-server", headers={"Origin": EVIL})
    assert metadata.headers["access-control-allow-origin"] == "*"


def test_a_plain_options_request_is_not_a_preflight(api: TestClient) -> None:
    assert api.options("/mcp").status_code == 405


def test_existing_routes_keep_their_cors_policy(api: TestClient) -> None:
    refused = api.options("/api/flags", headers={**PREFLIGHT_HEADERS})
    assert refused.status_code == 400
    assert "access-control-allow-origin" not in refused.headers
    local = "http://localhost:3000"
    allowed = api.options("/api/flags", headers={**PREFLIGHT_HEADERS, "Origin": local})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == local
    assert allowed.headers["access-control-allow-credentials"] == "true"
    simple = api.get("/api/health", headers={"Origin": local})
    assert simple.headers["access-control-allow-origin"] == local
    assert simple.headers["access-control-allow-credentials"] == "true"
    stranger = api.get("/api/health", headers={"Origin": EVIL})
    assert "access-control-allow-origin" not in stranger.headers
    # The consent page's API calls are server-side: /api/oauth/* keeps the app-wide policy.
    consent = api.options("/api/oauth/grants", headers=PREFLIGHT_HEADERS)
    assert consent.status_code == 400


# --- the registry ----------------------------------------------------------------------


def test_registry_from_a_module() -> None:
    module = SimpleNamespace(
        TOOLS=list(FAKE_REGISTRY.tools),
        PROMPTS=list(FAKE_REGISTRY.prompts),
        SERVER_INSTRUCTIONS="hi",
    )
    registry = mcp_server.registry_from(module)
    assert registry.tools == FAKE_REGISTRY.tools
    assert registry.instructions == "hi"
    assert registry.tool("echo") is FAKE_REGISTRY.tools[0]
    assert registry.prompt("missing") is None
    assert mcp_server.registry_from(SimpleNamespace()) == McpRegistry()
    for broken in (
        SimpleNamespace(TOOLS=["not a tool"]),
        SimpleNamespace(PROMPTS=[object()]),
        SimpleNamespace(SERVER_INSTRUCTIONS=5),
    ):
        with pytest.raises(TypeError):
            mcp_server.registry_from(broken)


def test_helpers() -> None:
    assert mcp_server.bearer_token("Bearer abc") == "abc"
    assert mcp_server.bearer_token("bearer   abc ") == "abc"
    assert mcp_server.bearer_token("Bearer a b") is None
    assert mcp_server.bearer_token("Token abc") is None
    assert mcp_server.is_json("Application/JSON")
    assert not mcp_server.is_json("text/json")
    assert not mcp_server.is_json(None)
    assert tool("x", lambda context, arguments: None).name == "x"


# --- the real Bridge tools -------------------------------------------------------------

CONTRACT_TOOLS = {
    "whoami",
    "list_tasks",
    "get_task",
    "claim_task",
    "release_task",
    "report_progress",
    "get_check_results",
    "submit_task",
}


def test_the_real_tools_answer_through_the_connector(
    monkeypatch: pytest.MonkeyPatch, auth_headers: AuthHeaders, assertion_secret: str
) -> None:
    pytest.importorskip("forge_api.services.bridge_mcp")
    use_connector(monkeypatch)
    mcp_server._bridge_registry.cache_clear()
    with TestClient(app) as client:
        connection = connect(client, auth_headers(*USER))
        access = connection.access_token
        initialized = rpc(client, access, "initialize", {"protocolVersion": "2025-11-25"}).json()
        assert initialized["result"]["serverInfo"]["name"] == "forge"
        assert initialized["result"].get("instructions")
        tools = rpc(client, access, "tools/list").json()["result"]["tools"]
        assert CONTRACT_TOOLS <= {entry["name"] for entry in tools}
        for entry in tools:
            assert entry["inputSchema"]["type"] == "object"
        prompts = rpc(client, access, "prompts/list").json()["result"]["prompts"]
        assert "forge_task" in {entry["name"] for entry in prompts}
        me = rpc(client, access, "tools/call", {"name": "whoami", "arguments": {}}).json()
        assert me["result"]["isError"] is False, me
        assert USER[1] in me["result"]["content"][0]["text"]
        listed = rpc(client, access, "tools/call", {"name": "list_tasks", "arguments": {}}).json()
        assert "result" in listed, listed
    mcp_server._bridge_registry.cache_clear()
