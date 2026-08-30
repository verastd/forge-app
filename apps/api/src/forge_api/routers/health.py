"""Liveness probe."""

from fastapi import APIRouter

from forge_api import __version__
from forge_api.models import HealthResponse

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)
