"""GitHub reads (services/github_reads.py): which pull request counts, how checks become
a state and notes, the caches, the read token, and failing soft."""

import logging
import socket
import threading
import time
from datetime import UTC, datetime
from functools import partial
from typing import Any

import httpx
import pytest

from forge_api.models import CheckRun
from forge_api.services import github_reads
from forge_api.services.github_reads import (
    MAX_CACHE_ENTRIES,
    GitHubReads,
    GitHubUnavailable,
    PullRequest,
    _parse_check_run,
    _parse_pull,
    _TTLCache,
    check_state,
    failure_notes,
    task_refs,
)

from .bridge_helpers import FakeGitHub, json_response

LOGIN = "octo-contributor"
BRANCH = "task/1-polish-the-csv-export-in-the-data-app"
SINCE = datetime(2026, 8, 10, 9, 0, tzinfo=UTC)


class Ticker:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def ticker() -> Ticker:
    return Ticker()


@pytest.fixture
def reads(github: FakeGitHub, ticker: Ticker) -> GitHubReads:
    return github.reads(ticker)


def test_an_open_pull_request_wins_then_merged_then_closed(
    github: FakeGitHub, reads: GitHubReads, ticker: Ticker
) -> None:
    assert reads.find_pull(LOGIN, BRANCH) is None
    github.add_pull(3, LOGIN, BRANCH, state="closed")
    github.add_pull(4, LOGIN, BRANCH, state="closed", merged=True)
    github.add_pull(5, LOGIN, BRANCH, state="closed")
    ticker.now += 61
    merged = reads.find_pull(LOGIN, BRANCH)
    assert merged is not None and (merged.number, merged.merged) == (4, True)
    github.add_pull(6, LOGIN, BRANCH)
    ticker.now += 61
    found = reads.find_pull(LOGIN, BRANCH)
    assert found is not None and found.number == 6 and found.is_open
    assert found.url == "https://github.com/verastd/forge-app/pull/6"
    assert found.head_owner == LOGIN
    query = github.requests[-1].url.params
    assert (query["head"], query["state"]) == (f"{LOGIN}:{BRANCH}", "all")
    github.pulls.clear()
    github.add_pull(7, LOGIN, BRANCH, state="closed")
    ticker.now += 61
    closed = reads.find_pull(LOGIN, BRANCH)
    assert closed is not None and closed.number == 7 and not closed.is_open


def test_lookups_are_cached_for_a_minute(
    github: FakeGitHub, reads: GitHubReads, ticker: Ticker
) -> None:
    github.add_pull(8, LOGIN, BRANCH)
    reads.find_pull(LOGIN, BRANCH)
    reads.find_pull(LOGIN, BRANCH)
    reads.pull(8)  # seeded by the head lookup
    assert len(github.requests) == 1
    ticker.now += 60
    reads.find_pull(LOGIN, BRANCH)
    assert len(github.requests) == 2
    reads.clear_cache()
    reads.pull(8)
    assert len(github.requests) == 3


def test_a_pull_request_by_number(github: FakeGitHub, reads: GitHubReads) -> None:
    assert reads.pull(99) is None
    github.add_pull(10, "someone", "x")
    reads.clear_cache()
    pull = reads.pull(10)
    assert pull is not None and pull.head_owner == "someone"


def test_an_invalid_login_never_reaches_github(github: FakeGitHub, reads: GitHubReads) -> None:
    assert reads.find_pull("bad login", BRANCH) is None
    assert reads.fork("../evil").exists is False
    assert reads.check_runs("not-a-sha") == []
    assert github.requests == []


def test_failures_raise_github_unavailable(github: FakeGitHub, ticker: Ticker) -> None:
    for fail in (500, 403, "timeout"):
        github.fail = fail
        reads = github.reads(ticker)  # a fresh breaker for each kind of failure
        for read in (
            partial(reads.find_pull, LOGIN, BRANCH),
            partial(reads.pull, 1),
            partial(reads.check_runs, "a" * 40),
            partial(reads.fork, LOGIN),
            partial(reads.search_pulls, LOGIN, 1, SINCE),
        ):
            before = len(github.requests)
            with pytest.raises(GitHubUnavailable):
                read()
            assert len(github.requests) == before + 1


def test_a_422_on_the_head_lookup_means_no_pull_request(reads: GitHubReads) -> None:
    client = httpx.Client(transport=httpx.MockTransport(lambda r: json_response(422, {})))
    assert GitHubReads(client=client, env={}).find_pull(LOGIN, BRANCH) is None


def test_non_json_answers_are_unavailable() -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"<html>"))
    )
    with pytest.raises(GitHubUnavailable):
        GitHubReads(client=client, env={}).pull(1)


def test_the_read_token_comes_only_from_its_own_variable(github: FakeGitHub) -> None:
    anonymous = GitHubReads(client=github.client(), env={"GITHUB_TOKEN": "test-only-not-ours"})
    anonymous.pull(1)
    assert "authorization" not in github.requests[-1].headers
    signed = GitHubReads(
        client=github.client(), env={"FORGE_GITHUB_READ_TOKEN": " test-only-read "}
    )
    signed.pull(1)
    assert github.requests[-1].headers["authorization"] == "Bearer test-only-read"
    assert github.requests[-1].headers["x-github-api-version"] == "2022-11-28"


EXPIRED_TOKEN = "test-only-expired-read-token"
READS_LOGGER = "forge_api.services.github_reads"


def warnings_from_reads(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """What github_reads logged (httpx logs each request too, at INFO)."""
    return [record for record in caplog.records if record.name == READS_LOGGER]


def refusing_the_token(github: FakeGitHub) -> httpx.Client:
    """api.github.com once the read token has expired: a request carrying it gets 401."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "authorization" in request.headers:
            github.requests.append(request)
            return json_response(401, {"message": "Bad credentials"})
        return github.handler(request)

    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_a_refused_read_token_is_retried_once_anonymously_with_one_warning(
    github: FakeGitHub, caplog: pytest.LogCaptureFixture
) -> None:
    github.add_pull(12, LOGIN, BRANCH)
    github.add_fork(LOGIN)
    reads = GitHubReads(
        client=refusing_the_token(github), env={"FORGE_GITHUB_READ_TOKEN": EXPIRED_TOKEN}
    )
    with caplog.at_level(logging.DEBUG):
        pull = reads.pull(12)

    assert pull is not None and pull.number == 12
    # Once with the token, then once without it.
    assert [request.headers.get("authorization") for request in github.requests] == [
        f"Bearer {EXPIRED_TOKEN}",
        None,
    ]
    ours = warnings_from_reads(caplog)
    assert [record.levelno for record in ours] == [logging.WARNING]
    warning = ours[0].getMessage()
    assert "FORGE_GITHUB_READ_TOKEN" in warning and "401" in warning
    # Nothing anyone logged (httpx included) carries the token or a header.
    for leaked in (EXPIRED_TOKEN, "Bearer", "uthorization", "Accept", "X-GitHub"):
        assert leaked not in caplog.text

    # Every kind of read falls back the same way, one warning each.
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        assert reads.fork(LOGIN).exists is True
        assert reads.find_pull(LOGIN, BRANCH) is not None
    assert len(warnings_from_reads(caplog)) == 2
    assert EXPIRED_TOKEN not in caplog.text


def test_only_a_refused_token_is_retried(
    github: FakeGitHub, caplog: pytest.LogCaptureFixture
) -> None:
    signed = GitHubReads(client=github.client(), env={"FORGE_GITHUB_READ_TOKEN": EXPIRED_TOKEN})
    with caplog.at_level(logging.WARNING):
        # Anonymous already: a 401 is just a failure.
        github.fail = 401
        with pytest.raises(GitHubUnavailable):
            github.reads().pull(1)
        assert len(github.requests) == 1
        # Any other refusal of the token (403: rate limited) isn't retried either.
        github.fail = 403
        with pytest.raises(GitHubUnavailable):
            signed.pull(1)
        assert len(github.requests) == 2
        assert warnings_from_reads(caplog) == []
        # An anonymous retry that fails too is a failure, after exactly one retry.
        github.fail = 401
        signed.clear_cache()  # the 403 is remembered for a minute otherwise
        with pytest.raises(GitHubUnavailable):
            signed.pull(1)
    assert len(github.requests) == 4
    assert github.requests[2].headers["authorization"] == f"Bearer {EXPIRED_TOKEN}"
    assert "authorization" not in github.requests[3].headers
    assert len(warnings_from_reads(caplog)) == 1


def test_check_runs_parse(github: FakeGitHub, reads: GitHubReads) -> None:
    sha = "b" * 40
    github.checks[sha] = [
        {"name": "z-last", "status": "waiting", "conclusion": None},
        {
            "name": "a‮first",
            "status": "completed",
            "conclusion": "failure",
            "details_url": "https://ci.example/1",
            "output": {"title": "Tests\nfailed", "summary": "x" * 400},
        },
        {"name": 7},
        "junk",
        {
            "name": "mid",
            "status": "in_progress",
            "conclusion": "success",
            "html_url": "http://insecure",
        },
    ]
    runs = reads.check_runs(sha)
    assert [run.name for run in runs] == ["afirst", "mid", "z-last"]
    first, mid, last = runs
    assert (first.status, first.conclusion, first.url) == (
        "completed",
        "failure",
        "https://ci.example/1",
    )
    assert first.summary is not None and first.summary.startswith("Tests failed — xxx")
    assert len(first.summary) == 300
    assert (mid.status, mid.conclusion, mid.url) == ("in_progress", None, None)
    assert last.status == "queued"
    query = github.requests[-1].url.params
    assert (query["filter"], query["per_page"]) == ("latest", "100")


def run(name: str, status: str = "completed", conclusion: str | None = "success") -> CheckRun:
    return CheckRun(name=name, status=status, conclusion=conclusion)  # type: ignore[arg-type]


def test_check_state() -> None:
    assert check_state([]) == ("pending", 0, 0)
    assert check_state([run("a"), run("b", "in_progress", None)]) == ("pending", 1, 2)
    assert check_state(
        [run("a"), run("b", conclusion="skipped"), run("c", conclusion="neutral")]
    ) == ("passed", 3, 3)
    assert check_state([run("a"), run("b", conclusion="failure"), run("c", "queued", None)]) == (
        "failed",
        1,
        3,
    )
    for conclusion in ("timed_out", "cancelled", "action_required", "startup_failure", "stale"):
        assert check_state([run("a", conclusion=conclusion)])[0] == "failed"


def test_failure_notes_name_only_the_failures() -> None:
    pull = PullRequest(
        12,
        "https://github.com/verastd/forge-app/pull/12",
        "open",
        False,
        "c" * 40,
        BRANCH,
        LOGIN,
        "t",
    )
    runs = [
        CheckRun(name="lint", status="completed", conclusion="success"),
        CheckRun(
            name="test",
            status="completed",
            conclusion="failure",
            summary="2 failed",
            url="https://ci.example/t",
        ),
        CheckRun(name="build", status="completed", conclusion="timed_out"),
        CheckRun(name="slow", status="in_progress"),
    ]
    notes = failure_notes(pull, runs, BRANCH)
    lines = notes.splitlines()
    assert lines[0] == (
        "These checks failed on pull request #12 (https://github.com/verastd/forge-app/pull/12), "
        "commit ccccccc:"
    )
    assert lines[1] == "- test: failure. 2 failed (https://ci.example/t)"
    assert lines[2] == "- build: timed_out"
    assert BRANCH in lines[3] and "make test" in lines[3]
    assert len(lines) == 4


def test_fork_status(github: FakeGitHub, reads: GitHubReads, ticker: Ticker) -> None:
    assert reads.fork(LOGIN).exists is False
    github.add_fork(LOGIN)
    assert reads.fork(LOGIN).exists is False  # cached for five minutes
    ticker.now += 299
    assert reads.fork(LOGIN).exists is False
    ticker.now += 2
    fork = reads.fork(LOGIN)
    assert (fork.exists, fork.url) == (True, f"https://github.com/{LOGIN}/forge-app")
    github.add_fork("copycat", parent="someone/forge-app")
    assert reads.fork("copycat").exists is False
    github.repos["plain/forge-app"] = {"fork": False}
    assert reads.fork("plain").exists is False


def test_parse_pull_rejects_odd_shapes() -> None:
    assert _parse_pull("x") is None
    assert _parse_pull({"number": True, "state": "open", "head": {}}) is None
    assert _parse_pull({"number": 1, "state": "draft", "head": {}}) is None
    assert _parse_pull({"number": 1, "state": "open", "head": {"sha": 1, "ref": "x"}}) is None
    gone = _parse_pull(
        {"number": 1, "state": "open", "head": {"sha": "AB", "ref": "x", "repo": None}}
    )
    assert gone is not None and gone.head_owner is None and gone.head_sha == "ab"
    assert _parse_check_run({"status": "completed"}) is None


def test_the_cache_stays_bounded() -> None:
    ticker = Ticker()
    cache = _TTLCache(ticker)
    for index in range(MAX_CACHE_ENTRIES):
        cache.put((str(index),), index, 10)
    ticker.now += 11  # all expired
    cache.put(("fresh",), 1, 10)
    assert cache.get(("fresh",)) == (True, 1)
    assert cache.get(("0",)) == (False, None)
    for index in range(MAX_CACHE_ENTRIES):
        cache.put((f"live{index}",), index, 100)
    cache.put(("overflow",), 1, 100)  # full: the least recently used entry makes room
    assert cache.get(("overflow",)) == (True, 1)
    assert cache.get(("live0",)) == (False, None)


def test_a_full_cache_drops_one_entry_never_everything() -> None:
    """mcp M3: one user asking about thousands of numbers flushed everyone's cache."""
    ticker = Ticker()
    cache = _TTLCache(ticker)
    cache.put(("pull", "12"), "watched", 100)
    for index in range(MAX_CACHE_ENTRIES - 1):
        cache.put(("pull", f"junk{index}"), index, 100)
    assert cache.get(("pull", "12")) == (True, "watched")  # used: now the newest
    cache.put(("pull", "one-more"), 1, 100)
    assert cache.get(("pull", "12")) == (True, "watched")
    assert cache.get(("pull", "junk0")) == (False, None)  # the least recently used went
    assert cache.get(("pull", "junk1")) == (True, 1)


def test_the_default_client_is_made_once() -> None:
    reads = GitHubReads(env={})
    assert reads.client is reads.client
    assert reads.client.follow_redirects is False


def test_a_read_gets_five_seconds_in_all(
    github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """B-M6: no step of a read may wait longer than 5 s, and bounded_send holds the
    whole read to the same 5 s (it was 5 s to connect, then 20 s more)."""
    assert GitHubReads(env={}).client.timeout == httpx.Timeout(5.0)
    budgets: list[float] = []
    real_send = github_reads.bounded_send

    def spy(client: httpx.Client, call: Any, **kwargs: Any) -> Any:
        budgets.append(kwargs["total_timeout"])
        return real_send(client, call, **kwargs)

    monkeypatch.setattr(github_reads, "bounded_send", spy)
    github.reads().pull(1)
    assert budgets == [5.0]


def test_a_silent_github_is_given_up_on_within_the_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B-M6: a GitHub that accepts the connection and never answers (the reviewer's
    blackhole) costs a read its budget, not more."""
    listener = socket.create_server(("127.0.0.1", 0))
    held: list[socket.socket] = []
    accepting = threading.Thread(target=lambda: held.append(listener.accept()[0]), daemon=True)
    accepting.start()
    monkeypatch.setattr(github_reads, "API_URL", f"http://127.0.0.1:{listener.getsockname()[1]}")
    try:
        started = time.monotonic()
        with pytest.raises(GitHubUnavailable):
            GitHubReads(env={}, timeout=0.5).pull(1)
        assert time.monotonic() - started < 3
    finally:
        accepting.join(timeout=5)
        for connection in held:
            connection.close()
        listener.close()


def test_a_failed_read_is_remembered_for_a_minute(github: FakeGitHub, ticker: Ticker) -> None:
    """B-M6: asking again while GitHub is failing fails at once."""
    reads = github.reads(ticker)
    github.fail = 502
    for _ in range(3):
        with pytest.raises(GitHubUnavailable):
            reads.pull(1)
    assert len(github.requests) == 1
    github.fail = None
    ticker.now += 61
    assert reads.pull(1) is None  # asked again: no such pull request
    assert len(github.requests) == 2


def test_five_failures_in_a_row_stop_reads_for_a_minute(github: FakeGitHub, ticker: Ticker) -> None:
    """B-M6: the breaker. A success resets the count; the fifth failure in a row stops
    every read, whatever it asks about, for 60 s."""
    reads = github.reads(ticker)
    github.fail = 500
    for number in range(1, 5):
        with pytest.raises(GitHubUnavailable):
            reads.pull(number)
    github.fail = None
    assert reads.pull(5) is None  # a success: the count starts again
    github.fail = 500
    for number in range(6, 11):
        with pytest.raises(GitHubUnavailable):
            reads.pull(number)
    asked = len(github.requests)
    assert asked == 10
    github.fail = None
    with pytest.raises(GitHubUnavailable, match="can't be reached right now"):
        reads.fork(LOGIN)
    with pytest.raises(GitHubUnavailable):
        reads.check_runs("a" * 40)
    assert len(github.requests) == asked
    ticker.now += 60
    assert reads.fork(LOGIN).exists is False
    assert len(github.requests) == asked + 1


def test_a_task_number_in_a_title_or_a_closing_link_names_it() -> None:
    """B-M1, B-M11: `[#<id>]` in the title, or Closes/Fixes/Resolves #<id> in the
    description (Foreman's G0 link), as GitHub's own keywords are written."""
    assert task_refs("[#12] Export", None) == {12}
    assert task_refs("Export (#12)", "see #12") == frozenset()
    assert task_refs(None, "Fixes #3\ncloses: #4 and RESOLVES #5") == {3, 4, 5}
    assert task_refs("[#0] x", "Fixesss #6 closes#7") == {7}
    started = time.perf_counter()
    assert task_refs("[#" + "1" * 70_000, "fixes" + " " * 70_000 + "x") == frozenset()
    assert time.perf_counter() - started < 0.5  # linear, and a long description is cut


def test_a_pull_request_carries_what_matching_needs() -> None:
    """B-M1, mcp L2: base repository, the head owner's GitHub id, and the times."""
    pull = _parse_pull(
        {
            "number": 7,
            "state": "closed",
            "title": "[#1] Export",
            "body": "Closes #1",
            "created_at": "2026-08-10T09:30:00Z",
            "closed_at": "2026-08-11T10:00:00Z",
            "merged_at": None,
            "base": {"repo": {"full_name": "verastd/forge-app"}},
            "head": {
                "sha": "a" * 40,
                "ref": "x",
                "repo": {"owner": {"login": "octo", "id": 1001}},
            },
        }
    )
    assert pull is not None
    assert (pull.base_repo, pull.head_owner_id, pull.refs) == ("verastd/forge-app", 1001, {1})
    assert pull.created_at == datetime(2026, 8, 10, 9, 30, tzinfo=UTC)
    assert pull.closed_at == datetime(2026, 8, 11, 10, 0, tzinfo=UTC)
    assert pull.merged is False and pull.merged_at is None
    odd = _parse_pull(
        {
            "number": 8,
            "state": "open",
            "created_at": "yesterday",
            "base": "main",
            "head": {"sha": "b" * 40, "ref": "y", "repo": {"owner": {"id": True}}},
        }
    )
    assert odd is not None
    assert (odd.created_at, odd.base_repo, odd.head_owner_id) == (None, "", None)


def test_the_search_reads_only_the_newest_pull_requests_naming_the_task(
    github: FakeGitHub, ticker: Ticker
) -> None:
    """B-M11: hits are read in full by number, at most three, and only those naming the
    task; an invalid login never reaches GitHub."""
    for number in range(30, 36):
        github.add_pull(number, LOGIN, f"branch-{number}", body="Fixes #1")
    github.add_pull(40, LOGIN, "other", title="[#2] Something else")
    reads = github.reads(ticker)
    found = reads.search_pulls(LOGIN, 1, SINCE)
    assert [pull.number for pull in found] == [35, 34, 33]
    assert reads.search_pulls("bad login", 1, SINCE) == []
    searches = [request for request in github.requests if request.url.path == "/search/issues"]
    assert len(searches) == 1
    assert searches[0].url.params["sort"] == "created"


def test_the_search_skips_hits_that_are_not_pull_requests() -> None:
    """B-M11: an issue (no `pull_request` key) or junk in the answer is never read."""
    items = [
        {"number": 7, "title": "[#1] An issue, not a pull request"},
        "junk",
        {"number": "8", "title": "[#1] A number that isn't one", "pull_request": {}},
    ]
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: json_response(200, {"items": items}))
    )
    assert GitHubReads(client=client, env={}).search_pulls(LOGIN, 1, SINCE) == []
