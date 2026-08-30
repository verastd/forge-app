"""The history feed must be identical on every process start — the Gauntlet depends on it."""

from datetime import datetime

from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services import history as history_service


def test_history_defaults_to_50_rows_of_10000(client: TestClient) -> None:
    payload = client.get("/api/history").json()
    assert payload["total"] == 10_000
    assert len(payload["items"]) == 50


def test_history_is_deterministic_across_clients(client: TestClient) -> None:
    first = client.get("/api/history?limit=5").json()["items"]
    with TestClient(app) as other_client:
        second = other_client.get("/api/history?limit=5").json()["items"]
    assert first == second
    # A fresh generator run (no cache) reproduces the same rows from the seed.
    regenerated = history_service._build_rows()[:5]
    assert [item.model_dump(exclude_none=True) for item in regenerated] == first


def test_history_pagination_window_is_a_slice_of_the_same_list(client: TestClient) -> None:
    page = client.get("/api/history?limit=10&offset=20").json()["items"]
    reference = client.get("/api/history?limit=30&offset=0").json()["items"]
    assert page == reference[20:30]
    assert len({item["id"] for item in reference}) == 30


def test_history_limit_is_capped_at_500(client: TestClient) -> None:
    payload = client.get("/api/history?limit=100000").json()
    assert len(payload["items"]) == history_service.MAX_LIMIT


def test_history_rejects_negative_offset(client: TestClient) -> None:
    assert client.get("/api/history?offset=-1").status_code == 422


def test_history_rows_are_plausible_and_descending(client: TestClient) -> None:
    items = client.get("/api/history?limit=500").json()["items"]
    stamps = [datetime.fromisoformat(item["ts"]) for item in items]
    assert stamps == sorted(stamps, reverse=True)
    assert all(item["type"] in {"earn", "spend", "transfer"} for item in items)
    assert all(0.01 <= item["amount"] <= 500.0 for item in items)
    assert any(item.get("memo") for item in items)
    # zod types memo as .optional(): rows without one omit the key entirely.
    assert any("memo" not in item for item in items)
