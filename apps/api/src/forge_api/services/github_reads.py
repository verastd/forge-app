"""What the Bridge reads from GitHub (contract §7): a task's pull request, its checks, a
pull request by number (for submit), and whether the caller has a fork.

Reads are anonymous unless FORGE_GITHUB_READ_TOKEN is set; a read-only token raises
GitHub's limit from 60 to 5,000 requests an hour, and production needs one (every status
poll may read a pull request and its checks). The GITHUB_TOKEN variable that CI runners
and dev containers carry is never read. A read that GitHub refuses with 401 because of
the token (expired or revoked) is retried once anonymously, and one warning is logged
for it, naming the variable but never the token or any header: reads keep working at
the anonymous rate until the operator replaces the token. Answers are cached per
process: pull requests and checks for 60 s, forks for 5 minutes. Every failure raises
GitHubUnavailable, and callers degrade (checks say "pending" with a plain note) instead
of answering 500.

Same outbound rules as the rail adapters (rail_adapters/base.py): no redirects, 5 s to
connect, 20 s in all, at most 1 MB read.
"""

import logging
import os
import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from forge_api.models import CheckRun, CheckRunStatus, CheckState, ForkStatus
from forge_api.services.brief import UPSTREAM_REPO, is_valid_login
from forge_api.services.rail_adapters.base import (
    FORK_REPO_NAME,
    OutboundCall,
    TransportFailure,
    VendorResponse,
    bounded_send,
    make_client,
    strip_controls,
)

logger = logging.getLogger(__name__)

READ_TOKEN_ENV = "FORGE_GITHUB_READ_TOKEN"
API_URL = "https://api.github.com"
API_VERSION = "2022-11-28"
PULL_TTL_SECONDS = 60.0
CHECKS_TTL_SECONDS = 60.0
FORK_TTL_SECONDS = 300.0
TASKS_TTL_SECONDS = 300.0
TASK_LABELS = ("agent-ready", "status:open")
#: Issues are read 100 at a time; at most this many pages.
TASK_PAGES = 3
MAX_CACHE_ENTRIES = 2048
MAX_SUMMARY = 300

#: Conclusions that let a pull request through; everything else completed is a failure.
PASSING = frozenset({"success", "neutral", "skipped"})
_SHA = re.compile(r"[0-9a-f]{7,64}")

PullState = Literal["open", "closed"]


class GitHubUnavailable(Exception):
    """GitHub didn't give a usable answer (network, rate limit, an unexpected status)."""


@dataclass(frozen=True)
class PullRequest:
    """The parts of an upstream pull request the Bridge looks at."""

    number: int
    url: str
    state: PullState
    merged: bool
    head_sha: str
    head_ref: str
    #: Login owning the head repository; None when that repository was deleted.
    head_owner: str | None
    title: str

    @property
    def is_open(self) -> bool:
        return self.state == "open" and not self.merged


def pull_url(number: int) -> str:
    return f"https://github.com/{UPSTREAM_REPO}/pull/{number}"


def _parse_pull(raw: Any) -> PullRequest | None:
    if not isinstance(raw, dict):
        return None
    number, state, head = raw.get("number"), raw.get("state"), raw.get("head")
    if not (isinstance(number, int) and not isinstance(number, bool) and number > 0):
        return None
    if state not in ("open", "closed") or not isinstance(head, dict):
        return None
    sha, ref = head.get("sha"), head.get("ref")
    if not isinstance(sha, str) or not isinstance(ref, str):
        return None
    repo = head.get("repo")
    owner = repo.get("owner") if isinstance(repo, dict) else None
    login = owner.get("login") if isinstance(owner, dict) else None
    title = raw.get("title")
    merged = raw.get("merged") is True or isinstance(raw.get("merged_at"), str)
    return PullRequest(
        number=number,
        url=pull_url(number),
        state="open" if state == "open" else "closed",
        merged=merged,
        head_sha=sha.lower(),
        head_ref=ref,
        head_owner=login if isinstance(login, str) else None,
        title=strip_controls(title)[:200] if isinstance(title, str) else "",
    )


def _status(raw: object) -> CheckRunStatus:
    if raw == "completed":
        return "completed"
    if raw == "in_progress":
        return "in_progress"
    return "queued"  # queued, waiting, requested, pending


def _parse_check_run(raw: Any) -> CheckRun | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
        return None
    status = _status(raw.get("status"))
    conclusion = raw.get("conclusion")
    raw_output = raw.get("output")
    output: dict[str, Any] = raw_output if isinstance(raw_output, dict) else {}
    pieces = [
        strip_controls(value)
        for value in (output.get("title"), output.get("summary"))
        if isinstance(value, str) and value.strip()
    ]
    summary = " — ".join(piece for piece in pieces if piece)[:MAX_SUMMARY] or None
    url = raw.get("html_url") or raw.get("details_url")
    return CheckRun(
        name=strip_controls(raw["name"])[:200] or "check",
        status=status,
        conclusion=conclusion if status == "completed" and isinstance(conclusion, str) else None,
        summary=summary,
        url=url if isinstance(url, str) and url.startswith("https://") else None,
    )


def check_state(runs: list[CheckRun]) -> tuple[CheckState, int, int]:
    """(state, passed, total) for the latest run of each check on one commit.

    No runs yet, or any still running with none failed, is "pending"; any completed
    run with a failing conclusion is "failed"; all completed and passing is "passed".
    """
    passed = sum(1 for run in runs if run.status == "completed" and run.conclusion in PASSING)
    failed = any(run.status == "completed" and run.conclusion not in PASSING for run in runs)
    if failed:
        return "failed", passed, len(runs)
    if runs and passed == len(runs):
        return "passed", passed, len(runs)
    return "pending", passed, len(runs)


def failure_notes(pull: PullRequest, runs: list[CheckRun], branch: str) -> str:
    """The plain text an agent needs to fix failed checks: which failed, what they said
    (truncated), where to read more, and what to do next."""
    lines = [
        f"These checks failed on pull request #{pull.number} ({pull.url}), "
        f"commit {pull.head_sha[:7]}:"
    ]
    for run in runs:
        if run.status != "completed" or run.conclusion in PASSING:
            continue
        line = f"- {run.name}: {run.conclusion}"
        if run.summary:
            line += f". {run.summary}"
        if run.url:
            line += f" ({run.url})"
        lines.append(line)
    lines.append(
        f"Fix the cause on the same branch ({branch}), run make lint and make test, and "
        "push; the checks run again on their own. Don't change the acceptance tests or "
        ".github/."
    )
    return "\n".join(lines)


class _TTLCache:
    """A small thread-safe cache with a per-entry lifetime."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, ...], tuple[float, object]] = {}

    def get(self, key: tuple[str, ...]) -> tuple[bool, object]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry[0] <= self._clock():
                self._entries.pop(key, None)
                return False, None
            return True, entry[1]

    def put(self, key: tuple[str, ...], value: object, ttl: float) -> None:
        with self._lock:
            now = self._clock()
            if len(self._entries) >= MAX_CACHE_ENTRIES:
                self._entries = {k: v for k, v in self._entries.items() if v[0] > now}
                if len(self._entries) >= MAX_CACHE_ENTRIES:
                    self._entries.clear()
            self._entries[key] = (now + ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


class GitHubReads:
    """Cached, read-only GitHub REST calls about verastd/forge-app and its forks."""

    def __init__(
        self,
        client: httpx.Client | None = None,
        *,
        env: Mapping[str, str] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._env = env
        self._cache = _TTLCache(clock)
        self._client_lock = threading.Lock()

    @property
    def client(self) -> httpx.Client:
        with self._client_lock:
            if self._client is None:
                self._client = make_client()
            return self._client

    def clear_cache(self) -> None:
        self._cache.clear()

    def _token(self) -> str:
        env = self._env if self._env is not None else os.environ
        return env.get(READ_TOKEN_ENV, "").strip()

    def _get(self, path: str, params: Mapping[str, str] | None = None) -> VendorResponse:
        token = self._token()
        response = self._send(path, params, token)
        if token and response.status == 401:
            # The token is expired or revoked, and every read would fail with it. The
            # same read anonymously still works, at 60 an hour. The warning names the
            # variable only: never the token, and no header.
            logger.warning(
                "GitHub refused %s (401), so a read was retried without it; "
                "replace the token, since anonymous reads are limited to 60 an hour",
                READ_TOKEN_ENV,
            )
            response = self._send(path, params, "")
        return response

    def _send(self, path: str, params: Mapping[str, str] | None, token: str) -> VendorResponse:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        call = OutboundCall(
            method="GET",
            url=f"{API_URL}{path}",
            headers=headers,
            params=params,
            secret_headers=frozenset({"Authorization"}),
        )
        try:
            return bounded_send(self.client, call)
        except TransportFailure as exc:
            raise GitHubUnavailable(f"GitHub didn't answer ({exc.reason})") from None

    @staticmethod
    def _json(response: VendorResponse) -> Any:
        try:
            return response.json()
        except (ValueError, UnicodeDecodeError):
            raise GitHubUnavailable("GitHub answered with something that isn't JSON") from None

    def _cached(self, key: tuple[str, ...], ttl: float, fetch: Callable[[], object]) -> object:
        hit, value = self._cache.get(key)
        if hit:
            return value
        value = fetch()
        self._cache.put(key, value, ttl)
        return value

    def find_pull(self, login: str, branch: str) -> PullRequest | None:
        """The upstream pull request from `<login>:<branch>`: an open one first, else
        the latest merged one, else the latest closed one; None when there is none."""
        if not is_valid_login(login):
            return None

        def fetch() -> PullRequest | None:
            response = self._get(
                f"/repos/{UPSTREAM_REPO}/pulls",
                {"head": f"{login}:{branch}", "state": "all", "per_page": "20"},
            )
            if response.status == 422:
                return None
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            raw = self._json(response)
            pulls = [
                pull for pull in map(_parse_pull, raw if isinstance(raw, list) else []) if pull
            ]
            for pull in pulls:  # the same objects answer a lookup by number for a while
                self._cache.put(("pull", str(pull.number)), pull, PULL_TTL_SECONDS)
            for wanted in (
                lambda pull: pull.is_open,
                lambda pull: pull.merged,
                lambda pull: True,
            ):
                matching = [pull for pull in pulls if wanted(pull)]
                if matching:
                    return max(matching, key=lambda pull: pull.number)
            return None

        found = self._cached(("pulls", login.lower(), branch), PULL_TTL_SECONDS, fetch)
        return found if isinstance(found, PullRequest) else None

    def pull(self, number: int, *, fresh: bool = False) -> PullRequest | None:
        """Upstream pull request #`number`, or None when it doesn't exist. `fresh` skips
        the cache (a submit checks the pull request as it is now) and refills it."""

        def fetch() -> PullRequest | None:
            response = self._get(f"/repos/{UPSTREAM_REPO}/pulls/{number}")
            if response.status == 404:
                return None
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            return _parse_pull(self._json(response))

        key = ("pull", str(number))
        if fresh:
            found: object = fetch()
            self._cache.put(key, found, PULL_TTL_SECONDS)
        else:
            found = self._cached(key, PULL_TTL_SECONDS, fetch)
        return found if isinstance(found, PullRequest) else None

    def check_runs(self, sha: str) -> list[CheckRun]:
        """The latest run of each check on upstream commit `sha`."""
        if not _SHA.fullmatch(sha):
            return []

        def fetch() -> list[CheckRun]:
            response = self._get(
                f"/repos/{UPSTREAM_REPO}/commits/{sha}/check-runs",
                {"filter": "latest", "per_page": "100"},
            )
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            raw = self._json(response)
            runs = raw.get("check_runs") if isinstance(raw, dict) else None
            parsed = [_parse_check_run(item) for item in (runs if isinstance(runs, list) else [])]
            return sorted((run for run in parsed if run), key=lambda run: run.name.lower())

        found = self._cached(("checks", sha), CHECKS_TTL_SECONDS, fetch)
        return list(found) if isinstance(found, list) else []

    def fork(self, login: str) -> ForkStatus:
        """Whether `<login>/forge-app` exists and is a fork of verastd/forge-app."""
        if not is_valid_login(login):
            return ForkStatus(exists=False)

        def fetch() -> ForkStatus:
            response = self._get(f"/repos/{login}/{FORK_REPO_NAME}")
            if response.status == 404:
                return ForkStatus(exists=False)
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            raw = self._json(response)
            if not isinstance(raw, dict) or raw.get("fork") is not True:
                return ForkStatus(exists=False)
            upstreams = {
                str(parent.get("full_name", "")).lower()
                for parent in (raw.get("parent"), raw.get("source"))
                if isinstance(parent, dict)
            }
            if UPSTREAM_REPO.lower() not in upstreams:
                return ForkStatus(exists=False)
            url = raw.get("html_url")
            return ForkStatus(
                exists=True,
                url=url if isinstance(url, str) and url.startswith("https://github.com/") else None,
            )

        found = self._cached(("fork", login.lower()), FORK_TTL_SECONDS, fetch)
        return found if isinstance(found, ForkStatus) else ForkStatus(exists=False)

    def task_issues(self) -> list[dict[str, Any]]:
        """Open issues on verastd/forge-app labelled `agent-ready` and `status:open` (pull
        requests left out), for FORGE_TASK_SOURCE=github. Cached for 5 minutes."""

        def fetch() -> list[dict[str, Any]]:
            issues: list[dict[str, Any]] = []
            for page in range(1, TASK_PAGES + 1):
                response = self._get(
                    f"/repos/{UPSTREAM_REPO}/issues",
                    {
                        "labels": ",".join(TASK_LABELS),
                        "state": "open",
                        "per_page": "100",
                        "page": str(page),
                    },
                )
                if not response.ok:
                    raise GitHubUnavailable(f"GitHub answered {response.status}")
                raw = self._json(response)
                batch = raw if isinstance(raw, list) else []
                issues.extend(
                    item for item in batch if isinstance(item, dict) and "pull_request" not in item
                )
                if len(batch) < 100:
                    break
            return issues

        found = self._cached(("task-issues",), TASKS_TTL_SECONDS, fetch)
        return list(found) if isinstance(found, list) else []
