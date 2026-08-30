"""Activity history feed."""

from fastapi import APIRouter, Query

from forge_api.models import HistoryList
from forge_api.services import history as history_service

router = APIRouter(prefix="/api", tags=["history"])


# exclude_none: @forge/shared types these fields with zod .optional() (absent-or-
# undefined), which rejects an explicit null — so unset fields are omitted, not nulled.
@router.get("/history", response_model=HistoryList, response_model_exclude_none=True)
def get_history(
    limit: int = Query(history_service.DEFAULT_LIMIT, ge=0),
    offset: int = Query(0, ge=0),
) -> HistoryList:
    """`limit` is capped at MAX_LIMIT rather than rejected; a negative offset is a 422."""
    return history_service.get_history(limit=limit, offset=offset)
