"""Live-test one start rail outside the web app (docs/live-tests.md).

    cd apps/api
    uv run python -m forge_api.tools.live_rails --rail jules --login <login> --task 1
    uv run python -m forge_api.tools.live_rails --rail jules --login <login> --task 1 --check
    uv run python -m forge_api.tools.live_rails --rail jules --login <login> --task 1 --go

With neither flag it is a dry run: it prints the requests the rail would send, with every
credential masked, and sends nothing. `--check` makes the cheapest signed-in read the
vendor offers (Jules lists its sources and looks for the fork), proving the key and the
repository connection without starting anything. `--go` really starts a session on the
test account and prints its link.

Credentials come only from these environment variables and are never printed:
JULES_API_KEY, CURSOR_API_KEY, DEVIN_API_KEY + DEVIN_ORG_ID, OPENHANDS_API_KEY,
CLAUDE_ROUTINE_URL + CLAUDE_ROUTINE_TOKEN, GITHUB_USER_TOKEN (Copilot). The GITHUB_TOKEN
a CI runner or dev container carries is never read.
"""

import argparse
import json
import os
import sys
from collections.abc import Mapping, Sequence
from typing import TextIO

import httpx

from forge_api.models import START_RAILS, StartRail
from forge_api.services.bridge import get_task_source
from forge_api.services.brief import branch_name, compile_brief, is_valid_login
from forge_api.services.rail_adapters import (
    AdapterError,
    AdapterRequest,
    OutboundCall,
    RailCredential,
    adapter_for,
    make_client,
)
from forge_api.services.rail_adapters.claude_routine import trigger_id
from forge_api.services.rails import rail_meta

#: rail -> (variable holding the key, variable holding the extra field or None)
CREDENTIAL_ENV: dict[StartRail, tuple[str, str | None]] = {
    "copilot": ("GITHUB_USER_TOKEN", None),
    "jules": ("JULES_API_KEY", None),
    "cursor": ("CURSOR_API_KEY", None),
    "devin": ("DEVIN_API_KEY", "DEVIN_ORG_ID"),
    "openhands": ("OPENHANDS_API_KEY", None),
    "claude-routine": ("CLAUDE_ROUTINE_TOKEN", "CLAUDE_ROUTINE_URL"),
}
PLACEHOLDER_ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_PLACEHOLDER/fire"

EXIT_OK, EXIT_VENDOR, EXIT_USAGE = 0, 1, 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m forge_api.tools.live_rails",
        description="Live-test one FORGE start rail. Dry run unless --check or --go.",
    )
    parser.add_argument("--rail", required=True, choices=START_RAILS, help="the start rail")
    parser.add_argument("--login", required=True, help="GitHub login that owns the fork")
    parser.add_argument("--task", required=True, type=int, help="FORGE task number, e.g. 1")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="read-only call proving key + fork")
    mode.add_argument("--go", action="store_true", help="really start a session")
    return parser


def credential_from_env(
    rail: StartRail, env: Mapping[str, str]
) -> tuple[RailCredential | None, list[str]]:
    """The rail's credential from the environment, and the names of missing variables."""
    key_var, extra_var = CREDENTIAL_ENV[rail]
    key = env.get(key_var, "").strip()
    extra = env.get(extra_var, "").strip() if extra_var else ""
    missing = [name for name, value in ((key_var, key), (extra_var, extra)) if name and not value]
    if missing:
        return None, missing
    if rail == "devin":
        return RailCredential(key=key, org_id=extra), []
    if rail == "claude-routine":
        return RailCredential(key=key, routine_url=extra), []
    return RailCredential(key=key), []


def placeholder_credential(rail: StartRail) -> RailCredential:
    """What a dry run shows in place of credentials that aren't set."""
    key_var, extra_var = CREDENTIAL_ENV[rail]
    if rail == "devin":
        return RailCredential(key=f"MISSING-{key_var}", org_id=f"MISSING-{extra_var}")
    if rail == "claude-routine":
        return RailCredential(key=f"MISSING-{key_var}", routine_url=PLACEHOLDER_ROUTINE_URL)
    return RailCredential(key=f"MISSING-{key_var}")


class Masker:
    """Replaces every credential value read from the environment with its variable
    name, wherever it appears in text about to be printed."""

    def __init__(self, rail: StartRail, env: Mapping[str, str]) -> None:
        self._pairs: list[tuple[str, str]] = []
        for name in CREDENTIAL_ENV[rail]:
            if name is None:
                continue
            value = env.get(name, "").strip()
            if len(value) >= 4:
                self._pairs.append((value, f"<{name}>"))
            if name == "CLAUDE_ROUTINE_URL":
                trig = trigger_id(value)
                if trig is not None:
                    self._pairs.append((trig, "<trigger id from CLAUDE_ROUTINE_URL>"))
        # Longest first, so a value containing another is replaced whole.
        self._pairs.sort(key=lambda pair: len(pair[0]), reverse=True)

    def __call__(self, text: str) -> str:
        for value, mask in self._pairs:
            text = text.replace(value, mask)
        return text


def describe(call: OutboundCall, mask: Masker, label: str = "<credential>") -> str:
    """One planned request as text: method, URL, headers (credential headers masked) and
    JSON body."""
    url = httpx.URL(call.url, params=dict(call.params) if call.params else None)
    lines = [f"{call.method} {url}"]
    for name, value in call.masked_headers(label).items():
        lines.append(f"  {name}: {value}")
    if call.body is not None:
        body = json.dumps(call.body, indent=2, ensure_ascii=False)
        lines.extend("  " + line for line in body.splitlines())
    return mask("\n".join(lines))


def main(
    argv: Sequence[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    client: httpx.Client | None = None,
    out: TextIO | None = None,
) -> int:
    stream = out if out is not None else sys.stdout
    environ: Mapping[str, str] = env if env is not None else os.environ
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0) if exc.code in (0, None) else EXIT_USAGE
    rail: StartRail = args.rail
    mask = Masker(rail, environ)

    def say(text: str = "") -> None:
        print(mask(text), file=stream)

    if not is_valid_login(args.login):
        say(f"--login {args.login!r} isn't a GitHub login.")
        return EXIT_USAGE
    task = get_task_source().get_task(args.task)
    if task is None:
        say(f"There's no FORGE task #{args.task} in the task source.")
        return EXIT_USAGE

    credential, missing = credential_from_env(rail, environ)
    live = args.check or args.go
    if credential is None:
        if live:
            say("Missing: " + ", ".join(missing) + ". Set them first (see docs/live-tests.md).")
            return EXIT_USAGE
        credential = placeholder_credential(rail)

    meta = rail_meta(rail)
    request = AdapterRequest(
        task_id=task.id,
        title=task.title,
        brief=compile_brief(task, task.acceptanceCriteria, args.login),
        branch=branch_name(task.id, task.title),
        login=args.login,
        credential=credential,
    )
    say(f"Rail: {rail} ({meta.label}) on {request.fork}, task #{task.id}: {task.title}")
    say(f"Branch: {request.branch}")
    adapter = adapter_for(rail, client if client is not None else make_client())
    try:
        if args.check:
            result = adapter.check(request)
            say(("OK: " if result.ok else "NOT OK: ") + result.summary)
            return EXIT_OK if result.ok else EXIT_VENDOR
        if args.go:
            started = adapter.start(request)
            say("Started.")
            say(f"Session: {started.session_url or '(the vendor sent no link)'}")
            if started.session_ref:
                say(f"Reference: {started.session_ref}")
            return EXIT_OK
        if missing:
            say("Not set: " + ", ".join(missing) + " (placeholders shown below).")
        say("Dry run: nothing is sent. --check makes a read-only call; --go starts it.")
        for number, call in enumerate(adapter.plan(request), start=1):
            say()
            say(f"{number}. {call.purpose}")
            say(describe(call, mask, f"<{CREDENTIAL_ENV[rail][0]}>"))
        return EXIT_OK
    except AdapterError as exc:
        say(f"{exc.code} (HTTP {exc.status}): {exc.message}")
        if exc.detail:
            say(f"The vendor said: {exc.detail}")
        return EXIT_VENDOR


if __name__ == "__main__":
    raise SystemExit(main())
