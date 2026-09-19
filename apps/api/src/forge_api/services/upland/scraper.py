"""Scraper: decodes Hyperion actions, stores them, and runs scrape jobs.

Ported from the upland-scraper `scraper.py`. Two halves:

* pure helpers (`process_action`, `extract_*`) that turn a raw Hyperion action into
  a flat row, and `store_and_update`, which writes actions AND the property
  roll-ups through a single connection;
* `ScrapeManager`, the single in-process job runner the control router drives.
"""

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from forge_api.models import ScrapeRequest, ScrapeStatus
from forge_api.services.errors import ApiError
from forge_api.services.upland.action_codes import ACTION_MAP, CONTRACT_PLAYUPLAND
from forge_api.services.upland.db import _db
from forge_api.services.upland.hyperion import BLOCKS_PER_DAY, HyperionClient

logger = logging.getLogger(__name__)

#: Observed obfuscated field names that carry a property id / a UPX amount.
PROPERTY_ID_FIELDS = ("a45", "a54", "p55", "p24", "p14")
PRICE_FIELDS = ("p24", "p12", "p55", "p54", "p45")
#: Categories that feed the per-property roll-up.
PROPERTY_CATEGORIES = frozenset({"trade", "mint"})

Row = dict[str, Any]
#: (current_block, end_block, fetched) after each stored chunk.
ProgressCallback = Callable[[int, int, int], Awaitable[None] | None]


def _is_property_id(value: object) -> bool:
    return isinstance(value, str) and len(value) >= 10 and value.isdigit()


def extract_property_id(data: dict[str, Any]) -> str | None:
    """Property ids are long (10+ digit) numeric strings, possibly inside a batch list."""
    for field in PROPERTY_ID_FIELDS:
        value = data.get(field)
        if _is_property_id(value):
            return str(value)
        if isinstance(value, list):
            for item in value:
                if _is_property_id(item):
                    return str(item)
    return None


def extract_price(data: dict[str, Any]) -> float | None:
    """UPX amounts appear as ``"12345.00 UPX"`` strings (or bare numbers)."""
    for field in PRICE_FIELDS:
        value = data.get(field)
        if not value:
            continue
        if isinstance(value, str):
            match = re.match(r"([\d,]+\.?\d*)\s*UPX?", value)
            if match:
                return float(match.group(1).replace(",", ""))
            try:
                return float(value)
            except ValueError:
                continue
        elif isinstance(value, int | float) and not isinstance(value, bool):
            return float(value)
    return None


def _account(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def extract_accounts(data: dict[str, Any]) -> tuple[str | None, str | None]:
    """(from, to). Explicit ``from``/``to`` win; otherwise fall back to the obfuscated fields."""
    if data.get("from"):
        return _account(data["from"]), _account(data.get("to"))
    from_acc = data.get("p51") or data.get("p14") or data.get("a54")
    to_acc = data.get("p14") or data.get("p51")
    return _account(from_acc), _account(to_acc)


def extract_address_from_memo(memo: str) -> str | None:
    """n5 memos notarize the sale: "... owns 111 VENICE BLVD, Los Angeles, CA on Upland..."."""
    match = re.search(r"owns (.+?) on Upland", memo or "")
    return match.group(1).strip() if match else None


def city_from_address(address: str | None) -> str | None:
    """"111 VENICE BLVD, Los Angeles, CA" -> "Los Angeles"."""
    parts = [part.strip() for part in (address or "").split(",")]
    return parts[-2] if len(parts) >= 3 and parts[-2] else None


def process_action(action: Row) -> Row:
    """Flatten a raw Hyperion action into the stored row shape.

    `_address` rides along for the property roll-up and is not an `actions` column.
    """
    act = action.get("act", {})
    data = act.get("data", {})
    if not isinstance(data, dict):  # Hyperion returns a hex string for undecodable actions
        data = {}
    action_name = act.get("name", "")
    info = ACTION_MAP.get(action_name)

    from_acc, to_acc = extract_accounts(data)
    memo = data.get("memo")
    address = (
        extract_address_from_memo(memo) if action_name == "n5" and isinstance(memo, str) else None
    )
    authorization = act.get("authorization") or []
    actor = authorization[0].get("actor") if authorization else None

    return {
        "global_sequence": action.get("global_sequence"),
        "timestamp": action.get("timestamp"),
        "block_num": action.get("block_num"),
        "trx_id": action.get("trx_id"),
        "contract": act.get("account", ""),
        "action_name": action_name,
        "action_meaning": info["meaning"] if info else action_name,
        "category": info["category"] if info else "unknown",
        "actor": actor or from_acc,
        "data_json": json.dumps(data),
        "raw_json": json.dumps(action),
        "property_id": extract_property_id(data),
        "price_upx": extract_price(data),
        "from_account": from_acc,
        "to_account": to_acc,
        "_address": address,
    }


ACTION_COLUMNS = (
    "global_sequence",
    "timestamp",
    "block_num",
    "trx_id",
    "contract",
    "action_name",
    "action_meaning",
    "category",
    "actor",
    "data_json",
    "raw_json",
    "property_id",
    "price_upx",
    "from_account",
    "to_account",
)
INSERT_ACTION_SQL = (
    f"INSERT OR REPLACE INTO actions ({', '.join(ACTION_COLUMNS)}) "
    f"VALUES ({', '.join('?' for _ in ACTION_COLUMNS)})"
)


async def store_and_update(processed: list[Row]) -> int:
    """Store processed actions AND update the property roll-ups in one connection.

    Property counters only move for actions not already stored, so re-scraping an
    overlapping range never double-counts a sale or listing.
    """
    if not processed:
        return 0
    async with _db() as db:
        low = min(p["global_sequence"] for p in processed)
        high = max(p["global_sequence"] for p in processed)
        cursor = await db.execute(
            "SELECT global_sequence FROM actions WHERE global_sequence BETWEEN ? AND ?",
            (low, high),
        )
        known = {row["global_sequence"] for row in await cursor.fetchall()}
        await cursor.close()

        await db.executemany(
            INSERT_ACTION_SQL, [tuple(p[column] for column in ACTION_COLUMNS) for p in processed]
        )

        for p in processed:
            if (
                p["global_sequence"] in known
                or not p["property_id"]
                or p["category"] not in PROPERTY_CATEGORIES
            ):
                continue
            await _update_property(db, p)
        await db.commit()
    return len(processed)


async def _update_property(db: Any, p: Row) -> None:
    pid, block, ts, price = p["property_id"], p["block_num"], p["timestamp"], p["price_upx"]
    await db.execute(
        "INSERT OR IGNORE INTO properties (property_id, first_seen_block, first_seen_timestamp) "
        "VALUES (?,?,?)",
        (pid, block, ts),
    )
    await db.execute(
        "UPDATE properties SET first_seen_block = ?, first_seen_timestamp = ? "
        "WHERE property_id = ? AND (first_seen_block IS NULL OR first_seen_block > ?)",
        (block, ts, pid, block),
    )
    address = p.get("_address")
    if address:
        await db.execute(
            "UPDATE properties SET address = COALESCE(address, ?), city = COALESCE(city, ?) "
            "WHERE property_id = ?",
            (address, city_from_address(address), pid),
        )
    if p["category"] == "mint" and price:
        await db.execute(
            "UPDATE properties SET mint_price_upx = ? "
            "WHERE property_id = ? AND mint_price_upx IS NULL",
            (price, pid),
        )
    if p["action_name"] == "n5" and price:
        await db.execute(
            "UPDATE properties SET total_sales = total_sales + 1 WHERE property_id = ?", (pid,)
        )
        await db.execute(
            "UPDATE properties SET last_sale_price_upx = ?, last_sale_timestamp = ? "
            "WHERE property_id = ? AND (last_sale_timestamp IS NULL OR last_sale_timestamp <= ?)",
            (price, ts, pid, ts),
        )
    if p["action_name"] == "n2":
        await db.execute(
            "UPDATE properties SET total_listings = total_listings + 1 WHERE property_id = ?",
            (pid,),
        )


def new_client(max_concurrent: int = 5) -> HyperionClient:
    """Client factory — a module-level seam so tests can substitute a fake."""
    return HyperionClient(max_concurrent=max_concurrent)


async def _record_progress(
    start_block: int, end_block: int, current_block: int, total: int, status: str, error: str | None
) -> None:
    now = datetime.now(UTC).isoformat()
    async with _db() as db:
        await db.execute(
            """INSERT INTO scrape_progress
               (key, start_block, end_block, current_block, status, total_actions,
                started_at, updated_at, error)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET current_block = excluded.current_block,
                 status = excluded.status, total_actions = excluded.total_actions,
                 updated_at = excluded.updated_at, error = excluded.error""",
            (f"{start_block}-{end_block}", start_block, end_block, current_block, status, total,
             now, now, error),
        )
        await db.commit()


async def scrape_range(
    start_block: int,
    end_block: int,
    filter_actions: str | None = None,
    chunk_blocks: int = 100_000,
    on_progress: ProgressCallback | None = None,
) -> dict[str, int]:
    """Scrape the inclusive block range and store it incrementally. Returns run stats."""
    client = new_client(5)
    stored = 0
    fetched = 0

    async def report(current_block: int) -> None:
        if on_progress:
            result = on_progress(current_block, end_block, fetched)
            if result is not None:
                await result

    async def on_chunk(actions: list[Row]) -> None:
        nonlocal stored, fetched
        stored += await store_and_update([process_action(a) for a in actions])
        fetched += len(actions)
        current = int(actions[-1]["block_num"])
        await _record_progress(start_block, end_block, current, fetched, "running", None)
        await report(current)

    await _record_progress(start_block, end_block, start_block, 0, "running", None)
    try:
        await client.get_actions_chunked(
            account=CONTRACT_PLAYUPLAND,
            filter_actions=filter_actions,
            start_block=start_block,
            end_block=end_block + 1,  # get_actions_chunked's end is exclusive
            chunk_blocks=chunk_blocks,
            on_chunk=on_chunk,
        )
    except asyncio.CancelledError:
        await _record_progress(start_block, end_block, start_block, fetched, "cancelled", None)
        raise
    except Exception as exc:
        await _record_progress(start_block, end_block, start_block, fetched, "error", str(exc))
        raise
    finally:
        await client.close()

    await _record_progress(start_block, end_block, end_block, fetched, "complete", None)
    await report(end_block)
    return {
        "totalFetched": fetched,
        "totalStored": stored,
        "startBlock": start_block,
        "endBlock": end_block,
    }


async def scrape_timeframe(
    days: int, on_progress: ProgressCallback | None = None
) -> dict[str, int]:
    """Scrape the last `days` days of Upland actions."""
    client = new_client(3)
    try:
        info = await client.get_info()
    finally:
        await client.close()
    head_block = int(info["head_block_num"])
    start_block = max(1, head_block - days * BLOCKS_PER_DAY)
    return await scrape_range(start_block, head_block, on_progress=on_progress)


async def count_actions() -> int:
    async with _db() as db:
        cursor = await db.execute("SELECT COUNT(*) AS c FROM actions")
        row = await cursor.fetchone()
        await cursor.close()
    return int(row["c"]) if row else 0


class ScrapeManager:
    """Runs at most one scrape at a time and exposes its progress."""

    def __init__(self) -> None:
        self.status = ScrapeStatus(running=False, phase="idle")
        self._task: asyncio.Task[None] | None = None

    async def start(self, request: ScrapeRequest) -> ScrapeStatus:
        """Validate the request and launch the job. 409 while one is already running."""
        if self.status.running:
            raise ApiError(409, {"error": "scrape-running"})
        has_range = request.startBlock is not None and request.endBlock is not None
        if request.days is None and not has_range:
            raise ApiError(400, {"error": "days-or-block-range-required"})
        if has_range and request.startBlock > request.endBlock:  # type: ignore[operator]
            raise ApiError(400, {"error": "invalid-block-range"})

        self.status = ScrapeStatus(
            running=True,
            phase="starting",
            startBlock=None if request.days is not None else request.startBlock,
            endBlock=None if request.days is not None else request.endBlock,
            lastResult=self.status.lastResult,
        )
        self._task = asyncio.create_task(self._run(request))
        return self.status

    async def cancel(self) -> ScrapeStatus:
        """Cancel the running job (no-op when idle) and wait for it to unwind."""
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self.status

    def _progress(self, current_block: int, end_block: int, fetched: int) -> None:
        self.status.phase = "scraping"
        self.status.endBlock = end_block
        self.status.currentBlock = current_block
        self.status.fetched = fetched

    async def _run(self, request: ScrapeRequest) -> None:
        try:
            if request.days is not None:
                result = await scrape_timeframe(request.days, on_progress=self._progress)
            else:
                assert request.startBlock is not None and request.endBlock is not None
                result = await scrape_range(
                    request.startBlock,
                    request.endBlock,
                    chunk_blocks=request.chunkBlocks,
                    on_progress=self._progress,
                )
            self.status.lastResult = result
            self.status.phase = "complete"
            self.status.totalActions = await count_actions()
        except asyncio.CancelledError:
            self.status.phase = "cancelled"
        except Exception as exc:
            logger.exception("Scrape failed")
            self.status.phase = "error"
            self.status.error = str(exc)
        finally:
            self.status.running = False


_manager = ScrapeManager()


def get_scrape_manager() -> ScrapeManager:
    """FastAPI dependency; tests override it with a fresh manager."""
    return _manager
