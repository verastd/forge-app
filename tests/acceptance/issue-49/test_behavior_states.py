"""Acceptance tests for issue #49: every behaviour's declared states, on screen.

Skipped until `tests/e2e/lobby-behavior-states.spec.ts` exists, which the implementation
has to create; from then on they run on every Gauntlet pass. The Playwright spec itself is
the behavioural proof (three flows read through `data-behavior-state`); these tests hold
the structural criteria: the copy comes from the catalog and nowhere else, the attribute
is written, the live region announces a rejection.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _shared import read, skip_until  # noqa: E402

ISSUE = 49
E2E = "tests/e2e/lobby-behavior-states.spec.ts"
CONTROLS = "apps/web/src/components/lobby/PlayControls.tsx"
LOBBY = "apps/web/src/components/lobby/Lobby.tsx"
PANEL = "apps/web/src/components/lobby/VoicePanel.tsx"
CATALOG = "packages/lobby/src/behaviors/catalog.ts"

pytestmark = skip_until(ISSUE, E2E)


def catalog_copy() -> set[str]:
    return set(re.findall(r"^\s+(?:requested|confirmed|contested|rejected|outOfRange|paused): ['\"](.+)['\"],?$", read(CATALOG), re.M))


def test_the_controls_take_their_state_copy_from_the_catalog() -> None:
    controls = read(CONTROLS)
    assert re.search(r"from '@forge/lobby'", controls)
    assert re.search(r"\b(BEHAVIORS|behaviorById|behaviorForIntent)\b", controls)
    assert re.search(r"\.states\b", controls)
    hard_coded = [copy for copy in catalog_copy() if copy in controls]
    assert hard_coded == [], f"state copy hard-coded in PlayControls: {hard_coded}"


def test_a_requested_state_shows_progress_and_confirms_within_the_catalogs_window() -> None:
    controls = read(CONTROLS)
    assert "confirmWithinMs" in controls
    assert re.search(r"requested", controls)
    assert re.search(r"spinner|progress|aria-busy", controls, re.I)


def test_the_lobby_root_reports_the_latest_behaviour_state_for_e2e() -> None:
    assert "data-behavior-state" in read(LOBBY)


def test_the_people_panel_announces_a_rejection() -> None:
    panel = read(PANEL)
    assert "aria-live" in panel
    assert re.search(r"rejected", panel)


def test_the_e2e_spec_covers_the_three_flows() -> None:
    spec = read(E2E)
    assert "data-behavior-state" in spec
    for state in ("outOfRange", "requested", "confirmed", "rejected"):
        assert state in spec, state
