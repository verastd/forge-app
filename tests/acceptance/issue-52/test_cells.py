"""Acceptance tests for issue #52: object state per cell, on data tracks, by distance.

Skipped until `tests/e2e/lobby-cells.spec.ts` exists. The hundred-member measurement is
the private suite's job; here the world has to publish per cell on tracks named for the
cell, the feed has to subscribe by `neighbours` with voice's hysteresis, the debug view has
to report the cells, and the baselines document has to carry the new number.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _shared import ROOT, read, skip_until  # noqa: E402

ISSUE = 52
E2E = "tests/e2e/lobby-cells.spec.ts"
FEED = "apps/web/src/components/lobby/presence/livekitFeed.ts"
BASELINES = "docs/lobby-baselines.md"

pytestmark = skip_until(ISSUE, E2E, "apps/world/package.json")


def world_sources() -> str:
    files = sorted((ROOT / "apps/world/src").rglob("*.ts"))
    return "\n".join(file.read_text(encoding="utf-8") for file in files)


def test_the_world_publishes_object_state_per_cell_on_named_tracks() -> None:
    source = world_sources()
    assert "cellOf" in source
    assert re.search(r"obj:\$\{|['\"]obj:", source), "tracks named obj:<cell>"
    assert re.search(r"1200", source), "frames kept under 1200 bytes"


def test_the_feed_subscribes_to_the_members_cell_and_its_neighbours_with_hysteresis() -> None:
    feed = read(FEED)
    assert "neighbours(" in feed
    assert "cellOf" in feed
    assert re.search(r"dwellMs|dwell", feed)
    assert re.search(r"\b500\b|2 Hz", feed), "re-evaluated at 2 Hz"
    assert re.search(r"__forgePresence[\s\S]*cells", feed), "the debug view reports the cells"


def test_the_e2e_spec_checks_the_subscription_set_for_a_scripted_walk() -> None:
    spec = read(E2E)
    assert "neighbours" in spec or "cells" in spec


def test_the_baselines_record_the_drop_against_broadcast() -> None:
    baselines = read(BASELINES)
    assert re.search(r"cell|data track", baselines, re.I)
    assert re.search(r"\b100\b", baselines)
