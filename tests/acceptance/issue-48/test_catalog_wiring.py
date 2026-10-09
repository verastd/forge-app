"""Acceptance tests for issue #48: catch, throw and wave registered in the behaviour catalog.

Criterion 1 is true of the catalog as shipped with ADR-009 and runs now, so it also
guards against regression. Criteria 2 and 3 need the feeds wired and the e2e spec, so
they are skipped until `tests/e2e/lobby-behaviors.spec.ts` exists (the implementation
has to create it). The behaviours' TypeScript is read as text here: pytest is the runner
the Gauntlet executes for this directory, and the package's own vitest suite covers the
logic.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _shared import ROOT, exists, read, skip_until  # noqa: E402

ISSUE = 48
E2E = "tests/e2e/lobby-behaviors.spec.ts"
CATALOG = "packages/lobby/src/behaviors/catalog.ts"
ACTIONS = "packages/lobby/src/actions.ts"
FEEDS = (
    "apps/web/src/components/lobby/presence/livekitFeed.ts",
    "apps/web/src/components/lobby/presence/localFeed.ts",
)
ACTION_KINDS = {"wave", "ball", "throw", "catch"}

implemented = skip_until(ISSUE, E2E)


def catalog_entries() -> list[str]:
    """The source of each entry in BEHAVIORS, split on `id:` lines."""
    source = read(CATALOG)
    body = source[source.index("export const BEHAVIORS") :]
    body = body[: body.index("]);")]
    parts = re.split(r"\n\s*\{\s*\n\s*id:", body)
    return ["id:" + part for part in parts[1:]]


def test_every_action_kind_the_lobby_sends_is_an_intent_of_exactly_one_entry() -> None:
    kinds = set(re.findall(r"kind: '([a-z]+)'", read(ACTIONS)))
    assert kinds >= ACTION_KINDS
    owners: dict[str, int] = {}
    for entry in catalog_entries():
        intents = re.search(r"intents: \[([^\]]*)\]", entry)
        assert intents is not None, entry
        for intent in re.findall(r"'([a-z-]+)'", intents.group(1)):
            owners[intent] = owners.get(intent, 0) + 1
    assert set(owners) == ACTION_KINDS, owners
    assert all(count == 1 for count in owners.values()), owners


def test_every_entry_names_the_lobby_flag_and_the_wires_own_rate() -> None:
    for entry in catalog_entries():
        assert "flag: 'apps_lobby'" in entry, entry[:80]
        assert "intentsPerSecond: MAX_ACTIONS_PER_SECOND" in entry, entry[:80]


def test_the_catalog_is_validated_by_its_own_suite() -> None:
    test = read("packages/lobby/src/behaviors/catalog.test.ts")
    assert "validateBehaviors(BEHAVIORS)" in test


@implemented
def test_both_feeds_consult_the_catalog_and_meter_inbound_actions() -> None:
    for feed in FEEDS:
        source = read(feed)
        assert re.search(r"behaviorForIntent|BEHAVIORS", source), feed
        assert "createBehaviorMeter" in source, feed
        assert "acceptIntent" in source, feed


@implemented
def test_the_meter_path_has_a_unit_test_in_the_lobby_package() -> None:
    tests = list((ROOT / "packages/lobby/src").rglob("*.test.ts"))
    assert any("acceptIntent" in test.read_text(encoding="utf-8") for test in tests)


@implemented
def test_the_e2e_spec_floods_a_sender_in_the_practice_build() -> None:
    assert exists(E2E)
    spec = read(E2E)
    assert "test(" in spec or "test.describe(" in spec
    assert re.search(r"flood|sixteen|16", spec), "the spec should send more than the rate allows"
