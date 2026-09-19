"""SQLite (WAL) schema and connection helper for the Upland data set.

Ported from the upland-scraper `db.py`. The scraper writes while the API reads, so
every connection runs in WAL mode with a generous busy timeout.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite

ENV_DB_PATH = "UPLAND_DB_PATH"
BUSY_TIMEOUT_MS = 30_000

SCHEMA_STATEMENTS: list[str] = [
    """CREATE TABLE IF NOT EXISTS actions (
    global_sequence INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    block_num INTEGER NOT NULL,
    trx_id TEXT NOT NULL,
    contract TEXT NOT NULL,
    action_name TEXT NOT NULL,
    action_meaning TEXT,
    category TEXT,
    actor TEXT,
    data_json TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    property_id TEXT,
    price_upx REAL,
    from_account TEXT,
    to_account TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_actions_block ON actions(block_num)",
    "CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action_name)",
    "CREATE INDEX IF NOT EXISTS idx_actions_category ON actions(category)",
    "CREATE INDEX IF NOT EXISTS idx_actions_property ON actions(property_id)",
    "CREATE INDEX IF NOT EXISTS idx_actions_actor ON actions(actor)",
    """CREATE TABLE IF NOT EXISTS scrape_progress (
    key TEXT PRIMARY KEY,
    start_block INTEGER,
    end_block INTEGER,
    current_block INTEGER,
    status TEXT,
    total_actions INTEGER DEFAULT 0,
    started_at TEXT,
    updated_at TEXT,
    error TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS properties (
    property_id TEXT PRIMARY KEY,
    address TEXT,
    city TEXT,
    first_seen_block INTEGER,
    first_seen_timestamp TEXT,
    mint_price_upx REAL,
    last_sale_price_upx REAL,
    last_sale_timestamp TEXT,
    total_sales INTEGER DEFAULT 0,
    total_listings INTEGER DEFAULT 0
    )""",
]

#: Paths whose schema has already been applied this process.
_initialised: set[str] = set()


def get_db_path() -> str:
    """Resolved on every call so `UPLAND_DB_PATH` changes (and tests) take effect."""
    default = Path(__file__).resolve().parents[4] / "data" / "upland.db"
    return os.environ.get(ENV_DB_PATH) or str(default)


async def init_db() -> None:
    """Create the schema (idempotent) with WAL mode enabled."""
    path = get_db_path()
    if path in _initialised and Path(path).exists():
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(path, timeout=30) as conn:
        await conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        await conn.execute("PRAGMA journal_mode=WAL")
        for statement in SCHEMA_STATEMENTS:
            await conn.execute(statement)
        await conn.commit()
    _initialised.add(path)


@asynccontextmanager
async def _db() -> AsyncIterator[aiosqlite.Connection]:
    """Yield a connection with pragmas applied and rows addressable by name.

    Use as ``async with _db() as db:`` — no ``await``. Awaiting the connection
    and then entering it starts aiosqlite's worker thread twice.
    """
    await init_db()
    conn = await aiosqlite.connect(get_db_path(), timeout=30)
    try:
        await conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        await conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = aiosqlite.Row
        yield conn
    finally:
        await conn.close()
