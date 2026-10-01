"""The FORGE connector's OAuth 2.1 authorization server (contract §1, §5, §9).

MCP clients (Claude, Codex, VS Code, Cursor, Antigravity, ChatGPT) find it through the
metadata documents (RFC 9728, RFC 8414), register themselves (RFC 7591), send the person
to the web's consent page (`/oauth/authorize`, which calls `check_authorization`,
`approve_authorization` and `deny_authorization` server-side), and trade the code for
tokens at `/oauth/token`. `/mcp` checks those tokens with `verify_access_token`. A client
that lost the metadata falls back to MCP 2025-03-26's default paths, so `/register` and
`/token` answer too (routers/oauth.py); the metadata names only the `/oauth/*` ones.

What is stored, and what isn't:

- Clients are not stored. A `client_id` is a signed, versioned record of what the client
  registered: `fc1.<base64url JSON>.<base64url HMAC-SHA256>`, keyed by a key derived from
  FORGE_OAUTH_SECRET, so registration is open and costs no storage (Claude registers a
  new client on every fresh connection). A confidential client's `client_secret` is
  derived from its client_id with a second derived key, so it is not stored either.
  Rotating FORGE_OAUTH_SECRET retires every client: clients register again and people
  reconnect.
- Codes (5 minutes, single use: Antigravity's sign-in has the person paste the code back
  by hand), access tokens (1 h) and refresh tokens (30 days, rotated on every use) are
  opaque random strings with a readable prefix, stored only as SHA-256.
- A grant is one person's connection of one client: what "Connected agents" lists and
  what DELETE revokes, together with every token in it. Presenting a used code again
  revokes the whole grant, and so does a rotated refresh token presented again more than
  30 seconds after it was rotated. Inside those 30 seconds it is a retry (the client lost
  the response, or two of its sessions refreshed at once) and gets a fresh pair.

Redirect URIs (contract §9): exact string match, except that an `http` loopback URI
(127.0.0.1, localhost, [::1]) matches on any port (RFC 8252 §7.3; Claude Code and Codex
pick the port at sign-in). No fragments; `javascript:`, `data:`, `file:`, `vbscript:`,
`about:` and `blob:` are refused, and so is plain `http:` to anything but loopback.
Private-use schemes (`cursor://...`) are accepted. Every error about the client or the
redirect URI stays on FORGE's page; every other authorization error goes back to the
client with `error`, `error_description`, `state` and `iss` (RFC 9207).

Nothing here logs a token, code, verifier or client secret.
"""

import base64
import binascii
import functools
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final
from urllib.parse import parse_qs, unquote_plus, urlencode, urlsplit

from fastapi import Request

from forge_api.models import (
    AuthorizeCheck,
    AuthorizeDecision,
    AuthorizeError,
    AuthorizeParams,
    ConnectedAgent,
    ConnectedAgentList,
)
from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity
from forge_api.services.state import StateDB, register_schema

logger = logging.getLogger(__name__)

FLAG: Final = "mcp_connector"
ORIGIN_ENV: Final = "FORGE_PUBLIC_ORIGIN"
SECRET_ENV: Final = "FORGE_OAUTH_SECRET"
ALLOWED_ORIGINS_ENV: Final = "FORGE_MCP_ALLOWED_ORIGINS"
MIN_SECRET_LENGTH: Final = 32
#: Hosted MCP clients' browser origins, accepted on /mcp besides FORGE_PUBLIC_ORIGIN and
#: FORGE_MCP_ALLOWED_ORIGINS. What protects /mcp is the bearer token, never a cookie, so a
#: script on one of these origins can only use a token it already holds; listing them
#: keeps a hosted client that sends an `Origin` header from being locked out. Any other
#: origin, and `null`, still gets 403.
HOSTED_CLIENT_ORIGINS: Final = frozenset(
    {
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
)

SCOPE: Final = "forge.tasks"
RESOURCE_PATH: Final = "/mcp"
RESOURCE_NAME: Final = "FORGE"

#: Five minutes: long enough for Antigravity's sign-in, where the person pastes the code
#: back by hand. Still single use and bound to the PKCE challenge.
CODE_TTL: Final = 5 * 60
ACCESS_TTL: Final = 60 * 60
REFRESH_TTL: Final = 30 * 24 * 60 * 60
#: A rotated refresh token presented again within this many seconds of its rotation is a
#: retry (a lost response, or two sessions refreshing at once): it gets a fresh pair in
#: the same grant. Later, it is a replay and revokes the grant.
REFRESH_REUSE_GRACE: Final = 30
#: A grant's "last used" moves at most once a minute, so an MCP call is not always a write.
LAST_USED_RESOLUTION: Final = 60
PURGE_INTERVAL: Final = 10 * 60
#: Expired codes and tokens are kept a day, so a late replay still reads as a replay.
PURGE_GRACE: Final = 24 * 60 * 60
GRANT_RETENTION: Final = 30 * 24 * 60 * 60

ACCESS_TOKEN_PREFIX: Final = "forge_at_"
REFRESH_TOKEN_PREFIX: Final = "forge_rt_"
CODE_PREFIX: Final = "forge_ac_"
CLIENT_ID_VERSION: Final = "fc1"

AUTH_METHODS: Final = ("none", "client_secret_post", "client_secret_basic")
GRANT_TYPES: Final = ("authorization_code", "refresh_token")
MAX_REDIRECT_URIS: Final = 10
MAX_REDIRECT_URI_LENGTH: Final = 512
MAX_CLIENT_NAME_LENGTH: Final = 64
MAX_CLIENT_ID_LENGTH: Final = 8192
MAX_STATE_LENGTH: Final = 2048
MAX_FORM_BYTES: Final = 16 * 1024
DEFAULT_CLIENT_NAME: Final = "Unnamed agent"

REFUSED_SCHEMES: Final = frozenset({"javascript", "data", "file", "vbscript", "about", "blob"})
#: As `urlsplit(...).hostname` gives them: lowercase, IPv6 without brackets.
LOOPBACK_HOSTS: Final = frozenset({"127.0.0.1", "localhost", "::1"})

#: Token, registration and decision responses carry credentials: never cache them.
NO_STORE: Final[Mapping[str, str]] = {"Cache-Control": "no-store", "Pragma": "no-cache"}
BASIC_CHALLENGE: Final = 'Basic realm="FORGE"'

_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*")
_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43}")  # BASE64URL(SHA-256) is always 43 characters
_VERIFIER = re.compile(r"[A-Za-z0-9._~-]{43,128}")  # RFC 7636 §4.1
_TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_-]{1,256}")
_B64URL = re.compile(r"[A-Za-z0-9_-]*")
#: Unicode categories a self-declared client name may not carry: controls, format
#: characters (bidi overrides, zero-width joiners), surrogates, private use, unassigned.
_HIDDEN_CATEGORIES: Final = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})

register_schema(
    "oauth",
    [
        """
        CREATE TABLE IF NOT EXISTS oauth_grants (
            id TEXT PRIMARY KEY,
            sub TEXT NOT NULL,
            login TEXT NOT NULL,
            client_key TEXT NOT NULL,
            client_name TEXT NOT NULL,
            redirect_host TEXT NOT NULL,
            scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER
        )
        """,
        "CREATE INDEX IF NOT EXISTS oauth_grants_by_user ON oauth_grants (sub, client_key)",
        """
        CREATE TABLE IF NOT EXISTS oauth_tokens (
            token_hash TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
            grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
            resource TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            revoked_at INTEGER
        )
        """,
        "CREATE INDEX IF NOT EXISTS oauth_tokens_by_grant ON oauth_tokens (grant_id)",
        """
        CREATE TABLE IF NOT EXISTS oauth_codes (
            code_hash TEXT PRIMARY KEY,
            client_key TEXT NOT NULL,
            redirect_uri TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            sub TEXT NOT NULL,
            login TEXT NOT NULL,
            resource TEXT NOT NULL,
            scope TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            grant_id TEXT
        )
        """,
    ],
)


# --- configuration ---------------------------------------------------------------------


@dataclass(frozen=True)
class ConnectorConfig:
    """The connector's public origin (issuer and resource live there) and signing secret."""

    origin: str
    secret: str = field(repr=False)
    #: Browser origins allowed to call /mcp: the public origin, HOSTED_CLIENT_ORIGINS and
    #: FORGE_MCP_ALLOWED_ORIGINS (as `load_config` builds it).
    mcp_origins: frozenset[str] = frozenset()

    @property
    def issuer(self) -> str:
        return self.origin

    @property
    def resource(self) -> str:
        return self.origin + RESOURCE_PATH

    @property
    def resource_metadata_url(self) -> str:
        return f"{self.origin}/.well-known/oauth-protected-resource{RESOURCE_PATH}"


#: A clock in epoch seconds. Routes take it from `get_clock`, which tests override.
Clock = Callable[[], float]


def get_clock() -> Clock:
    """FastAPI dependency: the wall clock. Tests override it to expire codes and tokens."""
    return time.time


def normalize_origin(value: str) -> str | None:
    """`scheme://host[:port]` in canonical form (lowercase, no default port, no trailing
    slash), or None for anything that is not an http(s) origin."""
    candidate = value.strip().rstrip("/")
    if not candidate or "?" in candidate or "#" in candidate:
        return None
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError:
        return None
    scheme, host = parts.scheme.lower(), parts.hostname
    if scheme not in ("http", "https") or not host or parts.path:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    default_port = 443 if scheme == "https" else 80
    netloc = _bracketed(host) + (f":{port}" if port not in (None, default_port) else "")
    return f"{scheme}://{netloc}"


def public_origin(value: str) -> str | None:
    """FORGE_PUBLIC_ORIGIN as an issuer: https, or http on loopback for local development."""
    origin = normalize_origin(value)
    if origin is None:
        return None
    if origin.startswith("https://") or urlsplit(origin).hostname in LOOPBACK_HOSTS:
        return origin
    return None


def load_config(env: Mapping[str, str] | None = None) -> ConnectorConfig | None:
    """The connector's configuration, or None while it can't run (logged once per cause)."""
    source = os.environ if env is None else env
    origin = public_origin(source.get(ORIGIN_ENV, ""))
    if origin is None:
        _warn_once(f"{ORIGIN_ENV} is unset or not an https origin: the FORGE connector is off")
        return None
    secret = source.get(SECRET_ENV, "")
    if len(secret) < MIN_SECRET_LENGTH:
        _warn_once(
            f"{SECRET_ENV} is unset or shorter than {MIN_SECRET_LENGTH} characters: "
            "the FORGE connector is off"
        )
        return None
    extra = (normalize_origin(item) for item in source.get(ALLOWED_ORIGINS_ENV, "").split(","))
    allowed = frozenset(item for item in extra if item is not None) | {origin}
    return ConnectorConfig(
        origin=origin, secret=secret, mcp_origins=allowed | HOSTED_CLIENT_ORIGINS
    )


def require_connector() -> ConnectorConfig:
    """Router dependency for every connector route: 404 while `mcp_connector` is off, then
    503 while the public origin or the OAuth secret is missing."""
    if not flags_service.is_enabled(FLAG):
        raise ApiError(404, {"error": "connector-disabled"})
    config = load_config()
    if config is None:
        raise ApiError(503, {"error": "connector_unavailable"})
    return config


@functools.lru_cache(maxsize=16)
def _warn_once(message: str) -> None:
    logger.warning(message)


# --- metadata --------------------------------------------------------------------------


def protected_resource_metadata(config: ConnectorConfig) -> dict[str, Any]:
    """RFC 9728, served at both well-known paths."""
    return {
        "resource": config.resource,
        "authorization_servers": [config.issuer],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": RESOURCE_NAME,
    }


def authorization_server_metadata(config: ConnectorConfig) -> dict[str, Any]:
    """RFC 8414. `authorization_response_iss_parameter_supported` (RFC 9207) tells Codex and
    Claude Code to expect `iss` on every authorization response, which FORGE always sends.
    No `client_id_metadata_document_supported`: clients fall back to registration."""
    origin = config.origin
    return {
        "issuer": config.issuer,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token",
        "registration_endpoint": f"{origin}/oauth/register",
        "revocation_endpoint": f"{origin}/oauth/revoke",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": list(GRANT_TYPES),
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": list(AUTH_METHODS),
        "revocation_endpoint_auth_methods_supported": list(AUTH_METHODS),
        "scopes_supported": [SCOPE],
        "service_documentation": f"{origin}/connect",
        "authorization_response_iss_parameter_supported": True,
    }


# --- errors ----------------------------------------------------------------------------


class OAuthError(ApiError):
    """An RFC 6749 §5.2 / RFC 7591 §3.2.2 error: {"error", "error_description"}, no-store."""

    def __init__(
        self,
        error: str,
        description: str,
        *,
        status: int = 400,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(
            status,
            {"error": error, "error_description": description},
            headers={**NO_STORE, **(headers or {})},
        )
        self.error = error


class InvalidToken(Exception):
    """A bearer token that is not a live FORGE access token for this resource. The message
    says why, for debug logs; it never contains the token."""


class BodyTooLarge(Exception):
    """The request body is over the endpoint's limit."""


async def read_body(request: Request, limit: int) -> bytes:
    """The request body, refused as soon as it passes `limit` bytes."""
    declared = request.headers.get("content-length", "")
    if declared.isascii() and declared.isdigit() and int(declared) > limit:
        raise BodyTooLarge
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise BodyTooLarge
    return bytes(body)


async def read_form_body(request: Request) -> bytes:
    """An OAuth endpoint's body (16 KiB at most)."""
    try:
        return await read_body(request, MAX_FORM_BYTES)
    except BodyTooLarge:
        raise OAuthError("invalid_request", "The request body is too large.", status=413) from None


# --- redirect URIs ---------------------------------------------------------------------


def redirect_uri_problem(uri: str) -> str | None:
    """Why `uri` can't be registered as a redirect URI, or None when it can."""
    if not uri:
        return "is empty"
    if len(uri) > MAX_REDIRECT_URI_LENGTH:
        return f"is longer than {MAX_REDIRECT_URI_LENGTH} characters"
    if any(not 0x21 <= ord(char) <= 0x7E for char in uri):
        return "must be printable ASCII without spaces"
    if "#" in uri:
        return "must not contain a fragment"
    scheme, colon, rest = uri.partition(":")
    if not colon or not _SCHEME.fullmatch(scheme) or not rest:
        return "must be an absolute URI"
    scheme = scheme.lower()
    if scheme in REFUSED_SCHEMES:
        return f"must not use the {scheme}: scheme"
    try:
        parts = urlsplit(uri)
        _ = parts.port  # raises ValueError for a malformed port
    except ValueError:
        return "is not a valid URI"
    if scheme in ("http", "https"):
        if not parts.hostname:
            return "must name a host"
        if parts.username is not None or parts.password is not None:
            return "must not contain user information"
        if scheme == "http" and parts.hostname not in LOOPBACK_HOSTS:
            return "must use https unless it is a loopback address (127.0.0.1, localhost, [::1])"
    return None


def redirect_uri_allowed(registered: Sequence[str], requested: str) -> bool:
    """`requested` is one of the client's redirect URIs: an exact match, or an http
    loopback URI that differs from a registered one only in its port."""
    if redirect_uri_problem(requested) is not None:
        return False
    if requested in registered:
        return True
    key = _loopback_key(requested)
    return key is not None and any(_loopback_key(uri) == key for uri in registered)


def _loopback_key(uri: str) -> tuple[str, str, str] | None:
    parts = urlsplit(uri)
    if parts.scheme.lower() != "http" or parts.hostname not in LOOPBACK_HOSTS:
        return None
    return parts.hostname, parts.path or "/", parts.query


def redirect_host(uri: str) -> str:
    """Where a redirect URI sends the person, for the consent page and the agents list:
    the host for http(s) (with a non-default https port; never a loopback port, which
    changes per sign-in), `scheme://authority` for a private-use scheme."""
    parts = urlsplit(uri)
    scheme = parts.scheme.lower()
    if scheme in ("http", "https"):
        host = _bracketed(parts.hostname or "")
        port = parts.port
        return f"{host}:{port}" if scheme == "https" and port not in (None, 443) else host
    return f"{scheme}://{parts.netloc}" if parts.netloc else f"{scheme}:"


def _with_params(uri: str, params: Mapping[str, str | None]) -> str:
    """`uri` with `params` added to its query (redirect URIs never carry a fragment)."""
    query = urlencode({name: value for name, value in params.items() if value is not None})
    return f"{uri}{'&' if '?' in uri else '?'}{query}"


def _bracketed(host: str) -> str:
    return f"[{host}]" if ":" in host else host


# --- resource indicators (RFC 8707) ----------------------------------------------------


def normalize_resource(config: ConnectorConfig, value: str) -> str | None:
    """`ORIGIN/mcp` for `ORIGIN/mcp`, `ORIGIN/mcp/` or `ORIGIN` (scheme and host in any
    case, default port optional); None for anything else."""
    if "?" in value or "#" in value:
        return None
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    origin = urlsplit(config.origin)
    scheme = parts.scheme.lower()
    if scheme != origin.scheme or parts.hostname != origin.hostname:
        return None
    default_port = 443 if scheme == "https" else 80
    if (port or default_port) != (origin.port or default_port):
        return None
    if parts.path not in ("", "/", RESOURCE_PATH, RESOURCE_PATH + "/"):
        return None
    return config.resource


# --- clients (RFC 7591, stateless) -----------------------------------------------------


@dataclass(frozen=True)
class Client:
    """A registered client, as its signed client_id records it."""

    client_id: str
    name: str
    redirect_uris: tuple[str, ...]
    auth_method: str
    issued_at: int

    @property
    def key(self) -> str:
        """What codes and grants store instead of the (long) client_id."""
        return _sha256(self.client_id)

    @property
    def confidential(self) -> bool:
        return self.auth_method != "none"


def issue_client_id(
    config: ConnectorConfig,
    *,
    name: str,
    redirect_uris: Sequence[str],
    auth_method: str,
    issued_at: int,
) -> str:
    """A new signed client_id. The random nonce makes every registration distinct, so a
    confidential client's derived secret can't be obtained by registering the same
    metadata again."""
    payload = {
        "a": auth_method,
        "n": name,
        "r": list(redirect_uris),
        "t": issued_at,
        "x": _b64(secrets.token_bytes(9)),
    }
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("ascii"))
    signing_input = f"{CLIENT_ID_VERSION}.{body}"
    return f"{signing_input}.{_b64(_mac(config, b'client-id', signing_input))}"


def parse_client_id(config: ConnectorConfig, client_id: str) -> Client | None:
    """The client a client_id describes, or None unless FORGE signed it, untouched, with
    the current secret."""
    if not 0 < len(client_id) <= MAX_CLIENT_ID_LENGTH:
        return None
    parts = client_id.split(".")
    if len(parts) != 3 or parts[0] != CLIENT_ID_VERSION:
        return None
    version, body, signature = parts
    given = _unb64(signature)
    expected = _mac(config, b"client-id", f"{version}.{body}")
    if given is None or not hmac.compare_digest(given, expected):
        return None
    raw = _unb64(body)
    try:
        payload = json.loads(raw) if raw is not None else None
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    name, uris, method, issued = (
        payload.get("n"),
        payload.get("r"),
        payload.get("a"),
        payload.get("t"),
    )
    if not (
        isinstance(name, str)
        and method in AUTH_METHODS
        and isinstance(issued, int)
        and isinstance(uris, list)
        and uris
        and all(isinstance(uri, str) for uri in uris)
    ):
        return None
    return Client(
        client_id=client_id,
        name=name,
        redirect_uris=tuple(uris),
        auth_method=str(method),
        issued_at=issued,
    )


def client_secret(config: ConnectorConfig, client_id: str) -> str:
    """A confidential client's secret: derived, never stored."""
    return _b64(_mac(config, b"client-secret", client_id))


def sanitize_client_name(raw: str) -> str:
    """A self-declared client name made safe to show: NFKC, no control or invisible
    characters, whitespace collapsed, at most 64 characters (… marks a cut)."""
    text = unicodedata.normalize("NFKC", raw)
    visible = "".join(
        " " if char.isspace() else char
        for char in text
        if char.isspace() or unicodedata.category(char) not in _HIDDEN_CATEGORIES
    )
    name = " ".join(visible.split())
    if len(name) > MAX_CLIENT_NAME_LENGTH:
        name = name[: MAX_CLIENT_NAME_LENGTH - 1].rstrip() + "…"
    return name or DEFAULT_CLIENT_NAME


def register_client(config: ConnectorConfig, body: bytes, *, now: int) -> dict[str, Any]:
    """RFC 7591 registration: validate the metadata, return the client information (201).
    Unsupported extras are replaced with what FORGE does (RFC 7591 §3.2.1 allows it):
    grant types become authorization_code + refresh_token, the scope forge.tasks."""
    try:
        metadata = json.loads(body)
    except (ValueError, RecursionError):
        raise _metadata_error("The registration request must be a JSON object.") from None
    if not isinstance(metadata, dict):
        raise _metadata_error("The registration request must be a JSON object.")
    redirect_uris = _registration_redirect_uris(metadata.get("redirect_uris"))
    method = metadata.get("token_endpoint_auth_method")
    auth_method = "client_secret_basic" if method is None else method  # RFC 7591 §2 default
    if auth_method not in AUTH_METHODS:
        raise _metadata_error(
            "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic."
        )
    _require_listed(metadata.get("grant_types"), "grant_types", "authorization_code")
    _require_listed(metadata.get("response_types"), "response_types", "code")
    raw_name = metadata.get("client_name")
    if raw_name is not None and not isinstance(raw_name, str):
        raise _metadata_error("client_name must be a string.")
    name = DEFAULT_CLIENT_NAME if raw_name is None else sanitize_client_name(raw_name)
    client_id = issue_client_id(
        config, name=name, redirect_uris=redirect_uris, auth_method=auth_method, issued_at=now
    )
    information: dict[str, Any] = {
        "client_id": client_id,
        "client_id_issued_at": now,
        "client_name": name,
        "redirect_uris": list(redirect_uris),
        "grant_types": list(GRANT_TYPES),
        "response_types": ["code"],
        "token_endpoint_auth_method": auth_method,
        "scope": SCOPE,
    }
    if auth_method != "none":
        information["client_secret"] = client_secret(config, client_id)
        information["client_secret_expires_at"] = 0
    return information


def _registration_redirect_uris(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty list.")
    if len(raw) > MAX_REDIRECT_URIS:
        raise OAuthError(
            "invalid_redirect_uri", f"Register at most {MAX_REDIRECT_URIS} redirect_uris."
        )
    uris: list[str] = []
    for index, uri in enumerate(raw):
        problem = redirect_uri_problem(uri) if isinstance(uri, str) else "must be a string"
        if problem is not None:
            raise OAuthError("invalid_redirect_uri", f"redirect_uris[{index}] {problem}.")
        if uri not in uris:
            uris.append(uri)
    return tuple(uris)


def _require_listed(raw: object, name: str, needed: str) -> None:
    if raw is None:
        return
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise _metadata_error(f"{name} must be a list of strings.")
    if needed not in raw:
        raise _metadata_error(f"{name} must include {needed}.")


def _metadata_error(description: str) -> OAuthError:
    return OAuthError("invalid_client_metadata", description)


# --- authorization (the consent page's server-side calls) ------------------------------


@dataclass(frozen=True)
class AuthorizationRequest:
    """A validated authorization request."""

    client: Client
    redirect_uri: str
    code_challenge: str
    resource: str
    state: str | None


def check_authorization(config: ConnectorConfig, params: AuthorizeParams) -> AuthorizeCheck:
    """What the consent page shows: the client's self-declared name, where it sends the
    person back, and the scopes."""
    request = validate_authorization(config, params)
    return AuthorizeCheck(
        clientName=request.client.name,
        redirectHost=redirect_host(request.redirect_uri),
        scopes=[SCOPE],
    )


def approve_authorization(
    config: ConnectorConfig,
    db: StateDB,
    params: AuthorizeParams,
    identity: Identity,
    *,
    now: int,
) -> AuthorizeDecision:
    """The person allowed it: a single-use code, bound to the client, redirect URI, PKCE
    challenge, person and resource, good for five minutes (CODE_TTL)."""
    request = validate_authorization(config, params)
    code = CODE_PREFIX + secrets.token_urlsafe(32)
    db.execute(
        "INSERT INTO oauth_codes (code_hash, client_key, redirect_uri, code_challenge, sub, "
        "login, resource, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            _sha256(code),
            request.client.key,
            request.redirect_uri,
            request.code_challenge,
            identity.sub,
            identity.login,
            request.resource,
            SCOPE,
            now,
            now + CODE_TTL,
        ),
    )
    _maybe_purge(db, now)
    redirect_to = _with_params(
        request.redirect_uri, {"code": code, "state": request.state, "iss": config.issuer}
    )
    return AuthorizeDecision(redirectTo=redirect_to)


def deny_authorization(config: ConnectorConfig, params: AuthorizeParams) -> AuthorizeDecision:
    """The person cancelled: back to the client with `access_denied`."""
    _, redirect_uri = _client_and_redirect(config, params)
    redirect_to = _with_params(
        redirect_uri,
        {
            "error": "access_denied",
            "error_description": "The person declined to connect this app to FORGE.",
            "state": _echoed_state(params.state),
            "iss": config.issuer,
        },
    )
    return AuthorizeDecision(redirectTo=redirect_to)


def validate_authorization(
    config: ConnectorConfig, params: AuthorizeParams
) -> AuthorizationRequest:
    """The request, or an ApiError(400) carrying an AuthorizeError: without `redirectTo`
    when the client or redirect URI is the problem, with it otherwise."""
    client, redirect_uri = _client_and_redirect(config, params)
    state = _echoed_state(params.state)

    def fail(error: str, description: str) -> ApiError:
        redirect_to = _with_params(
            redirect_uri,
            {
                "error": error,
                "error_description": description,
                "state": state,
                "iss": config.issuer,
            },
        )
        return _reject(error, description, redirect_to)

    if params.state is not None and state is None:
        raise fail("invalid_request", f"state is longer than {MAX_STATE_LENGTH} characters.")
    if params.responseType != "code":
        raise fail("unsupported_response_type", "FORGE supports only response_type=code.")
    if params.codeChallengeMethod != "S256":
        raise fail("invalid_request", "PKCE with code_challenge_method=S256 is required.")
    if not _CHALLENGE.fullmatch(params.codeChallenge):
        raise fail("invalid_request", "code_challenge must be an S256 challenge.")
    resource = (
        config.resource if not params.resource else normalize_resource(config, params.resource)
    )
    if resource is None:
        raise fail("invalid_target", f"resource must be {config.resource}.")
    return AuthorizationRequest(client, redirect_uri, params.codeChallenge, resource, state)


def _client_and_redirect(config: ConnectorConfig, params: AuthorizeParams) -> tuple[Client, str]:
    client = parse_client_id(config, params.clientId)
    if client is None:
        raise _reject(
            "invalid_client",
            "This app's FORGE registration isn't valid. "
            "Remove FORGE from the app and add it again.",
        )
    if not redirect_uri_allowed(client.redirect_uris, params.redirectUri):
        raise _reject(
            "invalid_redirect_uri",
            "The app asked FORGE to send you back to an address it didn't register.",
        )
    return client, params.redirectUri


def _echoed_state(state: str | None) -> str | None:
    return state if state is not None and len(state) <= MAX_STATE_LENGTH else None


def _reject(error: str, description: str, redirect_to: str | None = None) -> ApiError:
    body = AuthorizeError(error=error, errorDescription=description, redirectTo=redirect_to)
    return ApiError(400, body.model_dump(exclude_none=True), headers=dict(NO_STORE))


# --- the token endpoint ----------------------------------------------------------------


def parse_token_params(body: bytes, content_type: str | None) -> dict[str, list[str]]:
    """The token and revocation endpoints' parameters: form-encoded (RFC 6749), JSON
    tolerated. Every value is a list, so repeats can be refused."""
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if media == "application/json":
        try:
            data = json.loads(body)
        except (ValueError, RecursionError):
            raise OAuthError("invalid_request", "The body is not valid JSON.") from None
        if not isinstance(data, dict):
            raise OAuthError("invalid_request", "The body must be a JSON object.")
        params: dict[str, list[str]] = {}
        for name, value in data.items():
            if value is None:
                continue  # an explicit null is an absent parameter
            values = value if isinstance(value, list) else [value]
            strings = [item for item in values if isinstance(item, str)]
            if len(strings) != len(values):
                raise OAuthError("invalid_request", f"{name[:64]} must be a string.")
            params[name] = strings
        return params
    try:
        text = body.decode("utf-8")
        return parse_qs(text, keep_blank_values=True, max_num_fields=64)
    except (UnicodeDecodeError, ValueError):
        raise OAuthError("invalid_request", "The body is not a valid form.") from None


def exchange_token(
    config: ConnectorConfig,
    db: StateDB,
    params: Mapping[str, Sequence[str]],
    authorization: str | None,
    *,
    now: int,
) -> dict[str, Any]:
    """POST /oauth/token: authorization_code (PKCE S256) or refresh_token (rotated)."""
    grant_type = _param(params, "grant_type")
    client = authenticate_client(config, params, authorization)
    if grant_type is None:
        raise OAuthError("invalid_request", "grant_type is required.")
    _check_token_resource(config, params)
    if grant_type == "authorization_code":
        tokens = _redeem_code(config, db, client, params, now)
    elif grant_type == "refresh_token":
        tokens = _refresh(config, db, client, params, now)
    else:
        raise OAuthError(
            "unsupported_grant_type", "FORGE supports authorization_code and refresh_token."
        )
    _maybe_purge(db, now)
    return tokens


def authenticate_client(
    config: ConnectorConfig, params: Mapping[str, Sequence[str]], authorization: str | None
) -> Client:
    """The calling client: HTTP Basic or client_id (+ client_secret) in the body. A public
    client sends only its client_id; a confidential one must prove its secret."""
    basic = _basic_credentials(authorization)
    body_id, body_secret = _param(params, "client_id"), _param(params, "client_secret")
    client_id: str | None
    secret: str | None
    if basic is not None:
        if body_secret is not None or (body_id is not None and body_id != basic[0]):
            raise OAuthError("invalid_request", "Use one way of authenticating the client.")
        client_id, secret = basic
    else:
        client_id, secret = body_id, body_secret
    challenge = {"WWW-Authenticate": BASIC_CHALLENGE} if basic is not None else {}

    def failed(description: str) -> OAuthError:
        return OAuthError("invalid_client", description, status=401, headers=challenge)

    if not client_id:
        raise failed("client_id is required.")
    client = parse_client_id(config, client_id)
    if client is None:
        raise failed("Unknown client: register again.")
    if client.confidential:
        expected = client_secret(config, client.client_id).encode()
        if not secret or not hmac.compare_digest(secret.encode(), expected):
            raise failed("Client authentication failed.")
    return client


def _redeem_code(
    config: ConnectorConfig,
    db: StateDB,
    client: Client,
    params: Mapping[str, Sequence[str]],
    now: int,
) -> dict[str, Any]:
    code = _param(params, "code")
    redirect_uri = _param(params, "redirect_uri")
    verifier = _param(params, "code_verifier")
    if code is None or redirect_uri is None or verifier is None:
        raise OAuthError("invalid_request", "code, redirect_uri and code_verifier are required.")
    replayed: str | None = None
    tokens: dict[str, Any] | None = None
    with db.transaction():
        row = (
            db.query_one("SELECT * FROM oauth_codes WHERE code_hash = ?", (_sha256(code),))
            if _TOKEN_SHAPE.fullmatch(code)
            else None
        )
        if row is None:
            raise _invalid_grant("The authorization code is not valid.")
        if row["used_at"] is not None:
            # OAuth 2.1 §7.5.3: a code seen twice means someone else may hold it.
            replayed = row["grant_id"] or ""
            if replayed:
                _revoke_grant(db, replayed, now)
        else:
            if now >= row["expires_at"]:
                raise _invalid_grant("The authorization code expired.")
            if row["client_key"] != client.key:
                raise _invalid_grant("The authorization code was issued to another client.")
            if row["redirect_uri"] != redirect_uri:
                raise _invalid_grant("redirect_uri doesn't match the authorization request.")
            if not _VERIFIER.fullmatch(verifier) or not hmac.compare_digest(
                _s256(verifier).encode(), str(row["code_challenge"]).encode()
            ):
                raise _invalid_grant("code_verifier doesn't match the code_challenge.")
            if row["resource"] != config.resource:
                # FORGE_PUBLIC_ORIGIN moved since the consent: start over at the new address.
                raise _invalid_grant("The code was issued for another FORGE address.")
            db.execute(
                "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?", (now, row["code_hash"])
            )
            grant_id = _grant_for(db, client, row, now)
            db.execute(
                "UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?",
                (grant_id, row["code_hash"]),
            )
            tokens = _issue_tokens(db, grant_id, str(row["resource"]), now)
    if replayed is not None:
        logger.warning("an authorization code was presented twice; revoked grant %r", replayed)
        raise _invalid_grant("The authorization code was already used.")
    assert tokens is not None
    return tokens


def _refresh(
    config: ConnectorConfig,
    db: StateDB,
    client: Client,
    params: Mapping[str, Sequence[str]],
    now: int,
) -> dict[str, Any]:
    presented = _param(params, "refresh_token")
    if presented is None:
        raise OAuthError("invalid_request", "refresh_token is required.")
    replayed: str | None = None
    retried: str | None = None
    tokens: dict[str, Any] | None = None
    with db.transaction():
        row = (
            db.query_one(
                "SELECT t.token_hash, t.grant_id, t.resource, t.expires_at, t.used_at, "
                "t.revoked_at, g.client_key, g.revoked_at AS grant_revoked_at "
                "FROM oauth_tokens AS t JOIN oauth_grants AS g ON g.id = t.grant_id "
                "WHERE t.token_hash = ? AND t.kind = 'refresh'",
                (_sha256(presented),),
            )
            if _TOKEN_SHAPE.fullmatch(presented)
            else None
        )
        if row is None or row["client_key"] != client.key:
            raise _invalid_grant("The refresh token is not valid.")
        used_at = row["used_at"]
        retry = used_at is not None and now - int(used_at) < REFRESH_REUSE_GRACE
        if used_at is not None and not retry:
            # Rotation's reuse detection: the old token came back after the grace window,
            # so two parties hold the grant. Revoke all of it; the rightful client signs in
            # again.
            replayed = str(row["grant_id"])
            _revoke_grant(db, replayed, now)
        else:
            # A first use, or a retry inside the grace window. A grant revoked any other
            # way (Disconnect, /oauth/revoke, a replayed code) stays revoked either way.
            if row["revoked_at"] is not None or row["grant_revoked_at"] is not None:
                raise _invalid_grant("The refresh token was revoked.")
            if now >= row["expires_at"]:
                raise _invalid_grant("The refresh token expired.")
            if row["resource"] != config.resource:
                # Tokens for the old address would only be refused by /mcp: make the client
                # reconnect instead of refreshing in a loop.
                raise _invalid_grant("The connection was made for another FORGE address.")
            if retry:
                # Not marked again: the window runs from the rotation, not from a retry.
                retried = str(row["grant_id"])
            else:
                db.execute(
                    "UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?",
                    (now, row["token_hash"]),
                )
            db.execute(
                "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", (now, row["grant_id"])
            )
            tokens = _issue_tokens(db, str(row["grant_id"]), str(row["resource"]), now)
    if replayed is not None:
        logger.warning("a rotated refresh token was presented again; revoked grant %r", replayed)
        raise _invalid_grant("The refresh token was already used. Connect the app again.")
    if retried is not None:
        logger.info(
            "a rotated refresh token came back within %d s; treated as a retry for grant %r",
            REFRESH_REUSE_GRACE,
            retried,
        )
    assert tokens is not None
    return tokens


def _grant_for(db: StateDB, client: Client, code: Mapping[str, Any], now: int) -> str:
    """The person's live grant for this client, or a new one."""
    row = db.query_one(
        "SELECT id FROM oauth_grants WHERE sub = ? AND client_key = ? AND revoked_at IS NULL "
        "AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        (code["sub"], client.key, now),
    )
    if row is not None:
        db.execute("UPDATE oauth_grants SET login = ? WHERE id = ?", (code["login"], row["id"]))
        return str(row["id"])
    grant_id = secrets.token_urlsafe(12)
    db.execute(
        "INSERT INTO oauth_grants (id, sub, login, client_key, client_name, redirect_host, "
        "scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            grant_id,
            code["sub"],
            code["login"],
            client.key,
            client.name,
            redirect_host(str(code["redirect_uri"])),
            code["scope"],
            code["resource"],
            now,
            now + REFRESH_TTL,
        ),
    )
    return grant_id


def _issue_tokens(db: StateDB, grant_id: str, resource: str, now: int) -> dict[str, Any]:
    access = ACCESS_TOKEN_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_TOKEN_PREFIX + secrets.token_urlsafe(32)
    for value, kind, ttl in ((access, "access", ACCESS_TTL), (refresh, "refresh", REFRESH_TTL)):
        db.execute(
            "INSERT INTO oauth_tokens (token_hash, kind, grant_id, resource, created_at, "
            "expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (_sha256(value), kind, grant_id, resource, now, now + ttl),
        )
    db.execute(
        "UPDATE oauth_grants SET expires_at = MAX(expires_at, ?) WHERE id = ?",
        (now + REFRESH_TTL, grant_id),
    )
    return {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL,
        "refresh_token": refresh,
        "scope": SCOPE,
    }


def _check_token_resource(config: ConnectorConfig, params: Mapping[str, Sequence[str]]) -> None:
    """A token request's `resource` (optional, may repeat: RFC 8707) must name the
    connector; anything else is invalid_target."""
    values = [value for value in params.get("resource", ()) if value]
    if any(normalize_resource(config, value) is None for value in values):
        raise OAuthError("invalid_target", f"resource must be {config.resource}.")


def _basic_credentials(authorization: str | None) -> tuple[str, str] | None:
    """(client_id, client_secret) from `Authorization: Basic`, form-decoded as RFC 6749
    §2.3.1 says; None when the header is absent or another scheme."""
    if authorization is None:
        return None
    scheme, _, value = authorization.strip().partition(" ")
    if scheme.lower() != "basic":
        return None
    try:
        decoded = base64.b64decode(value.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        decoded = ""
    client_id, colon, secret = decoded.partition(":")
    if not colon:
        raise OAuthError(
            "invalid_client",
            "Malformed Basic credentials.",
            status=401,
            headers={"WWW-Authenticate": BASIC_CHALLENGE},
        )
    return unquote_plus(client_id), unquote_plus(secret)


def _param(params: Mapping[str, Sequence[str]], name: str) -> str | None:
    """One parameter's value; None when absent or empty. RFC 6749 §3.2: never repeated."""
    values = params.get(name)
    if not values:
        return None
    if len(values) > 1:
        raise OAuthError("invalid_request", f"{name} is repeated.")
    return values[0] or None


def _invalid_grant(description: str) -> OAuthError:
    return OAuthError("invalid_grant", description)


# --- revocation (RFC 7009) -------------------------------------------------------------


def revoke_token(
    config: ConnectorConfig,
    db: StateDB,
    params: Mapping[str, Sequence[str]],
    authorization: str | None,
    *,
    now: int,
) -> None:
    """Revoke a token the caller holds. A refresh token takes its whole grant with it (the
    client is disconnecting); an access token goes alone. A client that identifies itself
    must be the token's client. Raises OAuthError for a malformed request; the router
    answers 200 whatever happens (contract: always 200)."""
    token = _param(params, "token")
    if token is None or not _TOKEN_SHAPE.fullmatch(token):
        return
    identifies = _basic_credentials(authorization) is not None or _param(params, "client_id")
    client = authenticate_client(config, params, authorization) if identifies else None
    hashed = _sha256(token)
    with db.transaction():
        row = db.query_one(
            "SELECT t.kind, t.grant_id, g.client_key FROM oauth_tokens AS t "
            "JOIN oauth_grants AS g ON g.id = t.grant_id WHERE t.token_hash = ?",
            (hashed,),
        )
        if row is None or (client is not None and row["client_key"] != client.key):
            return
        if row["kind"] == "refresh":
            _revoke_grant(db, str(row["grant_id"]), now)
        else:
            db.execute(
                "UPDATE oauth_tokens SET revoked_at = ? "
                "WHERE token_hash = ? AND revoked_at IS NULL",
                (now, hashed),
            )


# --- the resource server's side --------------------------------------------------------


def verify_access_token(
    db: StateDB, token: str, resource: str, *, now: int | None = None
) -> Identity:
    """The person a live access token for `resource` acts for. Raises InvalidToken for
    anything else: unknown, expired, revoked (alone or with its grant), or issued for
    another resource (RFC 8707: a token is good only where it was meant to be used)."""
    if not token.startswith(ACCESS_TOKEN_PREFIX) or not _TOKEN_SHAPE.fullmatch(token):
        raise InvalidToken("not a FORGE access token")
    moment = int(time.time()) if now is None else now
    row = db.query_one(
        "SELECT t.expires_at, t.revoked_at, t.resource, g.id AS grant_id, g.sub, g.login, "
        "g.revoked_at AS grant_revoked_at, g.last_used_at "
        "FROM oauth_tokens AS t JOIN oauth_grants AS g ON g.id = t.grant_id "
        "WHERE t.token_hash = ? AND t.kind = 'access'",
        (_sha256(token),),
    )
    if row is None:
        raise InvalidToken("unknown access token")
    if row["revoked_at"] is not None or row["grant_revoked_at"] is not None:
        raise InvalidToken("revoked access token")
    if moment >= row["expires_at"]:
        raise InvalidToken("expired access token")
    if row["resource"] != resource:
        raise InvalidToken("access token issued for another resource")
    last_used = row["last_used_at"]
    if last_used is None or moment - last_used >= LAST_USED_RESOLUTION:
        db.execute(
            "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", (moment, row["grant_id"])
        )
    return Identity(sub=str(row["sub"]), login=str(row["login"]))


def token_key(token: str) -> str:
    """A stable, non-secret key for a token (its SHA-256), e.g. for rate limiting."""
    return _sha256(token)


# --- connected agents ------------------------------------------------------------------


def list_grants(db: StateDB, sub: str, *, now: int) -> ConnectedAgentList:
    """The person's live grants, newest first."""
    rows = db.query_all(
        "SELECT id, client_name, redirect_host, created_at, last_used_at FROM oauth_grants "
        "WHERE sub = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id",
        (sub, now),
    )
    return ConnectedAgentList(
        agents=[
            ConnectedAgent(
                id=str(row["id"]),
                clientName=str(row["client_name"]),
                redirectHost=str(row["redirect_host"]),
                connectedAt=_iso(int(row["created_at"])),
                lastUsedAt=None if row["last_used_at"] is None else _iso(int(row["last_used_at"])),
            )
            for row in rows
        ]
    )


def revoke_user_grant(db: StateDB, sub: str, grant_id: str, *, now: int) -> ConnectedAgentList:
    """Disconnect one of the person's agents (someone else's grant id changes nothing),
    then list what is left."""
    with db.transaction():
        row = db.query_one("SELECT id FROM oauth_grants WHERE id = ? AND sub = ?", (grant_id, sub))
        if row is not None:
            _revoke_grant(db, grant_id, now)
    return list_grants(db, sub, now=now)


def _revoke_grant(db: StateDB, grant_id: str, now: int) -> None:
    db.execute(
        "UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        (now, grant_id),
    )
    db.execute(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
        (now, grant_id),
    )


# --- housekeeping ----------------------------------------------------------------------

_purge_lock = threading.Lock()
_last_purge = 0


def purge_expired(db: StateDB, *, now: int) -> None:
    """Forget codes and tokens a day after they expire, and grants a month after they were
    revoked or lapsed (their tokens go with them)."""
    with db.transaction():
        db.execute("DELETE FROM oauth_codes WHERE expires_at < ?", (now - PURGE_GRACE,))
        db.execute("DELETE FROM oauth_tokens WHERE expires_at < ?", (now - PURGE_GRACE,))
        db.execute(
            "DELETE FROM oauth_grants WHERE revoked_at < ? OR expires_at < ?",
            (now - GRANT_RETENTION, now - GRANT_RETENTION),
        )


def _maybe_purge(db: StateDB, now: int) -> None:
    global _last_purge
    with _purge_lock:
        if 0 <= now - _last_purge < PURGE_INTERVAL:
            return
        _last_purge = now
    purge_expired(db, now=now)


# --- small helpers ---------------------------------------------------------------------


def _mac(config: ConnectorConfig, purpose: bytes, message: str) -> bytes:
    key = hmac.new(config.secret.encode(), b"forge-oauth/v1/" + purpose, hashlib.sha256).digest()
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


def _s256(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode("ascii")).digest())


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes | None:
    """Strict base64url (no padding, canonical): what `_b64` would have produced."""
    if not _B64URL.fullmatch(text):
        return None
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        return None
    return data if _b64(data) == text else None


def _iso(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")
