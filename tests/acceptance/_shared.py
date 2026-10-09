"""Helpers every acceptance directory under tests/acceptance/ may import.

Acceptance tests run from `cd apps/api && uv run pytest` (pyproject's testpaths), so
the repository root is two levels up from this file (tests/acceptance/_shared.py). Feature tasks' tests are skipped
until the artefact their implementation must create exists (`skip_until`): `main` stays
green while a task is open, and the pull request that creates the artefact is the one
whose Gauntlet run executes them. A pull request that leaves its own task's acceptance
tests skipped has not met the spec.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def exists(path: str) -> bool:
    return (ROOT / path).exists()


def skip_until(issue: int, *artefacts: str) -> pytest.MarkDecorator:
    """Skip while any of `artefacts` (repository-relative paths the implementation has to
    create) is missing. Apply as `pytestmark` or per test."""
    missing = [a for a in artefacts if not exists(a)]
    return pytest.mark.skipif(
        bool(missing),
        reason=f"issue #{issue} not implemented yet: {', '.join(missing)} missing",
    )


def flags_json() -> dict[str, object]:
    data: dict[str, object] = json.loads(read("config/flags.json"))
    return data


def flag_registered_everywhere(flag: str) -> dict[str, bool]:
    """Where a flag is registered, the way `lobby_avatars` is: the checked-in config, the
    browser-safe defaults, the zod schema and name list, the API's defaults, and the API's
    flag tests. `models.py` is checked separately by the task that owns it."""
    quoted = re.compile(rf"['\"]{re.escape(flag)}['\"]")
    bare = re.compile(rf"\b{re.escape(flag)}\b")
    return {
        "config/flags.json": flag in flags_json(),
        "packages/flags/src/core.ts": bool(bare.search(read("packages/flags/src/core.ts"))),
        "packages/shared/src/index.ts (FLAG_NAMES)": bool(
            quoted.search(read("packages/shared/src/index.ts"))
        ),
        "packages/shared/src/index.ts (schema)": bool(
            re.search(rf"\b{re.escape(flag)}: z\.boolean\(\)", read("packages/shared/src/index.ts"))
        ),
        "apps/api/src/forge_api/services/flags.py": bool(
            quoted.search(read("apps/api/src/forge_api/services/flags.py"))
        ),
        "apps/api/tests/test_flags.py": bool(quoted.search(read("apps/api/tests/test_flags.py"))),
    }
