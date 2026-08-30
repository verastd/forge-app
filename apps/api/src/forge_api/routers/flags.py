"""Feature-flag config for the web app."""

from fastapi import APIRouter

from forge_api.models import FlagConfig
from forge_api.services import flags as flags_service

router = APIRouter(prefix="/api", tags=["flags"])


@router.get("/flags", response_model=FlagConfig)
def get_flags() -> FlagConfig:
    return flags_service.get_flags()
