"""The Bridge: browse, claim, dispatch, watch, iterate, settle (PRD Appendix I)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from forge_api.models import (
    BridgeStatus,
    ClaimRequest,
    ClaimResponse,
    ContributorProfile,
    DispatchRequest,
    DispatchResult,
    FeedbackResponse,
    TaskList,
)
from forge_api.services import bridge as bridge_service
from forge_api.services import flags as flags_service
from forge_api.services.bridge import LeaseStore, TaskSource
from forge_api.services.errors import ApiError

FLAG = "contribute_bridge"


def _require_bridge_enabled() -> None:
    """Router-wide gate: every /api/bridge/* route 404s while the Bridge kill
    switch is off, instead of quietly continuing to serve it (mirrors
    routers/export.py's csv_export gate, applied once for the whole router
    rather than per-route since every route here is Bridge-only)."""
    if not flags_service.is_enabled(FLAG):
        raise ApiError(404, {"error": "bridge-disabled"})


router = APIRouter(
    prefix="/api/bridge",
    tags=["bridge"],
    dependencies=[Depends(_require_bridge_enabled)],
)

# response_model_exclude_none: @forge/shared declares deepLink, sessionRef, rewardUsd,
# claimedBy, leaseEndsAt, checksPassed/Total and refPr/refIssue with zod .optional(),
# which accepts a missing key but rejects an explicit null. Unset -> omitted.

Store = Annotated[LeaseStore, Depends(bridge_service.get_lease_store)]
Source = Annotated[TaskSource, Depends(bridge_service.get_task_source)]


@router.get("/tasks", response_model=TaskList, response_model_exclude_none=True)
def list_tasks(source: Source, store: Store) -> TaskList:
    return bridge_service.list_task_cards(source, store)


@router.post("/claim", response_model=ClaimResponse)
def claim(request: ClaimRequest, source: Source, store: Store) -> ClaimResponse:
    return bridge_service.claim_task(source, store, request.taskId)


@router.post("/dispatch", response_model=DispatchResult, response_model_exclude_none=True)
def dispatch(request: DispatchRequest, source: Source, store: Store) -> DispatchResult:
    return bridge_service.dispatch_task(source, store, request)


@router.get("/status/{task_id}", response_model=BridgeStatus, response_model_exclude_none=True)
def status(task_id: int, source: Source, store: Store) -> BridgeStatus:
    return bridge_service.get_status(source, store, task_id)


@router.post("/feedback/{task_id}", response_model=FeedbackResponse)
def feedback(task_id: int, source: Source) -> FeedbackResponse:
    return bridge_service.relay_feedback(source, task_id)


@router.get("/profile", response_model=ContributorProfile, response_model_exclude_none=True)
def profile(store: Store) -> ContributorProfile:
    return bridge_service.get_profile(store)
