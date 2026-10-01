"""GitHub reads (services/github_reads.py): which pull request counts, how checks become
a state and notes, the caches, the read token, and failing soft."""

import httpx
import pytest

from forge_api.models import CheckRun
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
)

from .bridge_helpers import FakeGitHub, json_response

LOGIN = "octo-contributor"
BRANCH = "task/1-polish-the-csv-export-in-the-data-app"


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


def test_failures_raise_github_unavailable(github: FakeGitHub, reads: GitHubReads) -> None:
    for fail in (500, 403, "timeout"):
        github.fail = fail
        reads.clear_cache()
        for read in (
            lambda: reads.find_pull(LOGIN, BRANCH),
            lambda: reads.pull(1),
            lambda: reads.check_runs("a" * 40),
            lambda: reads.fork(LOGIN),
            lambda: reads.task_issues(),
        ):
            with pytest.raises(GitHubUnavailable):
                read()


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


def test_task_issues_skip_pull_requests_and_page(github: FakeGitHub, reads: GitHubReads) -> None:
    github.issues = [{"number": n, "title": "t"} for n in range(1, 151)] + [
        {"number": 0, "pull_request": {}}
    ]
    assert len(reads.task_issues()) == 150
    assert [r.url.params["page"] for r in github.requests] == ["1", "2"]
    assert github.requests[0].url.params["labels"] == "agent-ready,status:open"
    github.issues = [{"number": n, "title": "t"} for n in range(1, 401)]
    reads.clear_cache()
    assert len(reads.task_issues()) == 300  # at most three pages


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
    ticker.now += 11  # all expired: the next put sweeps them
    cache.put(("fresh",), 1, 10)
    assert cache.get(("fresh",)) == (True, 1)
    assert cache.get(("0",)) == (False, None)
    for index in range(MAX_CACHE_ENTRIES):
        cache.put((f"live{index}",), index, 100)
    cache.put(("overflow",), 1, 100)  # none expired: start over
    assert cache.get(("overflow",)) == (True, 1)
    assert cache.get(("live0",)) == (False, None)


def test_the_default_client_is_made_once() -> None:
    reads = GitHubReads(env={})
    assert reads.client is reads.client
    assert reads.client.follow_redirects is False
