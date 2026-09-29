"""Read-side queries over the scraped Upland data (everything the /api/upland routes serve)."""

import csv
import io
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import aiosqlite

from forge_api.models import (
    ActionDistributionEntry,
    ActiveAccount,
    ChainInfo,
    PriceDistributionBucket,
    SalesVolumeDay,
    TimeSeriesPoint,
    UplandAction,
    UplandActionList,
    UplandDateRange,
    UplandEstimate,
    UplandHealth,
    UplandProperty,
    UplandPropertyList,
    UplandStatsOverview,
)
from forge_api.services.errors import ApiError
from forge_api.services.upland.action_codes import (
    ACTION_MAP,
    CONTRACT_PLAYUPLAND,
    CONTRACT_UPX_TOKEN,
    SALE_ACTIONS,
    VOLUME_ACTIONS,
)
from forge_api.services.upland.db import _db
from forge_api.services.upland.hyperion import BLOCKS_PER_DAY, HyperionClient
from forge_api.services.upland.scraper import UPLAND_PROPERTY, UPLAND_PROPERTY_PARAMS
from forge_api.services.upland.storage import gcs_configured

MAX_PAGE = 1000
Interval = Literal["hour", "day", "week"]
PropertySort = Literal["sales", "price"]
ExportType = Literal["actions", "sales"]

_BUCKET_FORMATS: dict[str, str] = {
    "hour": "%Y-%m-%d %H:00",
    "day": "%Y-%m-%d",
    "week": "%Y-W%W",
}
_ACTION_COLUMNS = (
    "global_sequence, timestamp, block_num, trx_id, contract, action_name, action_meaning, "
    "category, actor, property_id, price_upx, from_account, to_account"
)
_PRICE_BUCKETS = (
    ("0-1K", 1_000),
    ("1K-5K", 5_000),
    ("5K-10K", 10_000),
    ("10K-50K", 50_000),
    ("50K-100K", 100_000),
    ("100K-500K", 500_000),
)
#: Rows per chunk of the CSV export (see `iter_export_csv`).
EXPORT_BATCH_ROWS = 1_000
EXPORT_HEADER = [
    "global_sequence",
    "timestamp",
    "block_num",
    "trx_id",
    "contract",
    "action_name",
    "action_meaning",
    "category",
    "actor",
    "property_id",
    "price_upx",
    "from_account",
    "to_account",
]
#: Leads a spreadsheet reads as a formula, or skips on the way to one (CSV injection).
_FORMULA_LEADS = ("=", "+", "-", "@", "\t", "\r")


def _marks(values: tuple[str, ...]) -> str:
    return ",".join("?" for _ in values)


#: Every read here is scoped to playuplandme's own actions (`contract = ?`). The scraper
#: stores nothing else, but a database it filled before it dropped other contracts' actions
#: can still hold rows another contract wrote by notifying playuplandme, in its own words.
#: Reads of `properties` apply UPLAND_PROPERTY instead (scraper.py).
_UPLAND = (CONTRACT_PLAYUPLAND,)


def _safe_cell(value: Any) -> Any:
    """A text cell a spreadsheet would run as a formula, prefixed with `'` so it opens as text.

    Decoded fields hold whatever the action carried, and nothing checks them on the way in, so
    every text cell is treated as untrusted. Numbers, ISO timestamps and hex ids never start
    with a lead, so they pass through untouched.
    """
    if isinstance(value, str) and value.startswith(_FORMULA_LEADS):
        return "'" + value
    return value


def _to_action(row: aiosqlite.Row) -> UplandAction:
    return UplandAction(
        globalSequence=row["global_sequence"],
        ts=row["timestamp"],
        blockNum=row["block_num"],
        trxId=row["trx_id"],
        contract=row["contract"],
        actionName=row["action_name"],
        actionMeaning=row["action_meaning"],
        category=row["category"],
        actor=row["actor"],
        propertyId=row["property_id"],
        priceUpx=row["price_upx"],
        fromAccount=row["from_account"],
        toAccount=row["to_account"],
    )


def _to_property(row: aiosqlite.Row) -> UplandProperty:
    return UplandProperty(
        propertyId=row["property_id"],
        address=row["address"],
        city=row["city"],
        firstSeenBlock=row["first_seen_block"],
        firstSeenTs=row["first_seen_timestamp"],
        mintPriceUpx=row["mint_price_upx"],
        lastSalePriceUpx=row["last_sale_price_upx"],
        lastSaleTs=row["last_sale_timestamp"],
        totalSales=row["total_sales"] or 0,
        totalListings=row["total_listings"] or 0,
    )


async def _scalar(db: aiosqlite.Connection, sql: str, params: tuple[Any, ...] = ()) -> Any:
    cursor = await db.execute(sql, params)
    row = await cursor.fetchone()
    await cursor.close()
    return row[0] if row else None


async def _count_actions(db: aiosqlite.Connection) -> int:
    return int(await _scalar(db, "SELECT COUNT(*) FROM actions WHERE contract = ?", _UPLAND) or 0)


async def _count_properties(db: aiosqlite.Connection) -> int:
    sql = f"SELECT COUNT(*) FROM properties WHERE {UPLAND_PROPERTY}"
    return int(await _scalar(db, sql, UPLAND_PROPERTY_PARAMS) or 0)


async def health() -> UplandHealth:
    async with _db() as db:
        actions = await _count_actions(db)
        properties = await _count_properties(db)
        latest = await _scalar(db, "SELECT MAX(block_num) FROM actions WHERE contract = ?", _UPLAND)
    return UplandHealth(
        status="ok",
        actions=actions,
        properties=properties,
        latestBlock=latest,
        gcsConfigured=gcs_configured(),
    )


async def stats_overview() -> UplandStatsOverview:
    async with _db() as db:
        total = await _count_actions(db)
        # Apart, each is one step down the timestamp index; together they scan all of it.
        first = await _scalar(db, "SELECT MIN(timestamp) FROM actions WHERE contract = ?", _UPLAND)
        last = await _scalar(db, "SELECT MAX(timestamp) FROM actions WHERE contract = ?", _UPLAND)
        cursor = await db.execute(
            "SELECT category, COUNT(*) AS c FROM actions WHERE contract = ? "
            "GROUP BY category ORDER BY c DESC",
            _UPLAND,
        )
        by_category = {row["category"]: row["c"] for row in await cursor.fetchall()}
        await cursor.close()
        cursor = await db.execute(
            "SELECT action_name, action_meaning, category, COUNT(*) AS c FROM actions "
            "WHERE contract = ? GROUP BY action_name ORDER BY c DESC LIMIT 15",
            _UPLAND,
        )
        by_type = [_distribution_entry(row) for row in await cursor.fetchall()]
        await cursor.close()
        properties = await _count_properties(db)
    return UplandStatsOverview(
        totalActions=total,
        dateRange=UplandDateRange(min=first, max=last),
        byCategory=by_category,
        byType=by_type,
        totalProperties=properties,
    )


def _distribution_entry(row: aiosqlite.Row) -> ActionDistributionEntry:
    return ActionDistributionEntry(
        actionName=row["action_name"],
        actionMeaning=row["action_meaning"],
        category=row["category"],
        count=row["c"],
    )


async def list_actions(
    *,
    category: str | None = None,
    action_name: str | None = None,
    actor: str | None = None,
    property_id: str | None = None,
    start: str | None = None,
    end: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> UplandActionList:
    """Newest-first page of actions. `start`/`end` are ISO timestamps (inclusive)."""
    clauses: list[str] = ["contract = ?"]
    params: list[Any] = [CONTRACT_PLAYUPLAND]
    for column, value in (
        ("category", category),
        ("action_name", action_name),
        ("actor", actor),
        ("property_id", property_id),
    ):
        if value is not None:
            clauses.append(f"{column} = ?")
            params.append(value)
    if start is not None:
        clauses.append("timestamp >= ?")
        params.append(start)
    if end is not None:
        clauses.append("timestamp <= ?")
        params.append(end)
    where = f"WHERE {' AND '.join(clauses)}"
    limit = max(0, min(limit, MAX_PAGE))

    async with _db() as db:
        total = int(await _scalar(db, f"SELECT COUNT(*) FROM actions {where}", tuple(params)) or 0)
        cursor = await db.execute(
            f"SELECT {_ACTION_COLUMNS} FROM actions {where} "
            "ORDER BY timestamp DESC, global_sequence DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        )
        items = [_to_action(row) for row in await cursor.fetchall()]
        await cursor.close()
    return UplandActionList(items=items, total=total, hasMore=offset + len(items) < total)


async def recent_sales(limit: int = 100) -> list[UplandAction]:
    async with _db() as db:
        cursor = await db.execute(
            f"SELECT {_ACTION_COLUMNS} FROM actions WHERE contract = ? "
            f"AND action_name IN ({_marks(SALE_ACTIONS)}) AND price_upx IS NOT NULL "
            "ORDER BY timestamp DESC, global_sequence DESC LIMIT ?",
            (*_UPLAND, *SALE_ACTIONS, max(0, min(limit, MAX_PAGE))),
        )
        items = [_to_action(row) for row in await cursor.fetchall()]
        await cursor.close()
    return items


async def sales_volume(days: int = 90) -> list[SalesVolumeDay]:
    """Daily secondary-market volume for the last `days` days, newest first."""
    cutoff = (datetime.now(UTC) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    async with _db() as db:
        cursor = await db.execute(
            "SELECT DATE(timestamp) AS date, COUNT(*) AS count, SUM(price_upx) AS volume, "
            "AVG(price_upx) AS avg_price, MIN(price_upx) AS min_price, MAX(price_upx) AS max_price "
            f"FROM actions WHERE contract = ? AND action_name IN ({_marks(VOLUME_ACTIONS)}) "
            "AND price_upx IS NOT NULL AND timestamp >= ? "
            "GROUP BY DATE(timestamp) ORDER BY date DESC",
            (*_UPLAND, *VOLUME_ACTIONS, cutoff),
        )
        rows = await cursor.fetchall()
        await cursor.close()
    return [
        SalesVolumeDay(
            date=row["date"],
            count=row["count"],
            volumeUpx=row["volume"],
            avgPrice=row["avg_price"],
            minPrice=row["min_price"],
            maxPrice=row["max_price"],
        )
        for row in rows
    ]


async def action_distribution() -> list[ActionDistributionEntry]:
    async with _db() as db:
        cursor = await db.execute(
            "SELECT action_name, action_meaning, category, COUNT(*) AS c FROM actions "
            "WHERE contract = ? GROUP BY action_name ORDER BY c DESC",
            _UPLAND,
        )
        entries = [_distribution_entry(row) for row in await cursor.fetchall()]
        await cursor.close()
    return entries


async def top_properties(limit: int = 50, sort: PropertySort = "sales") -> UplandPropertyList:
    order = "total_sales" if sort == "sales" else "last_sale_price_upx"
    async with _db() as db:
        cursor = await db.execute(
            "SELECT * FROM properties "
            f"WHERE (total_sales > 0 OR last_sale_price_upx IS NOT NULL) AND {UPLAND_PROPERTY} "
            f"ORDER BY {order} DESC, property_id LIMIT ?",
            (*UPLAND_PROPERTY_PARAMS, max(0, min(limit, MAX_PAGE))),
        )
        items = [_to_property(row) for row in await cursor.fetchall()]
        await cursor.close()
    return UplandPropertyList(items=items, total=len(items))


async def active_accounts(limit: int = 50) -> list[ActiveAccount]:
    """Most active player accounts. The contract accounts themselves are excluded:
    playuplandme authors the majority of all actions (fees, yields, config), so
    counting it would bury every real player under the machine."""
    async with _db() as db:
        cursor = await db.execute(
            "SELECT actor, COUNT(*) AS tx_count, COALESCE(SUM(price_upx), 0) AS volume "
            "FROM actions WHERE contract = ? AND actor IS NOT NULL AND actor NOT IN (?, ?) "
            "GROUP BY actor ORDER BY tx_count DESC, actor LIMIT ?",
            (*_UPLAND, CONTRACT_PLAYUPLAND, CONTRACT_UPX_TOKEN, max(0, min(limit, MAX_PAGE))),
        )
        rows = await cursor.fetchall()
        await cursor.close()
    return [
        ActiveAccount(actor=row["actor"], txCount=row["tx_count"], volumeUpx=row["volume"])
        for row in rows
    ]


async def time_series(interval: Interval = "day", category: str = "trade") -> list[TimeSeriesPoint]:
    """Counts and UPX volume per bucket. `category` is an action category or "all"."""
    where, params = (
        ("WHERE contract = ?", _UPLAND)
        if category == "all"
        else ("WHERE contract = ? AND category = ?", (*_UPLAND, category))
    )
    async with _db() as db:
        cursor = await db.execute(
            f"SELECT strftime('{_BUCKET_FORMATS[interval]}', timestamp) AS bucket, "
            "COUNT(*) AS count, COALESCE(SUM(price_upx), 0) AS volume "
            f"FROM actions {where} GROUP BY bucket ORDER BY bucket",
            params,
        )
        rows = await cursor.fetchall()
        await cursor.close()
    return [
        TimeSeriesPoint(bucket=row["bucket"], count=row["count"], volume=row["volume"])
        for row in rows
    ]


async def price_distribution() -> list[PriceDistributionBucket]:
    """Sale-price histogram in ascending price order (empty buckets are omitted)."""
    cases = " ".join(f"WHEN price_upx < {limit} THEN '{label}'" for label, limit in _PRICE_BUCKETS)
    async with _db() as db:
        cursor = await db.execute(
            f"SELECT CASE {cases} ELSE '500K+' END AS range, COUNT(*) AS count, "
            "AVG(price_upx) AS avg_price, MIN(price_upx) AS lo FROM actions "
            "WHERE contract = ? AND action_name IN ('n5', 'n111') AND price_upx IS NOT NULL "
            "GROUP BY range ORDER BY lo",
            _UPLAND,
        )
        rows = await cursor.fetchall()
        await cursor.close()
    return [
        PriceDistributionBucket(range=row["range"], count=row["count"], avgPrice=row["avg_price"])
        for row in rows
    ]


async def get_property(property_id: str) -> UplandProperty:
    async with _db() as db:
        cursor = await db.execute(
            f"SELECT * FROM properties WHERE property_id = ? AND {UPLAND_PROPERTY}",
            (property_id, *UPLAND_PROPERTY_PARAMS),
        )
        row = await cursor.fetchone()
        await cursor.close()
    if row is None:
        raise ApiError(404, {"error": "property-not-found", "propertyId": property_id})
    return _to_property(row)


async def list_properties(limit: int = 100, offset: int = 0) -> UplandPropertyList:
    async with _db() as db:
        total = await _count_properties(db)
        cursor = await db.execute(
            f"SELECT * FROM properties WHERE {UPLAND_PROPERTY} "
            "ORDER BY first_seen_block, property_id LIMIT ? OFFSET ?",
            (*UPLAND_PROPERTY_PARAMS, max(0, min(limit, MAX_PAGE)), offset),
        )
        items = [_to_property(row) for row in await cursor.fetchall()]
        await cursor.close()
    return UplandPropertyList(items=items, total=total)


def action_codes() -> dict[str, dict[str, str | float]]:
    """The obfuscated-code -> meaning table."""
    return {
        code: {
            "meaning": info["meaning"],
            "confidence": info["confidence"],
            "category": info["category"],
        }
        for code, info in ACTION_MAP.items()
    }


async def chain_info(client: HyperionClient) -> ChainInfo:
    info = await _chain_head(client)
    return ChainInfo(
        headBlockNum=int(info["head_block_num"]),
        headBlockTime=str(info["head_block_time"]),
        chainId=str(info["chain_id"]),
        blocksPerDay=BLOCKS_PER_DAY,
    )


async def _chain_head(client: HyperionClient) -> dict[str, Any]:
    try:
        return await client.get_info()
    except Exception as exc:  # network / upstream failure
        raise ApiError(502, {"error": "upland-chain-unavailable", "detail": str(exc)}) from exc


async def estimate(client: HyperionClient, days: int = 90) -> UplandEstimate:
    """How many actions the last `days` days hold (capped by Hyperion at 10,000 -> "gte")."""
    head = int((await _chain_head(client))["head_block_num"])
    start, end = HyperionClient.blocks_for_timeframe(days, head)
    try:
        counted = await client.estimate_action_count(block_num_range=(start, end))
    except Exception as exc:
        raise ApiError(502, {"error": "upland-chain-unavailable", "detail": str(exc)}) from exc
    return UplandEstimate(
        estimatedActions=counted["total"],
        relation=counted["relation"],
        startBlock=start,
        endBlock=end,
        days=days,
    )


async def iter_export_csv(kind: ExportType) -> AsyncIterator[str]:
    """Stream playuplandme's actions (or just its priced sales) as CSV, oldest first.

    The header goes out before the query runs. After it, every chunk is one `fetchmany` of
    EXPORT_BATCH_ROWS rows, so memory holds one batch however big the table grows, and a
    10k-row export is 11 writes rather than 10,001.
    """
    # Both kinds are scoped to Upland's own contract: another contract can name an action `n5`.
    where = "WHERE contract = ?"
    params: tuple[str, ...] = _UPLAND
    if kind == "sales":
        where += f" AND action_name IN ({_marks(SALE_ACTIONS)}) AND price_upx IS NOT NULL"
        params = (*params, *SALE_ACTIONS)

    buffer = io.StringIO()
    writer = csv.writer(buffer)

    def take() -> str:
        chunk = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return chunk

    writer.writerow(EXPORT_HEADER)
    yield take()
    async with _db() as db:
        cursor = await db.execute(
            f"SELECT {_ACTION_COLUMNS} FROM actions {where} ORDER BY global_sequence", params
        )
        try:
            while rows := list(await cursor.fetchmany(EXPORT_BATCH_ROWS)):
                writer.writerows([_safe_cell(row[name]) for name in EXPORT_HEADER] for row in rows)
                yield take()
        finally:
            await cursor.close()
