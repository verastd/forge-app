"""The rail registry (contract §2), held to tests/fixtures/rails-golden.json: the file
packages/shared/src/rails.test.ts reads too, so the two registries cannot drift."""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from forge_api.models import OPEN_RAILS, RAILS, START_RAILS, RailInfo, RailMeta
from forge_api.services import rails

GOLDEN = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "rails-golden.json"

#: Words the copy must not use (contract §2 copy rules). "pull request" is fine.
JARGON = re.compile(r"\b(PRs?|CI|leases?|MCP)\b")


@pytest.fixture(scope="module")
def golden() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(GOLDEN.read_text(encoding="utf-8"))
    return loaded


def _copy(meta: RailMeta) -> list[str]:
    return [meta.label, meta.vendor, meta.blurb, meta.plan or "", *meta.setup]


def test_the_registry_matches_the_golden_exactly(golden: dict[str, Any]) -> None:
    assert set(golden) == {"rails", "routinePrompt"}
    dumped = [meta.model_dump(mode="json", exclude_none=True) for meta in rails.RAIL_REGISTRY]
    assert dumped == golden["rails"]


def test_the_routine_prompt_matches_the_golden(golden: dict[str, Any]) -> None:
    assert rails.ROUTINE_PROMPT == golden["routinePrompt"]


def test_display_order_is_the_start_rails_then_the_open_rails() -> None:
    assert tuple(meta.id for meta in rails.RAIL_REGISTRY) == RAILS == START_RAILS + OPEN_RAILS
    assert START_RAILS == ("copilot", "jules", "cursor", "devin", "openhands", "claude-routine")
    assert OPEN_RAILS == (
        "claude-code",
        "claude-cli",
        "codex",
        "vscode",
        "cursor-app",
        "antigravity",
    )
    assert {meta.id for meta in rails.RAIL_REGISTRY if meta.mode == "start"} == set(START_RAILS)


def test_start_rails_say_which_credential_and_where_the_key_comes_from() -> None:
    credentials = {meta.id: meta.credential for meta in rails.RAIL_REGISTRY}
    expected: dict[str, str | None] = {rail: None for rail in OPEN_RAILS}
    expected.update(
        {
            "copilot": "github",
            "jules": "api_key",
            "cursor": "api_key",
            "devin": "devin",
            "openhands": "api_key",
            "claude-routine": "routine",
        }
    )
    assert credentials == expected
    key_urls = {meta.id: meta.keyUrl for meta in rails.RAIL_REGISTRY if meta.keyUrl}
    # Every start rail but copilot (one-time GitHub authorization, nothing to paste).
    assert set(key_urls) == set(START_RAILS) - {"copilot"}
    assert all(url.startswith("https://") for url in key_urls.values())


def test_every_rail_has_a_blurb_a_plan_and_one_time_steps_starting_with_the_fork() -> None:
    for meta in rails.RAIL_REGISTRY:
        assert meta.setup[0] == "Fork forge-app on GitHub.", meta.id
        assert all(step.endswith(".") and step == step.strip() for step in meta.setup), meta.id
        assert meta.blurb.endswith(".") and ". " not in meta.blurb, meta.id  # one sentence
        assert meta.plan, meta.id


def test_the_copy_has_no_jargon() -> None:
    texts = [text for meta in rails.RAIL_REGISTRY for text in _copy(meta)]
    for text in [*texts, rails.ROUTINE_PROMPT]:
        assert not JARGON.search(text), text


def test_open_rails_that_report_progress_ask_for_the_connector_once() -> None:
    connect = "Connect your agent to FORGE once so it can report progress."
    for meta in rails.RAIL_REGISTRY:
        if meta.mode == "open" and meta.id != "antigravity":
            assert meta.setup[-1] == connect, meta.id
    antigravity = rails.rail_meta("antigravity")
    assert "connector is already set up" in antigravity.setup[-1]


def test_rail_meta_returns_a_copy_of_the_entry() -> None:
    jules = rails.rail_meta("jules")
    assert jules == rails.RAIL_REGISTRY[1]
    jules.setup.append("Changed by a caller.")
    assert rails.rail_meta("jules").setup == rails.RAIL_REGISTRY[1].setup
    assert "Changed by a caller." not in rails.RAIL_REGISTRY[1].setup


def test_rail_meta_refuses_an_unknown_rail() -> None:
    with pytest.raises(KeyError, match="gemini-cli"):
        rails.rail_meta("gemini-cli")


def test_a_rail_info_is_the_registry_entry_plus_enabled() -> None:
    meta = rails.rail_meta("claude-code")
    info = RailInfo(**meta.model_dump(), enabled=True)
    assert info.model_dump(exclude_none=True) == {
        **meta.model_dump(exclude_none=True),
        "enabled": True,
    }
    assert list(RailInfo.model_fields)[: len(RailMeta.model_fields)] == list(RailMeta.model_fields)


def test_the_routine_prompt_opts_in_only_to_a_forge_brief_in_the_fork() -> None:
    prompt = rails.ROUTINE_PROMPT
    assert "routine-fire-payload" in prompt  # what opts the routine in to the fired text
    assert 'starts with "FORGE task #"' in prompt
    assert "only in my fork" in prompt and "the branch the brief names" in prompt
    for refused in ("secrets", "another repository", "settings", ".github/"):
        assert refused in prompt
