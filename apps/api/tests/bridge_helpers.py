"""Shared helpers for the Bridge v2 tests: a stand-in GitHub, a stand-in vendor, and the
one call that points the Bridge's providers at them. Kept out of conftest.py on purpose
(conftest belongs to every API test); test modules import what they need from here."""

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from forge_api.services import bridge as bridge_service
from forge_api.services import vault as vault_service
from forge_api.services.bridge import FixtureTaskSource, LeaseStore
from forge_api.services.github_reads import GitHubReads
from forge_api.services.identity import Identity

from .conftest import FakeClock

#: 32 bytes, so its base64 is a valid FORGE_VAULT_KEY. Tests only.
TEST_VAULT_MASTER = b"test-only-forge-vault-master-key"
OTHER_VAULT_MASTER = b"test-only-another-vault-master!!"

USER = Identity(sub="1001", login="octo-contributor")
OTHER = Identity(sub="1003", login="other-dev")

#: Fake credentials (gitleaks-safe: nothing key-shaped).
JULES_KEY = "test-only-jules-credential"
CURSOR_KEY = "test-only-cursor-credential"
DEVIN_KEY = "test-only-devin-credential"
DEVIN_ORG = "org-test-only"
OPENHANDS_KEY = "test-only-openhands-credential"
ROUTINE_TOKEN = "test-only-routine-credential"
ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01TestOnly/fire"
GITHUB_USER_KEY = "test-only-github-user-credential"

#: Every environment variable the Bridge reads; tests start with none of them set.
BRIDGE_ENV = (
    "FORGE_START_RAILS",
    "FORGE_VAULT_KEY",
    "FORGE_GITHUB_READ_TOKEN",
    "FORGE_MAX_ACTIVE_CLAIMS",
    "FORGE_FLAGS_JSON",
    "FORGE_FLAGS_PATH",
)

#: GitHub user ids of the test accounts (a pull request is matched to its holder by id).
GITHUB_IDS = {"octo-contributor": 1001, "octo-operator": 1002, "other-dev": 1003}


def github_time(moment: datetime) -> str:
    """A time as GitHub writes it: whole seconds, Z."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def vault_key(master: bytes = TEST_VAULT_MASTER) -> str:
    return base64.b64encode(master).decode()


def json_response(status: int, body: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


# --- a stand-in for api.github.com ----------------------------------------------------


@dataclass
class FakeGitHub:
    """api.github.com for verastd/forge-app and its forks, through httpx.MockTransport."""

    pulls: list[dict[str, Any]] = field(default_factory=list)
    checks: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    repos: dict[str, dict[str, Any]] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)
    #: When set, every request is answered with this status (or raises, for "timeout").
    fail: int | str | None = None
    #: When set, only requests whose path contains this text fail (with a 500).
    fail_on: str | None = None
    #: The clock new pull requests are opened by (install_bridge sets the test's clock).
    now: Callable[[], datetime] | None = None
    #: GitHub user ids by login; unknown logins get a fresh one.
    ids: dict[str, int] = field(default_factory=lambda: dict(GITHUB_IDS))

    def user_id(self, login: str) -> int:
        return self.ids.setdefault(login.lower(), 5000 + len(self.ids))

    def add_pull(
        self,
        number: int,
        login: str,
        branch: str,
        *,
        state: str = "open",
        merged: bool = False,
        sha: str | None = None,
        title: str | None = None,
        body: str | None = None,
        created_at: str | None = None,
        owner_id: int | None = None,
        base: str = "verastd/forge-app",
    ) -> dict[str, Any]:
        """A pull request from `login`'s fork, opened now (by `now`) unless `created_at`
        says otherwise. A merged or closed one closed when it was opened."""
        opened = created_at or (
            github_time(self.now()) if self.now is not None else "2026-08-10T09:00:00Z"
        )
        user = {"login": login, "id": owner_id or self.user_id(login)}
        pull = {
            "number": number,
            "html_url": f"https://github.com/verastd/forge-app/pull/{number}",
            "state": state,
            "title": title if title is not None else f"Pull request {number}",
            "body": body,
            "user": user,
            "created_at": opened,
            "closed_at": opened if state == "closed" or merged else None,
            "merged": merged,
            "merged_at": opened if merged else None,
            "base": {"ref": "main", "repo": {"full_name": base}},
            "head": {
                "ref": branch,
                "sha": sha or f"{number:040x}",
                "repo": {"full_name": f"{login}/forge-app", "owner": dict(user)},
                "user": dict(user),
            },
        }
        self.pulls.insert(0, pull)
        return pull

    def set_checks(self, sha: str, *runs: tuple[str, str, str | None]) -> None:
        self.checks[sha] = [
            {
                "name": name,
                "status": status,
                "conclusion": conclusion,
                "html_url": f"https://github.com/verastd/forge-app/runs/{index}",
                "output": {"title": f"{name} said", "summary": f"details for {name}"},
            }
            for index, (name, status, conclusion) in enumerate(runs, start=1)
        ]

    def add_fork(self, login: str, *, parent: str = "verastd/forge-app") -> None:
        self.repos[f"{login}/forge-app".lower()] = {
            "full_name": f"{login}/forge-app",
            "fork": True,
            "html_url": f"https://github.com/{login}/forge-app",
            "parent": {"full_name": parent},
            "source": {"full_name": parent},
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail == "timeout":
            raise httpx.ReadTimeout("timed out", request=request)
        if isinstance(self.fail, int):
            return json_response(self.fail, {"message": "unavailable"})
        path = request.url.path
        if self.fail_on is not None and self.fail_on in path:
            return json_response(500, {"message": "unavailable"})
        query = parse_qs(urlsplit(str(request.url)).query)
        if path == "/repos/verastd/forge-app/pulls":
            head = query.get("head", [""])[0]
            login, _, branch = head.partition(":")
            found = [
                pull
                for pull in self.pulls
                if pull["head"]["user"]["login"].lower() == login.lower()
                and pull["head"]["ref"] == branch
            ]
            return json_response(200, found)
        if path.startswith("/repos/verastd/forge-app/pulls/"):
            number = int(path.rsplit("/", 1)[1])
            pull = next((item for item in self.pulls if item["number"] == number), None)
            return (
                json_response(200, pull) if pull else json_response(404, {"message": "Not Found"})
            )
        if path.startswith("/repos/verastd/forge-app/commits/") and path.endswith("/check-runs"):
            sha = path.split("/")[5]
            runs = self.checks.get(sha, [])
            return json_response(200, {"total_count": len(runs), "check_runs": runs})
        if path == "/search/issues":
            return json_response(200, self.search(query.get("q", [""])[0]))
        if path.startswith("/repos/"):
            repo = self.repos.get(path.removeprefix("/repos/").lower())
            return (
                json_response(200, repo) if repo else json_response(404, {"message": "Not Found"})
            )
        return json_response(404, {"message": "Not Found"})

    def search(self, q: str) -> dict[str, Any]:
        """GET /search/issues for `repo:verastd/forge-app is:pr author:<login>
        created:>=<time>`: issue-shaped hits, newest first, without head or base."""
        terms = dict(term.split(":", 1) for term in q.split() if ":" in term)
        since = terms.get("created", "").removeprefix(">=")
        items = [
            {
                "number": pull["number"],
                "title": pull["title"],
                "body": pull["body"],
                "state": pull["state"],
                "created_at": pull["created_at"],
                "user": dict(pull["user"]),
                "pull_request": {"html_url": pull["html_url"]},
            }
            for pull in self.pulls
            if terms.get("repo") == "verastd/forge-app"
            and terms.get("is") == "pr"
            and pull["user"]["login"].lower() == terms.get("author", "").lower()
            and (
                not since
                or datetime.fromisoformat(pull["created_at"]) >= datetime.fromisoformat(since)
            )
        ]
        items.sort(key=lambda item: item["created_at"], reverse=True)
        return {"total_count": len(items), "incomplete_results": False, "items": items}

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=False)

    def reads(self, clock: Callable[[], float] | None = None) -> GitHubReads:
        if clock is None:
            return GitHubReads(client=self.client(), env={})
        return GitHubReads(client=self.client(), env={}, clock=clock)


# --- a stand-in for the vendors -------------------------------------------------------


Responder = Callable[[httpx.Request], httpx.Response]


@dataclass
class FakeVendor:
    """Every vendor host at once: answers with `respond`, records every request."""

    respond: Responder = field(default=lambda request: json_response(500, {"error": "unset"}))
    requests: list[httpx.Request] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=False)

    def bodies(self) -> list[Any]:
        return [
            json.loads(request.content) if request.content else None for request in self.requests
        ]


def vendor_ok(request: httpx.Request) -> httpx.Response:
    """A plausible success answer from whichever vendor `request` went to."""
    host, path = request.url.host, request.url.path
    if host == "jules.googleapis.com" and path.endswith("/sources"):
        return json_response(
            200,
            {
                "sources": [
                    {
                        "name": "sources/github/octo-contributor/forge-app",
                        "id": "github/octo-contributor/forge-app",
                        "githubRepo": {"owner": "octo-contributor", "repo": "forge-app"},
                    }
                ]
            },
        )
    if host == "jules.googleapis.com" and path.endswith(":sendMessage"):
        return json_response(200, {})
    if host == "jules.googleapis.com":
        return json_response(
            200,
            {
                "name": "sessions/31415",
                "id": "31415",
                "state": "QUEUED",
                "url": "https://jules.google.com/session/31415",
            },
        )
    if host == "api.cursor.com" and path.endswith("/runs"):
        return json_response(200, {"run": {"id": "run-2", "status": "CREATING"}})
    if host == "api.cursor.com":
        return json_response(
            200,
            {
                "agent": {"id": "bc-1234", "url": "https://cursor.com/agents/bc-1234"},
                "run": {"id": "run-1", "status": "CREATING"},
            },
        )
    if host == "api.devin.ai" and path.endswith("/messages"):
        return json_response(
            200, {"session_id": "devin-77", "url": "https://app.devin.ai/sessions/77"}
        )
    if host == "api.devin.ai":
        return json_response(
            200,
            {
                "session_id": "devin-77",
                "url": "https://app.devin.ai/sessions/devin-77",
                "status": "new",
            },
        )
    if host == "app.all-hands.dev":
        return json_response(
            200, {"id": "task-9", "status": "WORKING", "app_conversation_id": "conv-9"}
        )
    if host == "api.anthropic.com":
        return json_response(
            200,
            {
                "type": "routine_fire",
                "claude_code_session_id": "session_01Test",
                "claude_code_session_url": "https://claude.ai/code/session_01Test",
            },
        )
    if host == "api.github.com":
        return json_response(
            201,
            {
                "id": "task-123",
                "html_url": "https://github.com/octo-contributor/forge-app/agents/task-123",
                "state": "queued",
            },
        )
    return json_response(404, {"error": "unknown host"})


# --- wiring ---------------------------------------------------------------------------


@dataclass
class BridgeEnv:
    clock: FakeClock
    store: LeaseStore
    github: FakeGitHub
    vendor: FakeVendor
    monkeypatch: pytest.MonkeyPatch

    def flags(self, **overrides: bool) -> None:
        self.monkeypatch.setenv("FORGE_FLAGS_JSON", json.dumps(overrides))

    def start_rails(self, *rails: str) -> None:
        """Switch start rails on: the `agent_start` flag plus FORGE_START_RAILS."""
        self.flags(agent_start=True)
        self.monkeypatch.setenv("FORGE_START_RAILS", ",".join(rails))

    def vault_on(self, master: bytes = TEST_VAULT_MASTER) -> None:
        self.monkeypatch.setenv("FORGE_VAULT_KEY", vault_key(master))


def install_bridge(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    """Point every Bridge provider at fakes: the clock, GitHub and the vendors. HTTP routes
    and connector tools both read the providers, so both see the same fakes."""
    for name in BRIDGE_ENV:
        monkeypatch.delenv(name, raising=False)
    vault_service._decode_master.cache_clear()
    store = LeaseStore(now_fn=clock)
    github = FakeGitHub(now=clock)
    vendor = FakeVendor(respond=vendor_ok)
    monkeypatch.setattr(bridge_service, "_store", store)
    # GitHub answers are cached against the same fake clock, so `advance(61)` expires them.
    monkeypatch.setattr(bridge_service, "_github", github.reads(lambda: clock().timestamp()))
    monkeypatch.setattr(bridge_service, "_rail_client", vendor.client())
    monkeypatch.setattr(bridge_service, "_source", FixtureTaskSource())
    return BridgeEnv(
        clock=clock, store=store, github=github, vendor=vendor, monkeypatch=monkeypatch
    )


def has_null(value: Any) -> bool:
    """True when a JSON value holds a null anywhere (zod .optional() rejects those)."""
    if value is None:
        return True
    if isinstance(value, dict):
        return any(has_null(item) for item in value.values())
    if isinstance(value, list):
        return any(has_null(item) for item in value)
    return False
