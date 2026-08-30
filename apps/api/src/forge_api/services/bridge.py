"""The Bridge: claim, dispatch, watch, iterate — for people who will never see GitHub.

Phase 0 stub of PRD Appendix I. Everything here is deliberately in-memory and
simulated: the real implementation talks to GitHub as the user (OAuth) and reads
Foreman's ledger. **Foreman's ledger is the real source of truth for leases** — this
module's LeaseStore only exists so the app can be demoed end-to-end before Foreman's
claim API is wired up, and is expected to be deleted, not grown.
"""

import json
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

from forge_api.models import (
    BridgeStage,
    BridgeStatus,
    ClaimResponse,
    ContributorProfile,
    DispatchMode,
    DispatchRequest,
    DispatchResult,
    FeedbackResponse,
    LedgerEvent,
    PendingReward,
    Rail,
    RewardClass,
    Size,
    TaskCard,
    TaskList,
    TierFloor,
)
from forge_api.services.errors import ApiError

# --- constants ---------------------------------------------------------------

#: Demo identity. The real Bridge acts as the authenticated GitHub user (PRD I.5).
DEMO_IDENTITY = "you"

#: Lease length by size class (PRD §4 Stage 3).
LEASE_HOURS_BY_SIZE: dict[Size, int] = {"XS": 48, "S": 48, "M": 96}

#: Simulated pipeline: one stage every SECONDS_PER_STAGE from the moment of claim.
SECONDS_PER_STAGE = 45
STAGES: tuple[BridgeStage, ...] = (
    "claimed",
    "agent_working",
    "ready_to_submit",
    "in_checks",
    "in_review",
    "shipping",
    "shipped",
)

#: Checks shown while the Gauntlet runs (PRD I.2, Watch row voice).
CHECKS_TOTAL = 5
CHECKS_PASSED = 3

#: Rails that dispatch through an API vs. rails that need a guided handoff (PRD I.3).
API_RAILS: dict[Rail, str] = {
    "copilot": "GitHub Copilot",
    "jules": "Google Jules",
    "cursor": "Cursor",
    "devin": "Devin",
    "openhands": "OpenHands Cloud",
}
HANDOFF_RAILS: dict[Rail, tuple[str, str]] = {
    "claude-code": ("Claude Code", "https://claude.ai/code"),
    "codex": ("OpenAI Codex", "https://chatgpt.com/codex"),
}

_API_RAIL_NOTES: dict[Rail, str] = {
    "copilot": (
        "GitHub Copilot picks this up under the same account you signed in with — "
        "nothing else to connect."
    ),
    "jules": "Jules runs this with the key you connected (its free tier covers 15 tasks a day).",
    "cursor": "Cursor's cloud agent runs this on your own plan, using the key you connected.",
    "devin": "Devin starts a session on your own plan, using the key you connected.",
    "openhands": "OpenHands Cloud starts a session using the key you connected.",
}

#: Stage 5 emits machine-readable failures precisely so the Bridge can relay them
#: (PRD I.2, Iterate row). This is a representative sample for the stub.
SAMPLE_GAUNTLET_FAILURE = (
    "gauntlet: FAIL G2.3 — acceptance test issue-1/test_csv_export.py::test_headers"
)

_FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "tasks.json"


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    """ISO 8601 with a Z suffix — the format the web app parses."""
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def slugify(text: str, max_length: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > max_length:
        slug = slug[:max_length].rsplit("-", 1)[0]
    return slug.strip("-")


def branch_name(task_id: int, title: str) -> str:
    """The one branch the agent is allowed to touch (PRD I.2, Dispatch row)."""
    return f"task/{task_id}-{slugify(title)}"


# --- task sources ------------------------------------------------------------


@dataclass(frozen=True)
class TaskFixture:
    """A Task Spec as the Bridge needs it: card fields plus acceptance criteria.

    `acceptanceCriteria` feeds the compiled prompt only; it is stripped before the
    card goes over the wire, so TaskCard stays exactly the shared zod shape.
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
    """Where agent-ready tasks come from. One interface, fixture now, GitHub later."""

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
    """Phase 3 — GraphQL `agent-ready`+`status:open` per PRD I.2.

    Lists Issues carrying both labels with a tier floor at or below the caller's tier,
    reading `civilian_summary` from the Task Spec form (PRD Appendix B) for card text.
    Not implemented in Phase 0: the Bridge ships against fixtures first so the UX can
    be built and reviewed before any GitHub token is in play.
    """

    def list_tasks(self) -> list[TaskFixture]:
        raise NotImplementedError("GitHubTaskSource lands in Phase 3 (PRD I.2)")

    def get_task(self, task_id: int) -> TaskFixture | None:
        raise NotImplementedError("GitHubTaskSource lands in Phase 3 (PRD I.2)")


# --- lease store -------------------------------------------------------------


@dataclass(frozen=True)
class Lease:
    task_id: int
    claimed_by: str
    claimed_at: datetime
    lease_hours: int

    @property
    def ends_at(self) -> datetime:
        return self.claimed_at + timedelta(hours=self.lease_hours)

    def is_active(self, now: datetime) -> bool:
        return now < self.ends_at


class LeaseStore:
    """In-memory claim state. Foreman's ledger is the real source of truth later.

    Expired leases are kept, not deleted: the status endpoint still has to answer for a
    task whose lease ran out ("first expiry is strike-free", PRD I.2 abandonment).
    """

    def __init__(self, now_fn: Callable[[], datetime] | None = None) -> None:
        self._now_fn = now_fn or utc_now
        self._lock = threading.Lock()
        self._leases: dict[int, Lease] = {}

    def now(self) -> datetime:
        return self._now_fn()

    def get(self, task_id: int) -> Lease | None:
        """Any lease ever recorded for this task, expired or not."""
        with self._lock:
            return self._leases.get(task_id)

    def get_active(self, task_id: int) -> Lease | None:
        lease = self.get(task_id)
        return lease if lease is not None and lease.is_active(self.now()) else None

    def claim(self, task_id: int, lease_hours: int, claimed_by: str = DEMO_IDENTITY) -> Lease:
        """Take the lease, or raise 409 if someone already holds an active one."""
        now = self.now()
        with self._lock:
            existing = self._leases.get(task_id)
            if existing is not None and existing.is_active(now):
                raise ApiError(
                    409, {"error": "already_claimed", "claimedBy": existing.claimed_by}
                )
            lease = Lease(
                task_id=task_id, claimed_by=claimed_by, claimed_at=now, lease_hours=lease_hours
            )
            self._leases[task_id] = lease
            return lease

    def clear(self) -> None:
        with self._lock:
            self._leases.clear()


_store = LeaseStore()
_source: TaskSource = FixtureTaskSource()


def get_lease_store() -> LeaseStore:
    """FastAPI dependency — overridden in tests to inject a clock."""
    return _store


def get_task_source() -> TaskSource:
    """FastAPI dependency — swapped for GitHubTaskSource in Phase 3."""
    return _source


# --- service operations ------------------------------------------------------


def _require_task(source: TaskSource, task_id: int) -> TaskFixture:
    task = source.get_task(task_id)
    if task is None:
        raise ApiError(404, {"error": "task_not_found", "taskId": task_id})
    return task


def list_task_cards(source: TaskSource, store: LeaseStore) -> TaskList:
    """Cards for the browse screen, with live claim state (PRD I.2, Browse row)."""
    cards: list[TaskCard] = []
    for task in source.list_tasks():
        lease = store.get_active(task.id)
        if lease is None:
            cards.append(task.to_card())
        else:
            cards.append(
                task.to_card(claimed_by=lease.claimed_by, lease_ends_at=iso(lease.ends_at))
            )
    return TaskList(tasks=cards)


def claim_task(source: TaskSource, store: LeaseStore, task_id: int) -> ClaimResponse:
    """Claim → lease countdown. Mirrors the `/claim` comment path exactly (PRD I.2)."""
    task = _require_task(source, task_id)
    lease_hours = LEASE_HOURS_BY_SIZE[task.size]
    lease = store.claim(task_id, lease_hours)
    return ClaimResponse(
        taskId=task_id,
        claimedBy=lease.claimed_by,
        leaseEndsAt=iso(lease.ends_at),
        leaseHours=lease.lease_hours,
    )


def compile_prompt(task: TaskFixture) -> str:
    """The compiled prompt — identical on every rail (PRD I.3, agent-agnosticism)."""
    criteria = "\n".join(
        f"{index}. {criterion}" for index, criterion in enumerate(task.acceptanceCriteria, start=1)
    )
    return (
        f"Task #{task.id}: {task.title}\n\n"
        f"What this means in plain language: {task.civilianSummary}\n\n"
        f"Acceptance criteria (each one is checked by a test):\n{criteria}\n\n"
        "Read AGENTS.md at repo root first. "
        f"Work ONLY in branch {branch_name(task.id, task.title)} of your fork of forge-app. "
        "Do not modify .github/, acceptance tests, or files outside the task scope."
    )


def _api_instructions(rail: Rail, task: TaskFixture) -> list[str]:
    """Civilian voice only: no fork/branch/PR/CI vocabulary reaches this list (PRD §4.9)."""
    return [
        _API_RAIL_NOTES[rail],
        "We set up your own copy of the app and a private workspace for this task inside it — "
        "your agent works there and nowhere else.",
        "You can close this screen. We'll watch your agent's progress and tell you the moment "
        "it's ready to submit.",
    ]


def _handoff_instructions(rail: Rail, task: TaskFixture) -> list[str]:
    """Civilian voice only — the instructions are about the agent app, not about git (PRD I.2)."""
    label, deep_link = HANDOFF_RAILS[rail]
    return [
        "Tap Copy to put the whole task prompt on your clipboard.",
        f"Tap Open {label} — it opens {deep_link} and already has access to your copy of the app.",
        f"Paste the prompt and send it. {label} does the work and sends your contribution in "
        "for checks automatically; come back here to watch how it goes.",
    ]


def dispatch_task(
    source: TaskSource, store: LeaseStore, request: DispatchRequest
) -> DispatchResult:
    """Hand the task to the contributor's own agent (BYOA — PRD §4.9 invariant 2)."""
    task = _require_task(source, request.taskId)
    if store.get_active(request.taskId) is None:
        raise ApiError(409, {"error": "not_claimed", "taskId": request.taskId})

    prompt = compile_prompt(task)
    rail = request.rail
    if rail in API_RAILS:
        mode: DispatchMode = "api"
        return DispatchResult(
            mode=mode,
            compiledPrompt=prompt,
            deepLink=None,
            sessionRef=f"stub-{rail}-{task.id}",
            instructions=_api_instructions(rail, task),
        )
    _, deep_link = HANDOFF_RAILS[rail]
    return DispatchResult(
        mode="handoff",
        compiledPrompt=prompt,
        deepLink=deep_link,
        sessionRef=None,
        instructions=_handoff_instructions(rail, task),
    )


def stage_for(elapsed_seconds: float) -> BridgeStage:
    index = int(max(0.0, elapsed_seconds) // SECONDS_PER_STAGE)
    return STAGES[min(index, len(STAGES) - 1)]


def _detail_for(stage: BridgeStage, lease: Lease) -> str:
    details: dict[BridgeStage, str] = {
        "claimed": (
            f"This task is yours for the next {lease.lease_hours} hours. "
            "Hand it to your agent whenever you're ready."
        ),
        "agent_working": (
            "Your agent has started. We'll let you know when there's something to see."
        ),
        "ready_to_submit": (
            "Your agent says it's done. Have a look at its summary, then submit it for checks."
        ),
        "in_checks": (
            f"{CHECKS_PASSED} of {CHECKS_TOTAL} checks passed. The rest are still running."
        ),
        "in_review": "All checks passed. A maintainer is reading your contribution now.",
        "shipping": (
            "A maintainer approved your contribution. It ships to beta on the next release."
        ),
        "shipped": (
            "Your contribution shipped. Your reward unlocks once it survives 14 days in production."
        ),
    }
    return details[stage]


def get_status(source: TaskSource, store: LeaseStore, task_id: int) -> BridgeStatus:
    """Translated status — the CI log in friendlier clothes (PRD I.2, Watch row)."""
    _require_task(source, task_id)
    lease = store.get(task_id)
    if lease is None:
        raise ApiError(404, {"error": "not_claimed", "taskId": task_id})

    elapsed = (store.now() - lease.claimed_at).total_seconds()
    stage = stage_for(elapsed)
    checks_passed = CHECKS_PASSED if stage == "in_checks" else None
    checks_total = CHECKS_TOTAL if stage == "in_checks" else None
    return BridgeStatus(
        taskId=task_id,
        stage=stage,
        detail=_detail_for(stage, lease),
        checksPassed=checks_passed,
        checksTotal=checks_total,
    )


def relay_feedback(source: TaskSource, task_id: int) -> FeedbackResponse:
    """One button: send the Gauntlet's notes back to the agent (PRD I.2, Iterate row)."""
    task = _require_task(source, task_id)
    prompt = (
        "The automated checks came back with a failure on your last push. "
        "Here is the report exactly as the checks produced it:\n\n"
        f"{SAMPLE_GAUNTLET_FAILURE}\n\n"
        f"Please fix the cause of that failure in branch {branch_name(task.id, task.title)}, "
        "keep every change inside this task's scope, do not modify the acceptance tests, "
        "and push again once the checks pass locally."
    )
    return FeedbackResponse(relayed=True, prompt=prompt)


def get_profile(store: LeaseStore) -> ContributorProfile:
    """The public ledger, in friendlier clothes (PRD §4.9, Settle row)."""
    now = store.now()
    return ContributorProfile(
        login=DEMO_IDENTITY,
        tier="T0",
        merged=1,
        survivalRate=1.0,
        pendingRewards=[
            PendingReward(
                pr=1,
                rewardClass="R1",
                usdEquivalent=50.0,
                survivalEndsAt=iso(now + timedelta(days=12)),
            )
        ],
        ledger=[
            LedgerEvent(
                kind="claim", refPr=None, refIssue=3, points=0.0, at=iso(now - timedelta(days=5))
            ),
            LedgerEvent(
                kind="merge", refPr=1, refIssue=3, points=1.0, at=iso(now - timedelta(days=2))
            ),
            LedgerEvent(
                kind="reward_pending",
                refPr=1,
                refIssue=3,
                points=0.0,
                at=iso(now - timedelta(days=2)),
            ),
        ],
    )
