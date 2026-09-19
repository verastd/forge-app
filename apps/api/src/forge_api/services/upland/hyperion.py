"""Async client for the Upland Hyperion full-history API (chain-history.upland.me).

Ported from the upland-scraper `hyperion.py`. No auth, but Hyperion answers 403 to
clients without a browser-like User-Agent.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

logger = logging.getLogger(__name__)

HYPERION_BASE = "https://chain-history.upland.me"
CHAIN_API_BASE = "https://chain-api.upland.me"
MAX_LIMIT = 1000
MAX_SKIP = 9999
BLOCKS_PER_DAY = 172_800  # 0.5s block time
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UplandLedger/1.0"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_ATTEMPTS = 4

Action = dict[str, Any]
OnChunk = Callable[[list[Action]], Awaitable[None]]


class HyperionClient:
    """Thin async wrapper over the two Upland endpoints the ledger needs."""

    def __init__(self, max_concurrent: int = 5, *, retry_delay: float = 1.0) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._retry_delay = retry_delay
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            headers={"User-Agent": USER_AGENT},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        """One request with bounded exponential backoff on throttling/5xx/transport errors."""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = await self._client.request(method, url, **kwargs)
                if response.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
                    logger.warning("%s %s -> %s; retrying", method, url, response.status_code)
                else:
                    response.raise_for_status()
                    return response.json()
            except httpx.TransportError as exc:
                if attempt == MAX_ATTEMPTS:
                    raise
                logger.warning("%s %s failed (%s); retrying", method, url, exc)
            await asyncio.sleep(self._retry_delay * 2 ** (attempt - 1))
        raise AssertionError("unreachable")  # pragma: no cover

    async def get_info(self) -> dict[str, Any]:
        """Chain info: head block number/time, chain id."""
        info: dict[str, Any] = await self._request("POST", f"{CHAIN_API_BASE}/v1/chain/get_info")
        return info

    async def get_actions(
        self,
        account: str = "playuplandme",
        filter_actions: str | None = None,
        limit: int = MAX_LIMIT,
        skip: int = 0,
        sort: str = "asc",
        block_num_range: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        """One Hyperion `get_actions` page.

        `filter_actions` looks like ``playuplandme:n5,playuplandme:n2``;
        `block_num_range` is an inclusive ``(first, last)`` pair.
        """
        params: dict[str, str | int] = {
            "account": account,
            "limit": min(limit, MAX_LIMIT),
            "skip": skip,
            "sort": sort,
        }
        if filter_actions:
            params["filter"] = filter_actions
        if block_num_range:
            params["block_num"] = f"{block_num_range[0]}-{block_num_range[1]}"
        async with self._semaphore:
            page: dict[str, Any] = await self._request(
                "GET", f"{HYPERION_BASE}/v2/history/get_actions", params=params
            )
            return page

    async def get_actions_batch(
        self,
        account: str = "playuplandme",
        filter_actions: str | None = None,
        block_num_range: tuple[int, int] | None = None,
        limit: int = MAX_LIMIT,
    ) -> list[Action]:
        """Every action in an inclusive block range via skip pagination.

        Skip pagination stops at MAX_SKIP, so a range with more actions than that is
        truncated (and logged) — callers narrow the range first, see
        `get_actions_chunked`.
        """
        collected: list[Action] = []
        skip = 0
        while True:
            data = await self.get_actions(
                account=account,
                filter_actions=filter_actions,
                limit=limit,
                skip=skip,
                sort="asc",
                block_num_range=block_num_range,
            )
            actions: list[Action] = data.get("actions", [])
            total = data.get("total", {}).get("value", 0)
            collected.extend(actions)
            skip += len(actions)

            if len(actions) < limit or skip >= total:
                break
            if skip > MAX_SKIP:
                logger.warning(
                    "Block range %s has more than %s actions; narrow it. Got %s so far.",
                    block_num_range,
                    MAX_SKIP,
                    len(collected),
                )
                break
        return collected

    async def get_actions_chunked(
        self,
        account: str = "playuplandme",
        filter_actions: str | None = None,
        start_block: int = 0,
        end_block: int = 0,
        chunk_blocks: int = 100_000,
        on_chunk: OnChunk | None = None,
    ) -> int:
        """Fetch all actions in ``[start_block, end_block)`` (end exclusive).

        Starts with `chunk_blocks`-wide windows and recursively halves any window
        that holds more than MAX_SKIP actions, so no window hits Hyperion's skip
        cap. `on_chunk` receives each fetched sub-chunk so the caller can persist
        incrementally instead of holding the range in memory. Returns the count.
        """
        total = 0
        current = start_block
        while current < end_block:
            chunk_end = min(current + max(1, chunk_blocks), end_block)
            block_range = (current, chunk_end - 1)  # Hyperion's range is inclusive
            estimate = await self.estimate_action_count(
                account=account, filter_actions=filter_actions, block_num_range=block_range
            )
            dense = estimate["relation"] == "gte" or estimate["total"] > MAX_SKIP
            if dense and chunk_end - current > 1:
                mid = current + (chunk_end - current) // 2
                for lo, hi in ((current, mid), (mid, chunk_end)):
                    total += await self.get_actions_chunked(
                        account=account,
                        filter_actions=filter_actions,
                        start_block=lo,
                        end_block=hi,
                        chunk_blocks=max(1, chunk_blocks // 2),
                        on_chunk=on_chunk,
                    )
            else:
                actions = await self.get_actions_batch(
                    account=account, filter_actions=filter_actions, block_num_range=block_range
                )
                if on_chunk and actions:
                    await on_chunk(actions)
                total += len(actions)
            current = chunk_end
        return total

    async def estimate_action_count(
        self,
        account: str = "playuplandme",
        filter_actions: str | None = None,
        block_num_range: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        """Cheap count for a block range (a one-row query).

        `relation` is "gte" when Hyperion capped the count, so the true total is higher.
        """
        data = await self.get_actions(
            account=account,
            filter_actions=filter_actions,
            limit=1,
            sort="desc",
            block_num_range=block_num_range,
        )
        total = data.get("total", {})
        return {
            "total": total.get("value", 0),
            "relation": total.get("relation", "eq"),
            "query_time_ms": data.get("query_time_ms", 0),
            "last_indexed_block": data.get("last_indexed_block", 0),
        }

    @staticmethod
    def blocks_for_timeframe(days: int, head_block: int) -> tuple[int, int]:
        """Inclusive block range covering the last `days` days."""
        return max(1, head_block - days * BLOCKS_PER_DAY), head_block
