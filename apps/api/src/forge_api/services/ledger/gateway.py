"""The Upland Ledger gateway: forwards one allowlisted request to the ledger and hands back
its status and JSON body.

The ledger (a Fastify service with no auth of its own) listens on the API's host only, at
`UPLAND_LEDGER_URL` (default http://127.0.0.1:3000), and has no public route. The only way
to it is the web's `/bff/ledger/*`, then `/api/ledger/*` here, behind the `upland_ledger`
flag and a verified API assertion (routers/ledger.py). This module never sees either: it
is given the method, the path below /v1/, the raw query string and, for the one POST, the
body.

What goes up is only that: `Accept: application/json`, and `Content-Type:
application/json` with the POST body. No header of the caller's (its assertion, cookies,
forwarded-for) is ever sent. What comes back is upstream's status and body, when the body
is JSON and at most MAX_RESPONSE_BYTES, with `Cache-Control: private, no-store`; none of
upstream's headers. Upstream's redirects are not followed.

Errors (flat JSON, never cached):
- 404 not_found: the route isn't on the allowlist (services/ledger/allowlist.py);
- 414 query_too_long, 413 too_large, 415 unsupported_media_type: the request's own limits;
- 503 ledger_not_configured: UPLAND_LEDGER_URL is not a plain http(s) URL;
- 504 ledger_timeout: no answer within the deadlines (3 s to connect, 25 s in all);
- 502 ledger_unavailable: refused, reset or otherwise unreachable;
- 502 ledger_response_too_large / ledger_bad_response: an answer too big, or not JSON.
"""

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

import httpx

from forge_api.services.errors import ApiError
from forge_api.services.ledger import allowlist

logger = logging.getLogger(__name__)

URL_ENV: Final = "UPLAND_LEDGER_URL"
DEFAULT_URL: Final = "http://127.0.0.1:3000"

CONNECT_TIMEOUT_SECONDS: float = 3.0
#: For the whole exchange, from connecting to the last byte of the answer.
TOTAL_TIMEOUT_SECONDS: float = 25.0
MAX_QUERY_BYTES: Final = 4 * 1024
MAX_BODY_BYTES: Final = 16 * 1024
MAX_RESPONSE_BYTES: int = 8 * 1024 * 1024

NO_STORE: Final = {"Cache-Control": "private, no-store"}
_JSON_TYPES: Final = ("application/json",)


@dataclass(frozen=True)
class LedgerAnswer:
    """What the ledger said: its status and its JSON body, as bytes."""

    status: int
    body: bytes


def _error(status: int, code: str) -> ApiError:
    return ApiError(status, {"error": code}, headers=dict(NO_STORE))


def not_found() -> ApiError:
    return _error(404, "not_found")


def require_allowed(method: str, path: str) -> allowlist.Route:
    """The allowlisted route `method path` is, or 404 not_found."""
    route = allowlist.match(method, path)
    if route is None:
        raise not_found()
    return route


def base_url(env: dict[str, str] | None = None) -> str:
    """UPLAND_LEDGER_URL without a trailing slash: an http(s) URL with a host and nothing
    after its path (no credentials, query or fragment). Anything else is 503."""
    raw = (env if env is not None else os.environ).get(URL_ENV, "").strip() or DEFAULT_URL
    try:
        parts = urlsplit(raw)
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        raise _error(503, "ledger_not_configured") from None
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
    ):
        logger.warning("%s is not a plain http(s) URL: the ledger gateway is off", URL_ENV)
        raise _error(503, "ledger_not_configured")
    return raw.rstrip("/")


def make_client(transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """The client for one request to the ledger: no redirects, no cookies, 3 s to connect,
    and the total deadline on every read."""
    return httpx.AsyncClient(
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(TOTAL_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        transport=transport,
    )


def check_query(query: bytes) -> bytes:
    """The raw query string, forwarded as it is, unless it is too long (414)."""
    if len(query) > MAX_QUERY_BYTES:
        raise _error(414, "query_too_long")
    return query


def is_json(content_type: str | None) -> bool:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    return media in _JSON_TYPES


async def read_body(chunks: AsyncIterator[bytes], content_type: str | None) -> bytes:
    """The POST body: JSON (415 otherwise) and at most MAX_BODY_BYTES (413), read from the
    stream rather than trusting Content-Length."""
    if not is_json(content_type):
        raise _error(415, "unsupported_media_type")
    body = bytearray()
    async for chunk in chunks:
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise _error(413, "too_large")
    return bytes(body)


async def _exchange(client: httpx.AsyncClient, request: httpx.Request) -> LedgerAnswer:
    response = await client.send(request, stream=True)
    try:
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
            raise _error(502, "ledger_response_too_large")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body += chunk
            if len(body) > MAX_RESPONSE_BYTES:
                raise _error(502, "ledger_response_too_large")
        if body and not is_json(response.headers.get("content-type")):
            raise _error(502, "ledger_bad_response")
        return LedgerAnswer(status=response.status_code, body=bytes(body))
    finally:
        await response.aclose()


async def forward(
    client: httpx.AsyncClient,
    *,
    method: str,
    path: str,
    query: bytes,
    body: bytes | None = None,
) -> LedgerAnswer:
    """Send `method /v1/<path>?<query>` to the ledger, if the allowlist has it (404
    otherwise, without a request), and return its answer."""
    require_allowed(method, path)
    url = httpx.URL(f"{base_url()}/v1/{path}", query=check_query(query) or None)
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = client.build_request(method, url, headers=headers, content=body)
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT_SECONDS):
            return await _exchange(client, request)
    except (TimeoutError, httpx.TimeoutException):
        logger.warning("ledger %s /v1/%s timed out", method, path)
        raise _error(504, "ledger_timeout") from None
    except httpx.HTTPError as exc:
        logger.warning("ledger %s /v1/%s failed: %s", method, path, type(exc).__name__)
        raise _error(502, "ledger_unavailable") from None
