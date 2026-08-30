"""Acceptance tests for issue #1 — CSV export of activity history.

Executable form of the acceptance criteria in this directory's README. Runs from
`cd apps/api && uv run pytest` (the root Makefile `test` target), which puts the
installed `forge_api` package on the path.
"""

import csv
import io
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app

EXPECTED_HEADER = "ts,type,amount"
EXPECTED_ROWS = 10_000
MAX_SECONDS = 3.0
VALID_TYPES = {"earn", "spend", "transfer"}


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(scope="module")
def export(client: TestClient) -> tuple[int, str, str, float]:
    """One export request, timed. Shared by every criterion below."""
    started = time.perf_counter()
    response = client.get("/api/export")
    body = response.text  # forces the whole stream to be consumed
    elapsed = time.perf_counter() - started
    return response.status_code, response.headers.get("content-type", ""), body, elapsed


def test_export_returns_csv(export: tuple[int, str, str, float]) -> None:
    status_code, content_type, _, _ = export
    assert status_code == 200
    assert content_type.startswith("text/csv")


def test_export_is_an_attachment_named_history_csv(client: TestClient) -> None:
    response = client.get("/api/export")
    assert response.headers["content-disposition"] == 'attachment; filename="history.csv"'


def test_headers(export: tuple[int, str, str, float]) -> None:
    _, _, body, _ = export
    assert body.splitlines()[0] == EXPECTED_HEADER


def test_export_contains_every_history_row(export: tuple[int, str, str, float]) -> None:
    _, _, body, _ = export
    rows = list(csv.reader(io.StringIO(body)))
    assert rows[0] == EXPECTED_HEADER.split(",")
    assert len(rows) - 1 == EXPECTED_ROWS


def test_export_completes_in_under_three_seconds(export: tuple[int, str, str, float]) -> None:
    _, _, _, elapsed = export
    assert elapsed < MAX_SECONDS, f"export took {elapsed:.2f}s (budget {MAX_SECONDS}s)"


def test_every_row_is_well_formed(export: tuple[int, str, str, float]) -> None:
    _, _, body, _ = export
    reader = csv.DictReader(io.StringIO(body))
    count = 0
    for row in reader:
        datetime.fromisoformat(row["ts"])  # raises if not ISO 8601
        assert row["type"] in VALID_TYPES
        float(row["amount"])  # raises if not a number
        count += 1
    assert count == EXPECTED_ROWS
