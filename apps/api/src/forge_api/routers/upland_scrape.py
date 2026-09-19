"""Scraper and GCS-sync control. Thin: the job state lives in services/upland."""

from typing import Annotated

from fastapi import APIRouter, Depends

from forge_api.models import GcsStatus, GcsSyncResult, ScrapeRequest, ScrapeStatus
from forge_api.routers.upland import require_upland_enabled
from forge_api.services.upland.scraper import ScrapeManager, get_scrape_manager
from forge_api.services.upland.storage import GcsSyncManager, get_sync_manager

Scraper = Annotated[ScrapeManager, Depends(get_scrape_manager)]
Sync = Annotated[GcsSyncManager, Depends(get_sync_manager)]

router = APIRouter(
    prefix="/api/upland", tags=["upland-scrape"], dependencies=[Depends(require_upland_enabled)]
)


@router.post("/scrape", response_model=ScrapeStatus)
async def start_scrape(request: ScrapeRequest, manager: Scraper) -> ScrapeStatus:
    """Start a background scrape: `days`, or `startBlock` + `endBlock`. 409 if one is running."""
    return await manager.start(request)


@router.get("/scrape/status", response_model=ScrapeStatus)
def get_scrape_status(manager: Scraper) -> ScrapeStatus:
    return manager.status


@router.post("/scrape/cancel", response_model=ScrapeStatus)
async def cancel_scrape(manager: Scraper) -> ScrapeStatus:
    return await manager.cancel()


@router.post("/gcs/sync", response_model=GcsSyncResult)
async def sync_gcs(manager: Sync) -> GcsSyncResult:
    return await manager.sync()


@router.get("/gcs/status", response_model=GcsStatus)
def get_gcs_status(manager: Sync) -> GcsStatus:
    return manager.status()
