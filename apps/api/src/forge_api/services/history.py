"""Deterministic history generator.

The beta app has no database yet, so the activity feed is synthesised from a fixed
seed: every process start produces byte-identical rows, which is what makes the
issue-1 acceptance test (10k-row CSV export) meaningful rather than flaky
(PRD Appendix H.2 — "test suite exists, deterministic").
"""

import random
from datetime import UTC, datetime, timedelta

from forge_api.models import HistoryItem, HistoryList, HistoryType

SEED = 42
TOTAL_ROWS = 10_000
MAX_LIMIT = 500
DEFAULT_LIMIT = 50

# Newest row first; timestamps walk backwards from this instant.
START_TS = datetime(2026, 8, 1, 12, 0, 0, tzinfo=UTC)

_TYPES: tuple[HistoryType, ...] = ("earn", "spend", "transfer")
_TYPE_WEIGHTS: tuple[int, ...] = (5, 3, 2)

_MEMOS: dict[HistoryType, tuple[str, ...]] = {
    "earn": (
        "Daily streak bonus",
        "Referral reward",
        "Quest completed",
        "Staking payout",
        "Community reward",
    ),
    "spend": (
        "Marketplace purchase",
        "Boost unlocked",
        "Collectible minted",
        "Premium month",
        "Tip sent",
    ),
    "transfer": (
        "Sent to a friend",
        "Received from a friend",
        "Moved to savings",
        "Top-up",
        "Split the bill",
    ),
}


def _build_rows() -> list[HistoryItem]:
    rng = random.Random(SEED)
    rows: list[HistoryItem] = []
    ts = START_TS
    for i in range(TOTAL_ROWS):
        kind = rng.choices(_TYPES, weights=_TYPE_WEIGHTS, k=1)[0]
        amount = round(rng.uniform(0.01, 500.0), 2)
        memo = rng.choice(_MEMOS[kind]) if rng.random() < 0.7 else None
        rows.append(
            HistoryItem(
                id=f"tx_{i:05d}",
                ts=ts.isoformat().replace("+00:00", "Z"),
                type=kind,
                amount=amount,
                memo=memo,
            )
        )
        # Descending: each subsequent row is older than the last.
        ts -= timedelta(seconds=rng.randint(60, 900))
    return rows


_ROWS: list[HistoryItem] | None = None


def all_rows() -> list[HistoryItem]:
    """Every generated row, newest first. Built once per process, never mutated."""
    global _ROWS
    if _ROWS is None:
        _ROWS = _build_rows()
    return _ROWS


def get_history(limit: int = DEFAULT_LIMIT, offset: int = 0) -> HistoryList:
    """A page of history. `limit` is capped at MAX_LIMIT; `offset` must be >= 0."""
    if offset < 0:
        offset = 0
    limit = max(0, min(limit, MAX_LIMIT))
    rows = all_rows()
    return HistoryList(items=rows[offset : offset + limit], total=len(rows))
