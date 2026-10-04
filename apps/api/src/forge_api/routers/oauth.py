"""The FORGE connector's OAuth surface (contract §5): metadata, registration, token and
revocation for MCP clients; check/approve/deny for the web's consent page; the caller's
connected agents.

Thin: parse, call services/oauth.py, return. Every route 404s while `mcp_connector` or
`github_signin` is off and 503s while FORGE_PUBLIC_ORIGIN or FORGE_OAUTH_SECRET is
missing. The public paths (`/.well-known/*`, `/oauth/*`) are reached through the web
origin's rewrites; `/api/oauth/*` is called by the web server with the caller's
assertion, like the BFF (`check` needs none: it only describes the request).

`POST /register` and `POST /token` are the same handlers as `/oauth/register` and
`/oauth/token`: MCP 2025-03-26's default paths, which a client that didn't keep the
metadata falls back to (the MCP Python SDK refreshes at `/token` after a restart). The
metadata never names them and the OpenAPI document leaves them out; main.py gives them
the connector's CORS.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from forge_api.models import (
    AuthorizeCheck,
    AuthorizeDecision,
    AuthorizeError,
    AuthorizeParams,
    ConnectedAgentList,
)
from forge_api.services import oauth as oauth_service
from forge_api.services.identity import Identity, require_identity
from forge_api.services.oauth import Clock, ConnectorConfig, OAuthError
from forge_api.services.state import StateDB, get_state_db

Config = Annotated[ConnectorConfig, Depends(oauth_service.require_connector)]
Db = Annotated[StateDB, Depends(get_state_db)]
ClockNow = Annotated[Clock, Depends(oauth_service.get_clock)]
Caller = Annotated[Identity, Depends(require_identity)]

router = APIRouter(tags=["oauth"], dependencies=[Depends(oauth_service.require_connector)])

_REJECTED: dict[int | str, dict[str, Any]] = {400: {"model": AuthorizeError}}


# --- discovery -------------------------------------------------------------------------


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource_metadata(config: Config) -> dict[str, Any]:
    return oauth_service.protected_resource_metadata(config)


@router.get("/.well-known/oauth-authorization-server")
def authorization_server_metadata(config: Config) -> dict[str, Any]:
    return oauth_service.authorization_server_metadata(config)


# --- MCP clients -----------------------------------------------------------------------


@router.post("/register", status_code=201, include_in_schema=False)
@router.post("/oauth/register", status_code=201)
async def register(request: Request, config: Config, clock: ClockNow) -> JSONResponse:
    body = await oauth_service.read_form_body(request)
    information = oauth_service.register_client(config, body, now=int(clock()))
    return JSONResponse(information, status_code=201, headers=dict(oauth_service.NO_STORE))


@router.post("/token", include_in_schema=False)
@router.post("/oauth/token")
async def token(request: Request, config: Config, db: Db, clock: ClockNow) -> JSONResponse:
    body = await oauth_service.read_form_body(request)
    params = oauth_service.parse_token_params(body, request.headers.get("content-type"))
    tokens = await run_in_threadpool(
        oauth_service.exchange_token,
        config,
        db,
        params,
        request.headers.get("authorization"),
        now=int(clock()),
    )
    return JSONResponse(tokens, headers=dict(oauth_service.NO_STORE))


@router.post("/oauth/revoke")
async def revoke(request: Request, config: Config, db: Db, clock: ClockNow) -> Response:
    """RFC 7009: 200 whatever happened, so a caller learns nothing about any token."""
    try:
        body = await oauth_service.read_form_body(request)
        params = oauth_service.parse_token_params(body, request.headers.get("content-type"))
        await run_in_threadpool(
            oauth_service.revoke_token,
            config,
            db,
            params,
            request.headers.get("authorization"),
            now=int(clock()),
        )
    except OAuthError:
        pass
    return Response(status_code=200, headers=dict(oauth_service.NO_STORE))


# --- the consent page (web server only) ------------------------------------------------


@router.post("/api/oauth/authorize/check", response_model=AuthorizeCheck, responses=_REJECTED)
def authorize_check(params: AuthorizeParams, config: Config, response: Response) -> AuthorizeCheck:
    response.headers.update(oauth_service.NO_STORE)
    return oauth_service.check_authorization(config, params)


@router.post("/api/oauth/authorize/approve", response_model=AuthorizeDecision, responses=_REJECTED)
def authorize_approve(
    params: AuthorizeParams,
    config: Config,
    caller: Caller,
    db: Db,
    clock: ClockNow,
    response: Response,
) -> AuthorizeDecision:
    response.headers.update(oauth_service.NO_STORE)
    return oauth_service.approve_authorization(config, db, params, caller, now=int(clock()))


@router.post(
    "/api/oauth/authorize/deny",
    response_model=AuthorizeDecision,
    responses=_REJECTED,
    # Like approve: only the signed-in person's own Cancel sends them back to the client.
    dependencies=[Depends(require_identity)],
)
def authorize_deny(
    params: AuthorizeParams, config: Config, response: Response
) -> AuthorizeDecision:
    response.headers.update(oauth_service.NO_STORE)
    return oauth_service.deny_authorization(config, params)


# --- connected agents (the caller's own grants) ----------------------------------------


@router.get(
    "/api/oauth/grants", response_model=ConnectedAgentList, response_model_exclude_none=True
)
def list_grants(caller: Caller, db: Db, clock: ClockNow) -> ConnectedAgentList:
    return oauth_service.list_grants(db, caller.sub, now=int(clock()))


@router.delete(
    "/api/oauth/grants/{grant_id}",
    response_model=ConnectedAgentList,
    response_model_exclude_none=True,
)
def delete_grant(grant_id: str, caller: Caller, db: Db, clock: ClockNow) -> ConnectedAgentList:
    return oauth_service.revoke_user_grant(db, caller.sub, grant_id, now=int(clock()))
