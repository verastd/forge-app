"""Acceptance tests for issue #50: the swarm of scripted members and the first baselines.

Skipped until `tools/lobby-swarm/swarm.mjs` exists. A real LiveKit room is the private
suite's job; here the tool has to start and stop cleanly with no members, the measuring
script has to name the numbers it reports, the baselines have to be recorded at the four
sizes, and the debug view has to be development-only.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _shared import ROOT, exists, read, skip_until  # noqa: E402

ISSUE = 50
SWARM = "tools/lobby-swarm/swarm.mjs"
MEASURE = "tools/lobby-swarm/measure.mjs"
BASELINES = "docs/lobby-baselines.md"
FEED = "apps/web/src/components/lobby/presence/livekitFeed.ts"

pytestmark = skip_until(ISSUE, SWARM)


def test_the_swarm_with_no_members_exits_cleanly() -> None:
    done = subprocess.run(
        ["node", SWARM, "--members", "0", "--room", "acceptance", "--minutes", "0"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr


def test_the_swarm_sends_what_a_browser_sends() -> None:
    source = read(SWARM)
    for name in ("encodePosition", "encodeAction", "sendPolicy", "CAMERA_LIMITS"):
        assert name in source, name
    assert "livekit-server-sdk" in source


def test_the_measuring_script_names_its_numbers() -> None:
    assert exists(MEASURE)
    source = read(MEASURE)
    for name in ("p50", "p95", "dropped", "heap", "subscri"):
        assert re.search(name, source, re.I), name
    assert "__forgePresence" in source


def test_the_debug_view_is_development_only() -> None:
    feed = read(FEED)
    assert "__forgePresence" in feed
    assert re.search(r"NODE_ENV|process\.env|import\.meta\.env", feed)


def test_the_baselines_are_recorded_at_the_four_sizes_and_linked_from_the_adr() -> None:
    assert exists(BASELINES)
    baselines = read(BASELINES)
    for size in ("25", "50", "100", "150"):
        assert re.search(rf"\b{size}\b", baselines), size
    assert "swarm.mjs" in baselines
    assert "lobby-baselines.md" in read("docs/adr/ADR-009-shared-behaviours.md")
