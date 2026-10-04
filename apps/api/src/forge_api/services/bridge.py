"""The Bridge v2: claim a task, get an agent on it, watch it, iterate, settle (PRD App. I).

Everything here acts as a real GitHub user (`Identity`: the web tier's assertion, or the
connector's OAuth token) and remembers what happened in the state database:

- `bridge_leases`: who holds which task until when (one row per claim, kept after it is
  released or runs out, so status can still answer for it), plus the upstream pull
  request FORGE matched to it: its number, state and head commit, when it closed
  without merging, and when it merged.
- `bridge_merges`: one row per (task, pull request) that merged; the profile counts these.
- `bridge_events`: the task's timeline (claimed, dispatched, opened, progress, submitted,
  released, relayed), at most the newest 200 per task. Agent-written text is stored as
  plain text: control and format characters, variation selectors and stacked combining
  marks stripped, at most 500 characters. Events an agent sent (source "agent") are
  shown to the lease holder only; everyone else sees FORGE's own.
- `bridge_dispatches`: every hand-off and every vendor call FORGE made (start, open,
  relay), which also feeds the 10-an-hour limit on vendor calls per user, with a keyed
  fingerprint of the credential that started a session (never the credential itself).
- `bridge_submits`: when each contributor handed in a pull request (10 a minute at most).

A lease holds its task while its clock runs, and past it while its pull request is open:
the clock waits while the maintainers have the ball (PRD §4 Stage 3). A pull request
closed without merging lets the clock run on from the close, with at least 24 hours to
go. A merged one settles the lease: the task stays off the open board, and the lease
stops counting toward the claim limit. A pull request counts for a lease only when it
targets verastd/forge-app, comes from the holder's own fork (by GitHub user id), was
opened after the claim, and names the task (it comes from the task's branch, or has
`[#<id>]` in its title or "Closes #<id>" in its description); it belongs to one task at
most.

Status is derived from those records and from GitHub, never from a timer:

    claimed          a lease and nothing else yet
    agent_working    an agent was started or opened, or reported progress, or its pull
                     request was closed without merging
    ready_to_submit  the agent says it pushed, opened the pull request or is done, but
                     no upstream pull request is found yet
    in_checks        the upstream pull request is open; checks pending or failing
    in_review        every check passed
    shipped          merged

(`shipping` stays in the stage list for the web app but nothing produces it: GitHub's
REST pull request has no review decision to read.) Status and check reads keep the pull
request recorded on the lease in step with GitHub (a merge is counted once, a close is
noted once); they never change anything a contributor did. Leases are FORGE's own until
Foreman's claim API is wired in; Foreman's ledger stays the long-term source of truth.
"""

import hashlib
import hmac
import json
import logging
import math
import os
import re
import sqlite3
import threading
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol, cast

import httpx
from pydantic import ValidationError

from forge_api.models import (
    RAILS,
    START_RAILS,
    BridgeEvent,
    BridgeEventKind,
    BridgeEventSource,
    BridgeStage,
    BridgeStatus,
    CheckResults,
    ClaimResponse,
    ContributorProfile,
    Credential,
    DispatchRequest,
    DispatchResult,
    FeedbackResponse,
    ForkStatus,
    LedgerEvent,
    ProgressStage,
    Rail,
    RailInfo,
    RailList,
    RewardClass,
    SavedCredentialList,
    Size,
    StartRail,
    TaskCard,
    TaskDetail,
    TaskList,
    Tier,
    TierFloor,
)
from forge_api.services import flags as flags_service
from forge_api.services.brief import UPSTREAM_REPO, branch_name, compile_brief, is_valid_login
from forge_api.services.errors import ApiError
from forge_api.services.github_reads import (
    PASSING,
    GitHubReads,
    GitHubUnavailable,
    PullRequest,
    best_pull,
    check_state,
    failure_notes,
    pull_url,
)
from forge_api.services.identity import Identity
from forge_api.services.rail_adapters import (
    ADAPTERS,
    AdapterError,
    AdapterRequest,
    RailCredential,
    adapter_for,
    make_client,
)
from forge_api.services.rail_adapters.base import (
    JSONTooDeep,
    log_failure,
    parse_json,
    strip_controls,
)
from forge_api.services.rail_adapters.claude_routine import API_URL as ROUTINE_API_URL
from forge_api.services.rail_adapters.claude_routine import trigger_id
from forge_api.services.rail_adapters.devin import valid_org_id
from forge_api.services.rails import RAIL_REGISTRY, rail_meta
from forge_api.services.state import StateDB, get_state_db, register_schema
from forge_api.services.vault import Vault, master_key

logger = logging.getLogger(__name__)

# --- settings -------------------------------------------------------------------------

#: Lease length by size class (PRD §4 Stage 3).
LEASE_HOURS_BY_SIZE: dict[Size, int] = {"XS": 48, "S": 48, "M": 96}
MAX_ACTIVE_CLAIMS_ENV = "FORGE_MAX_ACTIVE_CLAIMS"
DEFAULT_MAX_ACTIVE_CLAIMS = 2
START_RAILS_ENV = "FORGE_START_RAILS"
AGENT_START_FLAG = "agent_start"
#: Vendor calls (starts and relayed notes) per user per window.
DISPATCH_LIMIT = 10
DISPATCH_WINDOW = timedelta(hours=1)
#: A start on the same task and rail this recent (or still on its way) is answered with
#: `already_started` instead of a second vendor call: a retried click starts nothing new.
START_DEDUPE = timedelta(minutes=2)
#: Agent-written text is cut to this many characters.
MAX_MESSAGE = 500
#: Combining marks one character keeps; a taller stack ("Zalgo" text) is cut to this.
MAX_COMBINING_MARKS = 2
#: The newest events a status shows.
MAX_EVENTS_SHOWN = 50
#: The newest events a task keeps, all its leases together; older ones are deleted.
MAX_EVENTS_KEPT = 200
#: Progress reports a task takes per PROGRESS_WINDOW, all its leases together.
PROGRESS_LIMIT = 30
PROGRESS_WINDOW = timedelta(hours=1)
#: Clicking the same open-rail link again within this window records nothing new.
OPENED_DEDUPE = timedelta(minutes=5)
#: Progress stages after which the work is ready to hand in.
READY_STAGES: frozenset[str] = frozenset({"pushed", "pr_opened", "done"})
#: Contributor tiers, lowest first (PRD Appendix F).
TIER_ORDER: tuple[Tier, ...] = ("T0", "T1", "T2", "T3")
#: Once your lease on a task ends (released, or out of time), that task can't be yours
#: again for this long. Anyone else may claim it at once.
CLAIM_COOLDOWN = timedelta(hours=24)
#: New claims one contributor may make per CLAIM_WINDOW.
CLAIM_RATE_LIMIT = 20
CLAIM_WINDOW = timedelta(hours=24)
#: Pull requests one contributor may hand in (web and connector together) per window.
SUBMIT_LIMIT = 10
SUBMIT_WINDOW = timedelta(minutes=1)
#: While its pull request is open a lease never has less than this left, and once the
#: pull request closes without merging the clock runs on with at least this long to go.
PULL_GRACE = timedelta(hours=24)

#: A key as a contributor pastes it: printable ASCII, no spaces.
_KEY = re.compile(r"[\x21-\x7e]{1,4096}")
_PR_URL = re.compile(
    r"https://github\.com/" + re.escape(UPSTREAM_REPO) + r"/pull/([1-9][0-9]{0,9})/?",
    re.IGNORECASE,
)

_FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "tasks.json"

# --- small helpers --------------------------------------------------------------------

_DB_TIME = "%Y-%m-%dT%H:%M:%S.%fZ"


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    """ISO 8601 with a Z suffix — the format the web app parses."""
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _to_db(moment: datetime) -> str:
    # Fixed width (always microseconds), so stored times sort as text.
    return moment.astimezone(UTC).strftime(_DB_TIME)


def _from_db(value: str) -> datetime:
    return datetime.strptime(value, _DB_TIME).replace(tzinfo=UTC)


def _retry_after(when: datetime, now: datetime) -> int:
    """Whole seconds from `now` until `when`, at least 1: a Retry-After value."""
    return max(1, math.ceil((when - now).total_seconds()))


def _variation_selector(char: str) -> bool:
    code = ord(char)
    return 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF


def clean_text(text: str, limit: int = MAX_MESSAGE) -> str:
    """Untrusted text as FORGE stores it: plain, one line, at most `limit` characters.

    Control and format characters go, and so do variation selectors (invisible, they
    can carry a hidden byte stream); no character keeps more than MAX_COMBINING_MARKS
    combining marks.
    """
    plain = strip_controls("".join(char for char in text if not _variation_selector(char)))
    kept: list[str] = []
    marks = 0
    for char in plain:
        if unicodedata.category(char) in ("Mn", "Me"):
            marks += 1
            if marks > MAX_COMBINING_MARKS:
                continue
        else:
            marks = 0
        kept.append(char)
    return "".join(kept)[:limit]


def parse_pr_url(value: object) -> int | None:
    """The number in `https://github.com/verastd/forge-app/pull/<n>`, else None."""
    if not isinstance(value, str):
        return None
    match = _PR_URL.fullmatch(value.strip())
    return int(match.group(1)) if match else None


def compare_url(login: str, branch: str) -> str:
    """GitHub's "open a pull request" page, from the contributor's branch to main."""
    return f"https://github.com/{UPSTREAM_REPO}/compare/main...{login}:{branch}?expand=1"


def parse_dispatch(body: bytes) -> DispatchRequest:
    """The /dispatch body, validated without ever echoing it: FastAPI's own 422 would
    send the pasted key back in its `input` field. A body nested deeper than 32 is a 400
    before it is parsed, as on every other Bridge route (main.py), never a 500."""
    try:
        data = parse_json(body)
    except JSONTooDeep:
        raise ApiError(400, {"error": "invalid_request", "fields": ["body"]}) from None
    except (ValueError, UnicodeDecodeError):
        raise ApiError(422, {"error": "invalid_request", "fields": ["body"]}) from None
    if not isinstance(data, dict):
        raise ApiError(422, {"error": "invalid_request", "fields": ["body"]})
    try:
        return DispatchRequest.model_validate(data)
    except ValidationError as exc:
        fields = sorted(
            {
                ".".join(str(part) for part in error["loc"])
                for error in exc.errors(include_url=False, include_input=False)
            }
        )
        if any(field.startswith("credential") for field in fields):
            payload: dict[str, Any] = {"error": "credential_invalid", "fields": fields}
            if data.get("rail") in RAILS:
                payload["rail"] = data["rail"]
            raise ApiError(400, payload) from None
        raise ApiError(422, {"error": "invalid_request", "fields": fields}) from None


def credential_fingerprint(sub: str, rail: str, credential: RailCredential) -> str | None:
    """A keyed fingerprint (HMAC-SHA256 under the vault's master key) of the credential
    a session was started with, so a relay can tell whether the saved key is that same
    one without FORGE keeping a key nobody asked it to save. None while the vault is
    off: nothing is saved then, so there is no key a relay could use anyway."""
    master = master_key()
    if master is None:
        return None
    message = "\x00".join(
        (
            "forge-credential-fingerprint:v1",
            sub,
            rail,
            credential.key,
            credential.org_id or "",
            credential.routine_url or "",
        )
    )
    return hmac.new(master, message.encode(), hashlib.sha256).hexdigest()


# --- schema ---------------------------------------------------------------------------

register_schema(
    "bridge",
    [
        """CREATE TABLE IF NOT EXISTS bridge_leases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            holder_sub TEXT NOT NULL,
            holder_login TEXT NOT NULL,
            claimed_at TEXT NOT NULL,
            lease_hours INTEGER NOT NULL,
            ends_at TEXT NOT NULL,
            released_at TEXT,
            pr_number INTEGER,
            pr_state TEXT,
            pr_head_sha TEXT,
            pr_closed_at TEXT,
            merged_at TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_leases_task ON bridge_leases (task_id, id)",
        "CREATE INDEX IF NOT EXISTS bridge_leases_holder ON bridge_leases (holder_sub, id)",
        "CREATE INDEX IF NOT EXISTS bridge_leases_claims ON bridge_leases (holder_sub, claimed_at)",
        # A pull request belongs to one lease (so to one task) at most.
        "CREATE UNIQUE INDEX IF NOT EXISTS bridge_leases_pull ON bridge_leases (pr_number) "
        "WHERE pr_number IS NOT NULL",
        """CREATE TABLE IF NOT EXISTS bridge_merges (
            task_id INTEGER NOT NULL,
            pr_number INTEGER NOT NULL,
            lease_id INTEGER NOT NULL REFERENCES bridge_leases (id) ON DELETE CASCADE,
            holder_sub TEXT NOT NULL,
            merged_at TEXT NOT NULL,
            PRIMARY KEY (task_id, pr_number)
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_merges_holder ON bridge_merges (holder_sub)",
        """CREATE TABLE IF NOT EXISTS bridge_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lease_id INTEGER NOT NULL REFERENCES bridge_leases (id) ON DELETE CASCADE,
            at TEXT NOT NULL,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            message TEXT NOT NULL,
            rail TEXT,
            stage TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_events_lease ON bridge_events (lease_id, id)",
        """CREATE TABLE IF NOT EXISTS bridge_dispatches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lease_id INTEGER NOT NULL REFERENCES bridge_leases (id) ON DELETE CASCADE,
            sub TEXT NOT NULL,
            rail TEXT NOT NULL,
            mode TEXT NOT NULL,
            outcome TEXT NOT NULL,
            at TEXT NOT NULL,
            session_url TEXT,
            session_ref TEXT,
            credential_fingerprint TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_dispatches_lease ON bridge_dispatches (lease_id, id)",
        "CREATE INDEX IF NOT EXISTS bridge_dispatches_sub ON bridge_dispatches (sub, at)",
        """CREATE TABLE IF NOT EXISTS bridge_submits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sub TEXT NOT NULL,
            at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_submits_sub ON bridge_submits (sub, at)",
    ],
)

# --- task sources ---------------------------------------------------------------------


@dataclass(frozen=True)
class TaskFixture:
    """A Task Spec as the Bridge needs it: card fields plus acceptance criteria.

    `acceptanceCriteria` feeds the brief only; it is stripped before the card goes over
    the wire, so TaskCard stays exactly the shared zod shape.
    """

    id: int
    title: str
    civilianSummary: str
    size: Size
    rewardClass: RewardClass
    tierFloor: TierFloor
    url: str
    labels: list[str]
    acceptanceCriteria: list[str]

    def to_card(self, claimed_by: str | None = None, lease_ends_at: str | None = None) -> TaskCard:
        return TaskCard(
            id=self.id,
            title=self.title,
            civilianSummary=self.civilianSummary,
            size=self.size,
            rewardClass=self.rewardClass,
            tierFloor=self.tierFloor,
            status="claimed" if claimed_by is not None else "open",
            url=self.url,
            labels=list(self.labels),
            claimedBy=claimed_by,
            leaseEndsAt=lease_ends_at,
        )


class TaskSource(Protocol):
    """Where agent-ready tasks come from: the committed fixtures."""

    def list_tasks(self) -> list[TaskFixture]: ...

    def get_task(self, task_id: int) -> TaskFixture | None: ...


class FixtureTaskSource:
    """Reads the committed starter tasks (PRD Appendix H.3 self-hosting list)."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or _FIXTURE_PATH
        self._cache: list[TaskFixture] | None = None

    def list_tasks(self) -> list[TaskFixture]:
        if self._cache is None:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._cache = [TaskFixture(**item) for item in raw]
        return list(self._cache)

    def get_task(self, task_id: int) -> TaskFixture | None:
        return next((task for task in self.list_tasks() if task.id == task_id), None)


class GitHubTaskSource:
    """Waits for the Foreman claim linkage; until then the fixtures are the only tasks."""

    def list_tasks(self) -> list[TaskFixture]:
        raise NotImplementedError

    def get_task(self, task_id: int) -> TaskFixture | None:
        raise NotImplementedError


# --- Phase 5: tasks published from proposals (contract §3) ----------------------------
#
# Everything in this block is new. The Phase 4 code above and below is unchanged apart
# from two lines marked "Phase 5" (the shipped hook's call in LeaseStore.record_pull, and
# the default `_source`) and get_task_source's docstring.
#
# A passed proposal becomes a task here once an admin publishes it (services/proposals.py).
# Published tasks live in their own new table, with ids from 10001 up so they never
# collide with issue numbers. The link from a task back to its proposal is the proposals
# service's own table (proposal_tasks), so this block knows nothing about proposals: it
# stores the card it is given, serves it next to the fixtures, and tells whoever
# registered with `on_task_shipped` when a task's pull request is recorded as merged.

#: The first id a published task gets.
PUBLISHED_TASK_FIRST_ID = 10001
#: The largest integer SQLite stores: a larger task id is no published task.
_SQLITE_MAX_INT = 2**63 - 1

register_schema(
    "bridge_published",
    [
        """CREATE TABLE IF NOT EXISTS bridge_published_tasks (
            id INTEGER PRIMARY KEY CHECK (id >= 10001),
            title TEXT NOT NULL,
            civilian_summary TEXT NOT NULL,
            size TEXT NOT NULL,
            reward_class TEXT NOT NULL,
            tier_floor TEXT NOT NULL,
            url TEXT NOT NULL,
            labels TEXT NOT NULL,
            acceptance_criteria TEXT NOT NULL,
            published_at TEXT NOT NULL,
            published_by TEXT NOT NULL
        )""",
    ],
)


def _published_task(row: Mapping[str, Any]) -> TaskFixture:
    return TaskFixture(
        id=row["id"],
        title=row["title"],
        civilianSummary=row["civilian_summary"],
        size=row["size"],
        rewardClass=row["reward_class"],
        tierFloor=row["tier_floor"],
        url=row["url"],
        labels=list(json.loads(row["labels"])),
        acceptanceCriteria=list(json.loads(row["acceptance_criteria"])),
    )


class PublishedTaskSource:
    """The tasks admins published from passed proposals (`bridge_published_tasks`).

    `db` defaults to the process's state database, looked up on each use (as LeaseStore's).
    """

    def __init__(self, db: StateDB | None = None) -> None:
        self._db = db

    @property
    def db(self) -> StateDB:
        return self._db if self._db is not None else get_state_db()

    def list_tasks(self) -> list[TaskFixture]:
        rows = self.db.query_all("SELECT * FROM bridge_published_tasks ORDER BY id")
        return [_published_task(row) for row in rows]

    def get_task(self, task_id: int) -> TaskFixture | None:
        if not PUBLISHED_TASK_FIRST_ID <= task_id <= _SQLITE_MAX_INT:
            return None
        row = self.db.query_one("SELECT * FROM bridge_published_tasks WHERE id = ?", (task_id,))
        return _published_task(row) if row else None


class CompositeTaskSource:
    """Several sources as one board: each one's tasks in turn. A lookup asks each source in
    order and takes the first that has the id (the fixtures and the published tasks never
    share one)."""

    def __init__(self, *sources: TaskSource) -> None:
        self._sources = sources

    def list_tasks(self) -> list[TaskFixture]:
        return [task for source in self._sources for task in source.list_tasks()]

    def get_task(self, task_id: int) -> TaskFixture | None:
        for source in self._sources:
            task = source.get_task(task_id)
            if task is not None:
                return task
        return None


def publish_task(
    db: StateDB,
    *,
    title: str,
    civilian_summary: str,
    acceptance_criteria: list[str],
    size: Size,
    tier_floor: TierFloor,
    reward_class: RewardClass,
    url: str,
    labels: list[str],
    published_by: str,
    now: datetime,
) -> TaskFixture:
    """Put a new task on the board, numbered after every task published so far (10001
    first). Runs in the caller's transaction when there is one, so a publish that fails
    later leaves no task behind."""
    with db.transaction():
        row = db.query_one(
            "SELECT COALESCE(MAX(id), ?) + 1 AS next_id FROM bridge_published_tasks",
            (PUBLISHED_TASK_FIRST_ID - 1,),
        )
        task_id = int(row["next_id"]) if row else PUBLISHED_TASK_FIRST_ID
        db.execute(
            "INSERT INTO bridge_published_tasks (id, title, civilian_summary, size, "
            "reward_class, tier_floor, url, labels, acceptance_criteria, published_at, "
            "published_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                task_id,
                title,
                civilian_summary,
                size,
                reward_class,
                tier_floor,
                url,
                json.dumps(labels),
                json.dumps(acceptance_criteria),
                _to_db(now),
                published_by,
            ),
        )
        created = db.query_one("SELECT * FROM bridge_published_tasks WHERE id = ?", (task_id,))
    assert created is not None
    return _published_task(created)


def task_merged(db: StateDB, task_id: int) -> bool:
    """Whether a pull request for this task was recorded as merged (`bridge_merges`)."""
    row = db.query_one("SELECT 1 AS hit FROM bridge_merges WHERE task_id = ? LIMIT 1", (task_id,))
    return row is not None


#: Called as hook(db, task_id, now) when a task's pull request is recorded as merged,
#: inside the transaction that records it.
ShippedHook = Callable[[StateDB, int, datetime], None]
_shipped_hooks: list[ShippedHook] = []


def on_task_shipped(hook: ShippedHook) -> None:
    """Register `hook` to hear about every merge the Bridge records (once per hook)."""
    if hook not in _shipped_hooks:
        _shipped_hooks.append(hook)


def _task_shipped(db: StateDB, task_id: int, now: datetime) -> None:
    """Run every shipped hook, each in its own savepoint: a hook that fails is logged and
    its writes undone, and the merge it was told about stays recorded."""
    for hook in list(_shipped_hooks):
        try:
            with db.transaction():
                hook(db, task_id, now)
        except Exception:
            logger.exception("A shipped hook failed for task %s", task_id)


# --- end of Phase 5 block -------------------------------------------------------------

# --- the store ------------------------------------------------------------------------


@dataclass(frozen=True)
class Lease:
    id: int
    task_id: int
    holder_sub: str
    holder_login: str
    claimed_at: datetime
    lease_hours: int
    ends_at: datetime
    released_at: datetime | None
    pr_number: int | None
    merged_at: datetime | None
    #: The recorded pull request's state ("open" or "closed"), its head commit, and when
    #: it closed without being merged.
    pr_state: str | None = None
    pr_head_sha: str | None = None
    pr_closed_at: datetime | None = None

    @property
    def merged(self) -> bool:
        return self.merged_at is not None

    @property
    def pull_open(self) -> bool:
        """Its pull request is open: the clock waits on the maintainers."""
        return self.pr_number is not None and self.pr_state == "open" and not self.merged

    @property
    def pull_closed(self) -> bool:
        """Its pull request was closed without being merged."""
        return self.pr_number is not None and self.pr_state == "closed" and not self.merged

    def is_active(self, now: datetime) -> bool:
        """It holds the task: not released, and merged, waiting on its open pull
        request, or still in time."""
        return self.released_at is None and (self.merged or self.pull_open or now < self.ends_at)

    def effective_end(self, now: datetime) -> datetime:
        """When it runs out: `ends_at`, but never less than a day away while its pull
        request is open."""
        return max(self.ends_at, now + PULL_GRACE) if self.pull_open else self.ends_at

    def ended_at(self, now: datetime) -> datetime | None:
        """When it stopped holding the task (released, or out of time), or None."""
        if self.released_at is not None:
            return self.released_at
        return None if self.is_active(now) else self.ends_at


@dataclass(frozen=True)
class DispatchRecord:
    id: int
    rail: Rail
    mode: str
    outcome: str
    at: datetime
    session_url: str | None
    session_ref: str | None
    #: Keyed fingerprint of the credential a start used (credential_fingerprint).
    fingerprint: str | None = None


@dataclass(frozen=True)
class Merge:
    task_id: int
    pr_number: int
    merged_at: datetime


def _lease(row: Mapping[str, Any]) -> Lease:
    return Lease(
        id=row["id"],
        task_id=row["task_id"],
        holder_sub=row["holder_sub"],
        holder_login=row["holder_login"],
        claimed_at=_from_db(row["claimed_at"]),
        lease_hours=row["lease_hours"],
        ends_at=_from_db(row["ends_at"]),
        released_at=_from_db(row["released_at"]) if row["released_at"] else None,
        pr_number=row["pr_number"],
        merged_at=_from_db(row["merged_at"]) if row["merged_at"] else None,
        pr_state=row["pr_state"],
        pr_head_sha=row["pr_head_sha"],
        pr_closed_at=_from_db(row["pr_closed_at"]) if row["pr_closed_at"] else None,
    )


def _dispatch(row: Mapping[str, Any]) -> DispatchRecord:
    return DispatchRecord(
        id=row["id"],
        rail=row["rail"],
        mode=row["mode"],
        outcome=row["outcome"],
        at=_from_db(row["at"]),
        session_url=row["session_url"],
        session_ref=row["session_ref"],
        fingerprint=row["credential_fingerprint"],
    )


class LeaseStore:
    """The Bridge's records in the state database, read against an injectable clock.

    `db` defaults to the process's state database (`get_state_db()`), looked up on each
    use, so a test that points FORGE_STATE_DB_PATH at a fresh file gets a fresh store.
    """

    def __init__(
        self, now_fn: Callable[[], datetime] | None = None, db: StateDB | None = None
    ) -> None:
        self._now_fn = now_fn or utc_now
        self._db = db

    def now(self) -> datetime:
        return self._now_fn()

    @property
    def db(self) -> StateDB:
        return self._db if self._db is not None else get_state_db()

    def with_db(self, db: StateDB) -> "LeaseStore":
        """The same clock over an explicit database (the connector's ToolContext.db)."""
        return LeaseStore(self._now_fn, db)

    # leases

    def latest(self, task_id: int) -> Lease | None:
        """The newest lease ever taken on this task, active or not."""
        row = self.db.query_one(
            "SELECT * FROM bridge_leases WHERE task_id = ? ORDER BY id DESC LIMIT 1", (task_id,)
        )
        return _lease(row) if row else None

    def lease(self, lease_id: int) -> Lease | None:
        row = self.db.query_one("SELECT * FROM bridge_leases WHERE id = ?", (lease_id,))
        return _lease(row) if row else None

    def active(self, task_id: int) -> Lease | None:
        lease = self.latest(task_id)
        return lease if lease is not None and lease.is_active(self.now()) else None

    def current_leases(self, task_ids: Iterable[int]) -> dict[int, Lease]:
        """The newest lease of each task: one indexed read per task, never a scan of
        every lease ever written."""
        found: dict[int, Lease] = {}
        for task_id in task_ids:
            lease = self.latest(task_id)
            if lease is not None:
                found[task_id] = lease
        return found

    def held_by(self, sub: str, *, active_only: bool = True) -> list[Lease]:
        """The caller's leases that hold a task and aren't merged yet (what the claim
        limit counts), or with active_only=False every lease they ever took."""
        if active_only:
            rows = self.db.query_all(
                "SELECT * FROM bridge_leases WHERE holder_sub = ? AND released_at IS NULL "
                "AND merged_at IS NULL AND (ends_at > ? OR pr_state = 'open') ORDER BY id",
                (sub, _to_db(self.now())),
            )
        else:
            rows = self.db.query_all(
                "SELECT * FROM bridge_leases WHERE holder_sub = ? ORDER BY id", (sub,)
            )
        return [_lease(row) for row in rows]

    def last_lease_of(self, task_id: int, sub: str) -> Lease | None:
        """The caller's newest lease on this task, active or not."""
        row = self.db.query_one(
            "SELECT * FROM bridge_leases WHERE task_id = ? AND holder_sub = ? "
            "ORDER BY id DESC LIMIT 1",
            (task_id, sub),
        )
        return _lease(row) if row else None

    def claims_since(self, sub: str, since: datetime) -> list[datetime]:
        """When the caller's claims after `since` were made, oldest first."""
        rows = self.db.query_all(
            "SELECT claimed_at FROM bridge_leases WHERE holder_sub = ? AND claimed_at > ? "
            "ORDER BY claimed_at",
            (sub, _to_db(since)),
        )
        return [_from_db(row["claimed_at"]) for row in rows]

    def claim(
        self, task_id: int, identity: Identity, lease_hours: int, max_active: int
    ) -> tuple[Lease, bool]:
        """Take the lease, atomically. Returns (lease, created); re-claiming your own
        lease returns it unchanged. Raises 409 already_claimed (someone else holds it,
        or it was merged), claim_cooldown (your own lease on it ended less than 24 h
        ago) or claim_limit, or 429 claim_rate_limit (20 new claims in 24 h)."""
        now = self.now()
        with self.db.transaction() as db:
            current = self.latest(task_id)
            if current is not None and current.is_active(now):
                if current.holder_sub == identity.sub:
                    return current, False
                raise ApiError(409, {"error": "already_claimed", "claimedBy": current.holder_login})
            if current is not None and current.merged:
                raise ApiError(409, {"error": "already_claimed", "claimedBy": current.holder_login})
            mine = self.last_lease_of(task_id, identity.sub)
            ended = mine.ended_at(now) if mine is not None else None
            if ended is not None and now < ended + CLAIM_COOLDOWN:
                retry = _retry_after(ended + CLAIM_COOLDOWN, now)
                raise ApiError(
                    409,
                    {"error": "claim_cooldown", "retryAfter": retry},
                    headers={"Retry-After": str(retry)},
                )
            recent = self.claims_since(identity.sub, now - CLAIM_WINDOW)
            if len(recent) >= CLAIM_RATE_LIMIT:
                oldest = recent[len(recent) - CLAIM_RATE_LIMIT]
                raise ApiError(
                    429,
                    {"error": "claim_rate_limit", "limit": CLAIM_RATE_LIMIT},
                    headers={"Retry-After": str(_retry_after(oldest + CLAIM_WINDOW, now))},
                )
            if len(self.held_by(identity.sub)) >= max_active:
                raise ApiError(409, {"error": "claim_limit", "limit": max_active})
            ends = now + timedelta(hours=lease_hours)
            written = db.execute(
                "INSERT INTO bridge_leases (task_id, holder_sub, holder_login, claimed_at, "
                "lease_hours, ends_at) VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, identity.sub, identity.login, _to_db(now), lease_hours, _to_db(ends)),
            )
            lease = Lease(
                id=int(written.lastrowid or 0),
                task_id=task_id,
                holder_sub=identity.sub,
                holder_login=identity.login,
                claimed_at=now,
                lease_hours=lease_hours,
                ends_at=ends,
                released_at=None,
                pr_number=None,
                merged_at=None,
            )
            self.add_event(lease, "claimed", "forge", f"{identity.login} claimed this task.")
            return lease, True

    def release(self, lease: Lease, login: str) -> Lease:
        with self.db.transaction() as db:
            db.execute(
                "UPDATE bridge_leases SET released_at = ? WHERE id = ? AND released_at IS NULL",
                (_to_db(self.now()), lease.id),
            )
            self.add_event(lease, "released", "forge", f"{login} let this task go.")
        return self.lease(lease.id) or lease

    # pull requests

    def pull_taken(self, number: int, lease_id: int) -> bool:
        """Whether pull request #number is recorded on another lease already."""
        row = self.db.query_one(
            "SELECT 1 AS hit FROM bridge_leases WHERE pr_number = ? AND id != ?",
            (number, lease_id),
        )
        return row is not None

    def record_pull(self, lease: Lease, pull: PullRequest) -> Lease:
        """Keep the lease's pull request in step with what GitHub says about it.

        Merged: the lease is settled and the merge counted once per (task, pull
        request). Open: recorded, which holds the lease past its clock. Closed without
        merging: noted once with an event, and the clock runs on from the close with at
        least PULL_GRACE to go. A recorded open or merged pull request is never replaced
        by a closed one, and one recorded on another lease is never taken.
        """
        now = self.now()
        try:
            with self.db.transaction() as db:
                current = self.lease(lease.id) or lease
                if current.merged or current.released_at is not None:
                    return current
                if current.pr_number != pull.number and self.pull_taken(pull.number, current.id):
                    return current
                if pull.merged:
                    merged_at = _to_db(pull.merged_at or now)
                    db.execute(
                        "UPDATE bridge_leases SET pr_number = ?, pr_state = 'closed', "
                        "pr_head_sha = ?, pr_closed_at = NULL, merged_at = ? WHERE id = ?",
                        (pull.number, pull.head_sha, merged_at, current.id),
                    )
                    db.execute(
                        "INSERT OR IGNORE INTO bridge_merges (task_id, pr_number, lease_id, "
                        "holder_sub, merged_at) VALUES (?, ?, ?, ?, ?)",
                        (current.task_id, pull.number, current.id, current.holder_sub, merged_at),
                    )
                    _task_shipped(db, current.task_id, now)  # Phase 5: the shipped hook
                elif pull.is_open:
                    if (current.pr_number, current.pr_state, current.pr_head_sha) != (
                        pull.number,
                        "open",
                        pull.head_sha,
                    ):
                        db.execute(
                            "UPDATE bridge_leases SET pr_number = ?, pr_state = 'open', "
                            "pr_head_sha = ?, pr_closed_at = NULL WHERE id = ?",
                            (pull.number, pull.head_sha, current.id),
                        )
                elif current.pr_number is None or (
                    current.pr_number == pull.number and current.pr_state == "open"
                ):
                    closed = pull.closed_at or now
                    db.execute(
                        "UPDATE bridge_leases SET pr_number = ?, pr_state = 'closed', "
                        "pr_head_sha = ?, pr_closed_at = ?, ends_at = ? WHERE id = ?",
                        (
                            pull.number,
                            pull.head_sha,
                            _to_db(closed),
                            _to_db(max(current.ends_at, closed + PULL_GRACE)),
                            current.id,
                        ),
                    )
                    self.add_event(
                        current,
                        "submitted",
                        "forge",
                        f"Pull request #{pull.number} was closed without being merged.",
                    )
        except sqlite3.IntegrityError:
            pass  # another lease recorded this pull request first: it is theirs
        return self.lease(lease.id) or lease

    def merges_of(self, sub: str) -> list[Merge]:
        rows = self.db.query_all(
            "SELECT task_id, pr_number, merged_at FROM bridge_merges WHERE holder_sub = ? "
            "ORDER BY merged_at",
            (sub,),
        )
        return [
            Merge(
                task_id=row["task_id"],
                pr_number=row["pr_number"],
                merged_at=_from_db(row["merged_at"]),
            )
            for row in rows
        ]

    def take_submit_slot(self, sub: str) -> None:
        """Count one hand-in by `sub`, or raise 429 submit_limit when the minute's
        SUBMIT_LIMIT is used up (the check and the count are one transaction)."""
        now = self.now()
        with self.db.transaction() as db:
            db.execute(
                "DELETE FROM bridge_submits WHERE sub = ? AND at <= ?",
                (sub, _to_db(now - SUBMIT_WINDOW)),
            )
            rows = db.query_all("SELECT at FROM bridge_submits WHERE sub = ? ORDER BY at", (sub,))
            if len(rows) >= SUBMIT_LIMIT:
                oldest = _from_db(rows[len(rows) - SUBMIT_LIMIT]["at"])
                raise ApiError(
                    429,
                    {"error": "submit_limit", "limit": SUBMIT_LIMIT},
                    headers={"Retry-After": str(_retry_after(oldest + SUBMIT_WINDOW, now))},
                )
            db.execute("INSERT INTO bridge_submits (sub, at) VALUES (?, ?)", (sub, _to_db(now)))

    # events

    def add_event(
        self,
        lease: Lease,
        kind: BridgeEventKind,
        source: BridgeEventSource,
        message: str,
        *,
        rail: Rail | None = None,
        stage: ProgressStage | None = None,
    ) -> None:
        with self.db.transaction() as db:
            db.execute(
                "INSERT INTO bridge_events (lease_id, at, kind, source, message, rail, stage) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (lease.id, _to_db(self.now()), kind, source, clean_text(message), rail, stage),
            )
            # A task keeps its newest MAX_EVENTS_KEPT events, all its leases together.
            cutoff = db.query_one(
                "SELECT e.id FROM bridge_events e JOIN bridge_leases l ON l.id = e.lease_id "
                "WHERE l.task_id = ? ORDER BY e.id DESC LIMIT 1 OFFSET ?",
                (lease.task_id, MAX_EVENTS_KEPT),
            )
            if cutoff is not None:
                db.execute(
                    "DELETE FROM bridge_events WHERE id <= ? AND lease_id IN "
                    "(SELECT id FROM bridge_leases WHERE task_id = ?)",
                    (cutoff["id"], lease.task_id),
                )

    def events(
        self, lease_id: int, limit: int = MAX_EVENTS_SHOWN, *, with_agent_text: bool = False
    ) -> list[BridgeEvent]:
        """The newest `limit` events, oldest first. FORGE's own events only, unless
        `with_agent_text`: what an agent wrote (source "agent") goes to the lease holder
        alone, because agent text on a public page is a defacement vector."""
        sql = (
            "SELECT * FROM bridge_events WHERE lease_id = ? ORDER BY id DESC LIMIT ?"
            if with_agent_text
            else "SELECT * FROM bridge_events WHERE lease_id = ? AND source = 'forge' "
            "ORDER BY id DESC LIMIT ?"
        )
        rows = self.db.query_all(sql, (lease_id, limit))
        return [
            BridgeEvent(
                at=iso(_from_db(row["at"])),
                kind=row["kind"],
                source=row["source"],
                message=row["message"],
                rail=row["rail"],
                stage=row["stage"],
            )
            for row in reversed(rows)
        ]

    def progress_stages(self, lease_id: int) -> list[str]:
        rows = self.db.query_all(
            "SELECT stage FROM bridge_events WHERE lease_id = ? AND kind = 'progress' ORDER BY id",
            (lease_id,),
        )
        return [str(row["stage"]) for row in rows]

    def progress_since(self, task_id: int, since: datetime) -> int:
        """Progress reports on this task (all its leases) since `since`."""
        row = self.db.query_one(
            "SELECT COUNT(*) AS n FROM bridge_events e JOIN bridge_leases l ON l.id = e.lease_id "
            "WHERE l.task_id = ? AND e.kind = 'progress' AND e.at >= ?",
            (task_id, _to_db(since)),
        )
        return int(row["n"]) if row else 0

    def latest_signal(self, lease_id: int) -> tuple[str, str | None, str | None] | None:
        """(kind, rail, stage) of the newest dispatched / opened / progress event."""
        row = self.db.query_one(
            "SELECT kind, rail, stage FROM bridge_events WHERE lease_id = ? "
            "AND kind IN ('dispatched', 'opened', 'progress') ORDER BY id DESC LIMIT 1",
            (lease_id,),
        )
        return (row["kind"], row["rail"], row["stage"]) if row else None

    def has_submission(self, lease_id: int, number: int) -> bool:
        row = self.db.query_one(
            "SELECT 1 AS hit FROM bridge_events WHERE lease_id = ? AND kind = 'submitted' "
            "AND message = ?",
            (lease_id, f"Pull request #{number} was handed in for checks."),
        )
        return row is not None

    # dispatches

    def record_dispatch(
        self,
        lease: Lease,
        sub: str,
        rail: Rail,
        mode: Literal["start", "open", "relay"],
        outcome: str,
        *,
        fingerprint: str | None = None,
    ) -> int:
        written = self.db.execute(
            "INSERT INTO bridge_dispatches (lease_id, sub, rail, mode, outcome, at, "
            "credential_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (lease.id, sub, rail, mode, outcome, _to_db(self.now()), fingerprint),
        )
        return int(written.lastrowid or 0)

    def finish_dispatch(
        self,
        dispatch_id: int,
        outcome: str,
        *,
        session_url: str | None = None,
        session_ref: str | None = None,
    ) -> None:
        self.db.execute(
            "UPDATE bridge_dispatches SET outcome = ?, session_url = ?, session_ref = ? "
            "WHERE id = ?",
            (outcome, session_url, session_ref, dispatch_id),
        )

    def last_dispatch(self, lease_id: int, mode: str | None = None) -> DispatchRecord | None:
        """The newest successful hand-off (started or opened), optionally of one mode."""
        sql = (
            "SELECT * FROM bridge_dispatches WHERE lease_id = ? "
            "AND outcome IN ('started', 'opened')"
        )
        params: list[Any] = [lease_id]
        if mode is not None:
            sql += " AND mode = ?"
            params.append(mode)
        row = self.db.query_one(sql + " ORDER BY id DESC LIMIT 1", params)
        return _dispatch(row) if row else None

    def recent_start(self, lease_id: int, rail: Rail, since: datetime) -> DispatchRecord | None:
        """The newest start on this lease and rail after `since` that went out, or is
        still on its way to the vendor."""
        row = self.db.query_one(
            "SELECT * FROM bridge_dispatches WHERE lease_id = ? AND rail = ? AND mode = 'start' "
            "AND outcome IN ('pending', 'started') AND at > ? ORDER BY id DESC LIMIT 1",
            (lease_id, rail, _to_db(since)),
        )
        return _dispatch(row) if row else None

    def recently_opened(self, lease_id: int, rail: Rail, since: datetime) -> bool:
        row = self.db.query_one(
            "SELECT 1 AS hit FROM bridge_dispatches WHERE lease_id = ? AND rail = ? "
            "AND mode = 'open' AND at >= ?",
            (lease_id, rail, _to_db(since)),
        )
        return row is not None

    def vendor_calls_since(self, sub: str, since: datetime) -> list[datetime]:
        """When this user's vendor calls (starts and relays, failed ones too) happened."""
        rows = self.db.query_all(
            "SELECT at FROM bridge_dispatches WHERE sub = ? AND mode IN ('start', 'relay') "
            "AND at >= ? ORDER BY at",
            (sub, _to_db(since)),
        )
        return [_from_db(row["at"]) for row in rows]


# --- providers (FastAPI dependencies; the connector's tools call them directly) -------

_store = LeaseStore()
_github = GitHubReads()
_rail_client: httpx.Client | None = None
_source: TaskSource = CompositeTaskSource(FixtureTaskSource(), PublishedTaskSource())  # Phase 5
_providers_lock = threading.Lock()


def get_lease_store() -> LeaseStore:
    """The Bridge's records. Tests override it (or `_store`) to inject a clock."""
    return _store


def get_github_reads() -> GitHubReads:
    return _github


def get_rail_client() -> httpx.Client:
    """The client every start rail sends through (no redirects, timeouts set)."""
    global _rail_client
    with _providers_lock:
        if _rail_client is None:
            _rail_client = make_client()
        return _rail_client


def get_task_source() -> TaskSource:
    """The committed fixtures, then the tasks published from proposals (Phase 5), until
    Foreman's claim linkage."""
    return _source


# --- settings readers -----------------------------------------------------------------


def enabled_start_rails(env: Mapping[str, str] | None = None) -> frozenset[StartRail]:
    """The start rails FORGE_START_RAILS switches on (comma-separated ids; unknown ids
    are ignored). Empty unless set: a rail stays off until its live test passes."""
    raw = (env if env is not None else os.environ).get(START_RAILS_ENV, "")
    wanted = {item.strip().lower() for item in raw.split(",") if item.strip()}
    return frozenset(rail for rail in START_RAILS if rail in wanted)


def start_rail_enabled(rail: StartRail) -> bool:
    """A start rail is on when the `agent_start` flag is AND FORGE_START_RAILS names it."""
    return flags_service.is_enabled(AGENT_START_FLAG) and rail in enabled_start_rails()


def max_active_claims(env: Mapping[str, str] | None = None) -> int:
    """FORGE_MAX_ACTIVE_CLAIMS (1-100); anything else means the default, 2."""
    raw = (env if env is not None else os.environ).get(MAX_ACTIVE_CLAIMS_ENV, "").strip()
    if raw.isdigit() and 1 <= int(raw) <= 100:
        return int(raw)
    return DEFAULT_MAX_ACTIVE_CLAIMS


def caller_tier(identity: Identity) -> Tier:
    """The caller's contributor tier: T0 for every account until Foreman's ledger (PRD
    Appendix F) is wired in."""
    return "T0"


# --- the service ----------------------------------------------------------------------


def _hours_left(end: datetime, now: datetime) -> str:
    hours = math.ceil((end - now).total_seconds() / 3600)
    return "for less than an hour" if hours <= 1 else f"for about {hours} hours"


def pull_counts(pull: PullRequest, lease: Lease, task: TaskFixture, now: datetime) -> bool:
    """Whether `pull` is this lease's work. It must target verastd/forge-app, come from
    the holder's own fork (by GitHub user id: a login can change hands), be opened after
    the claim (and, for a lease whose time ran out, before it did), and name the task:
    come from the task's branch, or carry `[#<id>]` in its title or "Closes #<id>"
    (Fixes, Resolves) in its description."""
    if pull.base_repo.lower() != UPSTREAM_REPO or pull.head_owner_id is None:
        return False
    if str(pull.head_owner_id) != lease.holder_sub or pull.created_at is None:
        return False
    # GitHub keeps whole seconds; a claim keeps microseconds.
    if pull.created_at < lease.claimed_at.replace(microsecond=0):
        return False
    if not lease.is_active(now) and pull.created_at >= lease.ends_at:
        return False
    return pull.head_ref == branch_name(task.id, task.title) or task.id in pull.refs


class Bridge:
    """One request's view of the Bridge: the store, the task source, GitHub and the
    vendors. Every HTTP route and every connector tool goes through these methods."""

    def __init__(
        self,
        store: LeaseStore,
        source: TaskSource,
        github: GitHubReads,
        rail_client: httpx.Client | None = None,
    ) -> None:
        self.store = store
        self.source = source
        self.github = github
        self._rail_client = rail_client

    @classmethod
    def for_tools(cls, db: StateDB) -> "Bridge":
        """The Bridge the connector's tools use: the providers, over the tool's database."""
        return cls(get_lease_store().with_db(db), get_task_source(), get_github_reads())

    @property
    def rail_client(self) -> httpx.Client:
        return self._rail_client if self._rail_client is not None else get_rail_client()

    def vault(self) -> Vault:
        return Vault.from_env(self.store.db, now_fn=self.store.now)

    # lookups

    def task(self, task_id: int) -> TaskFixture:
        task = self.source.get_task(task_id)
        if task is None:
            raise ApiError(404, {"error": "task_not_found", "taskId": task_id})
        return task

    def held_lease(self, identity: Identity, task_id: int) -> Lease:
        """The caller's lease on the task while it holds it: 409 not_claimed when nobody
        holds it, 403 not_holder when someone else does, 409 already_shipped once its pull
        request merged (the lease still keeps the task off the board, but nobody can start
        agents, report, hand in or release on shipped work). The caller's own lease that ran
        out of time is first checked for a pull request opened in time, which holds it."""
        lease = self.store.latest(task_id)
        now = self.store.now()
        if (
            lease is not None
            and lease.holder_sub == identity.sub
            and lease.released_at is None
            and not lease.is_active(now)
        ):
            task = self.source.get_task(task_id)
            if task is not None:
                lease, _, _ = self._track(lease, task)
        if lease is None or not lease.is_active(now):
            raise ApiError(409, {"error": "not_claimed", "taskId": task_id})
        if lease.holder_sub != identity.sub:
            raise ApiError(403, {"error": "not_holder", "taskId": task_id})
        if lease.merged:
            raise ApiError(409, {"error": "already_shipped", "taskId": task_id})
        return lease

    def latest_lease(self, task_id: int) -> Lease:
        lease = self.store.latest(task_id)
        if lease is None:
            raise ApiError(404, {"error": "not_claimed", "taskId": task_id})
        return lease

    # browse

    def rails(self, identity: Identity | None) -> RailList:
        vault = self.vault()
        saved = vault.saved_rails(identity.sub) if identity is not None else set()
        enabled: frozenset[StartRail] = (
            enabled_start_rails() if flags_service.is_enabled(AGENT_START_FLAG) else frozenset()
        )
        rails: list[RailInfo] = []
        for meta in RAIL_REGISTRY:
            is_start = meta.mode == "start"
            rails.append(
                RailInfo(
                    **meta.model_dump(),
                    enabled=(meta.id in enabled) if is_start else True,
                    savedCredential=(meta.id in saved) if is_start and identity else None,
                )
            )
        return RailList(rails=rails, vault=vault.enabled)

    @staticmethod
    def _card(task: TaskFixture, lease: Lease | None, now: datetime) -> TaskCard:
        """The board's view of a task: merged work keeps it off the open board (claimed
        by whoever shipped it, with no clock); a held one names its holder and end."""
        if lease is not None and lease.merged:
            return task.to_card(claimed_by=lease.holder_login)
        if lease is not None and lease.is_active(now):
            return task.to_card(
                claimed_by=lease.holder_login, lease_ends_at=iso(lease.effective_end(now))
            )
        return task.to_card()

    def list_tasks(self) -> TaskList:
        tasks = self.source.list_tasks()
        current = self.store.current_leases(task.id for task in tasks)
        now = self.store.now()
        return TaskList(tasks=[self._card(task, current.get(task.id), now) for task in tasks])

    def card(self, task: TaskFixture) -> TaskCard:
        return self._card(task, self.store.latest(task.id), self.store.now())

    def brief(self, task_id: int, login: str | None) -> str:
        """The brief for `prompt_url` links; an invalid login gets the generic brief."""
        task = self.task(task_id)
        return compile_brief(
            task, task.acceptanceCriteria, login if is_valid_login(login) else None
        )

    def task_detail(self, task_id: int, identity: Identity | None) -> TaskDetail:
        task = self.task(task_id)
        return TaskDetail(
            task=self.card(task),
            acceptanceCriteria=list(task.acceptanceCriteria),
            branch=branch_name(task.id, task.title),
            brief=compile_brief(
                task, task.acceptanceCriteria, identity.login if identity is not None else None
            ),
        )

    # claim and release

    def claim(self, identity: Identity, task_id: int) -> ClaimResponse:
        """Claim → lease countdown. Mirrors the `/claim` comment path (PRD I.2)."""
        task = self.task(task_id)
        if TIER_ORDER.index(task.tierFloor) > TIER_ORDER.index(caller_tier(identity)):
            raise ApiError(403, {"error": "tier_too_low", "tierFloor": task.tierFloor})
        current = self.store.latest(task.id)
        if (
            current is not None
            and current.released_at is None
            and not current.merged
            and self.store.now() >= current.ends_at
        ):
            # Out of time: does a pull request still hold it, or did its one close?
            self._track(current, task)
        lease, _ = self.store.claim(
            task.id, identity, LEASE_HOURS_BY_SIZE[task.size], max_active_claims()
        )
        return ClaimResponse(
            taskId=task.id,
            claimedBy=lease.holder_login,
            leaseEndsAt=iso(lease.effective_end(self.store.now())),
            leaseHours=lease.lease_hours,
        )

    def release(self, identity: Identity, task_id: int) -> BridgeStatus:
        task = self.task(task_id)
        lease = self.held_lease(identity, task_id)
        return self.status_of(self.store.release(lease, identity.login), identity, task)

    # dispatch

    def _credential(
        self, identity: Identity, rail: StartRail, supplied: Credential | None
    ) -> tuple[RailCredential, bool]:
        """The credential for this start: (credential, came_from_the_vault)."""
        kind = rail_meta(rail).credential
        if supplied is not None:
            key = supplied.key.get_secret_value()
            if not _KEY.fullmatch(key):
                raise ApiError(400, {"error": "credential_invalid", "rail": rail, "field": "key"})
            org_id: str | None = None
            routine_url: str | None = None
            if kind == "devin":
                if supplied.orgId is None or not valid_org_id(supplied.orgId):
                    raise ApiError(
                        400, {"error": "credential_invalid", "rail": rail, "field": "orgId"}
                    )
                org_id = supplied.orgId
            if kind == "routine":
                trig = trigger_id(supplied.routineUrl)
                if trig is None:
                    raise ApiError(
                        400, {"error": "credential_invalid", "rail": rail, "field": "routineUrl"}
                    )
                routine_url = f"{ROUTINE_API_URL}/{trig}/fire"
            return RailCredential(key=key, org_id=org_id, routine_url=routine_url), False
        if kind != "github":
            saved = self.vault().load(identity.sub, rail)
            if saved is not None:
                return saved, True
        raise ApiError(400, {"error": "credential_required", "rail": rail})

    def _check_vendor_limit(self, identity: Identity) -> None:
        now = self.store.now()
        calls = self.store.vendor_calls_since(identity.sub, now - DISPATCH_WINDOW)
        if len(calls) >= DISPATCH_LIMIT:
            retry = max(1, math.ceil((calls[0] + DISPATCH_WINDOW - now).total_seconds()))
            raise ApiError(
                429,
                {"error": "dispatch_limit", "limit": DISPATCH_LIMIT},
                headers={"Retry-After": str(retry)},
            )

    def _reserve_vendor_call(
        self,
        identity: Identity,
        lease: Lease,
        rail: StartRail,
        mode: Literal["start", "relay"],
        fingerprint: str | None = None,
    ) -> int:
        """Check the vendor-call limit and record the call as pending in one transaction
        (BEGIN IMMEDIATE, so even another process can't count in between). A start
        first answers 409 already_started when one on the same task and rail went out,
        or is on its way, in the last START_DEDUPE."""
        now = self.store.now()
        with self.store.db.transaction():
            if mode == "start":
                recent = self.store.recent_start(lease.id, rail, now - START_DEDUPE)
                if recent is not None:
                    payload: dict[str, Any] = {"error": "already_started", "rail": rail}
                    if recent.session_url is not None:
                        payload["sessionUrl"] = recent.session_url
                    raise ApiError(409, payload)
            self._check_vendor_limit(identity)
            return self.store.record_dispatch(
                lease, identity.sub, rail, mode, "pending", fingerprint=fingerprint
            )

    def dispatch(self, identity: Identity, request: DispatchRequest) -> DispatchResult:
        """Hand the task to the contributor's own agent (BYOA — PRD §4.9 invariant 2)."""
        task = self.task(request.taskId)
        lease = self.held_lease(identity, task.id)
        meta = rail_meta(request.rail)
        brief = compile_brief(task, task.acceptanceCriteria, identity.login)
        now = self.store.now()
        if meta.mode == "open":
            if not self.store.recently_opened(lease.id, request.rail, now - OPENED_DEDUPE):
                self.store.record_dispatch(lease, identity.sub, request.rail, "open", "opened")
                self.store.add_event(
                    lease,
                    "opened",
                    "forge",
                    f"Opened {meta.label} with the task typed in.",
                    rail=request.rail,
                )
            return DispatchResult(mode="open", rail=request.rail, brief=brief, startedAt=iso(now))

        rail = cast(StartRail, request.rail)
        if not start_rail_enabled(rail):
            raise ApiError(400, {"error": "rail_disabled", "rail": rail})
        credential, from_vault = self._credential(identity, rail, request.credential)
        fingerprint = (
            credential_fingerprint(identity.sub, rail, credential)
            if ADAPTERS[rail].supports_notes
            else None
        )
        attempt = self._reserve_vendor_call(identity, lease, rail, "start", fingerprint)
        vault = self.vault()
        try:
            result = adapter_for(rail, self.rail_client).start(
                AdapterRequest(
                    task_id=task.id,
                    title=task.title,
                    brief=brief,
                    branch=branch_name(task.id, task.title),
                    login=identity.login,
                    credential=credential,
                )
            )
        except AdapterError as exc:
            log_failure(rail, "start", exc)
            self.store.finish_dispatch(attempt, exc.code)
            if exc.code == "credential_rejected":
                if from_vault:
                    vault.delete(identity.sub, rail)
                raise ApiError(400, {"error": "credential_rejected", "rail": rail}) from None
            if exc.code == "rail_setup_needed":
                raise ApiError(
                    400, {"error": "rail_setup_needed", "rail": rail, "message": exc.message}
                ) from None
            raise ApiError(
                502, {"error": "rail_failed", "rail": rail, "status": exc.status}
            ) from None
        saved = from_vault
        if from_vault:
            vault.mark_used(identity.sub, rail)
        elif request.saveCredential:
            saved = vault.save(identity.sub, rail, credential) is not None
        self.store.finish_dispatch(
            attempt, "started", session_url=result.session_url, session_ref=result.session_ref
        )
        self.store.add_event(
            lease, "dispatched", "forge", f"FORGE started {meta.label}.", rail=rail
        )
        return DispatchResult(
            mode="start",
            rail=rail,
            brief=brief,
            startedAt=iso(now),
            sessionUrl=result.session_url,
            sessionRef=result.session_ref,
            credentialSaved=saved,
        )

    # watch

    @staticmethod
    def _recorded_pull(lease: Lease) -> PullRequest | None:
        """The pull request recorded on the lease, as it was last seen."""
        if lease.pr_number is None:
            return None
        return PullRequest(
            number=lease.pr_number,
            url=pull_url(lease.pr_number),
            state="open" if lease.pull_open else "closed",
            merged=lease.merged,
            head_sha=lease.pr_head_sha or "",
            head_ref="",
            head_owner=lease.holder_login,
            title="",
        )

    def _find_pull(self, lease: Lease, task: TaskFixture, now: datetime) -> PullRequest | None:
        """The holder's pull request that counts for this lease (pull_counts) and isn't
        another lease's: from the task's branch, else through GitHub's search."""

        def usable(pull: PullRequest) -> bool:
            return pull_counts(pull, lease, task, now) and (
                pull.number == lease.pr_number or not self.store.pull_taken(pull.number, lease.id)
            )

        branch = branch_name(task.id, task.title)
        found = best_pull(filter(usable, self.github.find_pulls(lease.holder_login, branch)))
        if found is None:
            searched = self.github.search_pulls(lease.holder_login, task.id, lease.claimed_at)
            found = best_pull(filter(usable, searched))
        return found

    def _track(self, lease: Lease, task: TaskFixture) -> tuple[Lease, PullRequest | None, bool]:
        """Bring the lease's pull request up to date from GitHub (60 s cache): the
        recorded one, else a newer one that counts. Released and merged leases are
        settled and never read again. Returns the lease as recorded afterwards, its pull
        request (None when there is none) and whether GitHub answered."""
        if lease.released_at is not None or lease.merged:
            return lease, self._recorded_pull(lease), True
        try:
            pull = self.github.pull(lease.pr_number) if lease.pr_number is not None else None
            if pull is None or not (pull.is_open or pull.merged):
                found = self._find_pull(lease, task, self.store.now())
                if found is not None and (pull is None or found.is_open or found.merged):
                    pull = found
        except GitHubUnavailable as exc:
            logger.info("GitHub unavailable for task %s: %s", lease.task_id, exc)
            return lease, self._recorded_pull(lease), False
        if pull is None:
            return lease, self._recorded_pull(lease), True
        lease = self.store.record_pull(lease, pull)
        if lease.pr_number != pull.number:
            return lease, self._recorded_pull(lease), True
        return lease, pull, True

    def status_of(
        self, lease: Lease, viewer: Identity | None, task: TaskFixture | None = None
    ) -> BridgeStatus:
        task = task if task is not None else self.task(lease.task_id)
        branch = branch_name(task.id, task.title)
        lease, pull, github_ok = self._track(lease, task)
        now = self.store.now()
        active = lease.is_active(now)
        is_holder = viewer is not None and viewer.sub == lease.holder_sub
        live = pull if active and not lease.merged and pull is not None and pull.is_open else None
        check, passed, total, failed, checks_read = "pending", 0, 0, 0, True
        if live is not None:
            try:
                runs = self.github.check_runs(live.head_sha)
            except GitHubUnavailable:
                github_ok, checks_read, runs = False, False, []
            check, passed, total = check_state(runs)
            failed = sum(
                1 for run in runs if run.status == "completed" and run.conclusion not in PASSING
            )
        started = self.store.last_dispatch(lease.id, mode="start") if is_holder else None
        can_relay = (
            self._relay_credential(lease.holder_sub, started) is not None if is_holder else None
        )

        stage: BridgeStage
        pr_link: str | None = None
        if lease.merged:
            stage = "shipped"
            detail = "Your contribution was merged into FORGE. Thank you!"
            if task.rewardClass != "none":
                detail += " Its reward unlocks once it survives 14 days in production."
            pr_link = pull_url(lease.pr_number) if lease.pr_number is not None else None
        elif not active:
            # After a release or a run-out, nobody sees the former holder's pull request.
            stage = "claimed"
            detail = (
                "This task was let go, so it's open again. Anyone can claim it."
                if lease.released_at is not None
                else "Time ran out on this task, so it's open again. Anyone can claim it."
            )
        elif live is not None and check == "passed":
            stage, pr_link = "in_review", live.url
            detail = "All checks passed. A maintainer will review your contribution next."
        elif live is not None:
            stage, pr_link = "in_checks", live.url
            if check == "failed":
                # "Send the notes" only for the holder whose page offers it (canRelay).
                detail = f"{failed} of {total} checks failed. " + (
                    "Send the notes to your agent so it can fix them."
                    if can_relay
                    else "Your agent can read the notes below and fix them."
                )
            elif not checks_read:
                detail = "The pull request is open."
            elif total == 0:
                detail = "The pull request is open. Its checks haven't started yet."
            else:
                detail = f"{passed} of {total} checks passed. The rest are still running."
        elif lease.pull_closed and lease.pr_number is not None:
            stage, pr_link = "agent_working", pull_url(lease.pr_number)
            detail = "Your pull request was closed without merging."
        elif READY_STAGES.intersection(self.store.progress_stages(lease.id)):
            stage = "ready_to_submit"
            detail = (
                "Your agent says the work is ready, but there's no pull request for it yet. "
                "Use “When your agent has pushed its branch: open the pull request”, or ask "
                "your agent to open it."
            )
        elif (signal := self.store.latest_signal(lease.id)) is not None:
            stage = "agent_working"
            kind, rail, last_stage = signal
            label = rail_meta(rail).label if rail else "Your agent"
            if kind == "progress" and last_stage == "blocked":
                detail = (
                    "Your agent says it's stuck. Read its last message below; it may need an "
                    "answer from you in the agent's app."
                )
            elif kind == "progress":
                detail = "Your agent is working on it. Its latest note is below."
            elif kind == "opened":
                detail = (
                    f"You opened {label} with the task typed in. Once you press send there, "
                    "it gets to work."
                )
            else:
                detail = f"{label} is working on it. We'll show its progress here."
        else:
            stage = "claimed"
            detail = (
                f"This task is yours {_hours_left(lease.effective_end(now), now)}. Get your "
                "agent on it whenever you're ready."
            )
        if not github_ok:
            detail += " (GitHub can't be reached right now, so this may be a little behind.)"

        holds = active and not lease.merged
        last = self.store.last_dispatch(lease.id)
        counted = live is not None and checks_read and total > 0
        return BridgeStatus(
            taskId=task.id,
            stage=stage,
            detail=detail,
            events=self.store.events(lease.id, with_agent_text=is_holder),
            holder=lease.holder_login if active or lease.merged else None,
            leaseEndsAt=iso(lease.effective_end(now)) if holds else None,
            rail=last.rail if last is not None else None,
            sessionUrl=started.session_url if started is not None else None,
            prUrl=pr_link,
            compareUrl=(
                compare_url(lease.holder_login, branch)
                if is_holder and holds and pr_link is None
                else None
            ),
            checksPassed=passed if counted else None,
            checksTotal=total if counted else None,
            canRelay=can_relay,
        )

    def status(self, task_id: int, viewer: Identity | None) -> BridgeStatus:
        """Translated status — the CI log in friendlier clothes (PRD I.2, Watch row)."""
        task = self.task(task_id)
        return self.status_of(self.latest_lease(task_id), viewer, task)

    def check_results(self, task_id: int) -> CheckResults:
        """The checks on the task's pull request, with notes an agent can act on: only
        the current holder's pull request. Any GitHub failure is "pending" with a plain
        note, never an error."""
        task = self.task(task_id)
        lease, pull, github_ok = self._track(self.latest_lease(task_id), task)
        branch = branch_name(task.id, task.title)
        if lease.merged and lease.pr_number is not None:
            return CheckResults(
                taskId=task.id,
                state="passed",
                checks=[],
                notes=f"Pull request #{lease.pr_number} was merged. Nothing left to fix.",
                prUrl=pull_url(lease.pr_number),
            )
        if not lease.is_active(self.store.now()):
            return CheckResults(
                taskId=task.id,
                state="no_pr",
                checks=[],
                notes="Nobody holds this task right now, so there are no checks to read.",
            )
        if pull is None and not github_ok:
            return CheckResults(
                taskId=task.id,
                state="pending",
                checks=[],
                notes="GitHub can't be reached right now. Try again in a minute.",
            )
        if pull is None:
            return CheckResults(
                taskId=task.id,
                state="no_pr",
                checks=[],
                notes=(
                    "There's no open pull request for this task yet. When the work is ready, "
                    f"open one from {lease.holder_login}:{branch} to {UPSTREAM_REPO} main, "
                    "as the task's brief says."
                ),
            )
        if not pull.is_open:
            return CheckResults(
                taskId=task.id,
                state="no_pr",
                checks=[],
                notes=(
                    f"Pull request #{pull.number} was closed without being merged. Read why on "
                    "GitHub, then fix the work and open a new pull request as the task's brief "
                    "says."
                ),
                prUrl=pull.url,
            )
        try:
            runs = self.github.check_runs(pull.head_sha)
        except GitHubUnavailable:
            return CheckResults(
                taskId=task.id,
                state="pending",
                checks=[],
                notes=(
                    f"GitHub can't be reached right now, so the checks on pull request "
                    f"#{pull.number} can't be read. Try again in a minute."
                ),
                prUrl=pull.url,
                headSha=pull.head_sha,
            )
        state, passed, total = check_state(runs)
        if state == "failed":
            notes = failure_notes(pull, runs, branch)
        elif state == "passed":
            notes = f"All {total} checks passed on pull request #{pull.number}. Nothing to fix."
        elif total == 0:
            notes = f"The checks on pull request #{pull.number} haven't started yet."
        else:
            notes = (
                f"{passed} of {total} checks on pull request #{pull.number} passed so far; the "
                "rest are still running. Check again in a few minutes."
            )
        return CheckResults(
            taskId=task.id,
            state=state,
            checks=runs,
            notes=notes,
            prUrl=pull.url,
            headSha=pull.head_sha,
        )

    # iterate

    def _relay_credential(self, sub: str, started: DispatchRecord | None) -> RailCredential | None:
        """The saved credential a relay of notes would use, or None. Only for a session
        that takes follow-ups (Jules, Cursor, Devin), and only when the saved credential
        is the one that started it (by keyed fingerprint): notes never go out with
        another account's key."""
        if started is None or started.session_ref is None or started.fingerprint is None:
            return None
        rail = started.rail
        if rail not in START_RAILS or not ADAPTERS[rail].supports_notes:
            return None
        saved = self.vault().load(sub, rail)
        if saved is None:
            return None
        fingerprint = credential_fingerprint(sub, rail, saved)
        if fingerprint is None or not hmac.compare_digest(fingerprint, started.fingerprint):
            return None
        return saved

    def feedback(self, identity: Identity, task_id: int) -> FeedbackResponse:
        """One button: send the checks' notes back to the agent (PRD I.2, Iterate row).
        Relayed only when the last start went to a rail that takes follow-ups and the
        caller's saved credential is the one that started it; otherwise the notes come
        back to show."""
        self.task(task_id)
        lease = self.held_lease(identity, task_id)
        results = self.check_results(task_id)
        not_relayed = FeedbackResponse(relayed=False, notes=results.notes)
        started = self.store.last_dispatch(lease.id, mode="start")
        if results.state != "failed":
            return not_relayed
        credential = self._relay_credential(identity.sub, started)
        if credential is None or started is None or started.session_ref is None:
            return not_relayed
        rail = cast(StartRail, started.rail)
        try:
            attempt = self._reserve_vendor_call(identity, lease, rail, "relay")
        except ApiError:
            return not_relayed
        message = (
            "FORGE: the checks on your pull request failed. Fix what they found on the same "
            "branch and push.\n\n" + results.notes
        )
        vault = self.vault()
        try:
            adapter_for(rail, self.rail_client).send_notes(credential, started.session_ref, message)
        except AdapterError as exc:
            log_failure(rail, "relay", exc)
            self.store.finish_dispatch(attempt, exc.code)
            if exc.code == "credential_rejected" and exc.status == 401:
                # 401: the key itself is dead. A 403 may only mean this session isn't
                # that account's, so the saved key stays.
                vault.delete(identity.sub, rail)
            return not_relayed
        self.store.finish_dispatch(attempt, "relayed")
        vault.mark_used(identity.sub, rail)
        self.store.add_event(
            lease,
            "relayed",
            "forge",
            f"Sent the check notes to {rail_meta(rail).label}.",
            rail=rail,
        )
        return FeedbackResponse(relayed=True, notes=results.notes, relayedTo=rail)

    def submit(
        self,
        identity: Identity,
        task_id: int,
        pr_url: str,
        source: BridgeEventSource = "forge",
    ) -> BridgeStatus:
        """Hand in the pull request: on verastd/forge-app, from the caller's own fork,
        and this task's work (pull_counts). 10 a minute per contributor."""
        task = self.task(task_id)
        lease = self.held_lease(identity, task_id)
        number = parse_pr_url(pr_url)
        if number is None:
            raise ApiError(400, {"error": "invalid_pr_url"})
        self.store.take_submit_slot(identity.sub)
        try:
            pull = self.github.pull(number)
        except GitHubUnavailable:
            raise ApiError(503, {"error": "github_unavailable"}) from None
        if pull is None:
            raise ApiError(404, {"error": "pr_not_found", "prNumber": number})
        if pull.head_owner_id is None or str(pull.head_owner_id) != identity.sub:
            raise ApiError(403, {"error": "not_your_pr", "prNumber": number})
        if not pull_counts(pull, lease, task, self.store.now()) or (
            number != lease.pr_number and self.store.pull_taken(number, lease.id)
        ):
            raise ApiError(400, {"error": "pr_not_for_task", "prNumber": number})
        lease = self.store.record_pull(lease, pull)
        if not self.store.has_submission(lease.id, number):
            self.store.add_event(
                lease, "submitted", source, f"Pull request #{number} was handed in for checks."
            )
        return self.status_of(lease, identity, task)

    def report_progress(
        self,
        identity: Identity,
        task_id: int,
        stage: ProgressStage,
        message: str,
        pr_url: str | None = None,
    ) -> BridgeStatus:
        """An agent's milestone, through the connector. The message is untrusted text; a
        task takes PROGRESS_LIMIT reports an hour."""
        task = self.task(task_id)
        lease = self.held_lease(identity, task_id)
        now = self.store.now()
        text = clean_text(message) or stage.replace("_", " ")
        with self.store.db.transaction():
            if self.store.progress_since(task.id, now - PROGRESS_WINDOW) >= PROGRESS_LIMIT:
                raise ApiError(429, {"error": "progress_limit", "limit": PROGRESS_LIMIT})
            self.store.add_event(lease, "progress", "agent", text, stage=stage)
        number = parse_pr_url(pr_url) if pr_url else None
        if number is not None and number != lease.pr_number:
            # A hint: it counts only when that pull request is this task's work.
            try:
                hinted = self.github.pull(number)
            except GitHubUnavailable:
                hinted = None
            if (
                hinted is not None
                and pull_counts(hinted, lease, task, now)
                and not self.store.pull_taken(number, lease.id)
            ):
                lease = self.store.record_pull(lease, hinted)
        return self.status_of(self.store.lease(lease.id) or lease, identity, task)

    # settle

    def profile(self, identity: Identity) -> ContributorProfile:
        """The caller's own record as FORGE knows it: each merged pull request counts
        once. Foreman's ledger (tiers, rewards, survival) isn't wired in yet, so those
        stay at their starting values."""
        for held in self.store.held_by(identity.sub):
            task = self.source.get_task(held.task_id)
            if held.pr_number is not None and task is not None:
                self._track(held, task)  # a merge nobody has looked at yet counts too
        ledger: list[LedgerEvent] = [
            LedgerEvent(kind="claim", refIssue=lease.task_id, points=0.0, at=iso(lease.claimed_at))
            for lease in self.store.held_by(identity.sub, active_only=False)
        ]
        merges = self.store.merges_of(identity.sub)
        ledger.extend(
            LedgerEvent(
                kind="merge",
                refPr=merge.pr_number,
                refIssue=merge.task_id,
                points=1.0,
                at=iso(merge.merged_at),
            )
            for merge in merges
        )
        merged = len({merge.pr_number for merge in merges})
        return ContributorProfile(
            login=identity.login,
            tier=caller_tier(identity),
            merged=merged,
            survivalRate=1.0 if merged else 0.0,
            pendingRewards=[],
            ledger=sorted(ledger, key=lambda event: event.at, reverse=True),
        )

    def saved_keys(self, identity: Identity) -> SavedCredentialList:
        vault = self.vault()
        return SavedCredentialList(credentials=vault.list_saved(identity.sub), vault=vault.enabled)

    def delete_key(self, identity: Identity, rail: str) -> SavedCredentialList:
        if rail not in START_RAILS or rail == "copilot":
            raise ApiError(404, {"error": "unknown_rail"})
        self.vault().delete(identity.sub, rail)
        return self.saved_keys(identity)

    def fork(self, identity: Identity) -> ForkStatus:
        try:
            return self.github.fork(identity.login)
        except GitHubUnavailable:
            raise ApiError(503, {"error": "github_unavailable"}) from None
