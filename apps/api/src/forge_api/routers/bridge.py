"""The Bridge: browse, claim, dispatch, watch, iterate, settle (PRD Appendix I; contract §5).

Thin: parse, call `services.bridge.Bridge`, return the model. Every route 404s while the
`contribute_bridge` kill switch is off. Identity is the web tier's assertion:
`require_identity` (401 without one) or `optional_identity` (None when no Authorization
header is sent at all; a bad header is still 401).

response_model_exclude_none everywhere: @forge/shared declares optional fields with zod
`.optional()`, which accepts a missing key but rejects an explicit null.
"""

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Header, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse

from forge_api.models import (
    BridgeStatus,
    CheckResults,
    ClaimRequest,
    ClaimResponse,
    ContributorProfile,
    DispatchRequest,
    DispatchResult,
    FeedbackResponse,
    ForkStatus,
    RailList,
    SavedCredentialList,
    SubmitRequest,
    TaskDetail,
    TaskList,
)
from forge_api.services import bridge as bridge_service
from forge_api.services import flags as flags_service
from forge_api.services.bridge import Bridge, LeaseStore, TaskSource
from forge_api.services.errors import ApiError
from forge_api.services.github_reads import GitHubReads
from forge_api.services.identity import Identity, require_identity

FLAG = "contribute_bridge"
#: The largest /dispatch body read (a credential is at most ~5 KB).
MAX_DISPATCH_BODY = 16 * 1024


def _require_bridge_enabled() -> None:
    """Router-wide gate: every /api/bridge/* route 404s while the Bridge kill
    switch is off, instead of quietly continuing to serve it (mirrors the
    csv_export gate on routers/upland.py's export route, applied once for
    the whole router rather than per-route since every route here is
    Bridge-only)."""
    if not flags_service.is_enabled(FLAG):
        raise ApiError(404, {"error": "bridge-disabled"})


def optional_identity(authorization: Annotated[str | None, Header()] = None) -> Identity | None:
    """The verified caller, or None when the request carries no Authorization header.
    A header that is present but wrong is 401, exactly as `require_identity` says."""
    if authorization is None:
        return None
    return require_identity(authorization)


def get_bridge(
    store: Annotated[LeaseStore, Depends(bridge_service.get_lease_store)],
    source: Annotated[TaskSource, Depends(bridge_service.get_task_source)],
    github: Annotated[GitHubReads, Depends(bridge_service.get_github_reads)],
    client: Annotated[httpx.Client, Depends(bridge_service.get_rail_client)],
) -> Bridge:
    return Bridge(store, source, github, client)


router = APIRouter(
    prefix="/api/bridge",
    tags=["bridge"],
    dependencies=[Depends(_require_bridge_enabled)],
)

BridgeDep = Annotated[Bridge, Depends(get_bridge)]
User = Annotated[Identity, Depends(require_identity)]
MaybeUser = Annotated[Identity | None, Depends(optional_identity)]


@router.get("/rails", response_model=RailList, response_model_exclude_none=True)
def rails(bridge: BridgeDep, user: MaybeUser) -> RailList:
    return bridge.rails(user)


@router.get("/tasks", response_model=TaskList, response_model_exclude_none=True)
def list_tasks(bridge: BridgeDep) -> TaskList:
    return bridge.list_tasks()


@router.get("/tasks/{task_id}", response_model=TaskDetail, response_model_exclude_none=True)
def task_detail(task_id: int, bridge: BridgeDep, user: MaybeUser) -> TaskDetail:
    return bridge.task_detail(task_id, user)


@router.get("/tasks/{task_id}/brief", response_class=PlainTextResponse)
def brief(task_id: int, bridge: BridgeDep, login: str | None = None) -> PlainTextResponse:
    """The brief as plain text, for Claude Code's `prompt_url`: readable from any origin,
    no credentials. An invalid login gets the generic brief."""
    return PlainTextResponse(
        bridge.brief(task_id, login),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/claim", response_model=ClaimResponse)
def claim(request: ClaimRequest, bridge: BridgeDep, user: User) -> ClaimResponse:
    return bridge.claim(user, request.taskId)


@router.post("/release/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def release(task_id: int, bridge: BridgeDep, user: User) -> BridgeStatus:
    return bridge.release(user, task_id)


def _inline(schema: Any, defs: dict[str, Any]) -> Any:
    """`schema` with every `#/$defs/...` reference replaced by its definition: the
    OpenAPI document resolves `#/...` against its own root, not this inline schema."""
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            return _inline(defs[ref.removeprefix("#/$defs/")], defs)
        return {key: _inline(value, defs) for key, value in schema.items() if key != "$defs"}
    if isinstance(schema, list):
        return [_inline(item, defs) for item in schema]
    return schema


_DISPATCH_SCHEMA = DispatchRequest.model_json_schema()
#: /dispatch reads its own body (so a pasted key is never echoed); this documents it.
_DISPATCH_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {
                "schema": _inline(_DISPATCH_SCHEMA, _DISPATCH_SCHEMA.get("$defs", {}))
            }
        },
    }
}


async def _read_capped(request: Request, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, {"error": "body_too_large", "limit": limit})
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/dispatch",
    response_model=DispatchResult,
    response_model_exclude_none=True,
    openapi_extra=_DISPATCH_BODY,
)
async def dispatch(request: Request, bridge: BridgeDep, user: User) -> DispatchResult:
    parsed = bridge_service.parse_dispatch(await _read_capped(request, MAX_DISPATCH_BODY))
    return await run_in_threadpool(bridge.dispatch, user, parsed)


@router.get("/status/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def status(task_id: int, bridge: BridgeDep, user: MaybeUser) -> BridgeStatus:
    return bridge.status(task_id, user)


@router.get("/checks/{task_id}", response_model=CheckResults, response_model_exclude_none=True)
def checks(task_id: int, bridge: BridgeDep, user: MaybeUser) -> CheckResults:
    return bridge.check_results(task_id)


@router.post(
    "/feedback/{task_id}", response_model=FeedbackResponse, response_model_exclude_none=True
)
def feedback(task_id: int, bridge: BridgeDep, user: User) -> FeedbackResponse:
    return bridge.feedback(user, task_id)


@router.post("/submit/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def submit(task_id: int, request: SubmitRequest, bridge: BridgeDep, user: User) -> BridgeStatus:
    return bridge.submit(user, task_id, request.prUrl)


@router.get("/profile", response_model=ContributorProfile, response_model_exclude_none=True)
def profile(bridge: BridgeDep, user: User) -> ContributorProfile:
    return bridge.profile(user)


@router.get("/me/keys", response_model=SavedCredentialList, response_model_exclude_none=True)
def saved_keys(bridge: BridgeDep, user: User) -> SavedCredentialList:
    return bridge.saved_keys(user)


@router.delete(
    "/me/keys/{rail}", response_model=SavedCredentialList, response_model_exclude_none=True
)
def delete_key(rail: str, bridge: BridgeDep, user: User) -> SavedCredentialList:
    return bridge.delete_key(user, rail)


@router.get("/me/fork", response_model=ForkStatus, response_model_exclude_none=True)
def fork(bridge: BridgeDep, user: User) -> ForkStatus:
    return bridge.fork(user)
