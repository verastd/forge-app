"""The FORGE connector's authorization server (services/oauth.py, routers/oauth.py):
metadata, stateless registration, the consent page's check/approve/deny, the token
endpoint (PKCE, single-use codes, refresh rotation and reuse detection), revocation,
connected agents, and the 404/503 gates. The clock is injected; secrets are test-only."""

import base64
import json
import logging
import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services import mcp_server
from forge_api.services import oauth as oauth_service
from forge_api.services.identity import Identity
from forge_api.services.oauth import ConnectorConfig, InvalidToken
from forge_api.services.state import get_state_db

from .oauth_helpers import (
    CLAUDE_CALLBACK,
    CLIENT_REDIRECT_URIS,
    FAKE_REGISTRY,
    OAUTH_SECRET,
    ORIGIN,
    OTHER_OAUTH_SECRET,
    OTHER_USER,
    RESOURCE,
    RESOURCE_METADATA,
    USER,
    EpochClock,
    approve,
    authorize_params,
    connect,
    exchange,
    new_pkce,
    query_of,
    refresh,
    register,
    rpc,
    use_connector,
)

AuthHeaders = Callable[..., dict[str, str]]
NO_STORE = "no-store"
CONNECTOR_DISABLED = {"error": "connector-disabled"}
CONNECTOR_UNAVAILABLE = {"error": "connector_unavailable"}

#: The routes OpenAPI leaves out: GET/DELETE /mcp, and the MCP 2025-03-26 fallback aliases
#: of /oauth/register and /oauth/token.
HIDDEN_ROUTES = {("GET", "/mcp"), ("DELETE", "/mcp"), ("POST", "/register"), ("POST", "/token")}

#: Every connector route, as (method, path).
CONNECTOR_ROUTES = [
    ("GET", "/.well-known/oauth-protected-resource"),
    ("GET", "/.well-known/oauth-protected-resource/mcp"),
    ("GET", "/.well-known/oauth-authorization-server"),
    ("POST", "/oauth/register"),
    ("POST", "/oauth/token"),
    ("POST", "/oauth/revoke"),
    ("POST", "/register"),
    ("POST", "/token"),
    ("POST", "/api/oauth/authorize/check"),
    ("POST", "/api/oauth/authorize/approve"),
    ("POST", "/api/oauth/authorize/deny"),
    ("GET", "/api/oauth/grants"),
    ("DELETE", "/api/oauth/grants/{grant_id}"),
    ("POST", "/mcp"),
    ("GET", "/mcp"),
    ("DELETE", "/mcp"),
]


@pytest.fixture
def oauth_clock() -> EpochClock:
    return EpochClock()


@pytest.fixture
def api(
    monkeypatch: pytest.MonkeyPatch, oauth_clock: EpochClock, assertion_secret: str
) -> Iterator[TestClient]:
    """The app with the connector on, an injected clock and the fake tools."""
    use_connector(monkeypatch)
    limiter = mcp_server.RateLimiter()
    app.dependency_overrides[oauth_service.get_clock] = lambda: oauth_clock
    app.dependency_overrides[mcp_server.get_mcp_registry] = lambda: FAKE_REGISTRY
    app.dependency_overrides[mcp_server.get_rate_limiter] = lambda: limiter
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def user(auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers(*USER)


@pytest.fixture
def other_user(auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers(*OTHER_USER)


def config(origin: str = ORIGIN, secret: str = OAUTH_SECRET) -> ConnectorConfig:
    loaded = oauth_service.load_config(
        {oauth_service.ORIGIN_ENV: origin, oauth_service.SECRET_ENV: secret}
    )
    assert loaded is not None
    return loaded


def has_null(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(has_null(item) for item in value.values())
    if isinstance(value, list):
        return any(has_null(item) for item in value)
    return False


def whoami(client: TestClient, token: str) -> int:
    """The HTTP status of an MCP call made with `token`."""
    return rpc(
        client, token, "tools/call", {"name": "echo", "arguments": {"text": "hi"}}
    ).status_code


# --- the whole flow --------------------------------------------------------------------


def test_register_consent_token_mcp_refresh_revoke(
    api: TestClient, user: dict[str, str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    registration = register(api, [CLAUDE_CALLBACK], name="Claude")
    pkce = new_pkce()
    params = authorize_params(registration, pkce, state="opaque-state")

    check = api.post("/api/oauth/authorize/check", json=params)
    assert check.status_code == 200
    assert check.json() == {
        "clientName": "Claude",
        "redirectHost": "claude.ai",
        "scopes": ["forge.tasks"],
    }
    assert check.headers["cache-control"] == NO_STORE

    decision = api.post("/api/oauth/authorize/approve", json=params, headers=user)
    assert decision.status_code == 200
    redirect_to = decision.json()["redirectTo"]
    assert redirect_to.startswith(CLAUDE_CALLBACK + "?")
    returned = query_of(redirect_to)
    assert returned["state"] == "opaque-state"
    assert returned["iss"] == ORIGIN
    code = returned["code"]
    assert code.startswith("forge_ac_")

    granted = exchange(api, registration, code, pkce)
    assert granted.status_code == 200, granted.text
    assert granted.headers["cache-control"] == NO_STORE
    tokens = granted.json()
    assert set(tokens) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 3600
    assert tokens["scope"] == "forge.tasks"
    assert tokens["access_token"].startswith("forge_at_")
    assert tokens["refresh_token"].startswith("forge_rt_")

    called = rpc(
        api, tokens["access_token"], "tools/call", {"name": "echo", "arguments": {"text": "hi"}}
    )
    assert called.status_code == 200
    assert called.json()["result"]["structuredContent"] == {"text": "hi", "login": USER[1]}

    renewed = refresh(api, registration, tokens["refresh_token"])
    assert renewed.status_code == 200, renewed.text
    fresh = renewed.json()
    assert fresh["refresh_token"] != tokens["refresh_token"]
    assert whoami(api, fresh["access_token"]) == 200

    revoked = api.post(
        "/oauth/revoke",
        data={"token": fresh["refresh_token"], "client_id": registration["client_id"]},
    )
    assert revoked.status_code == 200
    assert whoami(api, fresh["access_token"]) == 401
    assert whoami(api, tokens["access_token"]) == 401
    assert refresh(api, registration, fresh["refresh_token"]).json()["error"] == "invalid_grant"

    # Nothing secret was logged along the way.
    for secret in (code, pkce.verifier, tokens["access_token"], tokens["refresh_token"]):
        assert secret not in caplog.text
    assert OAUTH_SECRET not in caplog.text


# --- metadata --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path", ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]
)
def test_protected_resource_metadata(api: TestClient, path: str) -> None:
    response = api.get(path)
    assert response.status_code == 200
    assert response.json() == {
        "resource": RESOURCE,
        "authorization_servers": [ORIGIN],
        "scopes_supported": ["forge.tasks"],
        "bearer_methods_supported": ["header"],
        "resource_name": "FORGE",
    }


def test_authorization_server_metadata(api: TestClient) -> None:
    metadata = api.get("/.well-known/oauth-authorization-server").json()
    assert metadata == {
        "issuer": ORIGIN,
        "authorization_endpoint": f"{ORIGIN}/oauth/authorize",
        "token_endpoint": f"{ORIGIN}/oauth/token",
        "registration_endpoint": f"{ORIGIN}/oauth/register",
        "revocation_endpoint": f"{ORIGIN}/oauth/revoke",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        "revocation_endpoint_auth_methods_supported": [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        "scopes_supported": ["forge.tasks"],
        "service_documentation": f"{ORIGIN}/connect",
        "authorization_response_iss_parameter_supported": True,
    }
    assert "client_id_metadata_document_supported" not in metadata  # registration it is


def test_metadata_follows_the_public_origin(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(oauth_service.ORIGIN_ENV, "HTTPS://Forge.Example:443/")
    assert api.get("/.well-known/oauth-authorization-server").json()["issuer"] == ORIGIN
    monkeypatch.setenv(oauth_service.ORIGIN_ENV, "http://localhost:3000")
    resource = api.get("/.well-known/oauth-protected-resource/mcp").json()["resource"]
    assert resource == "http://localhost:3000/mcp"


# --- registration ----------------------------------------------------------------------


@pytest.mark.parametrize("client_name", sorted(CLIENT_REDIRECT_URIS))
def test_every_target_client_can_register_and_be_sent_back(
    api: TestClient, user: dict[str, str], client_name: str
) -> None:
    uris = CLIENT_REDIRECT_URIS[client_name]
    registration = register(api, uris, name=client_name, application_type="native")
    assert registration["redirect_uris"] == uris
    for uri in uris:
        pkce = new_pkce()
        code = approve(api, authorize_params(registration, pkce, redirect_uri=uri), user)
        assert exchange(api, registration, code, pkce, redirect_uri=uri).status_code == 200


def test_registration_response(api: TestClient, oauth_clock: EpochClock) -> None:
    registration = register(api, [CLAUDE_CALLBACK], name="Claude", scope="openid profile")
    assert registration["client_id"].startswith("fc1.")
    assert registration["client_id_issued_at"] == int(oauth_clock())
    assert registration["client_name"] == "Claude"
    assert registration["grant_types"] == ["authorization_code", "refresh_token"]
    assert registration["response_types"] == ["code"]
    assert registration["token_endpoint_auth_method"] == "none"
    assert registration["scope"] == "forge.tasks"
    assert "client_secret" not in registration
    again = register(api, [CLAUDE_CALLBACK], name="Claude")
    assert again["client_id"] != registration["client_id"]  # every registration is distinct


def test_registration_is_no_store(api: TestClient) -> None:
    response = api.post("/oauth/register", json={"redirect_uris": [CLAUDE_CALLBACK]})
    assert response.status_code == 201
    assert response.headers["cache-control"] == NO_STORE


@pytest.mark.parametrize(
    "uri",
    [
        "http://localhost:8787/callback",
        "http://127.0.0.1/callback",
        "http://[::1]:9000/cb",
        "https://example.com/cb?tenant=a",
        "https://example.com:8443/cb",
        "cursor://anysphere.cursor-mcp/oauth/callback",
        "com.example.app:/oauth2redirect",
        "vscode://vscode.github-authentication/did-authenticate",
    ],
)
def test_redirect_uris_that_register(api: TestClient, uri: str) -> None:
    assert register(api, [uri])["redirect_uris"] == [uri]


@pytest.mark.parametrize(
    ("uri", "reason"),
    [
        ("javascript:alert(1)", "javascript: scheme"),
        ("JavaScript://example.com/%0aalert(1)", "javascript: scheme"),
        ("data:text/html,hi", "data: scheme"),
        ("file:///etc/passwd", "file: scheme"),
        ("vbscript:msgbox", "vbscript: scheme"),
        ("about:blank", "about: scheme"),
        ("blob:https://example.com/uuid", "blob: scheme"),
        ("http://example.com/callback", "must use https"),
        ("http://127.0.0.1.example.com/cb", "must use https"),
        ("http://localhost.example.com/cb", "must use https"),
        ("https://claude.ai/cb#frag", "fragment"),
        ("https://claude.ai/cb#", "fragment"),
        ("/relative/callback", "absolute URI"),
        ("callback", "absolute URI"),
        ("myapp:", "absolute URI"),
        ("", "is empty"),
        ("https://example.com/a b", "printable ASCII"),
        ("https://exämple.com/cb", "printable ASCII"),
        ("https://user:pass@example.com/cb", "user information"),
        ("https://example.com:99999/cb", "not a valid URI"),
        ("https:///no-host", "must name a host"),
        ("https://example.com/" + "a" * 600, "longer than 512"),
    ],
)
def test_redirect_uris_that_are_refused(api: TestClient, uri: str, reason: str) -> None:
    response = api.post("/oauth/register", json={"redirect_uris": [uri], "client_name": "x"})
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_redirect_uri"
    assert reason in body["error_description"]


@pytest.mark.parametrize(
    ("metadata", "error", "fragment"),
    [
        ({}, "invalid_redirect_uri", "non-empty list"),
        ({"redirect_uris": []}, "invalid_redirect_uri", "non-empty list"),
        ({"redirect_uris": CLAUDE_CALLBACK}, "invalid_redirect_uri", "non-empty list"),
        ({"redirect_uris": [7]}, "invalid_redirect_uri", "must be a string"),
        (
            {"redirect_uris": [f"https://example.com/{n}" for n in range(11)]},
            "invalid_redirect_uri",
            "at most 10",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "token_endpoint_auth_method": "private_key_jwt"},
            "invalid_client_metadata",
            "token_endpoint_auth_method",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "token_endpoint_auth_method": ""},
            "invalid_client_metadata",
            "token_endpoint_auth_method",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "grant_types": ["client_credentials"]},
            "invalid_client_metadata",
            "authorization_code",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "grant_types": "authorization_code"},
            "invalid_client_metadata",
            "list of strings",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "response_types": ["token"]},
            "invalid_client_metadata",
            "code",
        ),
        (
            {"redirect_uris": [CLAUDE_CALLBACK], "client_name": 42},
            "invalid_client_metadata",
            "client_name",
        ),
    ],
)
def test_registration_metadata_errors(
    api: TestClient, metadata: dict[str, Any], error: str, fragment: str
) -> None:
    response = api.post("/oauth/register", json=metadata)
    assert response.status_code == 400
    assert response.json()["error"] == error
    assert fragment in response.json()["error_description"]
    assert response.headers["cache-control"] == NO_STORE


@pytest.mark.parametrize("body", [b"not json", b"[1, 2]", b'"text"', b"[" * 5000])
def test_registration_needs_a_json_object(api: TestClient, body: bytes) -> None:
    response = api.post(
        "/oauth/register", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_client_metadata"


def test_registration_body_is_capped(api: TestClient) -> None:
    padding = "x" * (oauth_service.MAX_FORM_BYTES + 1)
    response = api.post("/oauth/register", json={"redirect_uris": [CLAUDE_CALLBACK], "p": padding})
    assert response.status_code == 413
    assert response.json()["error"] == "invalid_request"


def test_registration_normalizes_grant_types_and_drops_duplicates(api: TestClient) -> None:
    vscode_like = register(
        api,
        [CLAUDE_CALLBACK, CLAUDE_CALLBACK],
        grant_types=[
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:device_code",
        ],
        response_types=["code"],
        client_uri="https://code.visualstudio.com",
    )
    assert vscode_like["grant_types"] == ["authorization_code", "refresh_token"]
    assert vscode_like["redirect_uris"] == [CLAUDE_CALLBACK]


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("Claude Code", "Claude Code"),
        ("  Visual   Studio\tCode\n", "Visual Studio Code"),
        ("Evil‮edoC", "EviledoC"),  # a bidi override would reverse the text
        ("Zero​Width﻿", "ZeroWidth"),
        ("Bell\x07\x00Null", "BellNull"),
        ("Line Break", "Line Break"),
        ("ＦＯＲＧＥ", "FORGE"),  # full-width letters, NFKC
        ("​‮", "Unnamed agent"),
        ("", "Unnamed agent"),
        ("A" * 80, "A" * 63 + "…"),
    ],
)
def test_client_names_are_sanitized(api: TestClient, raw: str, shown: str) -> None:
    assert register(api, name=raw)["client_name"] == shown


def test_a_missing_client_name_has_a_default(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api, name=None)
    assert registration["client_name"] == "Unnamed agent"
    check = api.post("/api/oauth/authorize/check", json=authorize_params(registration, new_pkce()))
    assert check.json()["clientName"] == "Unnamed agent"


@pytest.mark.parametrize("method", ["client_secret_basic", "client_secret_post", None])
def test_confidential_clients_get_a_derived_secret(api: TestClient, method: str | None) -> None:
    registration = register(api, method=method)  # RFC 7591: omitted means client_secret_basic
    assert registration["token_endpoint_auth_method"] == (method or "client_secret_basic")
    assert registration["client_secret_expires_at"] == 0
    assert registration["client_secret"] == oauth_service.client_secret(
        config(), registration["client_id"]
    )


# --- client_id integrity ---------------------------------------------------------------


def _flip(text: str, index: int) -> str:
    return text[:index] + ("A" if text[index] != "A" else "B") + text[index + 1 :]


def tampered_ids(client_id: str) -> list[str]:
    version, body, signature = client_id.split(".")
    payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    payload["r"] = ["https://evil.example/cb"]
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return [
        f"{version}.{forged}.{signature}",  # someone else's redirect URI
        f"{version}.{_flip(body, 5)}.{signature}",
        f"{version}.{body}.{_flip(signature, 3)}",
        f"{version}.{body}.{signature}=",  # not canonical base64url
        f"fc2.{body}.{signature}",
        f"{version}.{body}",
        "not-a-client-id",
        "a.b.c",
        "x" * 9000,
    ]


def test_tampered_client_ids_are_refused_without_a_redirect(api: TestClient) -> None:
    registration = register(api)
    for client_id in tampered_ids(registration["client_id"]):
        params = authorize_params(registration, new_pkce(), clientId=client_id)
        response = api.post("/api/oauth/authorize/check", json=params)
        assert response.status_code == 400, client_id
        assert response.json()["error"] == "invalid_client"
        assert "redirectTo" not in response.json()


def test_a_client_id_signed_with_another_secret_is_foreign(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, user: dict[str, str]
) -> None:
    registration = register(api)
    monkeypatch.setenv(oauth_service.SECRET_ENV, OTHER_OAUTH_SECRET)
    params = authorize_params(registration, new_pkce())
    for path in ("check", "deny"):
        response = api.post(f"/api/oauth/authorize/{path}", json=params)
        assert response.json() == {
            "error": "invalid_client",
            "errorDescription": response.json()["errorDescription"],
        }
    assert api.post("/api/oauth/authorize/approve", json=params, headers=user).status_code == 400


def test_signed_payloads_must_have_the_expected_shape() -> None:
    settings = config()
    payloads: list[Any] = [
        [],
        {"n": 1, "r": ["https://a.example/cb"], "a": "none", "t": 1},
        {"r": []},
    ]
    for payload in payloads:
        body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        signing_input = f"fc1.{body}"
        signature = oauth_service._b64(oauth_service._mac(settings, b"client-id", signing_input))
        assert oauth_service.parse_client_id(settings, f"{signing_input}.{signature}") is None
    junk = "fc1.bm90IGpzb24"  # base64url of "not json", correctly signed
    signature = oauth_service._b64(oauth_service._mac(settings, b"client-id", junk))
    assert oauth_service.parse_client_id(settings, f"{junk}.{signature}") is None


# --- the consent page's calls ----------------------------------------------------------


def test_check_shows_where_the_client_sends_you(api: TestClient) -> None:
    cases = {
        "http://127.0.0.1:33418/": "127.0.0.1",
        "http://[::1]:9000/cb": "[::1]",
        "https://example.com:8443/cb": "example.com:8443",
        "https://example.com:443/cb": "example.com",
        "cursor://anysphere.cursor-mcp/oauth/callback": "cursor://anysphere.cursor-mcp",
        "com.example.app:/oauth2redirect": "com.example.app:",
    }
    for uri, host in cases.items():
        registration = register(api, [uri])
        check = api.post(
            "/api/oauth/authorize/check", json=authorize_params(registration, new_pkce())
        )
        assert check.json()["redirectHost"] == host, uri


@pytest.mark.parametrize(
    ("registered", "requested"),
    [
        ("http://127.0.0.1/callback", "http://127.0.0.1:51234/callback"),  # Codex
        (
            "http://127.0.0.1/callback/XuuuHAzzHOni",  # Codex's callback-ID form
            "http://127.0.0.1:61234/callback/XuuuHAzzHOni",
        ),
        ("http://127.0.0.1/", "http://127.0.0.1:40000/"),  # VS Code
        ("http://127.0.0.1:33418/", "http://127.0.0.1:40000/"),
        ("http://localhost:3118/callback", "http://localhost:50000/callback"),  # Claude Code
        ("http://[::1]/cb", "http://[::1]:8080/cb"),
        ("http://127.0.0.1", "http://127.0.0.1:9999/"),
        ("http://LOCALHOST:1/cb", "http://localhost:2/cb"),
    ],
)
def test_loopback_redirects_match_on_any_port(
    api: TestClient, user: dict[str, str], registered: str, requested: str
) -> None:
    registration = register(api, [registered])
    pkce = new_pkce()
    params = authorize_params(registration, pkce, redirect_uri=requested)
    assert api.post("/api/oauth/authorize/check", json=params).status_code == 200
    code = approve(api, params, user)
    assert exchange(api, registration, code, pkce, redirect_uri=requested).status_code == 200


@pytest.mark.parametrize(
    ("registered", "requested"),
    [
        (CLAUDE_CALLBACK, "https://claude.ai/api/mcp/auth_callback/"),
        (CLAUDE_CALLBACK, "https://claude.ai/api/mcp/auth_callback?x=1"),
        (CLAUDE_CALLBACK, "https://CLAUDE.ai/api/mcp/auth_callback"),
        (CLAUDE_CALLBACK, "https://evil.example/api/mcp/auth_callback"),
        (CLAUDE_CALLBACK, "https://claude.ai:8443/api/mcp/auth_callback"),
        (CLAUDE_CALLBACK, "https://claude.ai/api/mcp/auth_callback#x"),
        ("http://127.0.0.1/callback", "http://localhost:5000/callback"),  # another host
        ("http://localhost/callback", "http://127.0.0.1:5000/callback"),
        ("http://127.0.0.1/callback", "http://127.0.0.1:5000/other"),  # another path
        ("http://127.0.0.1/callback", "http://127.0.0.1:5000/callback?x=1"),
        ("http://127.0.0.1/callback", "https://127.0.0.1:5000/callback"),
        ("https://localhost/cb", "https://localhost:5000/cb"),  # only http loopback floats
        ("cursor://anysphere.cursor-mcp/oauth/callback", "cursor://anysphere.cursor-mcp/other"),
        (CLAUDE_CALLBACK, "javascript:alert(1)"),
    ],
)
def test_other_redirects_never_match(
    api: TestClient, user: dict[str, str], registered: str, requested: str
) -> None:
    registration = register(api, [registered])
    params = authorize_params(registration, new_pkce(), redirect_uri=requested)
    for path, headers in (("check", None), ("approve", user), ("deny", None)):
        response = api.post(f"/api/oauth/authorize/{path}", json=params, headers=headers)
        assert response.status_code == 400
        assert response.json()["error"] == "invalid_redirect_uri"
        assert "redirectTo" not in response.json()
        assert response.headers["cache-control"] == NO_STORE


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"responseType": "token"}, "unsupported_response_type"),
        ({"codeChallengeMethod": "plain"}, "invalid_request"),
        ({"codeChallengeMethod": ""}, "invalid_request"),
        ({"codeChallenge": "too-short"}, "invalid_request"),
        ({"codeChallenge": "=" * 43}, "invalid_request"),
        ({"resource": "https://elsewhere.example/mcp"}, "invalid_target"),
        ({"resource": f"{ORIGIN}/other"}, "invalid_target"),
        ({"resource": f"{ORIGIN}/mcp?x=1"}, "invalid_target"),
        ({"resource": f"{ORIGIN}/mcp#x"}, "invalid_target"),
        ({"resource": "http://forge.example/mcp"}, "invalid_target"),
        ({"resource": "https://forge.example:8443/mcp"}, "invalid_target"),
        ({"resource": "https://user@forge.example/mcp"}, "invalid_target"),
        ({"resource": "https://forge.example:x/mcp"}, "invalid_target"),
        ({"resource": "forge.example/mcp"}, "invalid_target"),
    ],
)
def test_other_errors_go_back_to_the_client(
    api: TestClient, user: dict[str, str], overrides: dict[str, Any], error: str
) -> None:
    registration = register(api)
    params = authorize_params(registration, new_pkce(), state="s-1", **overrides)
    for path, headers in (("check", None), ("approve", user)):
        response = api.post(f"/api/oauth/authorize/{path}", json=params, headers=headers)
        assert response.status_code == 400
        body = response.json()
        assert body["error"] == error
        assert body["redirectTo"].startswith(CLAUDE_CALLBACK + "?")
        returned = query_of(body["redirectTo"])
        assert returned["error"] == error
        assert returned["error_description"] == body["errorDescription"]
        assert returned["state"] == "s-1"
        assert returned["iss"] == ORIGIN
        assert "code" not in returned


@pytest.mark.parametrize(
    "resource",
    [
        None,
        "",
        RESOURCE,
        RESOURCE + "/",
        ORIGIN,
        ORIGIN + "/",
        "HTTPS://FORGE.EXAMPLE/mcp",
        "https://forge.example:443/mcp",
    ],
)
def test_resource_spellings_that_mean_the_connector(
    api: TestClient, user: dict[str, str], resource: str | None
) -> None:
    registration = register(api)
    pkce = new_pkce()
    params = authorize_params(registration, pkce, resource=resource)
    if resource == "":
        params["resource"] = ""
    code = approve(api, params, user)
    tokens = exchange(api, registration, code, pkce).json()
    assert whoami(api, tokens["access_token"]) == 200


def test_a_long_state_is_an_error_without_the_state(api: TestClient) -> None:
    registration = register(api)
    params = authorize_params(registration, new_pkce(), state="s" * 2049)
    body = api.post("/api/oauth/authorize/check", json=params).json()
    assert body["error"] == "invalid_request"
    assert "state" not in query_of(body["redirectTo"])
    denied = api.post("/api/oauth/authorize/deny", json=params).json()
    assert "state" not in query_of(denied["redirectTo"])


def test_approval_needs_the_signed_in_person(api: TestClient) -> None:
    params = authorize_params(register(api), new_pkce())
    response = api.post("/api/oauth/authorize/approve", json=params)
    assert response.status_code == 401
    assert response.json() == {"error": "unauthenticated"}


def test_deny_sends_access_denied_back(api: TestClient) -> None:
    registration = register(api, ["https://chatgpt.com/connector_platform_oauth_redirect?x=1"])
    response = api.post(
        "/api/oauth/authorize/deny", json=authorize_params(registration, new_pkce(), state="st")
    )
    assert response.status_code == 200
    redirect_to = response.json()["redirectTo"]
    assert redirect_to.startswith("https://chatgpt.com/connector_platform_oauth_redirect?x=1&")
    returned = query_of(redirect_to)
    assert returned["error"] == "access_denied"
    assert returned["state"] == "st"
    assert returned["iss"] == ORIGIN
    assert "code" not in returned
    assert response.headers["cache-control"] == NO_STORE


def test_deny_without_state_sends_none(api: TestClient) -> None:
    registration = register(api)
    params = authorize_params(registration, new_pkce(), state=None)
    assert "state" not in query_of(
        api.post("/api/oauth/authorize/deny", json=params).json()["redirectTo"]
    )


def test_consent_responses_carry_no_null(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api)
    params = authorize_params(registration, new_pkce(), state=None, resource=None)
    for path, headers in (("check", None), ("approve", user), ("deny", None)):
        assert not has_null(
            api.post(f"/api/oauth/authorize/{path}", json=params, headers=headers).json()
        )
    bad = authorize_params(registration, new_pkce(), clientId="nope")
    assert not has_null(api.post("/api/oauth/authorize/check", json=bad).json())


# --- the token endpoint ----------------------------------------------------------------


def test_a_used_code_revokes_everything_issued_from_it(
    api: TestClient, user: dict[str, str], caplog: pytest.LogCaptureFixture
) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    first = exchange(api, registration, code, pkce).json()
    assert whoami(api, first["access_token"]) == 200
    with caplog.at_level(logging.WARNING):
        second = exchange(api, registration, code, pkce)
    assert second.status_code == 400
    assert second.json()["error"] == "invalid_grant"
    assert whoami(api, first["access_token"]) == 401
    assert refresh(api, registration, first["refresh_token"]).json()["error"] == "invalid_grant"
    assert "presented twice" in caplog.text
    assert code not in caplog.text


def test_a_wrong_verifier_fails_and_keeps_the_code(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    for verifier in (new_pkce().verifier, "short", "x" * 129, "has space" + "x" * 40):
        wrong = exchange(api, registration, code, pkce, code_verifier=verifier)
        assert wrong.status_code == 400
        assert wrong.json()["error"] == "invalid_grant"
    assert exchange(api, registration, code, pkce).status_code == 200


def test_the_code_is_bound_to_its_redirect_uri(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api, ["http://127.0.0.1/callback"])
    pkce = new_pkce()
    params = authorize_params(registration, pkce, redirect_uri="http://127.0.0.1:5000/callback")
    code = approve(api, params, user)
    for other in ("http://127.0.0.1:5001/callback", "http://127.0.0.1/callback"):
        wrong = exchange(api, registration, code, pkce, redirect_uri=other)
        assert wrong.json()["error"] == "invalid_grant"
    right = exchange(api, registration, code, pkce, redirect_uri="http://127.0.0.1:5000/callback")
    assert right.status_code == 200


def test_the_code_is_bound_to_its_client(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api)
    stranger = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    assert exchange(api, stranger, code, pkce).json()["error"] == "invalid_grant"
    assert exchange(api, registration, code, pkce).status_code == 200


def test_the_code_lives_5_minutes(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    """Long enough for Antigravity, whose sign-in has the person paste the code back."""
    assert oauth_service.CODE_TTL == 5 * 60
    registration = register(api)
    late, in_time = new_pkce(), new_pkce()
    expired_code = approve(api, authorize_params(registration, late), user)
    fresh_code = approve(api, authorize_params(registration, in_time), user)
    oauth_clock.advance(5 * 60 - 1)
    assert exchange(api, registration, fresh_code, in_time).status_code == 200
    oauth_clock.advance(1)
    expired = exchange(api, registration, expired_code, late)
    assert expired.status_code == 400
    assert expired.json() == {
        "error": "invalid_grant",
        "error_description": "The authorization code expired.",
    }


def test_a_code_is_still_single_use_and_pkce_bound_late_in_its_life(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    oauth_clock.advance(4 * 60)
    wrong = exchange(api, registration, code, pkce, code_verifier=new_pkce().verifier)
    assert wrong.json()["error"] == "invalid_grant"
    assert exchange(api, registration, code, pkce).status_code == 200
    assert exchange(api, registration, code, pkce).json()["error"] == "invalid_grant"


@pytest.mark.parametrize("code", ["forge_ac_unknown", "not a code", "x" * 300])
def test_unknown_codes_are_invalid_grant(api: TestClient, code: str) -> None:
    registration = register(api)
    response = exchange(api, registration, code, new_pkce())
    assert response.json()["error"] == "invalid_grant"


def test_token_request_parameter_errors(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api)
    client_id = registration["client_id"]
    cases: list[tuple[dict[str, Any], int, str]] = [
        ({"client_id": client_id}, 400, "invalid_request"),  # no grant_type
        ({"grant_type": "password", "client_id": client_id}, 400, "unsupported_grant_type"),
        ({"grant_type": "authorization_code", "client_id": client_id}, 400, "invalid_request"),
        ({"grant_type": "refresh_token", "client_id": client_id}, 400, "invalid_request"),
        ({"grant_type": "authorization_code"}, 401, "invalid_client"),
        ({"grant_type": "authorization_code", "client_id": "fc1.x.y"}, 401, "invalid_client"),
        (
            {"grant_type": ["authorization_code", "refresh_token"], "client_id": client_id},
            400,
            "invalid_request",
        ),
        (
            {
                "grant_type": "refresh_token",
                "refresh_token": "x",
                "client_id": client_id,
                "resource": "https://elsewhere.example/mcp",
            },
            400,
            "invalid_target",
        ),
    ]
    for form, status, error in cases:
        response = api.post("/oauth/token", data=form)
        assert (response.status_code, response.json()["error"]) == (status, error), form
        assert response.headers["cache-control"] == NO_STORE
        assert "www-authenticate" not in response.headers


def test_the_token_endpoint_tolerates_json(api: TestClient, user: dict[str, str]) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": CLAUDE_CALLBACK,
        "code_verifier": pkce.verifier,
        "client_id": registration["client_id"],
        "resource": [RESOURCE, ORIGIN],
        "scope": None,  # an explicit null reads as absent
    }
    response = api.post("/oauth/token", json=body)
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "body",
    [b"{bad json", b"[]", json.dumps({"grant_type": 7}).encode()],
)
def test_bad_json_token_requests(api: TestClient, body: bytes) -> None:
    response = api.post("/oauth/token", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_bad_form_token_requests(api: TestClient) -> None:
    not_utf8 = api.post(
        "/oauth/token",
        content=b"grant_type=\xff\xfe",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert not_utf8.json()["error"] == "invalid_request"
    many = "&".join(f"p{n}=v" for n in range(70))
    too_many = api.post(
        "/oauth/token", content=many, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    assert too_many.json()["error"] == "invalid_request"
    huge = api.post("/oauth/token", data={"grant_type": "x" * (oauth_service.MAX_FORM_BYTES + 1)})
    assert huge.status_code == 413


def test_a_token_request_for_another_resource_is_invalid_target(
    api: TestClient, user: dict[str, str]
) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    for resource in ("https://elsewhere.example/mcp", f"{ORIGIN}/other"):
        wrong = exchange(api, registration, code, pkce, resource=resource)
        assert wrong.json()["error"] == "invalid_target"
    assert exchange(api, registration, code, pkce).status_code == 200


def _basic(client_id: str, secret: str) -> dict[str, str]:
    pair = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    return {"Authorization": f"Basic {pair}"}


def test_confidential_clients_authenticate(api: TestClient, user: dict[str, str]) -> None:
    for method in ("client_secret_basic", "client_secret_post"):
        registration = register(api, method=method)
        client_id, secret = registration["client_id"], registration["client_secret"]
        pkce = new_pkce()
        code = approve(api, authorize_params(registration, pkce), user)
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": CLAUDE_CALLBACK,
            "code_verifier": pkce.verifier,
        }
        missing = api.post("/oauth/token", data={**form, "client_id": client_id})
        assert (missing.status_code, missing.json()["error"]) == (401, "invalid_client")
        wrong = api.post("/oauth/token", data=form, headers=_basic(client_id, "wrong"))
        assert (wrong.status_code, wrong.json()["error"]) == (401, "invalid_client")
        assert wrong.headers["www-authenticate"] == 'Basic realm="FORGE"'
        if method == "client_secret_basic":
            ok = api.post("/oauth/token", data=form, headers=_basic(client_id, secret))
        else:
            ok = api.post(
                "/oauth/token", data={**form, "client_id": client_id, "client_secret": secret}
            )
        assert ok.status_code == 200, ok.text
        tokens = ok.json()
        renewed = api.post(
            "/oauth/token",
            data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
            headers=_basic(client_id, secret),
        )
        assert renewed.status_code == 200


def test_basic_credential_edge_cases(api: TestClient, user: dict[str, str]) -> None:
    public = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(public, pkce), user)
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": CLAUDE_CALLBACK,
        "code_verifier": pkce.verifier,
    }
    malformed = api.post("/oauth/token", data=form, headers={"Authorization": "Basic !!!"})
    assert (malformed.status_code, malformed.json()["error"]) == (401, "invalid_client")
    assert malformed.headers["www-authenticate"] == 'Basic realm="FORGE"'
    two_ids = api.post(
        "/oauth/token",
        data={**form, "client_id": "someone-else"},
        headers=_basic(public["client_id"], ""),
    )
    assert two_ids.json()["error"] == "invalid_request"
    two_secrets = api.post(
        "/oauth/token",
        data={**form, "client_secret": "x"},
        headers=_basic(public["client_id"], ""),
    )
    assert two_secrets.json()["error"] == "invalid_request"
    # A public client may send Basic with an empty secret, and other schemes are ignored.
    ok = api.post("/oauth/token", data=form, headers=_basic(public["client_id"], ""))
    assert ok.status_code == 200, ok.text
    bearer_header = api.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": ok.json()["refresh_token"],
            "client_id": public["client_id"],
        },
        headers={"Authorization": "Bearer something"},
    )
    assert bearer_header.status_code == 200


# --- MCP 2025-03-26's fallback paths ---------------------------------------------------


def test_the_fallback_paths_register_and_trade_tokens(
    api: TestClient, user: dict[str, str]
) -> None:
    """`/register` and `/token`, for a client that didn't keep the metadata (the MCP Python
    SDK refreshes at `/token` after a restart): the same handlers, never advertised."""
    registered = api.post(
        "/register",
        json={
            "redirect_uris": [CLAUDE_CALLBACK],
            "client_name": "MCP SDK",
            "token_endpoint_auth_method": "none",
        },
    )
    assert registered.status_code == 201, registered.text
    assert registered.headers["cache-control"] == NO_STORE
    registration = registered.json()
    assert registration["client_id"].startswith("fc1.")
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": CLAUDE_CALLBACK,
        "code_verifier": pkce.verifier,
        "client_id": registration["client_id"],
    }
    granted = api.post("/token", data=form, headers={"Origin": "https://example.com"})
    assert granted.status_code == 200, granted.text
    assert granted.headers["cache-control"] == NO_STORE
    assert granted.headers["access-control-allow-origin"] == "*"  # the connector's CORS
    tokens = granted.json()
    assert whoami(api, tokens["access_token"]) == 200
    renewed = api.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
            "client_id": registration["client_id"],
        },
    )
    assert renewed.status_code == 200
    assert whoami(api, renewed.json()["access_token"]) == 200
    # The same errors as /oauth/token and /oauth/register.
    missing = api.post("/token", data={"client_id": registration["client_id"]})
    assert (missing.status_code, missing.json()["error"]) == (400, "invalid_request")
    refused = api.post("/register", json={"redirect_uris": ["javascript:alert(1)"]})
    assert (refused.status_code, refused.json()["error"]) == (400, "invalid_redirect_uri")
    # The metadata still names only the /oauth/ paths.
    metadata = json.dumps(api.get("/.well-known/oauth-authorization-server").json())
    for alias in ("/token", "/register"):
        assert f'"{ORIGIN}{alias}"' not in metadata


# --- refresh rotation and reuse --------------------------------------------------------


def test_refresh_rotates_and_reuse_revokes_the_whole_grant(
    api: TestClient,
    user: dict[str, str],
    oauth_clock: EpochClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection = connect(api, user)
    first = refresh(api, connection.registration, connection.refresh_token).json()
    second = refresh(api, connection.registration, first["refresh_token"]).json()
    assert whoami(api, second["access_token"]) == 200
    oauth_clock.advance(oauth_service.REFRESH_REUSE_GRACE)  # past the retry window
    with caplog.at_level(logging.WARNING):
        replay = refresh(api, connection.registration, connection.refresh_token)
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"
    assert "presented again" in caplog.text
    assert connection.refresh_token not in caplog.text
    for token in (connection.access_token, first["access_token"], second["access_token"]):
        assert whoami(api, token) == 401
    assert refresh(api, connection.registration, second["refresh_token"]).json()["error"] == (
        "invalid_grant"
    )


def test_refresh_reuse_inside_the_grace_window_is_a_retry(
    api: TestClient,
    user: dict[str, str],
    oauth_clock: EpochClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The client lost the response, or two of its sessions refreshed at once: a fresh pair
    in the same grant, and nothing is revoked."""
    assert oauth_service.REFRESH_REUSE_GRACE == 30
    connection = connect(api, user)
    first = refresh(api, connection.registration, connection.refresh_token)
    assert first.status_code == 200
    oauth_clock.advance(29)
    with caplog.at_level(logging.INFO, logger=oauth_service.__name__):
        retry = refresh(api, connection.registration, connection.refresh_token)
    assert retry.status_code == 200, retry.text
    assert retry.headers["cache-control"] == NO_STORE
    again = retry.json()
    assert set(again) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}
    assert again["refresh_token"] not in (first.json()["refresh_token"], connection.refresh_token)
    assert again["access_token"] != first.json()["access_token"]
    # Nothing was revoked: both pairs work, and both new refresh tokens rotate as usual.
    for pair in (first.json(), again):
        assert whoami(api, pair["access_token"]) == 200
        assert refresh(api, connection.registration, pair["refresh_token"]).status_code == 200
    assert len(api.get("/api/oauth/grants", headers=user).json()["agents"]) == 1  # one grant
    assert "treated as a retry" in caplog.text
    assert "presented again" not in caplog.text
    for secret in (connection.refresh_token, again["refresh_token"], again["access_token"]):
        assert secret not in caplog.text


def test_refresh_reuse_30_seconds_after_the_rotation_revokes_the_grant(
    api: TestClient,
    user: dict[str, str],
    oauth_clock: EpochClock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection = connect(api, user)
    first = refresh(api, connection.registration, connection.refresh_token).json()
    oauth_clock.advance(30)
    with caplog.at_level(logging.WARNING, logger=oauth_service.__name__):
        replay = refresh(api, connection.registration, connection.refresh_token)
    assert replay.status_code == 400
    assert replay.json() == {
        "error": "invalid_grant",
        "error_description": "The refresh token was already used. Connect the app again.",
    }
    assert "presented again" in caplog.text
    assert whoami(api, first["access_token"]) == 401
    assert refresh(api, connection.registration, first["refresh_token"]).json()["error"] == (
        "invalid_grant"
    )
    assert api.get("/api/oauth/grants", headers=user).json() == {"agents": []}


def test_the_grace_window_runs_from_the_rotation_not_from_a_retry(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    connection = connect(api, user)
    first = refresh(api, connection.registration, connection.refresh_token).json()
    oauth_clock.advance(20)
    retried = refresh(api, connection.registration, connection.refresh_token)
    assert retried.status_code == 200
    oauth_clock.advance(10)  # 30 s after the rotation, 10 s after the retry
    replay = refresh(api, connection.registration, connection.refresh_token)
    assert replay.json()["error"] == "invalid_grant"
    for access in (first["access_token"], retried.json()["access_token"]):
        assert whoami(api, access) == 401


@pytest.mark.parametrize("how", ["disconnect", "revocation", "replayed code"])
def test_a_grant_revoked_another_way_stays_revoked_inside_the_grace_window(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock, how: str
) -> None:
    registration = register(api)
    pkce = new_pkce()
    code = approve(api, authorize_params(registration, pkce), user)
    tokens = exchange(api, registration, code, pkce).json()
    first = refresh(api, registration, tokens["refresh_token"]).json()
    oauth_clock.advance(5)
    if how == "disconnect":
        agent = api.get("/api/oauth/grants", headers=user).json()["agents"][0]
        assert api.delete(f"/api/oauth/grants/{agent['id']}", headers=user).status_code == 200
    elif how == "revocation":
        revoked = api.post(
            "/oauth/revoke",
            data={"token": first["refresh_token"], "client_id": registration["client_id"]},
        )
        assert revoked.status_code == 200
    else:
        assert exchange(api, registration, code, pkce).json()["error"] == "invalid_grant"
    oauth_clock.advance(5)  # 10 s after the rotation: inside the window
    retry = refresh(api, registration, tokens["refresh_token"])
    assert retry.status_code == 400
    assert retry.json() == {
        "error": "invalid_grant",
        "error_description": "The refresh token was revoked.",
    }
    for access in (tokens["access_token"], first["access_token"]):
        assert whoami(api, access) == 401
    assert api.get("/api/oauth/grants", headers=user).json() == {"agents": []}


def test_refresh_is_bound_to_the_client(api: TestClient, user: dict[str, str]) -> None:
    connection = connect(api, user)
    stranger = register(api)
    stolen = refresh(api, stranger, connection.refresh_token)
    assert stolen.json()["error"] == "invalid_grant"
    assert refresh(api, connection.registration, connection.refresh_token).status_code == 200


def test_tokens_expire(api: TestClient, user: dict[str, str], oauth_clock: EpochClock) -> None:
    connection = connect(api, user)
    oauth_clock.advance(3599)
    assert whoami(api, connection.access_token) == 200
    oauth_clock.advance(1)
    assert whoami(api, connection.access_token) == 401
    renewed = refresh(api, connection.registration, connection.refresh_token).json()
    oauth_clock.advance(30 * 24 * 3600)
    expired = refresh(api, connection.registration, renewed["refresh_token"])
    assert expired.json() == {
        "error": "invalid_grant",
        "error_description": "The refresh token expired.",
    }


def test_refresh_accepts_the_canonical_resource_only(api: TestClient, user: dict[str, str]) -> None:
    connection = connect(api, user)
    form = {
        "grant_type": "refresh_token",
        "refresh_token": connection.refresh_token,
        "client_id": connection.registration["client_id"],
    }
    wrong = api.post("/oauth/token", data={**form, "resource": "https://other.example/mcp"})
    assert wrong.json()["error"] == "invalid_target"
    assert api.post("/oauth/token", data={**form, "resource": ORIGIN}).status_code == 200


def test_codes_and_refresh_tokens_from_an_old_origin_make_the_client_reconnect(
    api: TestClient, user: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = connect(api, user)
    pkce = new_pkce()
    code = approve(api, authorize_params(connection.registration, pkce), user)
    moved = "https://forge-moved.example"
    monkeypatch.setenv(oauth_service.ORIGIN_ENV, moved)
    redeemed = exchange(api, connection.registration, code, pkce, resource=moved + "/mcp")
    assert redeemed.json() == {
        "error": "invalid_grant",
        "error_description": "The code was issued for another FORGE address.",
    }
    # Without a resource parameter too: new tokens for the old address would only 401.
    renewed = refresh(api, connection.registration, connection.refresh_token)
    assert renewed.json() == {
        "error": "invalid_grant",
        "error_description": "The connection was made for another FORGE address.",
    }
    again = new_pkce()
    code = approve(api, authorize_params(connection.registration, again, resource=None), user)
    reconnected = exchange(api, connection.registration, code, again, resource=moved + "/mcp")
    assert whoami(api, reconnected.json()["access_token"]) == 200


# --- revocation (RFC 7009) -------------------------------------------------------------


def test_revoking_an_access_token_leaves_the_refresh_token(
    api: TestClient, user: dict[str, str]
) -> None:
    connection = connect(api, user)
    response = api.post(
        "/oauth/revoke",
        data={"token": connection.access_token, "token_type_hint": "access_token"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == NO_STORE
    assert whoami(api, connection.access_token) == 401
    assert refresh(api, connection.registration, connection.refresh_token).status_code == 200


@pytest.mark.parametrize(
    "form",
    [
        {},
        {"token": ""},
        {"token": "forge_rt_unknown"},
        {"token": "bad token!"},
        {"token": ["a", "b"]},
    ],
)
def test_revocation_always_answers_200(api: TestClient, form: dict[str, Any]) -> None:
    assert api.post("/oauth/revoke", data=form).status_code == 200


def test_revocation_by_another_client_changes_nothing(
    api: TestClient, user: dict[str, str]
) -> None:
    connection = connect(api, user)
    stranger = register(api)
    for headers, extra in (
        ({}, {"client_id": stranger["client_id"]}),
        ({}, {"client_id": "not-a-client"}),
        ({"Authorization": "Basic !!!"}, {}),
    ):
        response = api.post(
            "/oauth/revoke", data={"token": connection.refresh_token, **extra}, headers=headers
        )
        assert response.status_code == 200
    assert whoami(api, connection.access_token) == 200
    revoke = api.post("/oauth/revoke", content=b"{", headers={"Content-Type": "application/json"})
    assert revoke.status_code == 200


# --- connected agents ------------------------------------------------------------------


def test_grants_list_and_delete_touch_only_the_callers_grants(
    api: TestClient,
    user: dict[str, str],
    other_user: dict[str, str],
    oauth_clock: EpochClock,
) -> None:
    mine = connect(api, user, redirect_uris=["http://localhost:3118/callback"])
    oauth_clock.advance(10)
    theirs = connect(api, other_user)

    listed = api.get("/api/oauth/grants", headers=user)
    assert listed.status_code == 200
    agents = listed.json()["agents"]
    assert len(agents) == 1
    agent = agents[0]
    assert agent["clientName"] == "Claude"
    assert agent["redirectHost"] == "localhost"
    assert agent["connectedAt"] == "2026-09-21T14:13:20Z"
    assert "lastUsedAt" not in agent
    assert not has_null(listed.json())

    oauth_clock.advance(5)
    assert whoami(api, mine.access_token) == 200
    used = api.get("/api/oauth/grants", headers=user).json()["agents"][0]
    assert used["lastUsedAt"] == "2026-09-21T14:13:35Z"

    other_agents = api.get("/api/oauth/grants", headers=other_user).json()["agents"]
    assert [entry["redirectHost"] for entry in other_agents] == ["claude.ai"]

    # Deleting someone else's grant id is a no-op that still lists your own agents.
    untouched = api.delete(f"/api/oauth/grants/{other_agents[0]['id']}", headers=user)
    assert untouched.status_code == 200
    assert untouched.json()["agents"] == api.get("/api/oauth/grants", headers=user).json()["agents"]
    assert whoami(api, theirs.access_token) == 200

    gone = api.delete(f"/api/oauth/grants/{agent['id']}", headers=user)
    assert gone.json() == {"agents": []}
    assert whoami(api, mine.access_token) == 401
    assert refresh(api, mine.registration, mine.refresh_token).json()["error"] == "invalid_grant"
    assert api.delete(f"/api/oauth/grants/{agent['id']}", headers=user).json() == {"agents": []}


def test_reconnecting_a_client_reuses_its_grant(api: TestClient, user: dict[str, str]) -> None:
    first = connect(api, user)
    second = connect(api, user, registration=first.registration)
    agents = api.get("/api/oauth/grants", headers=user).json()["agents"]
    assert len(agents) == 1
    assert whoami(api, first.access_token) == 200
    assert whoami(api, second.access_token) == 200
    other_client = connect(api, user)
    assert len(api.get("/api/oauth/grants", headers=user).json()["agents"]) == 2
    assert whoami(api, other_client.access_token) == 200


def test_grants_need_the_signed_in_person(api: TestClient) -> None:
    assert api.get("/api/oauth/grants").status_code == 401
    assert api.delete("/api/oauth/grants/anything").status_code == 401


def test_lapsed_grants_are_not_listed(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    connect(api, user)
    oauth_clock.advance(30 * 24 * 3600)
    assert api.get("/api/oauth/grants", headers=user).json() == {"agents": []}


# --- gates -----------------------------------------------------------------------------


def test_the_route_list_covers_every_connector_route() -> None:
    paths = app.openapi()["paths"]
    schema_routes = {
        (method.upper(), path)
        for path, operations in paths.items()
        if path.startswith(("/.well-known/", "/oauth/", "/api/oauth/", "/mcp"))
        for method in operations
    }
    assert schema_routes | HIDDEN_ROUTES == set(CONNECTOR_ROUTES)
    assert "/register" not in paths and "/token" not in paths  # fallbacks, never advertised


@pytest.mark.parametrize(("method", "path"), CONNECTOR_ROUTES)
def test_every_route_404s_while_the_flag_is_off(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, method: str, path: str
) -> None:
    use_connector(monkeypatch, mcp_connector=False)
    response = api.request(method, path.replace("{grant_id}", "x"))
    assert response.status_code == 404
    assert response.json() == CONNECTOR_DISABLED


@pytest.mark.parametrize(
    "environment",
    [
        {oauth_service.ORIGIN_ENV: None},
        {oauth_service.ORIGIN_ENV: ""},
        {oauth_service.ORIGIN_ENV: "http://forge.example"},
        {oauth_service.ORIGIN_ENV: "https://forge.example/app"},
        {oauth_service.ORIGIN_ENV: "forge.example"},
        {oauth_service.SECRET_ENV: None},
        {oauth_service.SECRET_ENV: "s" * 31},
    ],
    ids=repr,
)
@pytest.mark.parametrize(("method", "path"), CONNECTOR_ROUTES)
def test_every_route_503s_while_unconfigured(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    environment: dict[str, str | None],
    method: str,
    path: str,
) -> None:
    for name, value in environment.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    response = api.request(method, path.replace("{grant_id}", "x"))
    assert response.status_code == 503
    assert response.json() == CONNECTOR_UNAVAILABLE


def test_misconfiguration_is_logged_once_without_the_secret(
    caplog: pytest.LogCaptureFixture,
) -> None:
    oauth_service._warn_once.cache_clear()
    short = "short-test-only-secret"
    env = {oauth_service.ORIGIN_ENV: ORIGIN, oauth_service.SECRET_ENV: short}
    with caplog.at_level(logging.WARNING, logger=oauth_service.__name__):
        assert oauth_service.load_config(env) is None
        assert oauth_service.load_config(env) is None
    assert len(caplog.records) == 1
    assert oauth_service.SECRET_ENV in caplog.text
    assert short not in caplog.text


# --- the service, directly -------------------------------------------------------------


def test_config_parsing() -> None:
    loaded = oauth_service.load_config(
        {
            oauth_service.ORIGIN_ENV: " https://Forge.Example/ ",
            oauth_service.SECRET_ENV: OAUTH_SECRET,
            oauth_service.ALLOWED_ORIGINS_ENV: "http://localhost:6274, ,https://Claude.ai/,bad",
        }
    )
    assert loaded is not None
    assert loaded.origin == ORIGIN
    assert loaded.mcp_origins == (
        {ORIGIN, "http://localhost:6274", "https://claude.ai"} | oauth_service.HOSTED_CLIENT_ORIGINS
    )
    assert OAUTH_SECRET not in repr(loaded)
    assert loaded.resource_metadata_url == RESOURCE_METADATA
    bare = config()  # no FORGE_MCP_ALLOWED_ORIGINS: the public origin and the hosted clients
    assert bare.mcp_origins == {ORIGIN} | oauth_service.HOSTED_CLIENT_ORIGINS


def test_the_hosted_client_origins() -> None:
    """The hosted MCP clients whose backends may send an `Origin` to /mcp. Each is already
    in canonical form, so `normalize_origin` maps a request's header onto it."""
    assert oauth_service.HOSTED_CLIENT_ORIGINS == {
        "https://claude.ai",
        "https://chatgpt.com",
        "https://chat.openai.com",
        "https://antigravity.google",
        "https://cursor.com",
        "https://www.cursor.com",
        "https://vscode.dev",
        "https://insiders.vscode.dev",
        "https://github.com",
    }
    for origin in oauth_service.HOSTED_CLIENT_ORIGINS:
        assert oauth_service.normalize_origin(origin) == origin


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [
        ("https://a.example", "https://a.example"),
        ("HTTPS://A.EXAMPLE:443/", "https://a.example"),
        ("http://a.example:80", "http://a.example"),
        ("http://[::1]:8080", "http://[::1]:8080"),
        ("https://a.example:8443", "https://a.example:8443"),
        ("ftp://a.example", None),
        ("https://a.example/path", None),
        ("https://a.example?q", None),
        ("https://user@a.example", None),
        ("https://a.example:99999", None),
        ("", None),
        ("null", None),
    ],
)
def test_normalize_origin(raw: str, normalized: str | None) -> None:
    assert oauth_service.normalize_origin(raw) == normalized


def test_verify_access_token_directly(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    oauth_clock.now = time.time()  # so the default (wall) clock agrees with the injected one
    connection = connect(api, user)
    db = get_state_db()
    now = int(oauth_clock())
    assert oauth_service.verify_access_token(db, connection.access_token, RESOURCE, now=now) == (
        Identity(*USER)
    )
    for token, resource in (
        (connection.access_token, "https://other.example/mcp"),
        (connection.refresh_token, RESOURCE),  # a refresh token is not an access token
        ("forge_at_" + "A" * 43, RESOURCE),
        ("forge_at_bad token", RESOURCE),
    ):
        with pytest.raises(InvalidToken):
            oauth_service.verify_access_token(db, token, resource, now=now)
    assert oauth_service.verify_access_token(db, connection.access_token, RESOURCE).login == USER[1]


def test_purge_forgets_what_lapsed(
    api: TestClient, user: dict[str, str], oauth_clock: EpochClock
) -> None:
    connection = connect(api, user)
    pkce = new_pkce()
    approve(api, authorize_params(connection.registration, pkce), user)  # an unused code
    db = get_state_db()

    def count(table: str) -> int:
        row = db.query_one(f"SELECT COUNT(*) AS n FROM {table}")
        assert row is not None
        return int(row["n"])

    def counts() -> tuple[int, int, int]:
        return count("oauth_codes"), count("oauth_tokens"), count("oauth_grants")

    assert counts() == (2, 2, 1)
    now = int(oauth_clock())
    oauth_service.purge_expired(db, now=now + 2 * 24 * 3600)
    assert counts() == (0, 1, 1)  # the codes and the access token are gone
    oauth_service.purge_expired(db, now=now + 62 * 24 * 3600)
    assert counts() == (0, 0, 0)
