"""Feature-flag resolution (PRD Appendix H.2 — the deploy-safety linchpin).

Every flag defaults OFF (see `DEFAULT_FLAGS`): this module is a deploy-safety
kill switch, not a convenience toggle, and an unconfigured or misconfigured
deploy must never silently come up "enabled" (an independent assessment found
the prior all-true defaults let flags fail open). `config/flags.json` is
checked into the repo and stays all-true; that file — not this module's
defaults — is what keeps local/demo behavior enabled.

Layers, lowest precedence first (each is optional; later layers merge over
earlier ones, stating only what they change):

1. built-in defaults (`DEFAULT_FLAGS`, all False)
2. ``config/flags.json`` — found by walking up from this file to the repo root
3. ``FORGE_FLAGS_PATH``  — path to a JSON file
4. ``FORGE_FLAGS_JSON``  — a JSON object as an env var (staging/CI overrides)

Every layer is attempted, in that order, regardless of whether an earlier one
was present (mirrors packages/flags/src/index.ts::loadFlags, kept in lockstep
on purpose). Resolution never raises. A source that is simply ABSENT (no file
at the walked-up location, an unset env var) is skipped. A source that is
PRESENT but INVALID — unparseable JSON, an unreadable/missing explicit path, a
top-level value that isn't a JSON object, or a known flag key holding a
non-boolean value — fails the *entire* resolution closed: every flag comes
back False immediately, with no fall-through to later layers and no partial
salvage of the keys that did parse, and the reason is logged once. A flag
lookup silently defaulting to "on" because of a typo is the one outcome this
module exists to prevent. Unknown keys in an otherwise-valid object are
ignored (forward compat).
"""

import json
import logging
import os
from pathlib import Path
from typing import Any

from forge_api.models import FlagConfig

ENV_JSON = "FORGE_FLAGS_JSON"
ENV_PATH = "FORGE_FLAGS_PATH"
CONFIG_RELATIVE_PATH = Path("config") / "flags.json"

#: Every flag OFF — see the module docstring for why.
DEFAULT_FLAGS: dict[str, bool] = {
    "csv_export": False,
    "contribute_bridge": False,
    "upland_data": False,
}

logger = logging.getLogger(__name__)


class _FailClosed(Exception):
    """Internal signal only: a flag source was present but invalid. Always
    caught inside `get_flags`; never escapes this module."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _coerce(raw: object, *, source: str) -> dict[str, bool]:
    """Extract known boolean flags out of one already-JSON-parsed layer.

    Raises `_FailClosed` if `raw` isn't a JSON object, or if a *known* flag
    key holds a non-boolean value — never silently drops a bad key while
    keeping the rest. Unknown keys are ignored. Missing known keys are fine:
    the caller merges the result as a partial layer.
    """
    if not isinstance(raw, dict):
        raise _FailClosed(f"{source}: top-level value is not a JSON object")
    parsed: dict[str, bool] = {}
    for key, value in raw.items():
        if key not in DEFAULT_FLAGS:
            continue  # unknown flag name — forward compat, not an error
        if not isinstance(value, bool):
            raise _FailClosed(f'{source}: flag "{key}" is not a boolean')
        parsed[key] = value
    return parsed


def _read_file(path: Path, *, source: str) -> dict[str, bool]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise _FailClosed(f"{source}: could not be read ({path}): {exc}") from exc
    try:
        loaded: Any = json.loads(text)
    except (ValueError, TypeError) as exc:
        raise _FailClosed(f"{source}: is not valid JSON ({path}): {exc}") from exc
    return _coerce(loaded, source=source)


def _from_env_json() -> dict[str, bool] | None:
    raw = os.environ.get(ENV_JSON)
    if not raw:
        return None
    try:
        loaded: Any = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise _FailClosed(f"{ENV_JSON}: is not valid JSON: {exc}") from exc
    return _coerce(loaded, source=ENV_JSON)


def _from_env_path() -> dict[str, bool] | None:
    raw = os.environ.get(ENV_PATH)
    if not raw:
        return None
    return _read_file(Path(raw), source=ENV_PATH)


def find_config_file(start: Path | None = None) -> Path | None:
    """Walk up from this module toward the repo root looking for config/flags.json."""
    here = (start or Path(__file__)).resolve()
    for parent in here.parents:
        candidate = parent / CONFIG_RELATIVE_PATH
        if candidate.is_file():
            return candidate
    return None


def _from_repo_config() -> dict[str, bool] | None:
    found = find_config_file()
    if found is None:
        return None
    return _read_file(found, source="config/flags.json")


def get_flags() -> FlagConfig:
    """Resolve flags fresh on every call — env changes take effect without a restart."""
    resolved = dict(DEFAULT_FLAGS)
    for source in (_from_repo_config, _from_env_path, _from_env_json):
        try:
            layer = source()
        except _FailClosed as exc:
            logger.warning("flag resolution failing closed (all flags disabled): %s", exc.reason)
            return FlagConfig(**DEFAULT_FLAGS)
        if layer is not None:
            resolved.update(layer)
    return FlagConfig(**resolved)


def is_enabled(flag: str) -> bool:
    """True when `flag` is on. Unknown flag names are off."""
    return bool(getattr(get_flags(), flag, False))
