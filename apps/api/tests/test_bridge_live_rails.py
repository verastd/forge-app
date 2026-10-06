"""The live-test tool (forge_api.tools.live_rails): argument handling, and that no
credential is ever printed, whatever the vendor sends back."""

import io
import json
from typing import Any

import httpx
import pytest

from forge_api.services.rail_adapters.base import RailCredential
from forge_api.tools import live_rails
from forge_api.tools.live_rails import Masker, credential_from_env, main

from .bridge_helpers import (
    CURSOR_KEY,
    DEVIN_KEY,
    DEVIN_ORG,
    GITHUB_USER_KEY,
    JULES_KEY,
    ROUTINE_TOKEN,
    ROUTINE_URL,
    FakeVendor,
    json_response,
    vendor_ok,
)

LOGIN = "octo-contributor"
BASE = ["--login", LOGIN, "--task", "1"]


def run(
    argv: list[str], env: dict[str, str] | None = None, vendor: FakeVendor | None = None
) -> tuple[int, str, FakeVendor]:
    vendor = vendor or FakeVendor(respond=vendor_ok)
    out = io.StringIO()
    code = main(argv, env=env or {}, client=vendor.client(), out=out)
    return code, out.getvalue(), vendor


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--rail", "jules"],
        ["--rail", "nope", *BASE],
        ["--rail", "claude-code", *BASE],
        ["--rail", "jules", "--login", LOGIN, "--task", "one"],
        ["--rail", "jules", *BASE, "--check", "--go"],
    ],
)
def test_bad_arguments_exit_2(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    code, _, vendor = run(argv)
    assert code == 2
    assert vendor.requests == []


def test_help_exits_0(capsys: pytest.CaptureFixture[str]) -> None:
    assert run(["--help"])[0] == 0
    assert "--check" in capsys.readouterr().out


def test_a_bad_login_or_task_exits_2() -> None:
    code, out, _ = run(["--rail", "jules", "--login", "bad_login", "--task", "1"])
    assert code == 2 and "isn't a GitHub login" in out
    code, out, _ = run(["--rail", "jules", "--login", LOGIN, "--task", "999"])
    assert code == 2 and "no FORGE task #999" in out


def test_a_dry_run_sends_nothing_and_masks_the_key() -> None:
    code, out, vendor = run(["--rail", "jules", *BASE], env={"JULES_API_KEY": JULES_KEY})
    assert code == 0
    assert vendor.requests == []
    assert JULES_KEY not in out
    assert "x-goog-api-key: <JULES_API_KEY>" in out
    assert "GET https://jules.googleapis.com/v1alpha/sources?pageSize=100" in out
    assert "POST https://jules.googleapis.com/v1alpha/sessions" in out
    assert "Dry run: nothing is sent." in out
    body = out[out.index("{") : out.rindex("}") + 1]
    assert json.loads(body)["automationMode"] == "AUTO_CREATE_PR"


def test_a_dry_run_without_credentials_shows_placeholders() -> None:
    code, out, _ = run(["--rail", "devin", *BASE])
    assert code == 0
    assert "Not set: DEVIN_API_KEY, DEVIN_ORG_ID" in out
    assert "Authorization: Bearer <DEVIN_API_KEY>" in out


@pytest.mark.parametrize(
    ("rail", "env", "secrets"),
    [
        ("devin", {"DEVIN_API_KEY": DEVIN_KEY, "DEVIN_ORG_ID": DEVIN_ORG}, [DEVIN_KEY, DEVIN_ORG]),
        (
            "claude-routine",
            {"CLAUDE_ROUTINE_TOKEN": ROUTINE_TOKEN, "CLAUDE_ROUTINE_URL": ROUTINE_URL},
            [ROUTINE_TOKEN, ROUTINE_URL, "trig_01TestOnly"],
        ),
        ("copilot", {"GITHUB_USER_TOKEN": GITHUB_USER_KEY}, [GITHUB_USER_KEY]),
        ("cursor", {"CURSOR_API_KEY": CURSOR_KEY}, [CURSOR_KEY]),
        (
            "openhands",
            {"OPENHANDS_API_KEY": "test-only-openhands-credential"},
            ["test-only-openhands-credential"],
        ),
    ],
)
def test_every_rail_dry_run_hides_its_credentials(
    rail: str, env: dict[str, str], secrets: list[str]
) -> None:
    code, out, vendor = run(["--rail", rail, *BASE], env=env)
    assert code == 0 and vendor.requests == []
    for secret in secrets:
        assert secret not in out


def test_live_modes_need_the_credentials() -> None:
    for flag in ("--check", "--go"):
        code, out, vendor = run(["--rail", "devin", *BASE, flag], env={"DEVIN_API_KEY": DEVIN_KEY})
        assert code == 2 and "Missing: DEVIN_ORG_ID" in out
        assert vendor.requests == []


def test_copilot_never_reads_the_ambient_github_token() -> None:
    code, out, vendor = run(
        ["--rail", "copilot", *BASE, "--check"], env={"GITHUB_TOKEN": "test-only-ambient"}
    )
    assert code == 2 and "Missing: GITHUB_USER_TOKEN" in out
    assert vendor.requests == [] and "test-only-ambient" not in out


def test_check_makes_one_read_and_reports() -> None:
    code, out, vendor = run(["--rail", "jules", *BASE, "--check"], env={"JULES_API_KEY": JULES_KEY})
    assert code == 0
    assert "OK: Jules accepted the key" in out
    assert [request.method for request in vendor.requests] == ["GET"]
    assert JULES_KEY not in out


def test_a_failed_check_exits_1() -> None:
    vendor = FakeVendor(
        respond=lambda r: json_response(
            200, {"items": []} if r.url.path.endswith("repositories") else {}
        )
    )
    code, out, _ = run(
        ["--rail", "cursor", *BASE, "--check"], env={"CURSOR_API_KEY": CURSOR_KEY}, vendor=vendor
    )
    assert code == 1 and out.splitlines()[-1].startswith("NOT OK: Cursor can't reach your copy")


def test_go_starts_and_prints_the_link() -> None:
    code, out, vendor = run(["--rail", "cursor", *BASE, "--go"], env={"CURSOR_API_KEY": CURSOR_KEY})
    assert code == 0
    assert "Session: https://cursor.com/agents/bc-1234" in out
    assert "Reference: bc-1234" in out
    assert len(vendor.requests) == 1 and vendor.requests[0].method == "POST"
    assert CURSOR_KEY not in out


def test_a_vendor_error_is_printed_without_the_key() -> None:
    echo = {"message": f"key {JULES_KEY} is not valid"}
    vendor = FakeVendor(respond=lambda r: json_response(401, echo))
    code, out, _ = run(
        ["--rail", "jules", *BASE, "--go"], env={"JULES_API_KEY": JULES_KEY}, vendor=vendor
    )
    assert code == 1
    assert "credential_rejected (HTTP 401)" in out
    assert "The vendor said:" in out
    assert JULES_KEY not in out


def test_go_without_a_link_says_so() -> None:
    vendor = FakeVendor(respond=lambda r: json_response(200, {"type": "routine_fire"}))
    env = {"CLAUDE_ROUTINE_TOKEN": ROUTINE_TOKEN, "CLAUDE_ROUTINE_URL": ROUTINE_URL}
    code, out, _ = run(["--rail", "claude-routine", *BASE, "--go"], env=env, vendor=vendor)
    assert code == 0 and "(the vendor sent no link)" in out
    assert "trig_01TestOnly" not in out


def test_credentials_from_the_environment() -> None:
    assert credential_from_env("jules", {"JULES_API_KEY": f" {JULES_KEY} "}) == (
        RailCredential(key=JULES_KEY),
        [],
    )
    assert credential_from_env("devin", {}) == (None, ["DEVIN_API_KEY", "DEVIN_ORG_ID"])
    routine = {"CLAUDE_ROUTINE_TOKEN": ROUTINE_TOKEN, "CLAUDE_ROUTINE_URL": ROUTINE_URL}
    credential, missing = credential_from_env("claude-routine", routine)
    assert missing == [] and credential is not None
    assert (credential.key, credential.routine_url) == (ROUTINE_TOKEN, ROUTINE_URL)


def test_the_masker_replaces_the_longest_value_first() -> None:
    env: dict[str, Any] = {"CLAUDE_ROUTINE_TOKEN": ROUTINE_TOKEN, "CLAUDE_ROUTINE_URL": ROUTINE_URL}
    mask = Masker("claude-routine", env)
    text = mask(f"POST {ROUTINE_URL} with {ROUTINE_TOKEN} for trig_01TestOnly")
    assert text == (
        "POST <CLAUDE_ROUTINE_URL> with <CLAUDE_ROUTINE_TOKEN> "
        "for <trigger id from CLAUDE_ROUTINE_URL>"
    )
    assert Masker("jules", {"JULES_API_KEY": "abc"})("abc") == "abc"  # too short to be a key


def test_the_module_runs_as_a_script(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live_rails, "make_client", lambda: httpx.Client())
    out = io.StringIO()
    assert main(["--rail", "openhands", *BASE], env={}, out=out) == 0
    assert "app-conversations" in out.getvalue()


def test_a_routine_dry_run_without_credentials_uses_a_placeholder_url() -> None:
    code, out, _ = run(["--rail", "claude-routine", *BASE])
    assert code == 0
    assert "routines/trig_PLACEHOLDER/fire" in out


def test_the_module_entry_point(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import runpy
    import sys
    import warnings

    monkeypatch.delenv("JULES_API_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", ["live_rails", "--rail", "jules", *BASE])
    with pytest.raises(SystemExit) as caught, warnings.catch_warnings():
        # runpy notes the module was imported already (by this test file); harmless here.
        warnings.simplefilter("ignore", RuntimeWarning)
        runpy.run_module("forge_api.tools.live_rails", run_name="__main__")
    assert caught.value.code == 0
    assert "Dry run: nothing is sent." in capsys.readouterr().out
