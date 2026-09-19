"""Upland data queries (ledger.upland.me). Thin: parse, call services/upland/analytics, return."""

from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from forge_api.models import (
    ActionDistributionEntry,
    ActiveAccount,
    ChainInfo,
    PriceDistributionBucket,
    SalesVolumeDay,
    TimeSeriesPoint,
    UplandAction,
    UplandActionList,
    UplandEstimate,
    UplandHealth,
    UplandProperty,
    UplandPropertyList,
    UplandStatsOverview,
)
from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError
from forge_api.services.upland import analytics
from forge_api.services.upland.action_codes import CATEGORIES
from forge_api.services.upland.hyperion import HyperionClient

FLAG = "upland_data"

#: `stats/time_series?filter=` accepts any action category, or "all".
TimeSeriesFilter = str


def require_upland_enabled() -> None:
    """Router-wide gate: every /api/upland/* route 404s while `upland_data` is off."""
    if not flags_service.is_enabled(FLAG):
        raise ApiError(404, {"error": "upland-disabled"})


async def get_hyperion() -> AsyncIterator[HyperionClient]:
    """Per-request Hyperion client, closed afterwards. Tests override this."""
    client = HyperionClient(max_concurrent=1)
    try:
        yield client
    finally:
        await client.close()


Hyperion = Annotated[HyperionClient, Depends(get_hyperion)]

router = APIRouter(
    prefix="/api/upland", tags=["upland"], dependencies=[Depends(require_upland_enabled)]
)


@router.get("/health", response_model=UplandHealth)
async def get_health() -> UplandHealth:
    return await analytics.health()


@router.get("/stats/overview", response_model=UplandStatsOverview)
async def get_stats_overview() -> UplandStatsOverview:
    return await analytics.stats_overview()


@router.get("/actions", response_model=UplandActionList)
async def get_actions(
    category: str | None = None,
    action_name: str | None = None,
    actor: str | None = None,
    property_id: str | None = None,
    start: str | None = Query(None, description="ISO timestamp, inclusive"),
    end: str | None = Query(None, description="ISO timestamp, inclusive"),
    limit: int = Query(100, ge=1, le=analytics.MAX_PAGE),
    offset: int = Query(0, ge=0),
) -> UplandActionList:
    return await analytics.list_actions(
        category=category,
        action_name=action_name,
        actor=actor,
        property_id=property_id,
        start=start,
        end=end,
        limit=limit,
        offset=offset,
    )


@router.get("/actions/sales", response_model=list[UplandAction])
async def get_sales(limit: int = Query(100, ge=1, le=analytics.MAX_PAGE)) -> list[UplandAction]:
    return await analytics.recent_sales(limit)


@router.get("/stats/sales_volume", response_model=list[SalesVolumeDay])
async def get_sales_volume(days: int = Query(90, ge=1, le=365)) -> list[SalesVolumeDay]:
    return await analytics.sales_volume(days)


@router.get("/stats/action_distribution", response_model=list[ActionDistributionEntry])
async def get_action_distribution() -> list[ActionDistributionEntry]:
    return await analytics.action_distribution()


@router.get("/stats/top_properties", response_model=UplandPropertyList)
async def get_top_properties(
    limit: int = Query(50, ge=1, le=analytics.MAX_PAGE),
    sort: analytics.PropertySort = "sales",
) -> UplandPropertyList:
    return await analytics.top_properties(limit, sort)


@router.get("/stats/active_accounts", response_model=list[ActiveAccount])
async def get_active_accounts(
    limit: int = Query(50, ge=1, le=analytics.MAX_PAGE),
) -> list[ActiveAccount]:
    return await analytics.active_accounts(limit)


@router.get("/stats/time_series", response_model=list[TimeSeriesPoint])
async def get_time_series(
    interval: analytics.Interval = "day",
    filter: Annotated[
        TimeSeriesFilter, Query(description="an action category, or 'all'")
    ] = "trade",
) -> list[TimeSeriesPoint]:
    if filter != "all" and filter not in CATEGORIES:
        raise ApiError(422, {"error": "invalid-filter", "allowed": ["all", *CATEGORIES]})
    return await analytics.time_series(interval, filter)


@router.get("/stats/price_distribution", response_model=list[PriceDistributionBucket])
async def get_price_distribution() -> list[PriceDistributionBucket]:
    return await analytics.price_distribution()


@router.get("/properties", response_model=UplandPropertyList)
async def get_properties(
    limit: Annotated[int, Query(ge=1, le=analytics.MAX_PAGE)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> UplandPropertyList:
    return await analytics.list_properties(limit, offset)


@router.get("/properties/{property_id}", response_model=UplandProperty)
async def get_property(property_id: str) -> UplandProperty:
    return await analytics.get_property(property_id)


@router.get("/codes")
def get_codes() -> dict[str, dict[str, Any]]:
    return analytics.action_codes()


@router.get("/chain/info", response_model=ChainInfo)
async def get_chain_info(client: Hyperion) -> ChainInfo:
    return await analytics.chain_info(client)


@router.get("/estimate", response_model=UplandEstimate)
async def get_estimate(
    client: Hyperion, days: Annotated[int, Query(ge=1, le=365)] = 90
) -> UplandEstimate:
    return await analytics.estimate(client, days)


@router.get("/export")
async def export_csv(type: analytics.ExportType = "actions") -> StreamingResponse:
    return StreamingResponse(
        analytics.iter_export_csv(type),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="upland-{type}.csv"'},
    )
