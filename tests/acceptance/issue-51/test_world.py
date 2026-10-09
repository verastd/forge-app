"""Acceptance tests for issue #51: the world participant, owning nothing at first.

Skipped until `apps/world/package.json` exists. The process against a real LiveKit room is
the private suite's job; here it has to be a workspace package with a start script, refuse
to start without its settings in one line, carry the kernel's tick budget, the health route
and the guarded pause route, and the `lobby_world` flag has to be registered everywhere the
task's scope allows (`models.py` is the core team's, in the same window).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _shared import ROOT, exists, flag_registered_everywhere, read, skip_until  # noqa: E402

ISSUE = 51
PACKAGE = "apps/world/package.json"
WORLD_SRC = ROOT / "apps/world/src"

pytestmark = skip_until(ISSUE, PACKAGE)


def world_sources() -> str:
    files = sorted(WORLD_SRC.rglob("*.ts")) + sorted(WORLD_SRC.rglob("*.mts"))
    assert files, "apps/world/src has no TypeScript"
    return "\n".join(file.read_text(encoding="utf-8") for file in files)


def test_it_is_a_workspace_package_with_a_start_script() -> None:
    package = read(PACKAGE)
    assert '"name": "@forge/world"' in package
    assert re.search(r'"start":', package)
    assert "apps/world" in read("pnpm-workspace.yaml")


def test_without_its_settings_it_refuses_to_start_in_one_line() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LIVEKIT_", "LOBBY_", "WORLD_"))}
    env["CI"] = "1"
    done = subprocess.run(
        ["pnpm", "--filter", "@forge/world", "start"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode != 0
    reasons = [line for line in done.stderr.splitlines() if "LIVEKIT" in line or "LOBBY_ROOM" in line]
    assert len(reasons) == 1, done.stderr


def test_it_steps_the_kernel_on_its_own_timer_within_budget() -> None:
    source = world_sources()
    assert "createBehaviorMeter" in source
    assert "recordTick" in source
    assert re.search(r"\b(50|1000\s*/\s*20)\b", source), "a 20 Hz tick"


def test_it_exposes_health_and_a_guarded_pause() -> None:
    source = world_sources()
    assert "/healthz" in source
    assert re.search(r"/behaviors/[^'\"`]*pause", source)
    assert "WORLD_ADMIN_TOKEN" in source
    assert "pauseBehavior" in source


def test_the_flag_is_registered_everywhere_the_scope_allows() -> None:
    where = flag_registered_everywhere("lobby_world")
    assert all(where.values()), {k: v for k, v in where.items() if not v}


def test_the_e2e_spec_shows_one_holder_after_a_contested_catch() -> None:
    spec_path = "tests/e2e/lobby-world.spec.ts"
    assert exists(spec_path)
    spec = read(spec_path)
    assert "lobby_world" in spec
    assert re.search(r"contest|same holder|holder", spec, re.I)
