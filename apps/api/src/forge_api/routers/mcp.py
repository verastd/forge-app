"""POST /mcp: the FORGE connector (contract §6). GET and DELETE answer 405 (no SSE
stream, no sessions).

Thin: the checks the Streamable HTTP transport puts on the endpoint, in this order, then
services/mcp_server.py answers the JSON-RPC:

1. 404 / 503 while the connector is off or unconfigured (router dependency)
2. 403 for an `Origin` header that is neither FORGE's origin nor allowlisted
3. 401 without a live access token for this resource, with the RFC 9728 challenge
4. 400 for an `MCP-Protocol-Version` header this server doesn't speak
5. 415 / 413 / 400 for a body that isn't JSON, is too big, or doesn't parse
"""

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from forge_api.services import mcp_server
from forge_api.services import oauth as oauth_service
from forge_api.services.mcp_types import ToolContext
from forge_api.services.oauth import BodyTooLarge, Clock, ConnectorConfig, InvalidToken
from forge_api.services.state import StateDB, get_state_db

logger = logging.getLogger(__name__)

Config = Annotated[ConnectorConfig, Depends(oauth_service.require_connector)]
Db = Annotated[StateDB, Depends(get_state_db)]
ClockNow = Annotated[Clock, Depends(oauth_service.get_clock)]
Registry = Annotated[mcp_server.McpRegistry, Depends(mcp_server.get_mcp_registry)]
Limiter = Annotated[mcp_server.RateLimiter, Depends(mcp_server.get_rate_limiter)]

NO_STORE = {"Cache-Control": "no-store"}

router = APIRouter(tags=["mcp"], dependencies=[Depends(oauth_service.require_connector)])


@router.post("/mcp")
async def mcp_post(
    request: Request,
    config: Config,
    db: Db,
    clock: ClockNow,
    registry: Registry,
    limiter: Limiter,
) -> Response:
    origin = request.headers.get("origin")
    if origin is not None and not mcp_server.origin_allowed(config, origin):
        return _rpc_error(403, "Forbidden: this Origin may not call the FORGE connector")
    authorization = request.headers.get("authorization")
    if authorization is None:
        return _unauthorized(config, token_sent=False)
    token = mcp_server.bearer_token(authorization) or ""
    try:
        grant = await run_in_threadpool(
            oauth_service.verify_access_token, db, token, config.resource, now=int(clock())
        )
    except InvalidToken as exc:
        logger.debug("MCP bearer token rejected: %s", exc)  # why, never the token
        return _unauthorized(config, token_sent=True)
    version = request.headers.get("mcp-protocol-version")
    if version is not None and version not in mcp_server.SUPPORTED_PROTOCOL_VERSIONS:
        # Not a modern (2026-07-28) JSON-RPC error on purpose: a dual-era client reads this
        # body as "legacy server" and falls back to initialize.
        supported = ", ".join(mcp_server.SUPPORTED_PROTOCOL_VERSIONS)
        message = f"Unsupported MCP-Protocol-Version {version[:40]!r}; use {supported}"
        return _rpc_error(400, message)
    if not mcp_server.is_json(request.headers.get("content-type")):
        return _rpc_error(415, "Content-Type must be application/json")
    try:
        body = await oauth_service.read_body(request, mcp_server.MAX_BODY_BYTES)
    except BodyTooLarge:
        return _rpc_error(413, "Request body too large")
    try:
        payload = json.loads(body)
    except (ValueError, RecursionError):
        return _rpc_error(400, "Parse error", code=mcp_server.PARSE_ERROR)
    session = mcp_server.Session(
        registry=registry,
        context=ToolContext(identity=grant.identity, db=db),
        # One budget per grant (one connected agent): a refreshed token shares it.
        allow=lambda: limiter.allow(grant.grant_id, clock()),
    )
    status, reply = await run_in_threadpool(mcp_server.handle_payload, payload, session)
    if reply is None:
        return Response(status_code=status)
    return _Reply(reply, status_code=status, headers=NO_STORE)


@router.api_route("/mcp", methods=["GET", "DELETE"], include_in_schema=False)
def mcp_not_allowed() -> Response:
    """No server-initiated stream (GET) and no session to end (DELETE)."""
    return _rpc_error(405, "Method Not Allowed: POST JSON-RPC to this endpoint", allow="POST")


def _unauthorized(config: ConnectorConfig, *, token_sent: bool) -> Response:
    """401 with the challenge MCP clients start OAuth from (RFC 9728 §5.1, RFC 6750 §3)."""
    challenge = (
        f'Bearer resource_metadata="{config.resource_metadata_url}", scope="{oauth_service.SCOPE}"'
    )
    if token_sent:
        challenge += ', error="invalid_token"'
        body = {
            "error": "invalid_token",
            "error_description": "The access token is invalid, expired or revoked.",
        }
    else:
        body = {
            "error": "unauthorized",
            "error_description": f"Connect your MCP client to FORGE: see {config.origin}/connect",
        }
    return JSONResponse(body, status_code=401, headers={"WWW-Authenticate": challenge})


def _rpc_error(
    status: int,
    message: str,
    *,
    code: int = mcp_server.INVALID_REQUEST,
    allow: str | None = None,
) -> Response:
    headers = {"Allow": allow} if allow else None
    return JSONResponse(
        mcp_server.error_response(None, code, message), status_code=status, headers=headers
    )


class _Reply(JSONResponse):
    """A JSON-RPC reply that never fails to encode: a lone surrogate, which JSON can carry
    and UTF-8 can't, becomes "?" instead of a bare 500 without CORS headers. Ids and
    methods holding one are refused before this (services/mcp_server.py); this covers
    text echoed back, such as an unknown tool's name."""

    def render(self, content: Any) -> bytes:
        text = json.dumps(content, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        return text.encode("utf-8", "replace")
