"""The Bridge: browse, claim, dispatch, watch, iterate, settle (PRD Appendix I; contract §5).

Thin: parse, call `services.bridge.Bridge`, return the model. Every route 404s while the
`contribute_bridge` kill switch is off, except GET and DELETE `/me/keys`: people can see
and remove their saved keys whatever the switches say. Identity is the web tier's assertion:
`require_identity` (401 without one) or `optional_identity` (None when no Authorization
header is sent at all; a bad header is still 401).

response_model_exclude_none everywhere: @forge/shared declares optional fields with zod
`.optional()`, which accepts a missing key but rejects an explicit null.
"""

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse

from forge_api.models import (
    BridgeStatus,
    CheckResults,
    ClaimRequest,
    ClaimResponse,
    ContributorProfile,
    CopyResult,
    DispatchRequest,
    DispatchResult,
    FeedbackResponse,
    ForkStatus,
    RailList,
    RepoActionRequest,
    ReviewResult,
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
#: The largest /copy or /review body read (the one-time token is at most 4096 characters).
MAX_REPO_ACTION_BODY = 16 * 1024


def _require_bridge_enabled() -> None:
    """The kill switch: every gated /api/bridge/* route 404s while it is off, instead
    of quietly continuing to serve it (mirrors the csv_export gate on
    routers/upland.py's export route, applied once for the gated routes rather than
    per-route)."""
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
    repo_client: Annotated[httpx.Client, Depends(bridge_service.get_repo_client)],
) -> Bridge:
    return Bridge(store, source, github, client, repo_client)


#: Every route but the saved-key ones: 404 while the kill switch is off.
_gated = APIRouter(dependencies=[Depends(_require_bridge_enabled)])
#: Seeing and removing your saved keys works whatever the switches say: what FORGE keeps
#: of yours stays in your hands during an incident too.
_always = APIRouter()

BridgeDep = Annotated[Bridge, Depends(get_bridge)]
User = Annotated[Identity, Depends(require_identity)]
MaybeUser = Annotated[Identity | None, Depends(optional_identity)]


@_gated.get("/rails", response_model=RailList, response_model_exclude_none=True)
def rails(bridge: BridgeDep, user: MaybeUser) -> RailList:
    return bridge.rails(user)


@_gated.get("/tasks", response_model=TaskList, response_model_exclude_none=True)
def list_tasks(bridge: BridgeDep) -> TaskList:
    return bridge.list_tasks()


@_gated.get("/tasks/{task_id}", response_model=TaskDetail, response_model_exclude_none=True)
def task_detail(task_id: int, bridge: BridgeDep, user: MaybeUser) -> TaskDetail:
    return bridge.task_detail(task_id, user)


@_gated.get("/tasks/{task_id}/brief", response_class=PlainTextResponse)
def brief(
    task_id: int, bridge: BridgeDep, login: str | None = None, copy: str | None = None
) -> PlainTextResponse:
    """The brief as plain text, for Claude Code's `prompt_url`: readable from any origin,
    no credentials. An invalid login gets the generic brief; `copy` (the contributor's copy,
    `owner/name`) counts only when its owner is `login`."""
    return PlainTextResponse(
        bridge.brief(task_id, login, copy),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
            "X-Content-Type-Options": "nosniff",
        },
    )


@_gated.post("/claim", response_model=ClaimResponse)
def claim(request: ClaimRequest, bridge: BridgeDep, user: User) -> ClaimResponse:
    return bridge.claim(user, request.taskId)


@_gated.post("/release/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
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


def _body_doc(schema: dict[str, Any]) -> dict[str, Any]:
    """The OpenAPI requestBody of a route that reads its own body."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": _inline(schema, schema.get("$defs", {}))}},
        }
    }


_DISPATCH_SCHEMA = DispatchRequest.model_json_schema()
#: /dispatch reads its own body (so a pasted key is never echoed); this documents it.
_DISPATCH_BODY: dict[str, Any] = _body_doc(_DISPATCH_SCHEMA)
#: /copy and /review read theirs too (the one-time token is in it).
_REPO_ACTION_BODY: dict[str, Any] = _body_doc(RepoActionRequest.model_json_schema())


async def _read_capped(request: Request, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, {"error": "body_too_large", "limit": limit})
        chunks.append(chunk)
    return b"".join(chunks)


@_gated.post(
    "/dispatch",
    response_model=DispatchResult,
    response_model_exclude_none=True,
    openapi_extra=_DISPATCH_BODY,
)
async def dispatch(request: Request, bridge: BridgeDep, user: User) -> DispatchResult:
    parsed = bridge_service.parse_dispatch(await _read_capped(request, MAX_DISPATCH_BODY))
    return await run_in_threadpool(bridge.dispatch, user, parsed)


@_gated.post(
    "/copy",
    response_model=CopyResult,
    response_model_exclude_none=True,
    openapi_extra=_REPO_ACTION_BODY,
)
async def copy(request: Request, bridge: BridgeDep, user: User) -> CopyResult:
    """Set up the holder's copy of verastd/forge-app and the task's branch in it, with
    GitHub's one-time token for this one action (Phase 7 contract §3). The web server only."""
    parsed = bridge_service.parse_repo_action(await _read_capped(request, MAX_REPO_ACTION_BODY))
    return await run_in_threadpool(bridge.copy, user, parsed)


@_gated.post(
    "/review",
    response_model=ReviewResult,
    response_model_exclude_none=True,
    status_code=201,
    openapi_extra=_REPO_ACTION_BODY,
    responses={200: {"model": ReviewResult, "description": "A pull request was already open"}},
)
async def review(
    request: Request, response: Response, bridge: BridgeDep, user: User
) -> ReviewResult:
    """Open the pull request from the task's branch in the holder's copy, as them: 201, or
    200 with `created: false` when one is open already (Phase 7 contract §3)."""
    parsed = bridge_service.parse_repo_action(await _read_capped(request, MAX_REPO_ACTION_BODY))
    result = await run_in_threadpool(bridge.review, user, parsed)
    if not result.created:
        response.status_code = 200
    return result


@_gated.get("/status/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def status(task_id: int, bridge: BridgeDep, user: MaybeUser) -> BridgeStatus:
    return bridge.status(task_id, user)


@_gated.get("/checks/{task_id}", response_model=CheckResults, response_model_exclude_none=True)
def checks(task_id: int, bridge: BridgeDep, user: MaybeUser) -> CheckResults:
    return bridge.check_results(task_id)


@_gated.post(
    "/feedback/{task_id}", response_model=FeedbackResponse, response_model_exclude_none=True
)
def feedback(task_id: int, bridge: BridgeDep, user: User) -> FeedbackResponse:
    return bridge.feedback(user, task_id)


@_gated.post("/submit/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def submit(task_id: int, request: SubmitRequest, bridge: BridgeDep, user: User) -> BridgeStatus:
    return bridge.submit(user, task_id, request.prUrl)


@_gated.get("/profile", response_model=ContributorProfile, response_model_exclude_none=True)
def profile(bridge: BridgeDep, user: User) -> ContributorProfile:
    return bridge.profile(user)


@_always.get("/me/keys", response_model=SavedCredentialList, response_model_exclude_none=True)
def saved_keys(bridge: BridgeDep, user: User) -> SavedCredentialList:
    """Hints only; it works with the vault off and with the kill switch off."""
    return bridge.saved_keys(user)


@_always.delete(
    "/me/keys/{rail}", response_model=SavedCredentialList, response_model_exclude_none=True
)
def delete_key(rail: str, bridge: BridgeDep, user: User) -> SavedCredentialList:
    """Needs no vault key, and works with the kill switch off."""
    return bridge.delete_key(user, rail)


@_gated.get("/me/fork", response_model=ForkStatus, response_model_exclude_none=True)
def fork(bridge: BridgeDep, user: User) -> ForkStatus:
    return bridge.fork(user)


router = APIRouter(prefix="/api/bridge", tags=["bridge"])
router.include_router(_gated)
router.include_router(_always)
