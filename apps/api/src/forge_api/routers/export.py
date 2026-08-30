"""CSV export of the full history (Task Spec issue #1)."""

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from forge_api.services import export as export_service
from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError

router = APIRouter(prefix="/api", tags=["export"])

FLAG = "csv_export"


@router.get("/export")
def export_history() -> StreamingResponse:
    if not flags_service.is_enabled(FLAG):
        raise ApiError(403, {"error": "flag_disabled", "flag": FLAG})
    return StreamingResponse(
        export_service.iter_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": export_service.CONTENT_DISPOSITION},
    )
