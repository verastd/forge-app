"""Upland data app: action processing, models, flag gating, analytics and the HTTP surface.

No network: the database is a temp SQLite file (`UPLAND_DB_PATH`) and Hyperion is a fake
injected through the router's `get_hyperion` dependency.
"""

import asyncio
import json
from collections.abc import Coroutine, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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
from forge_api.services.upland import analytics
from forge_api.services.upland.scraper import (
    ScrapeManager,
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


@pytest.fixture(autouse=True)
def upland_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    path = tmp_path / "upland.db"
    monkeypatch.setenv("UPLAND_DB_PATH", str(path))
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"upland_data": True}))
    return path


@pytest.fixture
def http() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
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
    async def collect(kind: analytics.ExportType) -> list[str]:
        return [chunk async for chunk in analytics.iter_export_csv(kind)]

    everything = run(collect("actions"))
    assert everything[0].strip().split(",") == analytics.EXPORT_HEADER
    assert len(everything) == 8
    assert len(run(collect("sales"))) == 1 + 4 + 1  # header + n5 x3 + n111 + a4


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


def test_scrape_start_validation_and_status(http: TestClient) -> None:
    manager = ScrapeManager()
    app.dependency_overrides[get_scrape_manager] = lambda: manager
    assert http.get("/api/upland/scrape/status").json()["phase"] == "idle"
    assert http.post("/api/upland/scrape", json={}).status_code == 400
    bad_range = http.post("/api/upland/scrape", json={"startBlock": 10, "endBlock": 5})
    assert bad_range.status_code == 400
    assert http.post("/api/upland/scrape/cancel").json()["running"] is False


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
