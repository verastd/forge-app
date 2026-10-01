"""Helpers for the FORGE connector's tests (test_oauth.py, test_mcp.py): configure the
connector, register a client, run the consent flow as the web would, and call /mcp.

Every secret here is a test-only value; nothing is key-shaped.
"""

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from forge_api.services import flags as flags_service
from forge_api.services import oauth as oauth_service
from forge_api.services.mcp_server import McpRegistry
from forge_api.services.mcp_types import (
    PromptDef,
    ToolContext,
    ToolDef,
    ToolError,
    ToolOutput,
)

ORIGIN = "https://forge.example"
RESOURCE = ORIGIN + "/mcp"
RESOURCE_METADATA = ORIGIN + "/.well-known/oauth-protected-resource/mcp"
OAUTH_SECRET = "test-only-oauth-secret-0123456789abcdef"
OTHER_OAUTH_SECRET = "test-only-other-oauth-secret-0123456789"

CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback"
#: Every redirect URI the clients FORGE targets register (checked against their docs,
#: 2026-10-01), as they register it.
CLIENT_REDIRECT_URIS = {
    "claude.ai": [CLAUDE_CALLBACK, "https://claude.com/api/mcp/auth_callback"],
    "claude-code": ["http://localhost:3118/callback", "http://127.0.0.1:3118/callback"],
    "codex": ["http://127.0.0.1/callback/XuuuHAzzHOni", "http://127.0.0.1/callback"],
    "vscode": [
        "https://insiders.vscode.dev/redirect",
        "https://vscode.dev/redirect",
        "http://127.0.0.1/",
        "http://127.0.0.1:33418/",
    ],
    "cursor": [
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "http://localhost:8787/callback",
        "https://www.cursor.com/agents/mcp/oauth/callback",
    ],
    "antigravity": ["https://antigravity.google/oauth-callback"],
    "chatgpt": [
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/Zm9yZ2UtdGVzdA",
    ],
}

USER = ("1001", "octo-contributor")
OTHER_USER = ("1003", "octo-other")


class EpochClock:
    """An injectable clock in epoch seconds (services/oauth.get_clock's shape)."""

    def __init__(self, start: float = 1_790_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def use_connector(monkeypatch: pytest.MonkeyPatch, **flags: bool) -> None:
    """The connector configured and switched on (plus sign-in and the Bridge), whatever
    config/flags.json says. Keyword arguments override single flags."""
    monkeypatch.setenv(oauth_service.ORIGIN_ENV, ORIGIN)
    monkeypatch.setenv(oauth_service.SECRET_ENV, OAUTH_SECRET)
    monkeypatch.delenv(oauth_service.ALLOWED_ORIGINS_ENV, raising=False)
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)
    values = {"mcp_connector": True, "github_signin": True, "contribute_bridge": True, **flags}
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps(values))


@dataclass(frozen=True)
class Pkce:
    verifier: str
    challenge: str


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def new_pkce() -> Pkce:
    verifier = secrets.token_urlsafe(48)  # 64 characters, inside RFC 7636's 43..128
    return Pkce(verifier, b64url(hashlib.sha256(verifier.encode()).digest()))


def register(
    client: TestClient,
    redirect_uris: list[str] | None = None,
    *,
    name: str | None = "Claude",
    method: str | None = "none",
    **extra: Any,
) -> dict[str, Any]:
    """Register a client the way MCP clients do (RFC 7591); the 201 body."""
    metadata: dict[str, Any] = {"redirect_uris": redirect_uris or [CLAUDE_CALLBACK], **extra}
    if name is not None:
        metadata["client_name"] = name
    if method is not None:
        metadata["token_endpoint_auth_method"] = method
    response = client.post("/oauth/register", json=metadata)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def authorize_params(
    registration: dict[str, Any],
    pkce: Pkce,
    *,
    redirect_uri: str | None = None,
    state: str | None = "state-123",
    resource: str | None = RESOURCE,
    **overrides: Any,
) -> dict[str, Any]:
    """AuthorizeParams as the consent page forwards them (camelCase)."""
    params: dict[str, Any] = {
        "responseType": "code",
        "clientId": registration["client_id"],
        "redirectUri": redirect_uri or registration["redirect_uris"][0],
        "codeChallenge": pkce.challenge,
        "codeChallengeMethod": "S256",
        "scope": "forge.tasks",
    }
    if state is not None:
        params["state"] = state
    if resource is not None:
        params["resource"] = resource
    params.update(overrides)
    return params


def query_of(url: str) -> dict[str, str]:
    """A redirect URL's query, one value per name."""
    return {name: values[0] for name, values in parse_qs(urlsplit(url).query).items()}


def approve(client: TestClient, params: dict[str, Any], headers: dict[str, str]) -> str:
    """The person clicks Allow: the code from the redirect."""
    response = client.post("/api/oauth/authorize/approve", json=params, headers=headers)
    assert response.status_code == 200, response.text
    return query_of(response.json()["redirectTo"])["code"]


def exchange(
    client: TestClient,
    registration: dict[str, Any],
    code: str,
    pkce: Pkce,
    *,
    redirect_uri: str | None = None,
    **extra: str,
) -> Response:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri or registration["redirect_uris"][0],
        "code_verifier": pkce.verifier,
        "client_id": registration["client_id"],
        "resource": RESOURCE,
        **extra,
    }
    response: Response = client.post("/oauth/token", data=form)
    return response


def refresh(client: TestClient, registration: dict[str, Any], refresh_token: str) -> Response:
    form = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": registration["client_id"],
    }
    response: Response = client.post("/oauth/token", data=form)
    return response


@dataclass(frozen=True)
class Connection:
    registration: dict[str, Any]
    access_token: str
    refresh_token: str


def connect(
    client: TestClient,
    headers: dict[str, str],
    *,
    redirect_uris: list[str] | None = None,
    registration: dict[str, Any] | None = None,
) -> Connection:
    """Register (unless given a registration), consent and redeem: a working connection."""
    registration = registration or register(client, redirect_uris)
    pkce = new_pkce()
    code = approve(client, authorize_params(registration, pkce), headers)
    response = exchange(client, registration, code, pkce)
    assert response.status_code == 200, response.text
    tokens = response.json()
    return Connection(registration, tokens["access_token"], tokens["refresh_token"])


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def rpc(
    client: TestClient,
    token: str | None,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    request_id: int | str = 1,
    headers: dict[str, str] | None = None,
) -> Response:
    """POST one JSON-RPC request to /mcp."""
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    all_headers = {**(bearer(token) if token else {}), **(headers or {})}
    response: Response = client.post("/mcp", json=message, headers=all_headers)
    return response


# --- fake tools (the protocol layer's tests never touch the Bridge) --------------------

ECHO_INPUT = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "What to echo"},
        "mood": {"type": "string", "enum": ["calm", "loud"]},
        "times": {"type": "integer"},
    },
    "required": ["text"],
    "additionalProperties": False,
}
ECHO_OUTPUT = {
    "type": "object",
    "properties": {"text": {"type": "string"}, "login": {"type": "string"}},
    "required": ["text", "login"],
}


def _echo(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    text = str(arguments["text"]) * int(arguments.get("times", 1))
    return ToolOutput(
        text=f"{context.identity.login} said {text}",
        structured={"text": text, "login": context.identity.login},
    )


def _plain(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    return ToolOutput(text="plain answer")


def _refuse(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    raise ToolError("Task #9 isn't claimed by you.")


def _crash(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    raise RuntimeError("database exploded")


def _not_output(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    return "just a string"  # type: ignore[return-value]  # a tool that breaks the seam


def _not_json(context: ToolContext, arguments: dict[str, Any]) -> ToolOutput:
    return ToolOutput(text="ok", structured={"value": float("nan")})


def _render(context: ToolContext, arguments: dict[str, str]) -> list[dict[str, Any]]:
    task_id = arguments["task_id"]
    if task_id == "404":
        raise ToolError("There is no FORGE task #404.")
    if task_id == "500":
        raise RuntimeError("render exploded")
    if task_id == "bad":
        return "not a list"  # type: ignore[return-value]
    text = f"Start FORGE task #{task_id} as {context.identity.login}."
    return [{"role": "user", "content": {"type": "text", "text": text}}]


NO_ARGS = {"type": "object", "additionalProperties": False}


def tool(name: str, handler: Any, **overrides: Any) -> ToolDef:
    fields: dict[str, Any] = {
        "name": name,
        "title": name.title(),
        "description": f"The {name} test tool.",
        "input_schema": NO_ARGS,
        "output_schema": None,
        "annotations": {"readOnlyHint": True},
        "handler": handler,
        **overrides,
    }
    return ToolDef(**fields)


FAKE_REGISTRY = McpRegistry(
    tools=(
        tool("echo", _echo, input_schema=ECHO_INPUT, output_schema=ECHO_OUTPUT),
        tool("plain", _plain, annotations={}),
        tool("refuse", _refuse),
        tool("crash", _crash, input_schema={"type": "object"}),
        tool("not_output", _not_output),
        tool("not_json", _not_json),
    ),
    prompts=(
        PromptDef(
            name="forge_task",
            title="Start a FORGE task",
            description="Starts work on one FORGE task.",
            arguments=[{"name": "task_id", "description": "The task number", "required": True}],
            render=_render,
        ),
    ),
    instructions="Use the FORGE tools to claim, report and submit.",
)
