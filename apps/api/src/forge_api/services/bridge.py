"""The Bridge v2: claim a task, get an agent on it, watch it, iterate, settle (PRD App. I).

Everything here acts as a real GitHub user (`Identity`: the web tier's assertion, or the
connector's OAuth token) and remembers what happened in the state database:

- `bridge_leases`: who holds which task until when (one row per claim, kept after it is
  released or runs out, so status can still answer for it), plus the pull request FORGE
  knows of and when it merged.
- `bridge_events`: the task's timeline (claimed, dispatched, opened, progress, submitted,
  released, relayed). Agent-written text is stored as plain text: control characters
  stripped, at most 500 characters. Events an agent sent (source "agent") are shown to
  the lease holder only; everyone else sees FORGE's own.
- `bridge_dispatches`: every hand-off and every vendor call FORGE made (start, open,
  relay), which also feeds the 10-an-hour limit on vendor calls per user.

Status is derived from those records and from GitHub, never from a timer:

    claimed          a lease and nothing else yet
    agent_working    an agent was started or opened, or reported progress
    ready_to_submit  the agent says it pushed, opened the pull request or is done, but
                     no upstream pull request is found yet
    in_checks        the upstream pull request is open; checks pending or failing
    in_review        every check passed
    shipped          merged

(`shipping` stays in the stage list for the web app but nothing produces it: GitHub's
REST pull request has no review decision to read.) Leases are FORGE's own until Foreman's
claim API is wired in; Foreman's ledger stays the long-term source of truth.
"""

import json
import logging
import math
import os
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol, cast, get_args

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
    check_state,
    failure_notes,
    pull_url,
)
from forge_api.services.identity import Identity
from forge_api.services.rail_adapters import (
    AdapterError,
    AdapterRequest,
    RailCredential,
    adapter_for,
    make_client,
)
from forge_api.services.rail_adapters.base import log_failure, strip_controls
from forge_api.services.rail_adapters.claude_routine import API_URL as ROUTINE_API_URL
from forge_api.services.rail_adapters.claude_routine import trigger_id
from forge_api.services.rail_adapters.devin import valid_org_id
from forge_api.services.rails import RAIL_REGISTRY, rail_meta
from forge_api.services.state import StateDB, get_state_db, register_schema
from forge_api.services.vault import Vault

logger = logging.getLogger(__name__)

# --- settings -------------------------------------------------------------------------

#: Lease length by size class (PRD §4 Stage 3).
LEASE_HOURS_BY_SIZE: dict[Size, int] = {"XS": 48, "S": 48, "M": 96}
MAX_ACTIVE_CLAIMS_ENV = "FORGE_MAX_ACTIVE_CLAIMS"
DEFAULT_MAX_ACTIVE_CLAIMS = 2
START_RAILS_ENV = "FORGE_START_RAILS"
TASK_SOURCE_ENV = "FORGE_TASK_SOURCE"
AGENT_START_FLAG = "agent_start"
#: Vendor calls (starts and relayed notes) per user per window.
DISPATCH_LIMIT = 10
DISPATCH_WINDOW = timedelta(hours=1)
#: Agent-written text is cut to this many characters.
MAX_MESSAGE = 500
#: The newest events a status shows.
MAX_EVENTS_SHOWN = 50
#: Progress reports one lease accepts before it asks the agent to stop.
MAX_PROGRESS_PER_LEASE = 200
#: Clicking the same open-rail link again within this window records nothing new.
OPENED_DEDUPE = timedelta(minutes=5)
#: Progress stages after which the work is ready to hand in.
READY_STAGES: frozenset[str] = frozenset({"pushed", "pr_opened", "done"})
#: USD equivalents of the reward classes (PRD §6: R1 ≈ $50 … R4 ≈ $1,500).
REWARD_USD: dict[str, float] = {"R1": 50.0, "R2": 200.0, "R3": 600.0, "R4": 1500.0}

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


def clean_text(text: str, limit: int = MAX_MESSAGE) -> str:
    """Untrusted text as FORGE stores it: plain, one line, at most `limit` characters."""
    return strip_controls(text)[:limit]


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
    send the pasted key back in its `input` field."""
    try:
        data = json.loads(body)
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
            merged_at TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_leases_task ON bridge_leases (task_id, id)",
        "CREATE INDEX IF NOT EXISTS bridge_leases_holder ON bridge_leases (holder_sub, id)",
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
            session_ref TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS bridge_dispatches_lease ON bridge_dispatches (lease_id, id)",
        "CREATE INDEX IF NOT EXISTS bridge_dispatches_sub ON bridge_dispatches (sub, at)",
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
    rewardUsd: float | None
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
            rewardUsd=self.rewardUsd,
            tierFloor=self.tierFloor,
            status="claimed" if claimed_by is not None else "open",
            url=self.url,
            labels=list(self.labels),
            claimedBy=claimed_by,
            leaseEndsAt=lease_ends_at,
        )


class TaskSource(Protocol):
    """Where agent-ready tasks come from: the committed fixtures, or GitHub."""

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


_SECTION = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
_ITEM = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$")
_NO_RESPONSE = "_No response_"


def _sections(body: str) -> dict[str, str]:
    """The answers of a rendered GitHub issue form, by lowercased heading."""
    found: dict[str, str] = {}
    matches = list(_SECTION.finditer(body))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        text = body[match.end() : end].strip()
        found[match.group(1).strip().lower()] = "" if text == _NO_RESPONSE else text
    return found


def parse_task_issue(issue: Mapping[str, Any]) -> TaskFixture | None:
    """A task from an issue written with .github/ISSUE_TEMPLATE/task-spec.yml, or None
    when it doesn't parse (no summary, no size class, not an issue)."""
    number, title, body, url = (
        issue.get("number"),
        issue.get("title"),
        issue.get("body"),
        issue.get("html_url"),
    )
    if not (isinstance(number, int) and not isinstance(number, bool) and number > 0):
        return None
    if not (isinstance(title, str) and isinstance(body, str) and isinstance(url, str)):
        return None
    labels: list[str] = [
        str(label["name"])
        for label in issue.get("labels") or []
        if isinstance(label, dict) and isinstance(label.get("name"), str)
    ]
    answers = _sections(body)
    summary = clean_text(answers.get("civilian summary") or answers.get("goal") or "", 300)
    criteria = [
        clean_text(match.group(1), 300)
        for line in (answers.get("acceptance criteria") or "").splitlines()
        if (match := _ITEM.match(line))
    ]

    def pick(answer: str, label_prefix: str, allowed: tuple[str, ...], default: str) -> str:
        value = answers.get(answer, "").strip()
        if value in allowed:
            return value
        for label in labels:
            if label.startswith(label_prefix) and label[len(label_prefix) :] in allowed:
                return label[len(label_prefix) :]
        return default

    size = pick("size class", "size:", get_args(Size), "")
    if not summary or not size:
        return None
    reward = pick("reward class", "bounty:", get_args(RewardClass), "none")
    return TaskFixture(
        id=number,
        title=clean_text(title, 200),
        civilianSummary=summary,
        size=cast(Size, size),
        rewardClass=cast(RewardClass, reward),
        rewardUsd=REWARD_USD.get(reward),
        tierFloor=cast(TierFloor, pick("tier floor", "tier:", get_args(TierFloor), "T0")),
        url=url,
        labels=labels,
        acceptanceCriteria=criteria,
    )


class GitHubTaskSource:
    """Open issues on verastd/forge-app labelled `agent-ready` and `status:open`, read
    through GitHubReads (cached 5 minutes). On a GitHub failure the last good list is
    kept; with none yet, the list is empty."""

    def __init__(self, github: GitHubReads | None = None) -> None:
        self._github = github
        self._last: list[TaskFixture] = []

    def list_tasks(self) -> list[TaskFixture]:
        github = self._github if self._github is not None else get_github_reads()
        try:
            issues = github.task_issues()
        except GitHubUnavailable as exc:
            logger.warning("task list from GitHub unavailable: %s", exc)
            return list(self._last)
        tasks = [task for task in map(parse_task_issue, issues) if task is not None]
        self._last = sorted(tasks, key=lambda task: task.id)
        return list(self._last)

    def get_task(self, task_id: int) -> TaskFixture | None:
        return next((task for task in self.list_tasks() if task.id == task_id), None)


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

    def is_active(self, now: datetime) -> bool:
        return self.released_at is None and now < self.ends_at


@dataclass(frozen=True)
class DispatchRecord:
    id: int
    rail: Rail
    mode: str
    outcome: str
    at: datetime
    session_url: str | None
    session_ref: str | None


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

    def active_by_task(self) -> dict[int, Lease]:
        rows = self.db.query_all(
            "SELECT * FROM bridge_leases WHERE released_at IS NULL AND ends_at > ? ORDER BY id",
            (_to_db(self.now()),),
        )
        return {lease.task_id: lease for lease in map(_lease, rows)}

    def held_by(self, sub: str, *, active_only: bool = True) -> list[Lease]:
        if active_only:
            rows = self.db.query_all(
                "SELECT * FROM bridge_leases WHERE holder_sub = ? AND released_at IS NULL "
                "AND ends_at > ? ORDER BY id",
                (sub, _to_db(self.now())),
            )
        else:
            rows = self.db.query_all(
                "SELECT * FROM bridge_leases WHERE holder_sub = ? ORDER BY id", (sub,)
            )
        return [_lease(row) for row in rows]

    def claim(
        self, task_id: int, identity: Identity, lease_hours: int, max_active: int
    ) -> tuple[Lease, bool]:
        """Take the lease, atomically. Returns (lease, created); re-claiming your own
        active lease returns it unchanged. Raises 409 already_claimed / claim_limit."""
        now = self.now()
        with self.db.transaction() as db:
            current = self.active(task_id)
            if current is not None:
                if current.holder_sub == identity.sub:
                    return current, False
                raise ApiError(409, {"error": "already_claimed", "claimedBy": current.holder_login})
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

    def set_pr(self, lease_id: int, number: int) -> None:
        self.db.execute(
            "UPDATE bridge_leases SET pr_number = ? WHERE id = ? AND merged_at IS NULL",
            (number, lease_id),
        )

    def set_merged(self, lease_id: int, number: int) -> None:
        self.db.execute(
            "UPDATE bridge_leases SET pr_number = ?, merged_at = ? WHERE id = ? "
            "AND merged_at IS NULL",
            (number, _to_db(self.now()), lease_id),
        )

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
        self.db.execute(
            "INSERT INTO bridge_events (lease_id, at, kind, source, message, rail, stage) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (lease.id, _to_db(self.now()), kind, source, clean_text(message), rail, stage),
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
            "AND message LIKE ?",
            (lease_id, f"Pull request #{number} %"),
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
    ) -> int:
        written = self.db.execute(
            "INSERT INTO bridge_dispatches (lease_id, sub, rail, mode, outcome, at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (lease.id, sub, rail, mode, outcome, _to_db(self.now())),
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
_sources: dict[str, TaskSource] = {}
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
    """Fixtures by default; GitHub issues with FORGE_TASK_SOURCE=github."""
    kind = "github" if os.environ.get(TASK_SOURCE_ENV, "").strip().lower() == "github" else ""
    with _providers_lock:
        source = _sources.get(kind)
        if source is None:
            source = GitHubTaskSource() if kind else FixtureTaskSource()
            _sources[kind] = source
        return source


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


# --- the service ----------------------------------------------------------------------


def _hours_left(lease: Lease, now: datetime) -> str:
    hours = math.ceil((lease.ends_at - now).total_seconds() / 3600)
    return "for less than an hour" if hours <= 1 else f"for about {hours} hours"


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
        """The caller's active lease on the task: 409 not_claimed when nobody holds it,
        403 not_holder when someone else does."""
        lease = self.store.active(task_id)
        if lease is None:
            raise ApiError(409, {"error": "not_claimed", "taskId": task_id})
        if lease.holder_sub != identity.sub:
            raise ApiError(403, {"error": "not_holder", "taskId": task_id})
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

    def list_tasks(self) -> TaskList:
        active = self.store.active_by_task()
        cards: list[TaskCard] = []
        for task in self.source.list_tasks():
            lease = active.get(task.id)
            cards.append(
                task.to_card()
                if lease is None
                else task.to_card(claimed_by=lease.holder_login, lease_ends_at=iso(lease.ends_at))
            )
        return TaskList(tasks=cards)

    def card(self, task: TaskFixture) -> TaskCard:
        lease = self.store.active(task.id)
        if lease is None:
            return task.to_card()
        return task.to_card(claimed_by=lease.holder_login, lease_ends_at=iso(lease.ends_at))

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
        lease, _ = self.store.claim(
            task.id, identity, LEASE_HOURS_BY_SIZE[task.size], max_active_claims()
        )
        return ClaimResponse(
            taskId=task.id,
            claimedBy=lease.holder_login,
            leaseEndsAt=iso(lease.ends_at),
            leaseHours=lease.lease_hours,
        )

    def release(self, identity: Identity, task_id: int) -> BridgeStatus:
        self.task(task_id)
        lease = self.held_lease(identity, task_id)
        return self.status_of(self.store.release(lease, identity.login), identity)

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
        self._check_vendor_limit(identity)
        attempt = self.store.record_dispatch(lease, identity.sub, rail, "start", "pending")
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

    def _pull_for(self, lease: Lease, branch: str) -> tuple[PullRequest | None, bool]:
        """The upstream pull request for this lease, and whether GitHub answered.

        A number FORGE was told (submit, or an agent's report) is used only when that
        pull request comes from the holder's fork; otherwise the holder's branch is
        looked up. A merge is remembered, so a shipped task never asks GitHub again.
        """
        if lease.merged_at is not None and lease.pr_number is not None:
            return (
                PullRequest(
                    number=lease.pr_number,
                    url=pull_url(lease.pr_number),
                    state="closed",
                    merged=True,
                    head_sha="",
                    head_ref=branch,
                    head_owner=lease.holder_login,
                    title="",
                ),
                True,
            )
        try:
            pull: PullRequest | None = None
            if lease.pr_number is not None:
                candidate = self.github.pull(lease.pr_number)
                owner = (candidate.head_owner or "").lower() if candidate is not None else ""
                if candidate is not None and owner == lease.holder_login.lower():
                    pull = candidate
            if pull is None or not (pull.is_open or pull.merged):
                found = self.github.find_pull(lease.holder_login, branch)
                if found is not None and (pull is None or found.is_open or found.merged):
                    pull = found
        except GitHubUnavailable as exc:
            logger.info("GitHub unavailable for task %s: %s", lease.task_id, exc)
            return None, False
        if pull is not None and pull.merged:
            self.store.set_merged(lease.id, pull.number)
        elif pull is not None and pull.is_open and pull.number != lease.pr_number:
            self.store.set_pr(lease.id, pull.number)
        return pull, True

    def status_of(self, lease: Lease, viewer: Identity | None) -> BridgeStatus:
        task = self.task(lease.task_id)
        branch = branch_name(task.id, task.title)
        now = self.store.now()
        active = lease.is_active(now)
        is_holder = viewer is not None and viewer.sub == lease.holder_sub
        pull, github_ok = self._pull_for(lease, branch)
        live = pull if pull is not None and (pull.is_open or pull.merged) else None
        check, passed, total, failed = "pending", 0, 0, 0
        if live is not None and live.is_open:
            try:
                runs = self.github.check_runs(live.head_sha)
            except GitHubUnavailable:
                github_ok, runs = False, []
            check, passed, total = check_state(runs)
            failed = sum(
                1 for run in runs if run.status == "completed" and run.conclusion not in PASSING
            )

        stage: BridgeStage
        if live is not None and live.merged:
            stage = "shipped"
            detail = "Your contribution was merged into FORGE. Thank you!"
            if task.rewardClass != "none":
                detail += " Its reward unlocks once it survives 14 days in production."
        elif live is not None and check == "passed":
            stage = "in_review"
            detail = "All checks passed. A maintainer will review your contribution next."
        elif live is not None:
            stage = "in_checks"
            if check == "failed":
                detail = (
                    f"{failed} of {total} checks failed. Send the notes to your agent so it "
                    "can fix them."
                )
            elif total == 0:
                detail = "The pull request is open. Its checks haven't started yet."
            else:
                detail = f"{passed} of {total} checks passed. The rest are still running."
        elif not active:
            stage = "claimed"
            detail = (
                "This task was let go, so it's open again. Anyone can claim it."
                if lease.released_at is not None
                else "Time ran out on this task, so it's open again. Anyone can claim it."
            )
        elif READY_STAGES.intersection(self.store.progress_stages(lease.id)):
            stage = "ready_to_submit"
            detail = (
                "Your agent says the work is ready, but there's no pull request for it yet. "
                "Use “Open the pull request on GitHub”, or ask your agent to open it."
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
                f"This task is yours {_hours_left(lease, now)}. Get your agent on it "
                "whenever you're ready."
            )
        if not github_ok:
            detail += " (We couldn't reach GitHub just now, so this may be a little behind.)"

        last = self.store.last_dispatch(lease.id)
        started = self.store.last_dispatch(lease.id, mode="start") if is_holder else None
        counted = live is not None and live.is_open and total > 0
        return BridgeStatus(
            taskId=task.id,
            stage=stage,
            detail=detail,
            events=self.store.events(lease.id, with_agent_text=is_holder),
            holder=lease.holder_login if active else None,
            leaseEndsAt=iso(lease.ends_at) if active else None,
            rail=last.rail if last is not None else None,
            sessionUrl=started.session_url if started is not None else None,
            prUrl=live.url if live is not None else None,
            compareUrl=(
                compare_url(lease.holder_login, branch)
                if is_holder and active and live is None
                else None
            ),
            checksPassed=passed if counted else None,
            checksTotal=total if counted else None,
        )

    def status(self, task_id: int, viewer: Identity | None) -> BridgeStatus:
        """Translated status — the CI log in friendlier clothes (PRD I.2, Watch row)."""
        self.task(task_id)
        return self.status_of(self.latest_lease(task_id), viewer)

    def check_results(self, task_id: int) -> CheckResults:
        """The checks on the task's pull request, with notes an agent can act on. Any
        GitHub failure is "pending" with a plain note, never an error."""
        task = self.task(task_id)
        lease = self.latest_lease(task_id)
        branch = branch_name(task.id, task.title)
        pull, github_ok = self._pull_for(lease, branch)
        if not github_ok:
            return CheckResults(
                taskId=task.id,
                state="pending",
                checks=[],
                notes="FORGE couldn't reach GitHub just now. Try again in a minute.",
            )
        if pull is None or not (pull.is_open or pull.merged):
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
        if pull.merged:
            return CheckResults(
                taskId=task.id,
                state="passed",
                checks=[],
                notes=f"Pull request #{pull.number} was merged. Nothing left to fix.",
                prUrl=pull.url,
            )
        try:
            runs = self.github.check_runs(pull.head_sha)
        except GitHubUnavailable:
            return CheckResults(
                taskId=task.id,
                state="pending",
                checks=[],
                notes="FORGE couldn't read the checks from GitHub just now. Try again in a minute.",
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

    def feedback(self, identity: Identity, task_id: int) -> FeedbackResponse:
        """One button: send the checks' notes back to the agent (PRD I.2, Iterate row).
        Relayed only when the last start went to a rail that takes follow-ups and the
        caller saved a credential for it; otherwise the notes come back to show."""
        self.task(task_id)
        lease = self.held_lease(identity, task_id)
        results = self.check_results(task_id)
        not_relayed = FeedbackResponse(relayed=False, notes=results.notes)
        last = self.store.last_dispatch(lease.id, mode="start")
        if results.state != "failed" or last is None or last.session_ref is None:
            return not_relayed
        rail = cast(StartRail, last.rail)
        adapter = adapter_for(rail, self.rail_client)
        vault = self.vault()
        credential = vault.load(identity.sub, rail) if adapter.supports_notes else None
        if credential is None:
            return not_relayed
        try:
            self._check_vendor_limit(identity)
        except ApiError:
            return not_relayed
        attempt = self.store.record_dispatch(lease, identity.sub, rail, "relay", "pending")
        message = (
            "FORGE: the checks on your pull request failed. Fix what they found on the same "
            "branch and push.\n\n" + results.notes
        )
        try:
            adapter.send_notes(credential, last.session_ref, message)
        except AdapterError as exc:
            log_failure(rail, "relay", exc)
            self.store.finish_dispatch(attempt, exc.code)
            if exc.code == "credential_rejected":
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
        """Hand in the pull request: on verastd/forge-app, from the caller's own fork."""
        self.task(task_id)
        lease = self.held_lease(identity, task_id)
        number = parse_pr_url(pr_url)
        if number is None:
            raise ApiError(400, {"error": "invalid_pr_url"})
        try:
            pull = self.github.pull(number, fresh=True)
        except GitHubUnavailable:
            raise ApiError(503, {"error": "github_unavailable"}) from None
        if pull is None:
            raise ApiError(404, {"error": "pr_not_found", "prNumber": number})
        if (pull.head_owner or "").lower() != identity.login.lower():
            raise ApiError(403, {"error": "not_your_pr", "prNumber": number})
        if not self.store.has_submission(lease.id, number):
            self.store.set_pr(lease.id, number)
            self.store.add_event(
                lease, "submitted", source, f"Pull request #{number} was handed in for checks."
            )
        return self.status_of(self.store.lease(lease.id) or lease, identity)

    def report_progress(
        self,
        identity: Identity,
        task_id: int,
        stage: ProgressStage,
        message: str,
        pr_url: str | None = None,
    ) -> BridgeStatus:
        """An agent's milestone, through the connector. The message is untrusted text."""
        self.task(task_id)
        lease = self.held_lease(identity, task_id)
        if len(self.store.progress_stages(lease.id)) >= MAX_PROGRESS_PER_LEASE:
            raise ApiError(429, {"error": "progress_limit", "limit": MAX_PROGRESS_PER_LEASE})
        text = clean_text(message) or stage.replace("_", " ")
        self.store.add_event(lease, "progress", "agent", text, stage=stage)
        number = parse_pr_url(pr_url) if pr_url else None
        if number is not None and lease.pr_number is None:
            self.store.set_pr(lease.id, number)  # a hint: status checks whose fork it's from
        return self.status_of(self.store.lease(lease.id) or lease, identity)

    # settle

    def profile(self, identity: Identity) -> ContributorProfile:
        """The caller's own record as FORGE knows it. Foreman's ledger (tiers, rewards,
        survival) isn't wired in yet, so those stay at their starting values."""
        leases = self.store.held_by(identity.sub, active_only=False)
        ledger: list[LedgerEvent] = []
        for lease in leases:
            ledger.append(
                LedgerEvent(
                    kind="claim", refIssue=lease.task_id, points=0.0, at=iso(lease.claimed_at)
                )
            )
            if lease.merged_at is not None:
                ledger.append(
                    LedgerEvent(
                        kind="merge",
                        refPr=lease.pr_number,
                        refIssue=lease.task_id,
                        points=1.0,
                        at=iso(lease.merged_at),
                    )
                )
        merged = sum(1 for lease in leases if lease.merged_at is not None)
        return ContributorProfile(
            login=identity.login,
            tier="T0",
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
