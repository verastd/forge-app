"""FORGE's GitHub calls as the contributor (Phase 7 contract §3): set up "your copy" (their
fork of verastd/forge-app, kept up to date, with the task's branch in it) and "Send for
review" (the pull request, opened as them, once FORGE has checked the diff).

FORGE still never writes code: the agent does. These are the only GitHub calls FORGE makes
as a contributor, each with the one-time token GitHub gave the web app for that one action
(FORGE's OAuth App, scope `public_repo`); the web revokes it as soon as the action is over.
The Bridge (services/bridge.py) checks who holds the task, counts the action against its
hourly limit and records what happened; this module talks to GitHub and checks the diff.

The rules every call here follows:

- The token only, as `Authorization: Bearer`, only to https://api.github.com, with
  `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`. The token is
  never logged, stored, put in a URL or an error, or echoed: a failure is logged as the
  endpoint's name and GitHub's status, nothing else.
- 5 s to connect and 8 s for each whole call, and 40 s for the whole action, its claim
  lookup and public reads included (no call starts after it, and none runs past it), so the
  web's callback fits its platform's 60 s. No redirect is followed (a 3xx is a failure); at
  most 1 MiB of an answer is read, 8 MiB for the comparison a review checks
  (`bounded_send`, rail_adapters/base.py). The client keeps no cookies.
- Only these endpoints:

    copy    GET  /user
            POST /repos/verastd/forge-app/forks  {"default_branch_only": true}
            GET  /repos/{copy}  (every 2 s for up to 15 s, while GitHub makes a new copy)
            POST /repos/{copy}/merge-upstream  {"branch": <the copy's default branch>}
            GET  /repos/verastd/forge-app/git/ref/heads/main
            GET  /repos/{copy}/git/ref/heads/{task branch}
            POST /repos/{copy}/git/refs  {"ref": "refs/heads/{task branch}", "sha": ...}
            (and when GitHub refuses upstream main's commit there,
            GET /repos/{copy}/git/ref/heads/{default branch} to start from that instead)
    review  GET  /user
            GET  /repos/verastd/forge-app/compare/main...{owner}:{task branch}?per_page=1
                 (its first page: the commit count and the changed files)
            GET  /repos/verastd/forge-app/pulls?head={owner}:{task branch}&base=main&state=open
            POST /repos/verastd/forge-app/pulls

- Before any write, the token's GitHub account must be the caller's (`403 wrong_account`),
  and the copy must be that account's own fork whose parent is verastd/forge-app (`409
  copy_mismatch`; a fork of someone else's fork would sync with that third party).
- Before FORGE opens a pull request it checks the diff against the rules on upstream main's
  `.github/forge-protocol.json` (read publicly, services/github_reads.py): no existing test
  modified, removed or moved (`409 tests_modified`), no protected path touched (`409
  protected_paths`); a diff it can't see whole, or bigger than Foreman takes, is `409
  too_large`. Then, and only then, the description carries the pull request template's test
  attestation, checked and naming the commit FORGE checked: it is true of that diff. Only
  the caller's own pull request counts: one another account opened from their branch is
  `409 head_taken`.
- A GitHub failure is `502 github_failed` with `status`: GitHub's HTTP status, 502 for an
  answer FORGE can't use, 504 when none came in time. A 401 means the token is dead; the
  person presses the button again, which is always safe: GitHub hands back the copy that
  already exists, and a branch that exists is never touched.
"""

import logging
import re
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any, TypeGuard
from urllib.parse import quote

import httpx

from forge_api.services.brief import UPSTREAM_REPO, is_valid_copy, is_valid_login
from forge_api.services.errors import ApiError
from forge_api.services.github_reads import ProtocolRules, PullRequest, best_pull, parse_pull
from forge_api.services.rail_adapters.base import (
    STATUS_BAD_GATEWAY,
    STATUS_TIMEOUT,
    USER_AGENT,
    OutboundCall,
    ResponseTooLarge,
    TransportFailure,
    VendorResponse,
    bounded_send,
    strip_controls,
)

logger = logging.getLogger(__name__)

API_URL = "https://api.github.com"
API_VERSION = "2022-11-28"
CONNECT_TIMEOUT_SECONDS = 5.0
#: Everything one call may take, connecting and the whole answer included.
CALL_TIMEOUT_SECONDS = 8.0
#: Everything one action (one copy, one review) may take, its claim lookup and public reads
#: included: the web's callback has 60 s in all on its platform.
ACTION_BUDGET_SECONDS = 40.0
MAX_RESPONSE_BYTES = 1024 * 1024
#: The comparison a review checks carries every changed file's patch.
MAX_COMPARE_BYTES = 8 * 1024 * 1024
#: GitHub lists at most this many changed files, on the comparison's first page only: a
#: list this long may have been cut, so FORGE can't vouch for the diff.
MAX_COMPARE_FILES = 300
#: Foreman's G0.4 cap on a pull request's changed lines, additions and deletions together
#: (MAX_PR_TOTAL_CHANGES in verastd/forge apps/foreman/src/gh.ts): a bigger diff would be
#: closed with a strike, so FORGE doesn't send it.
MAX_CHANGED_LINES = 20_000
#: While GitHub makes a new copy, FORGE asks after it this often, for at most this long.
POLL_INTERVAL_SECONDS = 2.0
POLL_LIMIT_SECONDS = 15.0
#: Upstream's branch: every task branch starts from it, and every pull request targets it.
BASE_BRANCH = "main"
#: The largest integer SQLite stores: a GitHub account id is always far below it.
_MAX_ID = 2**63 - 1
#: An error names at most this many paths, each cut to this many characters.
MAX_ERROR_PATHS = 10
MAX_PATH_CHARS = 200

#: The pull request template's test attestation (.github/PULL_REQUEST_TEMPLATE.md), after its
#: checkbox. FORGE writes it checked (`attestation`), as Foreman's G0 wants it.
TEMPLATE_ATTESTATION = (
    "I did not modify or delete any existing file under `tests/acceptance/` or any other "
    "pre-existing test. Any new tests I added are new files, not edits to existing ones."
)

#: A commit id: SHA-1, or SHA-256 in a repository that uses it.
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
#: The commit upstream main was at for a comparison (its `base_commit`): 40 lowercase hex.
_BASE_SHA = re.compile(r"[0-9a-f]{40}")
#: The head commit a comparison was made at, from the end of its permalink
#: (".../compare/verastd:<base sha>...<owner>:<head sha>").
_COMPARED_HEAD = re.compile(r"\.\.\.(?:[A-Za-z0-9-]{1,39}:)?([0-9a-f]{40}|[0-9a-f]{64})$")

#: How an action tells the time (its budget, the wait for a new copy) and waits. Tests
#: replace both.
clock: Callable[[], float] = time.monotonic
wait: Callable[[float], None] = time.sleep


def make_client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    """The production client for these calls: no redirects, 5 s to connect, 8 s a call, and
    no cookies kept, since one client serves every contributor."""
    return httpx.Client(
        follow_redirects=False,
        timeout=httpx.Timeout(CALL_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        headers={"User-Agent": USER_AGENT},
        cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=[])),
        transport=transport,
    )


def github_failed(endpoint: str, status: int) -> ApiError:
    """`502 github_failed` with GitHub's status, logged as the endpoint's name and the status
    only: never a header, a body or the token."""
    logger.warning("GitHub %s failed for a contributor's action (HTTP %s)", endpoint, status)
    return ApiError(502, {"error": "github_failed", "status": status})


def copy_mismatch() -> ApiError:
    """The repository GitHub named isn't the caller's own fork of verastd/forge-app."""
    return ApiError(409, {"error": "copy_mismatch"})


def too_large() -> ApiError:
    """The diff is too big for FORGE to see whole, so it can't vouch for it."""
    return ApiError(409, {"error": "too_large"})


def checks_unavailable() -> ApiError:
    """The rules the diff is checked against can't be read: no pull request (fail closed)."""
    return ApiError(503, {"error": "checks_unavailable"})


def attestation(sha: str) -> str:
    """The template's test attestation, checked, naming the commit whose diff FORGE checked."""
    return f"- [x] {TEMPLATE_ATTESTATION} FORGE checked the diff at {sha[:7]} before sending it."


@dataclass(frozen=True)
class GitHubUser:
    """The account a token belongs to."""

    id: int
    login: str


@dataclass(frozen=True)
class CopyRepo:
    """The contributor's copy, as GitHub describes it."""

    full_name: str
    default_branch: str
    #: GitHub's id for it: it outlasts a rename of the repository or of its owner.
    repo_id: int


@dataclass(frozen=True)
class CopySetup:
    """What setting up the copy came to (CopyResult on the wire)."""

    full_name: str
    branch: str
    #: GitHub's id for the copy, and its owner's (the caller's) id.
    repo_id: int
    owner_id: int
    #: False: the copy's own main has changes of its own, so GitHub didn't bring it up to date.
    synced: bool
    #: False: the branch was already there, and was left alone.
    branch_created: bool
    #: False only when the branch was made from the copy's own main, because GitHub refused
    #: verastd/forge-app's latest main there.
    branch_from_latest: bool


@dataclass(frozen=True)
class ChangedFile:
    """One file of a comparison: its path, GitHub's status for it (added, removed,
    modified, renamed, copied, changed, unchanged) and, when moved, where it was."""

    filename: str
    status: str
    previous_filename: str | None = None
    additions: int = 0
    deletions: int = 0

    @property
    def names(self) -> tuple[str, ...]:
        """Every path the change touches: both, for a file that moved."""
        if self.previous_filename is None:
            return (self.filename,)
        return (self.previous_filename, self.filename)


@dataclass(frozen=True)
class Comparison:
    """The first page of GitHub's comparison of the task's branch with upstream main."""

    ahead_by: int
    files: tuple[ChangedFile, ...]
    #: The head commit the comparison was made at (from its permalink), when GitHub said.
    head_sha: str | None = None
    #: The commit upstream main was at for this comparison (`base_commit`), when GitHub said:
    #: the diff is checked against the protocol rules as they are at that commit.
    base_sha: str | None = None


@dataclass(frozen=True)
class AsContributor:
    """api.github.com as one contributor, for one action, with their one-time token. The
    token never appears in a repr, a log line or an error."""

    client: httpx.Client = field(repr=False)
    token: str = field(repr=False)
    #: When the whole action must be over (`clock()`): no call starts after it, and none
    #: runs past it.
    deadline: float = field(default_factory=lambda: clock() + ACTION_BUDGET_SECONDS)

    def send(
        self,
        endpoint: str,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, str] | None = None,
        limit: int = MAX_RESPONSE_BYTES,
        oversize: ApiError | None = None,
    ) -> VendorResponse:
        """One call to `path` on api.github.com. `endpoint` names it in the log. An answer
        over `limit` bytes raises `oversize` when given, else `github_failed`."""
        left = self.deadline - clock()
        if left <= 0:
            raise github_failed(endpoint, STATUS_TIMEOUT)
        call = OutboundCall(
            method=method,
            url=f"{API_URL}{path}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
            },
            body=body,
            params=params,
            secret_headers=frozenset({"Authorization"}),
            purpose=endpoint,
        )
        try:
            return bounded_send(
                self.client, call, limit=limit, total_timeout=min(CALL_TIMEOUT_SECONDS, left)
            )
        except ResponseTooLarge as exc:
            if oversize is not None:
                raise oversize from None
            raise github_failed(endpoint, exc.status) from None
        except TransportFailure as exc:
            raise github_failed(endpoint, exc.status) from None


# --- reading GitHub's answers ---------------------------------------------------------


def _json(endpoint: str, response: VendorResponse) -> Any:
    try:
        return response.json()
    except (ValueError, UnicodeDecodeError):
        raise github_failed(endpoint, STATUS_BAD_GATEWAY) from None


def _object(endpoint: str, response: VendorResponse) -> dict[str, Any]:
    parsed = _json(endpoint, response)
    if not isinstance(parsed, dict):
        raise github_failed(endpoint, STATUS_BAD_GATEWAY)
    return parsed


def _account_id(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= _MAX_ID:
        return value
    return None


def _branch_ok(name: object) -> TypeGuard[str]:
    """A branch name FORGE may put in a URL path: what git allows (no `..`, no leading `/`
    or `-`, no whitespace or control characters), at most 255 characters."""
    return (
        isinstance(name, str)
        and 0 < len(name) <= 255
        and ".." not in name
        and not name.startswith(("/", "-"))
        and name.isprintable()
        and " " not in name
    )


def _ref_path(full_name: str, branch: str) -> str:
    return f"/repos/{full_name}/git/ref/heads/{quote(branch, safe='/')}"


def _parent(repo: Mapping[str, Any]) -> str:
    """The repository a fork was made from (lowercased): only verastd/forge-app will do, since
    `merge-upstream` syncs with the parent, never with the root of the network."""
    parent = repo.get("parent")
    return str(parent.get("full_name", "")).lower() if isinstance(parent, dict) else ""


def _copy_repo(endpoint: str, repo: Mapping[str, Any], user: GitHubUser) -> CopyRepo:
    """The copy GitHub described: it must be named like a repository and owned by `user`."""
    full_name, default_branch = repo.get("full_name"), repo.get("default_branch")
    if not is_valid_copy(full_name):
        raise github_failed(endpoint, STATUS_BAD_GATEWAY)
    if not _branch_ok(default_branch):
        raise github_failed(endpoint, STATUS_BAD_GATEWAY)
    repo_id = _account_id(repo.get("id"))
    if repo_id is None:
        raise github_failed(endpoint, STATUS_BAD_GATEWAY)
    owner = repo.get("owner")
    if not isinstance(owner, dict) or _account_id(owner.get("id")) != user.id:
        raise copy_mismatch()
    return CopyRepo(full_name=full_name, default_branch=default_branch, repo_id=repo_id)


# --- both actions ---------------------------------------------------------------------


def caller(gh: AsContributor, caller_sub: str) -> GitHubUser:
    """`GET /user`: the token's account, which must be the caller's (`403 wrong_account`)."""
    response = gh.send("user", "GET", "/user")
    if response.status != 200:
        raise github_failed("user", response.status)
    body = _object("user", response)
    user_id, login = _account_id(body.get("id")), body.get("login")
    if user_id is None or not is_valid_login(login):
        raise github_failed("user", STATUS_BAD_GATEWAY)
    if str(user_id) != caller_sub:
        raise ApiError(403, {"error": "wrong_account"})
    return GitHubUser(id=user_id, login=login)


# --- copy -----------------------------------------------------------------------------


def fork(gh: AsContributor, user: GitHubUser) -> CopyRepo:
    """`POST /repos/verastd/forge-app/forks`: the caller's copy. GitHub answers with the copy
    they already have when there is one, possibly under another name (forge-app-1)."""
    response = gh.send(
        "fork", "POST", f"/repos/{UPSTREAM_REPO}/forks", body={"default_branch_only": True}
    )
    if not response.ok:
        raise github_failed("fork", response.status)
    return _copy_repo("fork", _object("fork", response), user)


def wait_for_copy(gh: AsContributor, user: GitHubUser, full_name: str) -> CopyRepo:
    """`GET /repos/{copy}` until GitHub has made it (every 2 s, for at most 15 s and never past
    the action's budget; then `504 copy_not_ready`, and pressing again is safe). It must be a
    fork whose parent is verastd/forge-app, owned by the caller (`409 copy_mismatch`)."""
    deadline = min(clock() + POLL_LIMIT_SECONDS, gh.deadline)
    while True:
        response = gh.send("repo", "GET", f"/repos/{full_name}")
        if response.status == 200:
            repo = _object("repo", response)
            if repo.get("fork") is not True or _parent(repo) != UPSTREAM_REPO.lower():
                raise copy_mismatch()
            return _copy_repo("repo", repo, user)
        if response.status != 404:
            raise github_failed("repo", response.status)
        if clock() + POLL_INTERVAL_SECONDS > deadline:
            raise ApiError(504, {"error": "copy_not_ready"})
        wait(POLL_INTERVAL_SECONDS)


def merge_upstream(gh: AsContributor, repo: CopyRepo) -> bool:
    """`POST /repos/{copy}/merge-upstream`: bring the copy's main up to date. False when
    GitHub can't (409 or 422: the copy has changes of its own); that is fine, the task's
    branch starts from upstream main whatever the copy's main holds."""
    response = gh.send(
        "merge_upstream",
        "POST",
        f"/repos/{repo.full_name}/merge-upstream",
        body={"branch": repo.default_branch},
    )
    if response.status == 200:
        return True
    if response.status in (409, 422):
        return False
    raise github_failed("merge_upstream", response.status)


def branch_sha(gh: AsContributor, endpoint: str, full_name: str, branch: str) -> str | None:
    """`GET /repos/{full_name}/git/ref/heads/{branch}`: the commit it points at, or None
    when there is no such branch (404)."""
    response = gh.send(endpoint, "GET", _ref_path(full_name, branch))
    if response.status == 404:
        return None
    if response.status != 200:
        raise github_failed(endpoint, response.status)
    target = _object(endpoint, response).get("object")
    sha = target.get("sha") if isinstance(target, dict) else None
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise github_failed(endpoint, STATUS_BAD_GATEWAY)
    return sha


def create_branch(gh: AsContributor, full_name: str, branch: str, sha: str) -> bool:
    """`POST /repos/{copy}/git/refs`: make `branch` at `sha`. False when GitHub refuses that
    commit there (422)."""
    response = gh.send(
        "create_ref",
        "POST",
        f"/repos/{full_name}/git/refs",
        body={"ref": f"refs/heads/{branch}", "sha": sha},
    )
    if response.status == 201:
        return True
    if response.status == 422:
        return False
    raise github_failed("create_ref", response.status)


def set_up_copy(gh: AsContributor, user: GitHubUser, branch: str) -> CopySetup:
    """The caller's copy, up to date, with the task's branch in it: made from upstream's
    latest main when it is new. A branch that is already there is never touched, so
    nobody's work is reset."""
    repo = wait_for_copy(gh, user, fork(gh, user).full_name)
    synced = merge_upstream(gh, repo)
    latest = branch_sha(gh, "upstream_ref", UPSTREAM_REPO, BASE_BRANCH)
    if latest is None:
        raise github_failed("upstream_ref", 404)

    def done(created: bool, from_latest: bool = True) -> CopySetup:
        return CopySetup(
            repo.full_name, branch, repo.repo_id, user.id, synced, created, from_latest
        )

    if branch_sha(gh, "branch_ref", repo.full_name, branch) is not None:
        return done(created=False)
    if create_branch(gh, repo.full_name, branch, latest):
        return done(created=True)
    own = branch_sha(gh, "default_ref", repo.full_name, repo.default_branch)
    if own is None:
        raise github_failed("default_ref", 404)
    if not create_branch(gh, repo.full_name, branch, own):
        raise github_failed("create_ref", 422)
    return done(created=True, from_latest=False)


# --- review ---------------------------------------------------------------------------


def _changed_file(raw: object) -> ChangedFile | None:
    if not isinstance(raw, dict):
        return None
    filename, status, previous = (
        raw.get("filename"),
        raw.get("status"),
        raw.get("previous_filename"),
    )
    if not isinstance(filename, str) or not filename or not isinstance(status, str):
        return None
    if previous is not None and (not isinstance(previous, str) or not previous):
        return None
    counts = (raw.get("additions", 0), raw.get("deletions", 0))
    if not all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in counts):
        return None
    return ChangedFile(filename, status, previous, additions=counts[0], deletions=counts[1])


def compare(gh: AsContributor, owner: str, branch: str) -> Comparison | None:
    """`GET /repos/verastd/forge-app/compare/main...{owner}:{branch}?per_page=1`: how many
    commits the branch has that upstream main doesn't, and the files it changes (GitHub
    lists them on the first page only, up to 300). None when there is no such branch (404).
    An answer over 8 MiB is `409 too_large`."""
    response = gh.send(
        "compare",
        "GET",
        f"/repos/{UPSTREAM_REPO}/compare/{BASE_BRANCH}...{owner}:{quote(branch, safe='/')}",
        params={"per_page": "1"},
        limit=MAX_COMPARE_BYTES,
        oversize=too_large(),
    )
    if response.status == 404:
        return None
    if response.status != 200:
        raise github_failed("compare", response.status)
    body = _object("compare", response)
    ahead, listed = body.get("ahead_by"), body.get("files")
    if not isinstance(ahead, int) or isinstance(ahead, bool) or ahead < 0:
        raise github_failed("compare", STATUS_BAD_GATEWAY)
    files = [_changed_file(raw) for raw in listed] if isinstance(listed, list) else [None]
    if any(changed is None for changed in files):
        raise github_failed("compare", STATUS_BAD_GATEWAY)
    link = body.get("permalink_url")
    head = _COMPARED_HEAD.search(link) if isinstance(link, str) else None
    base = body.get("base_commit")
    base_sha = base.get("sha") if isinstance(base, dict) else None
    return Comparison(
        ahead_by=ahead,
        files=tuple(file for file in files if file is not None),
        head_sha=head.group(1) if head else None,
        base_sha=base_sha if isinstance(base_sha, str) and _BASE_SHA.fullmatch(base_sha) else None,
    )


#: Glob syntax minimatch (Foreman, `{dot: true}`) and git's `:(glob)` pathspecs
#: (tools/forge/test-mod-detector.sh) read alike: `*` and `?` within one path segment, `**`
#: as a whole segment for any number of segments, none included. Anything else (character
#: classes, braces, extglobs, escapes, negation, a comment, an empty segment) the two don't
#: read the same way, so FORGE doesn't guess: the rules count as unreadable.
_UNSUPPORTED_GLOB = re.compile(r"[\[\]{}()\\]|^[!#]")


def glob_pattern(glob: str) -> re.Pattern[str] | None:
    """A `testGlobs` entry as a regular expression for a whole repository path, or None
    when it uses syntax the two detectors could read differently."""
    if not glob or _UNSUPPORTED_GLOB.search(glob):
        return None
    segments = glob.split("/")
    if "" in segments:
        return None
    regex = ""
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if segment == "**":
            # Last: everything below (not the directory itself); else zero or more segments.
            regex += ".*" if last else "(?:[^/]+/)*"
            continue
        regex += "".join(
            "[^/]*" if char == "*" else "[^/]" if char == "?" else re.escape(char)
            for char in segment
        )
        if not last:
            regex += "/"
    return re.compile(regex)


def is_protected(path: str, protected: Iterable[str]) -> bool:
    """Foreman's protectedPaths grammar (protocol.ts `protectedPaths`): an entry ending in
    `/` is a directory prefix, anything else an exact path. Case matters."""
    return any(
        path.startswith(entry) if entry.endswith("/") else path == entry for entry in protected
    )


#: Statuses that leave every file that was there before as it was: a new file, or nothing.
#: Any other status counts as changing one, including one GitHub may add later (fail closed)
#: and "copied", which Foreman's testChangeFiles counts too.
_LEAVES_EXISTING = frozenset({"added", "unchanged"})


def _reported(paths: Iterable[str]) -> list[str]:
    """Paths for an error body: plain, each once, at most MAX_ERROR_PATHS of them, each cut."""
    plain = (strip_controls(path)[:MAX_PATH_CHARS] for path in paths)
    return list(dict.fromkeys(path for path in plain if path))[:MAX_ERROR_PATHS]


def check_diff(comparison: Comparison, rules: ProtocolRules) -> None:
    """What makes the template's test attestation true of this diff, checked before any
    write: GitHub showed all of it (`409 too_large` at 300 files) and it is within Foreman's
    20,000 changed lines (`409 too_large`), no existing test was modified, removed or moved
    (`409 tests_modified`, both names of a moved file checked), and no protected path was
    touched in any way (`409 protected_paths`). Rules FORGE can't read alike with Foreman are
    `503 checks_unavailable`."""
    if len(comparison.files) >= MAX_COMPARE_FILES:
        raise too_large()
    if sum(file.additions + file.deletions for file in comparison.files) > MAX_CHANGED_LINES:
        raise too_large()
    patterns = [glob_pattern(glob) for glob in rules.test_globs]
    tests = [pattern for pattern in patterns if pattern is not None]
    if len(tests) != len(patterns):
        logger.warning("A testGlobs entry FORGE can't read the way Foreman does: no review")
        raise checks_unavailable()
    touched = [
        name
        for changed in comparison.files
        if changed.status not in _LEAVES_EXISTING
        for name in changed.names
        if any(pattern.fullmatch(name) for pattern in tests)
    ]
    if touched:
        raise ApiError(409, {"error": "tests_modified", "paths": _reported(touched)})
    guarded = [
        name
        for changed in comparison.files
        for name in changed.names
        if is_protected(name, rules.protected_paths)
    ]
    if guarded:
        raise ApiError(409, {"error": "protected_paths", "paths": _reported(guarded)})


def open_pull(gh: AsContributor, user: GitHubUser, owner: str, branch: str) -> PullRequest | None:
    """`GET /repos/verastd/forge-app/pulls?head={owner}:{branch}&base=main&state=open`: the
    caller's own open pull request from that branch into main, if there is one. Anyone may
    open a pull request from a public fork's branch, and GitHub allows one open pull request
    per branch and base: one another account opened is `409 head_taken`, never taken for the
    caller's (nothing is recorded or attested)."""
    response = gh.send(
        "list_pulls",
        "GET",
        f"/repos/{UPSTREAM_REPO}/pulls",
        params={"head": f"{owner}:{branch}", "base": BASE_BRANCH, "state": "open"},
    )
    if response.status != 200:
        raise github_failed("list_pulls", response.status)
    found = _json("list_pulls", response)
    if not isinstance(found, list):
        raise github_failed("list_pulls", STATUS_BAD_GATEWAY)
    pulls = [
        pull
        for pull in map(parse_pull, found)
        if pull is not None
        and pull.is_open
        and pull.head_ref == branch
        and pull.base_ref == BASE_BRANCH
        and pull.base_repo.lower() == UPSTREAM_REPO
    ]
    for pull in pulls:
        if pull.author_id != user.id or pull.head_owner_id != user.id:
            raise ApiError(409, {"error": "head_taken", "prNumber": pull.number})
    return best_pull(pulls)


def create_pull(gh: AsContributor, owner: str, branch: str, title: str, body: str) -> PullRequest:
    """`POST /repos/verastd/forge-app/pulls`: the pull request, opened as the caller, which
    the maintainers may edit."""
    response = gh.send(
        "create_pull",
        "POST",
        f"/repos/{UPSTREAM_REPO}/pulls",
        body={
            "title": title,
            "head": f"{owner}:{branch}",
            "base": BASE_BRANCH,
            "body": body,
            "maintainer_can_modify": True,
        },
    )
    if response.status != 201:
        raise github_failed("create_pull", response.status)
    pull = parse_pull(_object("create_pull", response))
    if pull is None:
        raise github_failed("create_pull", STATUS_BAD_GATEWAY)
    return pull


def pull_title(task_id: int, title: str) -> str:
    """AGENTS.md rule 8's `[#<issue>] <goal>`, with `"` as `'` as the brief writes it."""
    return f"[#{task_id}] " + strip_controls(title).replace('"', "'")


#: A `#` that would start an issue reference.
_REFERENCE = re.compile(r"#(?=[0-9])")
#: U+200B ZERO WIDTH SPACE: invisible on the page, and it stops GitHub's mention and
#: issue-reference filters, which may run after HTML entities are decoded (so `&#64;` and
#: `&#35;` alone might still mention or link).
_ZWSP = "\u200b"


def task_text(text: str) -> str:
    """Task text as a pull request carries it: one plain line that can't close or link an
    issue, mention anyone, open an HTML comment or tag, or make a checkbox or a link. `&`
    becomes `&amp;` first (so no entity in it decodes), a zero-width space goes right after
    every `@` and between a `#` and a digit after it, `<` becomes `&lt;` and `[` `&#91;`."""
    plain = strip_controls(text).replace("&", "&amp;")
    plain = _REFERENCE.sub("#" + _ZWSP, plain).replace("@", "@" + _ZWSP)
    return plain.replace("<", "&lt;").replace("[", "&#91;")


def pull_body(
    task_id: int, title: str, url: str, criteria: Sequence[str], login: str, checked_sha: str
) -> str:
    """The pull request's description. FORGE's own lines come first (`Closes`, the checked
    test attestation naming the commit FORGE checked, the AI-assistance disclosure, who sent
    it), so Foreman's G0, which reads the first match of each, always reads FORGE's. The
    task's title, link and acceptance criteria follow as neutralised text (`task_text`), the
    criteria as plain bullets; never an agent's or a member's text."""
    lines = [
        f"Closes #{task_id}",
        "",
        "## Tests",
        "",
        attestation(checked_sha),
        "",
        "## AI-assistance disclosure",
        "",
        "- [x] This PR was produced with the assistance of a coding agent / LLM.",
        "",
        "## Summary",
        "",
        f"Sent for review through FORGE by @{login}; their agent did the work.",
        "",
        f"FORGE task #{task_id}: {task_text(title)}",
        task_text(url),
    ]
    if criteria:
        lines += ["", "## Acceptance criteria", ""]
        lines += [f"- {task_text(item)}" for item in criteria]
    return "\n".join(lines)
