"""Acceptance tests for issue #1: the Data app's CSV export.

Executable form of the acceptance criteria in this directory's README. Runs from
`cd apps/api && uv run pytest` (the root Makefile's `test` and `test-coverage` targets,
which is how the Gauntlet runs it), which puts the installed `forge_api` package on
the path.

Everything the export needs is set up here, for this module only: a temp database
seeded with 10,000 deterministic actions, the three flags the route sits behind, and
the API assertion secret. The client signs every call the way the web tier's BFF does.
"""

import asyncio
import csv
import io
import json
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services.identity import mint_assertion
from forge_api.services.upland.scraper import process_action, store_and_update

EXPORT_URL = "/api/upland/export"
EXPECTED_HEADER = [
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
EXPECTED_ROWS = 10_000
MAX_SECONDS = 3.0

#: FORGE_API_ASSERTION_SECRET for this module: 32+ ASCII characters, built at runtime and
#: low-entropy on purpose (a key-shaped literal trips the Gauntlet's secret scan).
ASSERTION_SECRET = "issue-1-acceptance-" + "x" * 32
SUB, LOGIN = "1001", "issue-1-acceptance"

#: The seed. Fixed values only, so every run exports byte-identical rows.
FIRST_SEQUENCE = 900_000_000_000
FIRST_BLOCK = 250_000_000
FIRST_MOMENT = datetime(2026, 9, 1, tzinfo=UTC)
FIRST_PROPERTY = 81_000_000_000_000
#: Coprime with EXPECTED_ROWS, so `n * STRIDE % EXPECTED_ROWS` visits every n exactly once.
STRIDE = 7_919


def seed_action(n: int) -> dict[str, Any]:
    """Raw Hyperion action `n` of the seed: a sale, a listing, a yield or a fee, in turn."""
    player = f"player{n % 97}"
    property_id = str(FIRST_PROPERTY + n % 250)
    name, data = (
        ("n5", {"a45": property_id, "p24": f"{1_000 + n}.00 UPX", "p51": player, "p14": "buyer"}),
        ("n2", {"a45": property_id, "p24": f"{2_000 + n}.50 UPX"}),
        ("n31", {"from": "upxtokenacct", "to": player}),
        ("n41", {"p51": player}),
    )[n % 4]
    return {
        "global_sequence": FIRST_SEQUENCE + n,
        "timestamp": (FIRST_MOMENT + timedelta(seconds=3 * n)).strftime("%Y-%m-%dT%H:%M:%S.000"),
        "block_num": FIRST_BLOCK + 6 * n,
        "trx_id": f"{n:064x}",
        "act": {
            "account": "playuplandme",
            "name": name,
            "authorization": [{"actor": player, "permission": "active"}],
            "data": data,
        },
    }


@dataclass(frozen=True)
class Export:
    status_code: int
    headers: Mapping[str, str]
    body: str
    seconds: float


@pytest.fixture(scope="module")
def signed_in(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    """A signed-in client, and a temp database holding the 10,000-action seed."""
    flags = {"upland_data": True, "csv_export": True, "github_signin": True}
    with pytest.MonkeyPatch.context() as env:
        env.setenv("UPLAND_DB_PATH", str(tmp_path_factory.mktemp("issue-1") / "upland.db"))
        env.delenv("FORGE_FLAGS_PATH", raising=False)
        env.setenv("FORGE_FLAGS_JSON", json.dumps(flags))
        env.setenv("FORGE_API_ASSERTION_SECRET", ASSERTION_SECRET)
        # Stored out of order, so the export has to sort to come out oldest first.
        order = [n * STRIDE % EXPECTED_ROWS for n in range(EXPECTED_ROWS)]
        asyncio.run(store_and_update([process_action(seed_action(n)) for n in order]))
        token = mint_assertion(SUB, LOGIN, secret=ASSERTION_SECRET, ttl=120)
        with TestClient(app, headers={"Authorization": f"Bearer {token}"}) as client:
            yield client


@pytest.fixture(scope="module")
def export(signed_in: TestClient) -> Export:
    """One export request, timed from the request to its last byte. Shared by every test."""
    started = time.perf_counter()
    response = signed_in.get(EXPORT_URL)
    body = response.text  # the whole stream, consumed
    seconds = time.perf_counter() - started
    return Export(response.status_code, response.headers, body, seconds)


def data_rows(export: Export) -> list[list[str]]:
    return list(csv.reader(io.StringIO(export.body)))[1:]


def test_export_is_csv(export: Export) -> None:
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("text/csv")


def test_export_is_an_attachment_named_upland_actions_csv(export: Export) -> None:
    assert export.headers["content-disposition"] == 'attachment; filename="upland-actions.csv"'


def test_headers(export: Export) -> None:
    assert export.body.splitlines()[0] == ",".join(EXPECTED_HEADER)


def test_every_action_is_exported_once_oldest_first(export: Export) -> None:
    sequences = [int(row[0]) for row in data_rows(export)]
    assert len(sequences) == EXPECTED_ROWS
    assert all(earlier < later for earlier, later in pairwise(sequences))
    assert sequences[0] == FIRST_SEQUENCE
    assert sequences[-1] == FIRST_SEQUENCE + EXPECTED_ROWS - 1


def test_every_row_is_well_formed(export: Export) -> None:
    rows = data_rows(export)
    assert len(rows) == EXPECTED_ROWS
    for row in rows:
        assert len(row) == len(EXPECTED_HEADER), row
        datetime.fromisoformat(row[1])  # raises unless the timestamp is ISO 8601
        assert row[2] == str(int(row[2])), row  # block_num is an integer


def test_export_completes_in_under_three_seconds(export: Export) -> None:
    budget = f"export took {export.seconds:.2f}s (budget {MAX_SECONDS}s)"
    assert export.seconds < MAX_SECONDS, budget
