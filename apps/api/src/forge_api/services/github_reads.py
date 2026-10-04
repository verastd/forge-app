"""What the Bridge reads from GitHub (contract §7): a task's pull request, its checks, a
pull request by number (for submit), and whether the caller has a fork.

Reads are anonymous unless FORGE_GITHUB_READ_TOKEN is set; a read-only token raises
GitHub's limit from 60 to 5,000 requests an hour, and production needs one (every status
poll may read a pull request and its checks). The GITHUB_TOKEN variable that CI runners
and dev containers carry is never read. A read that GitHub refuses with 401 because of
the token (expired or revoked) is retried once anonymously, and one warning is logged
for it, naming the variable but never the token or any header: reads keep working at
the anonymous rate until the operator replaces the token. Answers are cached per
process: pull requests, checks and searches for 60 s, forks for 5 minutes; a full cache
drops its least recently used entry, never everything. Every failure raises
GitHubUnavailable, and callers degrade (checks say "pending" with a plain note) instead
of answering 500.

A slow or broken GitHub can't hold the API up: a read gets 5 s in all, a failed read is
remembered for 60 s (asking again fails at once), and after 5 failures in a row FORGE
stops asking GitHub for 60 s.

Same outbound rules as the rail adapters (rail_adapters/base.py): no redirects, at most
1 MB read.
"""

import logging
import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

from forge_api.models import CheckRun, CheckRunStatus, CheckState, ForkStatus
from forge_api.services.brief import UPSTREAM_REPO, is_valid_login
from forge_api.services.rail_adapters.base import (
    FORK_REPO_NAME,
    USER_AGENT,
    OutboundCall,
    TransportFailure,
    VendorResponse,
    bounded_send,
    strip_controls,
)

logger = logging.getLogger(__name__)

READ_TOKEN_ENV = "FORGE_GITHUB_READ_TOKEN"
API_URL = "https://api.github.com"
API_VERSION = "2022-11-28"
#: Everything one read may take, connecting and the whole answer included.
READ_TIMEOUT_SECONDS = 5.0
PULL_TTL_SECONDS = 60.0
CHECKS_TTL_SECONDS = 60.0
SEARCH_TTL_SECONDS = 60.0
FORK_TTL_SECONDS = 300.0
#: A failed read is remembered this long: asking again fails at once.
FAILURE_TTL_SECONDS = 60.0
#: After this many failed reads in a row, GitHub isn't asked at all for BREAKER_SECONDS.
BREAKER_FAILURES = 5
BREAKER_SECONDS = 60.0
MAX_CACHE_ENTRIES = 2048
MAX_SUMMARY = 300
#: A search for a task's pull request reads at most this many of them in full.
SEARCH_CANDIDATES = 3
#: How much of a pull request's description is searched for "Closes #<task>".
MAX_BODY_SCAN = 20_000

#: Conclusions that let a pull request through; everything else completed is a failure.
PASSING = frozenset({"success", "neutral", "skipped"})
_SHA = re.compile(r"[0-9a-f]{7,64}")
#: `[#12]` in a pull request title: AGENTS.md rule 8's `[#<issue>] <goal>`.
_TITLE_REF = re.compile(r"\[#([1-9][0-9]{0,9})\]")
#: "Fixes #12", "closes: #12", "Resolves #12" in a description: the link Foreman's G0 gate
#: reads (protocol.ts LINK_RE). Linear: no quantifier can retry another's characters.
_BODY_REF = re.compile(r"\b(?:fixes|closes|resolves)\s*(?::\s*)?#([0-9]{1,10})\b", re.IGNORECASE)

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
    #: GitHub user id owning the head repository (a login can change hands; an id can't).
    head_owner_id: int | None = None
    #: `owner/name` of the repository the pull request asks to merge into.
    base_repo: str = ""
    created_at: datetime | None = None
    closed_at: datetime | None = None
    merged_at: datetime | None = None
    #: Task numbers it names: `[#<n>]` in its title, "Closes #<n>" in its description.
    refs: frozenset[int] = frozenset()

    @property
    def is_open(self) -> bool:
        return self.state == "open" and not self.merged


def pull_url(number: int) -> str:
    return f"https://github.com/{UPSTREAM_REPO}/pull/{number}"


def _time(value: object) -> datetime | None:
    """A GitHub timestamp ("2026-08-10T09:00:00Z"), or None when it isn't one."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def task_refs(title: object, body: object) -> frozenset[int]:
    """The task numbers a pull request names: `[#<n>]` in its title, or a closing link
    ("Closes #<n>", "Fixes #<n>", "Resolves #<n>") in its description."""
    found: set[int] = set()
    if isinstance(title, str):
        found.update(int(number) for number in _TITLE_REF.findall(title))
    if isinstance(body, str):
        found.update(int(number) for number in _BODY_REF.findall(body[:MAX_BODY_SCAN]))
    return frozenset(found)


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _parse_pull(raw: Any) -> PullRequest | None:
    if not isinstance(raw, dict):
        return None
    number, state, head = _positive_int(raw.get("number")), raw.get("state"), raw.get("head")
    if number is None:
        return None
    if state not in ("open", "closed") or not isinstance(head, dict):
        return None
    sha, ref = head.get("sha"), head.get("ref")
    if not isinstance(sha, str) or not isinstance(ref, str):
        return None
    repo = head.get("repo")
    owner = repo.get("owner") if isinstance(repo, dict) else None
    login = owner.get("login") if isinstance(owner, dict) else None
    base = raw.get("base")
    base_repo = base.get("repo") if isinstance(base, dict) else None
    base_name = base_repo.get("full_name") if isinstance(base_repo, dict) else None
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
        head_owner_id=_positive_int(owner.get("id")) if isinstance(owner, dict) else None,
        base_repo=base_name if isinstance(base_name, str) else "",
        created_at=_time(raw.get("created_at")),
        closed_at=_time(raw.get("closed_at")),
        merged_at=_time(raw.get("merged_at")),
        refs=task_refs(title, raw.get("body")),
    )


def best_pull(pulls: Iterable[PullRequest]) -> PullRequest | None:
    """An open pull request first, else the latest merged one, else the latest closed."""
    candidates = list(pulls)
    for wanted in (
        lambda pull: pull.is_open,
        lambda pull: pull.merged,
        lambda pull: True,
    ):
        matching = [pull for pull in candidates if wanted(pull)]
        if matching:
            return max(matching, key=lambda pull: pull.number)
    return None


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


@dataclass(frozen=True)
class _Failure:
    """A read that failed, remembered in the cache so asking again fails at once."""

    reason: str


class _TTLCache:
    """A small thread-safe cache with a per-entry lifetime. When it is full, the least
    recently used entry makes room: one entry goes, never the whole cache."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[tuple[str, ...], tuple[float, object]] = OrderedDict()

    def get(self, key: tuple[str, ...]) -> tuple[bool, object]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry[0] <= self._clock():
                self._entries.pop(key, None)
                return False, None
            self._entries.move_to_end(key)
            return True, entry[1]

    def put(self, key: tuple[str, ...], value: object, ttl: float) -> None:
        with self._lock:
            self._entries.pop(key, None)
            while len(self._entries) >= MAX_CACHE_ENTRIES:
                self._entries.popitem(last=False)
            self._entries[key] = (self._clock() + ttl, value)

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
        timeout: float = READ_TIMEOUT_SECONDS,
    ) -> None:
        self._client = client
        self._env = env
        self._clock = clock
        self._timeout = timeout
        self._cache = _TTLCache(clock)
        self._client_lock = threading.Lock()
        self._breaker_lock = threading.Lock()
        self._failures = 0
        self._paused_until = float("-inf")

    @property
    def client(self) -> httpx.Client:
        with self._client_lock:
            if self._client is None:
                # No step of a read (connecting, sending, waiting, reading) may take
                # longer than the whole budget, and bounded_send holds the read to it.
                self._client = httpx.Client(
                    follow_redirects=False,
                    timeout=httpx.Timeout(self._timeout),
                    headers={"User-Agent": USER_AGENT},
                )
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
            return bounded_send(self.client, call, total_timeout=self._timeout)
        except TransportFailure as exc:
            raise GitHubUnavailable(f"GitHub didn't answer ({exc.reason})") from None

    @staticmethod
    def _json(response: VendorResponse) -> Any:
        try:
            return response.json()
        except (ValueError, UnicodeDecodeError):
            raise GitHubUnavailable("GitHub answered with something that isn't JSON") from None

    def _paused(self) -> bool:
        with self._breaker_lock:
            return self._clock() < self._paused_until

    def _count(self, *, failed: bool) -> None:
        """One read's outcome, for the breaker: a success resets the count of failures
        in a row; the BREAKER_FAILURES-th failure stops reads for BREAKER_SECONDS."""
        with self._breaker_lock:
            if not failed:
                self._failures = 0
                return
            self._failures += 1
            if self._failures >= BREAKER_FAILURES:
                self._paused_until = self._clock() + BREAKER_SECONDS
                if self._failures == BREAKER_FAILURES:
                    logger.warning(
                        "GitHub failed %d reads in a row; not asking it again for %d s",
                        BREAKER_FAILURES,
                        int(BREAKER_SECONDS),
                    )

    def _cached(self, key: tuple[str, ...], ttl: float, fetch: Callable[[], object]) -> object:
        hit, value = self._cache.get(key)
        if hit:
            if isinstance(value, _Failure):
                raise GitHubUnavailable(value.reason)
            return value
        if self._paused():
            raise GitHubUnavailable("GitHub can't be reached right now")
        try:
            value = fetch()
        except GitHubUnavailable as exc:
            self._count(failed=True)
            self._cache.put(key, _Failure(str(exc)), FAILURE_TTL_SECONDS)
            raise
        self._count(failed=False)
        self._cache.put(key, value, ttl)
        return value

    def find_pulls(self, login: str, branch: str) -> list[PullRequest]:
        """Every upstream pull request from `<login>:<branch>`, whatever its state."""
        if not is_valid_login(login):
            return []

        def fetch() -> list[PullRequest]:
            response = self._get(
                f"/repos/{UPSTREAM_REPO}/pulls",
                {"head": f"{login}:{branch}", "state": "all", "per_page": "20"},
            )
            if response.status == 422:
                return []
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            raw = self._json(response)
            pulls = [
                pull for pull in map(_parse_pull, raw if isinstance(raw, list) else []) if pull
            ]
            for pull in pulls:  # the same objects answer a lookup by number for a while
                self._cache.put(("pull", str(pull.number)), pull, PULL_TTL_SECONDS)
            return pulls

        found = self._cached(("pulls", login.lower(), branch), PULL_TTL_SECONDS, fetch)
        return list(found) if isinstance(found, list) else []

    def find_pull(self, login: str, branch: str) -> PullRequest | None:
        """The upstream pull request from `<login>:<branch>`: an open one first, else
        the latest merged one, else the latest closed one; None when there is none."""
        return best_pull(self.find_pulls(login, branch))

    def search_pulls(self, login: str, task_id: int, since: datetime) -> list[PullRequest]:
        """`login`'s pull requests on verastd/forge-app opened since `since` that name task
        `task_id` (`[#<id>]` in the title or "Closes #<id>" in the description), for a
        pull request from another branch. GitHub's search answers which ones (cached for
        60 s); the newest few are then read in full, since a search hit says nothing
        about where the pull request comes from."""
        if not is_valid_login(login):
            return []
        stamp = since.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S+00:00")

        def fetch() -> list[tuple[int, frozenset[int]]]:
            response = self._get(
                "/search/issues",
                {
                    "q": f"repo:{UPSTREAM_REPO} is:pr author:{login} created:>={stamp}",
                    "sort": "created",
                    "order": "desc",
                    "per_page": "30",
                },
            )
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            raw = self._json(response)
            items = raw.get("items") if isinstance(raw, dict) else None
            hits: list[tuple[int, frozenset[int]]] = []
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict) or "pull_request" not in item:
                    continue
                number = _positive_int(item.get("number"))
                if number is not None:
                    hits.append((number, task_refs(item.get("title"), item.get("body"))))
            return hits

        found = self._cached(("search", login.lower(), stamp), SEARCH_TTL_SECONDS, fetch)
        hits = found if isinstance(found, list) else []
        numbers = [number for number, refs in hits if task_id in refs][:SEARCH_CANDIDATES]
        return [pull for pull in map(self.pull, numbers) if pull is not None]

    def pull(self, number: int) -> PullRequest | None:
        """Upstream pull request #`number`, or None when it doesn't exist (cached for
        60 s either way, so asking about many numbers costs GitHub one read each)."""

        def fetch() -> PullRequest | None:
            response = self._get(f"/repos/{UPSTREAM_REPO}/pulls/{number}")
            if response.status == 404:
                return None
            if not response.ok:
                raise GitHubUnavailable(f"GitHub answered {response.status}")
            return _parse_pull(self._json(response))

        found = self._cached(("pull", str(number)), PULL_TTL_SECONDS, fetch)
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
