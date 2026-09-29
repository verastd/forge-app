"""Upland data app: action processing, models, flag gating, analytics and the HTTP surface.

No network: the database is a temp SQLite file (`UPLAND_DB_PATH`) and Hyperion is a fake
injected through the router's `get_hyperion` dependency. HTTP calls carry a minted API
assertion; the identity gate itself is covered in test_identity.py.
"""

import asyncio
import csv
import io
import json
import logging
import sqlite3
from collections.abc import Callable, Coroutine, Iterator
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiosqlite
import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.models import (
    ScrapeRequest,
    ScrapeStatus,
    UplandAction,
    UplandProperty,
)
from forge_api.routers.upland import get_hyperion
from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError
from forge_api.services.upland import analytics, scraper, storage
from forge_api.services.upland.action_codes import SALE_ACTIONS
from forge_api.services.upland.db import _db
from forge_api.services.upland.scraper import (
    ACTION_COLUMNS,
    INSERT_ACTION_SQL,
    PROPERTY_CATEGORIES,
    ScrapeManager,
    _update_property,
    get_scrape_manager,
    process_action,
    store_and_update,
)

PROPERTY = "1234567890123"
OTHER_PROPERTY = "9876543210987"
MEMO = "Buyer owns 111 VENICE BLVD, Los Angeles, CA on Upland"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def raw_action(
    seq: int,
    name: str,
    *,
    data: dict[str, Any] | None = None,
    when: datetime | None = None,
    actor: str = "alice",
    block: int | None = None,
) -> dict[str, Any]:
    moment = when or datetime.now(UTC) - timedelta(days=1)
    return {
        "global_sequence": seq,
        "timestamp": moment.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "block_num": block if block is not None else 1000 + seq,
        "trx_id": f"trx{seq}",
        "act": {
            "account": "playuplandme",
            "name": name,
            "authorization": [{"actor": actor, "permission": "active"}],
            "data": data if data is not None else {},
        },
    }


def n5(seq: int, price: str, *, prop: str = PROPERTY, **kwargs: Any) -> dict[str, Any]:
    data = {"a45": prop, "p24": f"{price} UPX", "p51": "seller", "p14": "buyer", "memo": MEMO}
    return raw_action(seq, "n5", data=data, **kwargs)


def set_flags(monkeypatch: pytest.MonkeyPatch, **flags: bool) -> None:
    """FORGE_FLAGS_JSON: the named flags, over config/flags.json (which turns all of them on)."""
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps(flags))


def seed_yields(count: int) -> None:
    """Actions 1..`count`, all plain yield collections: no property roll-ups, so it is quick."""
    when = datetime(2026, 9, 1, tzinfo=UTC)
    actions = [raw_action(seq, "n31", when=when) for seq in range(1, count + 1)]
    run(store_and_update([process_action(action) for action in actions]))


def export_chunks(kind: analytics.ExportType = "actions") -> list[str]:
    async def collect() -> list[str]:
        return [chunk async for chunk in analytics.iter_export_csv(kind)]

    return run(collect())


def csv_rows(chunk: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(chunk)))


@pytest.fixture(autouse=True)
def upland_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    path = tmp_path / "upland.db"
    monkeypatch.setenv("UPLAND_DB_PATH", str(path))
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"upland_data": True}))
    return path


@pytest.fixture
def http(user_headers: dict[str, str]) -> Iterator[TestClient]:
    """A signed-in contributor: enough for every read route."""
    with TestClient(app, headers=user_headers) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def admin_http(admin_headers: dict[str, str]) -> Iterator[TestClient]:
    """A signed-in operator: the scrape and GCS controls are admin-only."""
    with TestClient(app, headers=admin_headers) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def seeded() -> None:
    """A small, known data set: 3 sales (n5), an n111, a listing, a mint and an earnings action."""
    now = datetime.now(UTC)
    actions = [
        n5(1, "1000.00", when=now - timedelta(days=2)),
        n5(2, "3000.00", when=now - timedelta(days=2, hours=1), actor="bob"),
        n5(3, "20000.00", prop=OTHER_PROPERTY, when=now - timedelta(days=1)),
        raw_action(4, "n111", data={"a45": PROPERTY, "p24": "5000.00 UPX"}, when=now),
        raw_action(5, "n2", data={"a45": PROPERTY, "p24": "9000.00 UPX"}, when=now),
        raw_action(6, "a4", data={"a45": OTHER_PROPERTY, "p24": "10.00 UPX"}, when=now),
        raw_action(7, "n31", data={"from": "upxtokenacct", "to": "alice"}, when=now),
    ]
    run(store_and_update([process_action(a) for a in actions]))


# --- action processing ---------------------------------------------------------


def test_process_action_decodes_a_secondary_sale() -> None:
    row = process_action(n5(42, "1,500.50"))
    assert row["global_sequence"] == 42
    assert row["action_name"] == "n5"
    assert row["action_meaning"] == "secondary market property buy"
    assert row["category"] == "trade"
    assert row["contract"] == "playuplandme"
    assert row["actor"] == "alice"
    assert row["property_id"] == PROPERTY
    assert row["price_upx"] == 1500.50
    assert (row["from_account"], row["to_account"]) == ("seller", "buyer")
    assert row["_address"] == "111 VENICE BLVD, Los Angeles, CA"
    assert json.loads(row["data_json"])["a45"] == PROPERTY


def test_process_action_handles_unmapped_and_undecodable_actions() -> None:
    row = process_action(raw_action(1, "zzz", data={}))
    assert row["category"] == "unknown"
    assert row["action_meaning"] == "zzz"
    assert row["property_id"] is None and row["price_upx"] is None

    hexed = raw_action(2, "n5")
    hexed["act"]["data"] = "deadbeef"  # Hyperion's shape for undecodable data
    assert process_action(hexed)["data_json"] == "{}"


def test_process_action_falls_back_to_from_account_for_actor() -> None:
    action = raw_action(3, "n31", data={"from": "upxtokenacct", "to": "carol"})
    action["act"]["authorization"] = []
    row = process_action(action)
    assert row["actor"] == "upxtokenacct"
    assert row["to_account"] == "carol"


def test_store_and_update_rolls_up_properties_without_double_counting() -> None:
    rows = [process_action(a) for a in (n5(1, "1000.00"), n5(2, "3000.00"))]
    run(store_and_update(rows))
    run(store_and_update(rows))  # overlapping re-scrape

    prop = run(analytics.get_property(PROPERTY))
    assert prop.totalSales == 2
    assert prop.lastSalePriceUpx == 3000.0
    assert prop.city == "Los Angeles"
    assert run(analytics.list_actions()).total == 2


# --- models ----------------------------------------------------------------------


def test_upland_action_serializes_camel_case() -> None:
    action = UplandAction(
        globalSequence=1,
        ts="2026-09-01T00:00:00",
        blockNum=10,
        trxId="abc",
        contract="playuplandme",
        actionName="n5",
        priceUpx=12.5,
    )
    dumped = action.model_dump()
    assert dumped["globalSequence"] == 1 and dumped["priceUpx"] == 12.5
    assert dumped["actor"] is None
    assert UplandAction.model_validate_json(action.model_dump_json()) == action


def test_upland_property_defaults_and_round_trip() -> None:
    prop = UplandProperty(propertyId=PROPERTY, address="1 Main St", totalSales=3)
    dumped = prop.model_dump()
    assert dumped["totalListings"] == 0 and dumped["mintPriceUpx"] is None
    assert UplandProperty(**dumped) == prop


def test_scrape_status_serializes() -> None:
    status = ScrapeStatus(running=True, phase="scraping", currentBlock=5, lastResult={"stored": 9})
    assert status.model_dump() == {
        "running": True,
        "phase": "scraping",
        "currentBlock": 5,
        "fetched": 0,
        "totalActions": 0,
        "startBlock": None,
        "endBlock": None,
        "error": None,
        "lastResult": {"stored": 9},
    }


def test_scrape_request_defaults_and_bounds() -> None:
    assert ScrapeRequest(days=90).chunkBlocks == 100_000
    with pytest.raises(ValueError):
        ScrapeRequest(days=0)


# --- feature flag gating -----------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/upland/health"),
        ("get", "/api/upland/stats/overview"),
        ("get", "/api/upland/actions"),
        ("get", "/api/upland/properties"),
        ("get", "/api/upland/codes"),
        ("get", "/api/upland/export?type=actions"),
        ("get", "/api/upland/scrape/status"),
        ("post", "/api/upland/scrape"),
        ("post", "/api/upland/gcs/sync"),
        ("get", "/api/upland/gcs/status"),
    ],
)
def test_routes_404_when_flag_is_off(
    http: TestClient, monkeypatch: pytest.MonkeyPatch, method: str, path: str
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"upland_data": False}))
    response = http.request(method, path, json={"days": 1} if method == "post" else None)
    assert response.status_code == 404
    assert response.json() == {"error": "upland-disabled"}


def test_flag_fails_closed_on_corrupt_config(
    http: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, "{not json")
    assert http.get("/api/upland/health").status_code == 404


def test_flag_on_serves_routes(http: TestClient) -> None:
    assert http.get("/api/upland/health").status_code == 200


# --- analytics (temp SQLite) ----------------------------------------------------------


def test_empty_database_is_healthy() -> None:
    health = run(analytics.health())
    assert (health.actions, health.properties, health.latestBlock) == (0, 0, None)
    overview = run(analytics.stats_overview())
    assert overview.totalActions == 0 and overview.dateRange.min is None


def test_stats_overview(seeded: None) -> None:
    overview = run(analytics.stats_overview())
    assert overview.totalActions == 7
    assert overview.byCategory["trade"] == 5
    assert overview.byCategory["mint"] == 1
    assert overview.byType[0].actionName == "n5" and overview.byType[0].count == 3
    assert overview.totalProperties == 2
    assert overview.dateRange.min is not None and overview.dateRange.min <= overview.dateRange.max  # type: ignore[operator]


def test_list_actions_filters_and_paginates(seeded: None) -> None:
    page = run(analytics.list_actions(limit=2))
    assert page.total == 7 and len(page.items) == 2 and page.hasMore is True
    last = run(analytics.list_actions(limit=2, offset=6))
    assert len(last.items) == 1 and last.hasMore is False

    assert run(analytics.list_actions(action_name="n5")).total == 3
    assert run(analytics.list_actions(actor="bob")).total == 1
    assert run(analytics.list_actions(property_id=OTHER_PROPERTY)).total == 2
    assert run(analytics.list_actions(category="earnings")).total == 1
    cutoff = (datetime.now(UTC) - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S")
    assert run(analytics.list_actions(start=cutoff)).total == 4


def test_recent_sales_only_priced_sale_actions(seeded: None) -> None:
    sales = run(analytics.recent_sales())
    assert {s.actionName for s in sales} == {"n5", "n111", "a4"}
    assert all(s.priceUpx is not None for s in sales)
    assert sales[0].ts >= sales[-1].ts


def test_sales_volume_groups_by_day(seeded: None) -> None:
    days = run(analytics.sales_volume(30))
    assert sum(d.count for d in days) == 4  # 3 x n5 + 1 x n111; the mint is not volume
    assert sum(d.volumeUpx for d in days) == 29_000.0
    top = max(days, key=lambda d: d.maxPrice)
    assert top.maxPrice == 20_000.0
    assert days == sorted(days, key=lambda d: d.date, reverse=True)


def test_action_distribution_and_active_accounts(seeded: None) -> None:
    distribution = run(analytics.action_distribution())
    assert [(e.actionName, e.count) for e in distribution][0] == ("n5", 3)
    accounts = run(analytics.active_accounts(limit=1))
    assert accounts[0].actor == "alice" and accounts[0].txCount >= 5


def test_active_accounts_exclude_the_contract_itself(seeded: None) -> None:
    # playuplandme authors most actions on chain (fees, yields, config); the
    # "most active accounts" board is about players, not the machine.
    for seq, name in enumerate(["n31", "n41", "n43"], start=90):
        run(store_and_update([process_action(raw_action(seq, name, actor="playuplandme"))]))
    accounts = run(analytics.active_accounts())
    actors = {a.actor for a in accounts}
    assert "playuplandme" not in actors
    assert "alice" in actors


def test_top_properties_and_lookup(seeded: None) -> None:
    by_sales = run(analytics.top_properties(10, "sales"))
    assert by_sales.items[0].propertyId == PROPERTY
    assert by_sales.items[0].totalSales == 2
    by_price = run(analytics.top_properties(10, "price"))
    assert by_price.items[0].propertyId == OTHER_PROPERTY

    listed = run(analytics.list_properties(limit=1))
    assert listed.total == 2 and len(listed.items) == 1
    assert run(analytics.get_property(PROPERTY)).totalListings == 1
    with pytest.raises(ApiError) as excinfo:
        run(analytics.get_property("nope"))
    assert excinfo.value.status_code == 404


def test_time_series_and_price_distribution(seeded: None) -> None:
    trade = run(analytics.time_series("day", "trade"))
    assert sum(p.count for p in trade) == 5
    assert sum(p.volume for p in trade) == 38_000.0
    assert sum(p.count for p in run(analytics.time_series("week", "all"))) == 7
    assert all(len(p.bucket) == 16 for p in run(analytics.time_series("hour", "all")))

    buckets = {b.range: b for b in run(analytics.price_distribution())}
    assert set(buckets) == {"1K-5K", "5K-10K", "10K-50K"}
    assert buckets["10K-50K"].count == 1 and buckets["10K-50K"].avgPrice == 20_000.0


def test_export_csv_streams_header_and_rows(seeded: None) -> None:
    header, *batches = export_chunks("actions")
    assert csv_rows(header) == [analytics.EXPORT_HEADER]
    assert [len(csv_rows(batch)) for batch in batches] == [7]  # one partial batch

    _, *sales = export_chunks("sales")
    rows = [row for batch in sales for row in csv_rows(batch)]
    assert [row[5] for row in rows] == ["n5", "n5", "n5", "n111", "a4"]  # priced sales only
    assert all(len(row) == len(analytics.EXPORT_HEADER) for row in rows)


def test_export_csv_of_an_empty_table_is_just_the_header() -> None:
    assert export_chunks("actions") == [",".join(analytics.EXPORT_HEADER) + "\r\n"]


@pytest.fixture
def many_actions() -> int:
    """2,500 actions: two full export batches and a partial third."""
    seed_yields(2_500)
    return 2_500


def test_export_streams_one_chunk_per_thousand_rows(many_actions: int) -> None:
    header, *batches = export_chunks("actions")
    assert csv_rows(header) == [analytics.EXPORT_HEADER]
    assert analytics.EXPORT_BATCH_ROWS == 1_000
    assert [len(csv_rows(batch)) for batch in batches] == [1_000, 1_000, 500]
    sequences = [int(row[0]) for batch in batches for row in csv_rows(batch)]
    assert sequences == list(range(1, many_actions + 1))  # every row once, oldest first


@pytest.fixture
def fetches(many_actions: int, monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """After seeding: the row count of every `fetchmany` from here on. `fetchall` fails the
    test outright."""
    seen: list[int] = []
    fetchmany = aiosqlite.Cursor.fetchmany

    async def counted(self: aiosqlite.Cursor, size: int | None = None) -> list[Any]:
        rows = list(await fetchmany(self, size))
        seen.append(len(rows))
        return rows

    async def refused(self: aiosqlite.Cursor) -> list[Any]:
        raise AssertionError("the export read the whole table at once")

    monkeypatch.setattr(aiosqlite.Cursor, "fetchmany", counted)
    monkeypatch.setattr(aiosqlite.Cursor, "fetchall", refused)
    return seen


def test_export_reads_one_batch_per_chunk_and_never_the_whole_table(
    fetches: list[int],
) -> None:
    async def read() -> None:
        stream = analytics.iter_export_csv("actions")
        await anext(stream)
        assert fetches == []  # the header goes out before the query runs
        await anext(stream)
        assert fetches == [1_000]  # one batch per chunk, fetched when it is asked for
        async for _ in stream:
            pass

    run(read())
    assert fetches == [1_000, 1_000, 500, 0]


def test_export_stops_reading_when_the_client_goes_away(fetches: list[int]) -> None:
    async def first_batch_only() -> None:
        stream = analytics.iter_export_csv("actions")
        await anext(stream)
        await anext(stream)
        await stream.aclose()

    run(first_batch_only())
    assert fetches == [1_000]


# --- the export opens safely in a spreadsheet ---------------------------------------------


def exported_cells() -> dict[str, str]:
    """The one exported row, by column name."""
    _, batch = export_chunks("actions")
    [row] = csv_rows(batch)
    return dict(zip(analytics.EXPORT_HEADER, row, strict=True))


@pytest.mark.parametrize("lead", ["=", "+", "-", "@", "\t", "\r"])
def test_export_neutralises_every_formula_lead(lead: str) -> None:
    payload = f"{lead}SUM(1+1)*cmd|' /C calc'!A0"
    data = {"from": payload, "to": payload}
    run(store_and_update([process_action(raw_action(1, "n31", data=data, actor=payload))]))

    cells = exported_cells()
    assert cells["actor"] == cells["from_account"] == cells["to_account"] == "'" + payload


def test_export_leaves_benign_cells_alone() -> None:
    data = {"from": "alice", "to": "b=c+d", "p24": "-5"}  # a lead past the first character is inert
    action = raw_action(1, "n31", data=data)
    action["trx_id"] = "0f" * 32
    run(store_and_update([process_action(action)]))

    cells = exported_cells()
    assert (cells["from_account"], cells["to_account"]) == ("alice", "b=c+d")
    assert cells["timestamp"] == action["timestamp"]  # ISO timestamp
    assert cells["trx_id"] == "0f" * 32  # hex
    assert cells["price_upx"] == "-5.0"  # a number, even a negative one, is never prefixed


# --- HTTP surface ------------------------------------------------------------------------


def test_http_reads_return_wire_shapes(http: TestClient, seeded: None) -> None:
    overview = http.get("/api/upland/stats/overview").json()
    assert overview["totalActions"] == 7
    assert set(overview) == {"totalActions", "dateRange", "byCategory", "byType", "totalProperties"}

    page = http.get("/api/upland/actions", params={"category": "trade", "limit": 2}).json()
    assert page["total"] == 5 and page["hasMore"] is True
    assert {"globalSequence", "ts", "blockNum", "trxId", "actionName"} <= set(page["items"][0])

    assert http.get("/api/upland/actions/sales").status_code == 200
    assert http.get("/api/upland/stats/sales_volume?days=90").status_code == 200
    assert http.get("/api/upland/stats/top_properties?limit=5&sort=price").status_code == 200
    assert http.get(f"/api/upland/properties/{PROPERTY}").json()["totalSales"] == 2
    assert http.get("/api/upland/properties/missing").status_code == 404
    assert "n5" in http.get("/api/upland/codes").json()


def test_http_validation(http: TestClient) -> None:
    assert http.get("/api/upland/stats/time_series?filter=bogus").status_code == 422
    assert http.get("/api/upland/actions?limit=0").status_code == 422
    assert http.get("/api/upland/stats/time_series?filter=all&interval=week").status_code == 200


def test_http_csv_export(http: TestClient, seeded: None) -> None:
    response = http.get("/api/upland/export?type=sales")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "upland-sales.csv" in response.headers["content-disposition"]
    assert len(response.text.strip().splitlines()) == 6


def test_the_sales_export_leaves_out_other_contracts(http: TestClient) -> None:
    """Any contract can notify playuplandme with an action named `n5`; it is not an Upland sale."""
    foreign = n5(2, "999999.00", prop=OTHER_PROPERTY)
    foreign["act"]["account"] = "evilcontract"
    run(store_and_update([process_action(n5(1, "1000.00")), process_action(foreign)]))

    _, *rows = csv_rows(http.get("/api/upland/export?type=sales").text)
    assert [(row[0], row[4]) for row in rows] == [("1", "playuplandme")]


# --- other contracts' actions ------------------------------------------------------------
#
# Hyperion's account=playuplandme query also returns every action another contract ran with
# require_recipient(playuplandme), named and shaped by that contract's ABI: its `n5` is no
# Upland sale. The scraper stores none of it, and every read is scoped to playuplandme besides,
# for a database filled before the scraper dropped them.

FOREIGN_CONTRACT = "evilcontract"
FOREIGN_PROPERTY = "81000000000001"
HUGE_PRICE = "999999999.00"
FORMULA = '=HYPERLINK("https://evil.example","x")'


def as_foreign(action: dict[str, Any]) -> dict[str, Any]:
    """`action`, as another contract ran it."""
    action["act"]["account"] = FOREIGN_CONTRACT
    return action


def foreign_sale(seq: int, *, prop: str = FOREIGN_PROPERTY, **kwargs: Any) -> dict[str, Any]:
    """Another contract's `n5`, at a price that would top every chart."""
    sale = as_foreign(n5(seq, HUGE_PRICE, prop=prop, actor=FOREIGN_CONTRACT, **kwargs))
    sale["act"]["data"]["p51"] = FORMULA
    return sale


def legacy_store(actions: list[dict[str, Any]]) -> None:
    """What store_and_update did before it dropped other contracts' actions: store every action
    and roll every trade or mint one into `properties`. Builds a database from before the fix."""

    async def write() -> None:
        rows = [process_action(action) for action in actions]
        async with _db() as db:
            await db.executemany(
                INSERT_ACTION_SQL, [tuple(row[column] for column in ACTION_COLUMNS) for row in rows]
            )
            for row in rows:
                if row["property_id"] and row["category"] in PROPERTY_CATEGORIES:
                    await _update_property(db, row)
            await db.commit()

    run(write())


def stored(upland_db: Path, sql: str, *params: Any) -> list[tuple[Any, ...]]:
    """Rows straight from the SQLite file, past every read-side scope."""
    with closing(sqlite3.connect(upland_db)) as db:
        return db.execute(sql, params).fetchall()


class OneChunk:
    """Stands in for HyperionClient in scrape_range: every action arrives in one chunk."""

    def __init__(self, actions: list[dict[str, Any]]) -> None:
        self.actions = actions

    async def get_actions_chunked(self, **kwargs: Any) -> int:
        assert kwargs["account"] == "playuplandme" and kwargs["filter_actions"] is None
        await kwargs["on_chunk"](self.actions)
        return len(self.actions)

    async def close(self) -> None:
        pass


def test_the_scraper_stores_only_playuplandme_actions(
    upland_db: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A chunk holding a real sale and another contract's `n5` at 999,999,999 UPX: the sale is
    stored and rolled up as ever, the `n5` neither."""
    chunk = [n5(1, "1000.00"), foreign_sale(2)]
    monkeypatch.setattr(scraper, "new_client", lambda max_concurrent=5: OneChunk(chunk))
    caplog.set_level(logging.DEBUG, logger=scraper.__name__)

    result = run(scraper.scrape_range(1001, 1002))

    assert (result["totalFetched"], result["totalStored"]) == (2, 1)
    assert stored(upland_db, "SELECT global_sequence, contract FROM actions") == [
        (1, "playuplandme")
    ]
    assert stored(upland_db, "SELECT property_id, total_sales FROM properties") == [(PROPERTY, 1)]
    # The count, at debug level only, and not one string the other contract chose.
    assert [(r.levelno, r.getMessage()) for r in caplog.records if r.name == scraper.__name__] == [
        (logging.DEBUG, "dropped 1 actions other contracts sent to playuplandme")
    ]
    for chosen in (FOREIGN_CONTRACT, FOREIGN_PROPERTY, "HYPERLINK", "999999999"):
        assert chosen not in caplog.text


def test_no_other_contracts_action_moves_a_property_roll_up(upland_db: Path) -> None:
    """Not even a sale of a real property: its counters stay the ones playuplandme set."""
    assert run(store_and_update([process_action(n5(1, "1000.00"))])) == 1
    later = foreign_sale(2, prop=PROPERTY, when=datetime.now(UTC))
    assert run(store_and_update([process_action(later)])) == 0

    assert stored(upland_db, "SELECT global_sequence FROM actions") == [(1,)]
    prop = run(analytics.get_property(PROPERTY))
    assert (prop.totalSales, prop.lastSalePriceUpx) == (1, 1000.0)


#: Every read of the data set, as the Data app asks for it.
READS = [
    "/api/upland/health",
    "/api/upland/stats/overview",
    "/api/upland/stats/action_distribution",
    "/api/upland/stats/active_accounts",
    "/api/upland/actions",
    "/api/upland/actions?category=trade",
    "/api/upland/actions?actor=alice",
    f"/api/upland/actions?property_id={FOREIGN_PROPERTY}",
    "/api/upland/actions/sales",
    "/api/upland/stats/sales_volume?days=365",
    "/api/upland/stats/price_distribution",
    "/api/upland/stats/top_properties?sort=sales",
    "/api/upland/stats/top_properties?sort=price",
    "/api/upland/properties",
    f"/api/upland/properties/{FOREIGN_PROPERTY}",
    "/api/upland/stats/time_series?interval=day&filter=trade",
    "/api/upland/stats/time_series?interval=hour&filter=all",
    "/api/upland/stats/time_series?interval=week&filter=mint",
    "/api/upland/stats/time_series?interval=day&filter=unknown",
    "/api/upland/export?type=actions",
    "/api/upland/export?type=sales",
]


def test_an_old_databases_foreign_rows_reach_no_read(
    http: TestClient, seeded: None, upland_db: Path
) -> None:
    """Every read answers exactly what it answered before another contract's rows were added."""
    before = {path: (r.status_code, r.text) for path in READS for r in [http.get(path)]}
    assert [path for path, (status, _) in before.items() if status != 200] == [
        f"/api/upland/properties/{FOREIGN_PROPERTY}"  # the one read that should find nothing
    ]
    now = datetime.now(UTC)
    legacy_store(
        [
            foreign_sale(20, when=now),  # on a property only it names
            as_foreign(
                raw_action(21, "a4", data={"a45": FOREIGN_PROPERTY, "p24": "777.00 UPX"}, when=now)
            ),
            # Authorised by a real player, so it would count towards her activity.
            as_foreign(raw_action(22, "transfer", data={"from": FORMULA, "to": "bob"}, when=now)),
        ]
    )
    # The old database really holds them, roll-up included.
    assert stored(
        upland_db, "SELECT COUNT(*) FROM actions WHERE contract = ?", FOREIGN_CONTRACT
    ) == [(3,)]
    assert stored(
        upland_db, "SELECT total_sales FROM properties WHERE property_id = ?", FOREIGN_PROPERTY
    ) == [(1,)]

    after = {path: (r.status_code, r.text) for path in READS for r in [http.get(path)]}
    assert after == before
    assert run(scraper.count_actions()) == 7


def test_an_old_roll_up_another_contract_sold_into_is_withheld(
    seeded: None, upland_db: Path
) -> None:
    """A database from before may have rolled another contract's `n5` into a real property's
    counters. They are no longer Upland's alone, so every properties read leaves the property out
    rather than report the foreign sale; its own actions still list."""
    legacy_store([foreign_sale(20, prop=PROPERTY, when=datetime.now(UTC))])
    assert stored(
        upland_db, "SELECT total_sales FROM properties WHERE property_id = ?", PROPERTY
    ) == [(3,)]

    with pytest.raises(ApiError) as excinfo:
        run(analytics.get_property(PROPERTY))
    assert excinfo.value.status_code == 404
    for listing in (
        run(analytics.top_properties(10, "sales")),
        run(analytics.top_properties(10, "price")),
        run(analytics.list_properties()),
    ):
        assert [p.propertyId for p in listing.items] == [OTHER_PROPERTY]
    assert run(analytics.list_properties()).total == 1
    assert run(analytics.stats_overview()).totalProperties == 1
    assert run(analytics.health()).properties == 1
    assert run(analytics.list_actions(property_id=PROPERTY)).total == 4


def statement_plans(
    upland_db: Path, monkeypatch: pytest.MonkeyPatch, read: Callable[[], Any]
) -> list[str]:
    """The plan steps over `actions` of every SELECT that `read` runs."""
    statements: list[tuple[str, Any]] = []
    execute = aiosqlite.Connection.execute

    async def spy(self: aiosqlite.Connection, sql: str, parameters: Any = None) -> Any:
        statements.append((sql, parameters))
        return await execute(self, sql, parameters)

    monkeypatch.setattr(aiosqlite.Connection, "execute", spy)
    run(read())
    with closing(sqlite3.connect(upland_db)) as db:
        return [
            step
            for sql, params in statements
            if sql.startswith("SELECT") and "FROM actions" in sql
            for *_, step in db.execute(f"EXPLAIN QUERY PLAN {sql}", params or ()).fetchall()
            if step.startswith(("SCAN actions", "SEARCH actions"))
        ]


@pytest.mark.parametrize(
    "read",
    [
        pytest.param(analytics.stats_overview, id="overview"),
        pytest.param(analytics.action_distribution, id="action_distribution"),
        pytest.param(analytics.active_accounts, id="active_accounts"),
        pytest.param(analytics.list_actions, id="actions"),
        pytest.param(lambda: analytics.list_actions(category="trade"), id="actions-category"),
        pytest.param(analytics.recent_sales, id="sales"),
        pytest.param(analytics.sales_volume, id="sales_volume"),
        pytest.param(analytics.price_distribution, id="price_distribution"),
        pytest.param(lambda: analytics.time_series("day", "trade"), id="time_series"),
        pytest.param(analytics.top_properties, id="top_properties"),
    ],
)
def test_scoped_reads_check_the_contract_in_an_index(
    read: Callable[[], Any], upland_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`contract = ?` must not send a read back to the table for every row it scans: each index
    these reads go through carries `contract` (db.py; active_accounts at 2M actions: 0.2s
    covered, 2.8s not)."""
    steps = statement_plans(upland_db, monkeypatch, read)
    assert steps and all("contract" in step for step in steps), steps


# --- the GCS sync carries playuplandme's actions only -------------------------------------

DAY_ONE = datetime(2026, 9, 1, 12, tzinfo=UTC)
DAY_TWO = DAY_ONE + timedelta(days=1)


def two_days() -> list[dict[str, Any]]:
    """playuplandme's actions over two fixed UTC days: sales, a listing, a mint and a yield."""
    return [
        n5(1, "1000.00", when=DAY_ONE),
        n5(2, "3000.00", when=DAY_ONE + timedelta(hours=1), actor="bob"),
        raw_action(3, "n2", data={"a45": PROPERTY, "p24": "9000.00 UPX"}, when=DAY_ONE),
        n5(4, "20000.00", prop=OTHER_PROPERTY, when=DAY_TWO),
        raw_action(5, "a4", data={"a45": OTHER_PROPERTY, "p24": "10.00 UPX"}, when=DAY_TWO),
        raw_action(6, "n31", data={"from": "upxtokenacct", "to": "alice"}, when=DAY_TWO),
    ]


def bucket_files(root: Path) -> dict[str, str]:
    """Every blob a LocalStore at `root` holds, by `<bucket>/<name>`; the checkpoint without
    the clock it carries."""
    files = {
        path.relative_to(root).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }
    checkpoint = f"{storage.checkpoint_bucket()}/{storage.CHECKPOINT_BLOB}"
    if checkpoint in files:
        files[checkpoint] = json.dumps({"days": json.loads(files[checkpoint])["days"]})
    return files


def unscoped_sync(upland_db: Path) -> dict[str, str]:
    """The blobs the GCS sync uploaded before it was scoped, from its queries of the time,
    verbatim (the properties payload is JSONL: pyarrow is not a dependency)."""
    raw, processed = storage.raw_bucket(), storage.processed_bucket()
    marks = ",".join("?" for _ in SALE_ACTIONS)
    blobs: dict[str, str] = {}
    days = stored(
        upland_db,
        "SELECT DATE(timestamp) AS day, COUNT(*) AS c FROM actions GROUP BY day ORDER BY day",
    )
    for day, _ in days:
        lines = stored(
            upland_db,
            "SELECT raw_json FROM actions WHERE DATE(timestamp) = ? ORDER BY global_sequence",
            day,
        )
        blobs[f"{raw}/{storage._day_blob(day)}"] = "".join(f"{line}\n" for (line,) in lines)
        by_category = dict(
            stored(
                upland_db,
                "SELECT category, COUNT(*) AS c FROM actions WHERE DATE(timestamp) = ? "
                "GROUP BY category",
                day,
            )
        )
        [(count, volume)] = stored(
            upland_db,
            f"SELECT COUNT(*) AS c, COALESCE(SUM(price_upx), 0) AS v FROM actions "
            f"WHERE DATE(timestamp) = ? AND action_name IN ({marks}) AND price_upx IS NOT NULL",
            day,
            *SALE_ACTIONS,
        )
        stats = {
            "date": day,
            "totalActions": sum(by_category.values()),
            "byCategory": by_category,
            "salesCount": count,
            "salesVolumeUpx": volume,
        }
        blobs[f"{processed}/daily_stats/{day}.json"] = json.dumps(stats)
    columns = storage.PROPERTY_COLUMNS
    rows = stored(upland_db, f"SELECT {', '.join(columns)} FROM properties")
    blobs[f"{processed}/properties/properties.jsonl"] = "".join(
        json.dumps(dict(zip(columns, row, strict=True))) + "\n" for row in rows
    )
    checkpoint = f"{storage.checkpoint_bucket()}/{storage.CHECKPOINT_BLOB}"
    blobs[checkpoint] = json.dumps({"days": dict(days)})
    return blobs


def test_a_clean_database_syncs_byte_for_byte_as_before(upland_db: Path, tmp_path: Path) -> None:
    """With no other contract's rows the scoping filters nothing: every blob is the one the
    unscoped sync uploaded."""
    run(store_and_update([process_action(action) for action in two_days()]))

    result = run(storage.sync_to_store(storage.LocalStore(tmp_path / "gcs")))

    assert result.synced and result.errors == []
    assert bucket_files(tmp_path / "gcs") == unscoped_sync(upland_db)


def test_the_gcs_sync_leaves_out_other_contracts_rows(tmp_path: Path) -> None:
    """A database from before holds another contract's `n5`, rolled up: no blob carries it."""
    real = two_days()
    legacy_store([*real, foreign_sale(7, when=DAY_ONE)])
    store = storage.LocalStore(tmp_path / "gcs")

    run(storage.sync_to_store(store))

    day_one = [action for action in real if action["timestamp"].startswith("2026-09-01")]
    raw_day = store.read_text(storage.raw_bucket(), "actions/2026/09/01/actions.jsonl")
    assert raw_day == "".join(json.dumps(action) + "\n" for action in day_one)
    stats = store.read_text(storage.processed_bucket(), "daily_stats/2026-09-01.json")
    assert json.loads(stats or "") == {
        "date": "2026-09-01",
        "totalActions": 3,
        "byCategory": {"trade": 3},
        "salesCount": 2,
        "salesVolumeUpx": 4000.0,
    }
    payload = store.read_text(storage.processed_bucket(), "properties/properties.jsonl") or ""
    assert [json.loads(line)["property_id"] for line in payload.splitlines()] == [
        PROPERTY,
        OTHER_PROPERTY,
    ]


def test_a_day_synced_with_other_contracts_rows_is_uploaded_once_more_clean(
    upland_db: Path, tmp_path: Path
) -> None:
    """Unscoped, the sync uploaded day one with the foreign `n5` in it and checkpointed its 4
    rows. Scoped, day one counts 3: it is uploaded once more, clean, and then left alone. Day
    two never held a foreign row, so it is not uploaded again at all."""
    legacy_store([*two_days(), foreign_sale(7, when=DAY_ONE)])
    store = storage.LocalStore(tmp_path / "gcs")
    for blob, text in unscoped_sync(upland_db).items():  # what the bucket holds from before
        store.upload_text(*blob.split("/", 1), text)
    day_one = "actions/2026/09/01/actions.jsonl"
    assert FOREIGN_CONTRACT in (store.read_text(storage.raw_bucket(), day_one) or "")

    first = run(storage.sync_to_store(store)).uploadedFiles
    second = run(storage.sync_to_store(store)).uploadedFiles

    assert [blob for blob in first if "/properties/" not in blob] == [
        f"{storage.raw_bucket()}/{day_one}",
        f"{storage.processed_bucket()}/daily_stats/2026-09-01.json",
        f"{storage.checkpoint_bucket()}/{storage.CHECKPOINT_BLOB}",
    ]
    assert [blob for blob in second if "/actions/" in blob or "/daily_stats/" in blob] == []
    files = bucket_files(tmp_path / "gcs")
    for foreign in (FOREIGN_CONTRACT, FOREIGN_PROPERTY):  # the raw day, and the payload's row
        assert not [blob for blob, text in files.items() if foreign in text]
    assert json.loads(files[f"{storage.checkpoint_bucket()}/{storage.CHECKPOINT_BLOB}"]) == {
        "days": {"2026-09-01": 3, "2026-09-02": 3}
    }


# --- the export's own gate: csv_export ---------------------------------------------------

FLAG_DISABLED = {"error": "flag_disabled"}


@pytest.mark.parametrize("path", ["/api/upland/export", "/api/upland/export?type=sales"])
def test_export_gates_404_then_401_then_403(
    client: TestClient,
    user_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    def call(headers: dict[str, str] | None = None) -> tuple[int, Any]:
        response = client.get(path, headers=headers)
        return response.status_code, response.json()

    set_flags(monkeypatch, upland_data=False, github_signin=True, csv_export=False)
    assert call() == (404, {"error": "upland-disabled"})
    assert call(user_headers) == (404, {"error": "upland-disabled"})
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=False)
    assert call() == (401, {"error": "unauthenticated"})
    assert call(user_headers) == (403, FLAG_DISABLED)
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=True)
    response = client.get(path, headers=user_headers)
    assert response.status_code == 200
    assert csv_rows(response.text) == [analytics.EXPORT_HEADER]


def test_the_export_403_carries_no_bearer_challenge(
    client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=False)
    response = client.get("/api/upland/export", headers=user_headers)
    assert response.status_code == 403
    assert "www-authenticate" not in response.headers


def test_the_export_type_is_not_validated_before_the_gates(
    client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=False)
    assert client.get("/api/upland/export?type=bogus").status_code == 401
    assert client.get("/api/upland/export?type=bogus", headers=user_headers).json() == FLAG_DISABLED
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=True)
    assert client.get("/api/upland/export?type=bogus", headers=user_headers).status_code == 422


def test_csv_export_off_closes_the_export_alone(
    http: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_flags(monkeypatch, upland_data=True, github_signin=True, csv_export=False)
    assert http.get("/api/upland/health").status_code == 200
    assert http.get("/api/upland/actions").status_code == 200
    assert http.get("/api/upland/codes").status_code == 200
    assert http.get("/api/upland/export").json() == FLAG_DISABLED


class FakeHyperion:
    """Stands in for HyperionClient: chain head plus a capped action count."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    async def get_info(self) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("upstream down")
        return {
            "head_block_num": 5_000_000,
            "head_block_time": "2026-09-19T00:00:00",
            "chain_id": "cid",
        }

    async def estimate_action_count(self, **kwargs: Any) -> dict[str, Any]:
        start, end = kwargs["block_num_range"]
        assert end - start == 7 * 172_800
        return {"total": 10_000, "relation": "gte"}


def test_chain_info_and_estimate_use_the_injected_client(http: TestClient) -> None:
    app.dependency_overrides[get_hyperion] = lambda: FakeHyperion()
    info = http.get("/api/upland/chain/info").json()
    assert info == {
        "headBlockNum": 5_000_000,
        "headBlockTime": "2026-09-19T00:00:00",
        "chainId": "cid",
        "blocksPerDay": 172_800,
    }
    estimate = http.get("/api/upland/estimate?days=7").json()
    assert estimate["estimatedActions"] == 10_000 and estimate["relation"] == "gte"
    assert estimate["endBlock"] == 5_000_000


def test_chain_unavailable_is_a_502(http: TestClient) -> None:
    app.dependency_overrides[get_hyperion] = lambda: FakeHyperion(fail=True)
    response = http.get("/api/upland/chain/info")
    assert response.status_code == 502
    assert response.json()["error"] == "upland-chain-unavailable"


# --- scrape control (Hyperion never touched) -------------------------------------------------


def test_scrape_start_validation_and_status(admin_http: TestClient) -> None:
    manager = ScrapeManager()
    app.dependency_overrides[get_scrape_manager] = lambda: manager
    assert admin_http.get("/api/upland/scrape/status").json()["phase"] == "idle"
    assert admin_http.post("/api/upland/scrape", json={}).status_code == 400
    bad_range = admin_http.post("/api/upland/scrape", json={"startBlock": 10, "endBlock": 5})
    assert bad_range.status_code == 400
    assert admin_http.post("/api/upland/scrape/cancel").json()["running"] is False


def test_scrape_runs_days_job_with_mocked_scraper(
    http: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from forge_api.services.upland import scraper

    async def fake_timeframe(days: int, on_progress: Any = None) -> dict[str, int]:
        return {"stored": days}

    monkeypatch.setattr(scraper, "scrape_timeframe", fake_timeframe)
    manager = ScrapeManager()
    app.dependency_overrides[get_scrape_manager] = lambda: manager

    async def start_and_wait() -> ScrapeStatus:
        await manager.start(ScrapeRequest(days=3))
        assert manager._task is not None
        await manager._task
        return manager.status

    status = run(start_and_wait())
    assert status.phase == "complete" and status.running is False
    assert status.lastResult == {"stored": 3}
