"""API contract models.

Mirrors packages/shared/src/index.ts — change both sides together or not at all (AGENTS.md)

Field names are camelCase on purpose: these models ARE the JSON wire contract the
Next.js app (via @forge/shared zod schemas) is coded against. Renaming a field here
without renaming it there is a cross-boundary drift bug the Gauntlet should catch
(PRD Appendix H.1).

Optional fields are `X | None = None` and Bridge, proposal and notification routes
serialize with `response_model_exclude_none`: zod's `.optional()` accepts a missing key
but rejects an explicit null, so None must never reach the wire (Upland is the documented
exception). The rail registry and the brief have their own mirrors: services/rails.py ⇄
packages/shared/src/rails.ts and services/brief.py ⇄ packages/shared/src/brief.ts.

A length limit counts characters as Unicode code points: len(), which pydantic's
min_length/max_length count. The zod side counts the same way (`textLength`), so an emoji
is one character on both. tests/fixtures/wire-golden.json records every limit.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Annotated, Final, Literal, get_args

from pydantic import BaseModel, Field, SecretStr, StrictBool, StrictInt, field_validator

Size = Literal["XS", "S", "M"]
RewardClass = Literal["none", "R1", "R2", "R3", "R4"]
#: The lowest tier that may take a task: T3 is never a floor.
TierFloor = Literal["T0", "T1", "T2"]
Tier = Literal["T0", "T1", "T2", "T3"]
TaskStatus = Literal["open", "claimed"]

#: Rails FORGE starts through the vendor's API (contract §2), in display order.
StartRail = Literal["copilot", "jules", "cursor", "devin", "openhands", "claude-routine"]
#: Rails FORGE opens as a link or a few steps (contract §2), in display order.
OpenRail = Literal["claude-code", "claude-cli", "codex", "vscode", "cursor-app", "antigravity"]
Rail = Literal[StartRail, OpenRail]
RailMode = Literal["start", "open"]
CredentialKind = Literal["github", "api_key", "devin", "routine"]

BridgeStage = Literal[
    "claimed",
    "agent_working",
    "ready_to_submit",
    "in_checks",
    "in_review",
    "shipping",
    "shipped",
]
#: What an agent may report through the connector's `report_progress`.
ProgressStage = Literal["started", "working", "pushed", "pr_opened", "blocked", "done"]
BridgeEventKind = Literal[
    "claimed", "dispatched", "opened", "progress", "submitted", "released", "relayed"
]
BridgeEventSource = Literal["forge", "agent"]
CheckRunStatus = Literal["queued", "in_progress", "completed"]
CheckState = Literal["no_pr", "pending", "passed", "failed"]

#: Stored proposal states (Phase 5 contract §2). `seconded` is momentary: seconding opens
#: debate at once, so a proposal goes submitted -> debate and its timeline records the
#: second. `lapsed`: nobody seconded in time; `withdrawn`: the mover withdrew first.
ProposalState = Literal[
    "submitted",
    "debate",
    "voting",
    "passed",
    "failed",
    "building",
    "shipped",
    "lapsed",
    "withdrawn",
]
#: Every kind of line in a proposal's timeline.
ProposalEventKind = Literal[
    "moved",
    "edited",
    "seconded",
    "consented",
    "objected",
    "commented",
    "debate_ended",
    "vote_opened",
    "voted",
    "vote_closed",
    "passed",
    "failed",
    "lapsed",
    "withdrawn",
    "task_drafted",
    "task_published",
    "shipped",
    "admin_ended_debate",
    "admin_closed_vote",
    "test_timers_on",
    "test_timers_off",
    # The floor closed while members couldn't act (`proposals` or `github_signin` off),
    # then opened again with every running deadline moved later by the time it was closed.
    "floor_paused",
    "floor_resumed",
]
VoteChoice = Literal["yes", "no", "abstain"]
#: Where a member of the eligible set stands in debate (ProposalYou.consent).
ConsentChoice = Literal["consented", "objected"]
NotificationKind = Literal[
    "proposal_moved",
    "proposal_seconded",
    "your_proposal_seconded",
    "proposal_passed",
    "proposal_failed",
    "proposal_lapsed",
    "vote_opened",
    "task_published",
]

#: The runtime tuples behind the literals above — the same names in packages/shared, in
#: the same order.
START_RAILS: tuple[StartRail, ...] = get_args(StartRail)
OPEN_RAILS: tuple[OpenRail, ...] = get_args(OpenRail)
RAILS: tuple[Rail, ...] = get_args(Rail)
PROGRESS_STAGES: tuple[ProgressStage, ...] = get_args(ProgressStage)
PROPOSAL_STATES: tuple[ProposalState, ...] = get_args(ProposalState)
PROPOSAL_EVENT_KINDS: tuple[ProposalEventKind, ...] = get_args(ProposalEventKind)
VOTE_CHOICES: tuple[VoteChoice, ...] = get_args(VoteChoice)
CONSENT_CHOICES: tuple[ConsentChoice, ...] = get_args(ConsentChoice)
NOTIFICATION_KINDS: tuple[NotificationKind, ...] = get_args(NotificationKind)

#: A member whose proposal is in one of these can't move another (409
#: one_active_proposal). Every other state is decided.
ACTIVE_PROPOSAL_STATES: tuple[ProposalState, ...] = ("submitted", "debate", "voting")

#: The most characters each text a member writes may have, and the most acceptance
#: criteria a draft task lists; each needs at least one. PROPOSAL_LIMITS in
#: packages/shared, with the same keys.
PROPOSAL_LIMITS: Final[Mapping[str, int]] = MappingProxyType(
    {
        "title": 100,
        "pitch": 4000,
        "comment": 2000,
        "summary": 500,  # a draft task's civilianSummary
        "criteria": 10,  # acceptance criteria per draft task
        "criterion": 300,  # characters per acceptance criterion
    }
)

#: A proposal's eligible set, frozen at its second, is the members seen in the last this
#: many days (members.last_seen), plus the mover and the seconder. ELIGIBLE_ACTIVITY_DAYS
#: in packages/shared.
ELIGIBLE_ACTIVITY_DAYS: Final = 30

_Title = Annotated[str, Field(min_length=1, max_length=PROPOSAL_LIMITS["title"])]
_Pitch = Annotated[str, Field(min_length=1, max_length=PROPOSAL_LIMITS["pitch"])]
_CommentText = Annotated[str, Field(min_length=1, max_length=PROPOSAL_LIMITS["comment"])]
_Summary = Annotated[str, Field(min_length=1, max_length=PROPOSAL_LIMITS["summary"])]
_Criterion = Annotated[str, Field(min_length=1, max_length=PROPOSAL_LIMITS["criterion"])]


class FlagConfig(BaseModel):
    """Feature flags (PRD Appendix H.2 — the deploy-safety linchpin)."""

    csv_export: bool
    contribute_bridge: bool
    upland_data: bool
    github_signin: bool
    apps_lobby: bool
    mcp_connector: bool
    agent_start: bool
    proposals: bool


class TaskCard(BaseModel):
    """A Bridge task card: an Issue rendered in plain language (PRD I.2, Browse row)."""

    id: int
    title: str
    civilianSummary: str
    size: Size
    rewardClass: RewardClass
    tierFloor: TierFloor
    status: TaskStatus
    url: str
    labels: list[str]
    claimedBy: str | None = None
    leaseEndsAt: str | None = None


class TaskList(BaseModel):
    tasks: list[TaskCard]


# ---------------------------------------------------------------------------
# Rails (contract §2) and the task as an agent gets it
# ---------------------------------------------------------------------------


class RailMeta(BaseModel):
    """One rail's static description. services/rails.py holds every rail's copy."""

    id: Rail
    mode: RailMode
    label: str
    vendor: str
    blurb: str
    setup: list[str]
    credential: CredentialKind | None = None  # start rails only
    keyUrl: str | None = None  # start rails except copilot
    plan: str | None = None


class RailInfo(RailMeta):
    """A rail as GET /api/bridge/rails serves it."""

    enabled: bool  # open: always; start: flag agent_start AND id in FORGE_START_RAILS
    savedCredential: bool | None = None  # present only when the caller is identified


class RailList(BaseModel):
    rails: list[RailInfo]
    vault: bool  # FORGE can save keys (FORGE_VAULT_KEY is set and valid)


class TaskDetail(BaseModel):
    """GET /api/bridge/tasks/{id}: the card plus everything an agent needs."""

    task: TaskCard
    acceptanceCriteria: list[str]
    branch: str
    brief: str


class ForkStatus(BaseModel):
    """GET /api/bridge/me/fork: whether the caller has a fork of verastd/forge-app."""

    exists: bool
    url: str | None = None


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


class Credential(BaseModel):
    """What a contributor pastes for a start rail. `key` is a SecretStr so it never
    shows up in a repr, a log line or a serialized response."""

    key: SecretStr = Field(min_length=1, max_length=4096)
    orgId: str | None = Field(default=None, max_length=200)  # devin
    routineUrl: str | None = Field(default=None, max_length=500)  # claude-routine


class DispatchRequest(BaseModel):
    taskId: int
    rail: Rail
    credential: Credential | None = None
    saveCredential: bool | None = None


class DispatchResult(BaseModel):
    """Result of handing a task to the contributor's own agent (contract §5, /dispatch)."""

    mode: RailMode
    rail: Rail
    brief: str
    startedAt: str
    sessionUrl: str | None = None
    sessionRef: str | None = None
    credentialSaved: bool | None = None


class ClaimRequest(BaseModel):
    taskId: int


class ClaimResponse(BaseModel):
    taskId: int
    claimedBy: str
    leaseEndsAt: str
    leaseHours: int


# ---------------------------------------------------------------------------
# Watch, checks, iterate, submit
# ---------------------------------------------------------------------------


class BridgeEvent(BaseModel):
    """One line of a task's history. `message` from an agent is untrusted plain text."""

    at: str
    kind: BridgeEventKind
    source: BridgeEventSource
    message: str
    rail: Rail | None = None
    stage: ProgressStage | None = None


class BridgeStatus(BaseModel):
    """Translated pipeline status — plain English, no CI jargon (PRD I.2, Watch row)."""

    taskId: int
    stage: BridgeStage
    detail: str
    events: list[BridgeEvent]
    holder: str | None = None
    leaseEndsAt: str | None = None
    rail: Rail | None = None
    sessionUrl: str | None = None  # holder only
    prUrl: str | None = None
    compareUrl: str | None = None  # holder only
    checksPassed: int | None = None
    checksTotal: int | None = None
    # Holder only: POST /feedback would really send the notes on (the last start went to
    # a rail that takes follow-ups, with the same saved credential, by fingerprint).
    canRelay: bool | None = None


class CheckRun(BaseModel):
    name: str
    status: CheckRunStatus
    conclusion: str | None = None
    summary: str | None = None
    url: str | None = None


class CheckResults(BaseModel):
    taskId: int
    state: CheckState
    checks: list[CheckRun]
    notes: str
    prUrl: str | None = None
    headSha: str | None = None


class FeedbackResponse(BaseModel):
    relayed: bool
    notes: str
    relayedTo: Rail | None = None


class SubmitRequest(BaseModel):
    prUrl: str


# ---------------------------------------------------------------------------
# The caller's saved keys and connected agents (/api/bridge/me/*)
# ---------------------------------------------------------------------------


class SavedCredential(BaseModel):
    rail: Rail
    hint: str  # the last 4 characters, e.g. "…a1b2"; never the key
    savedAt: str
    lastUsedAt: str | None = None


class SavedCredentialList(BaseModel):
    credentials: list[SavedCredential]
    vault: bool


class ConnectedAgent(BaseModel):
    id: str
    clientName: str  # self-declared by the client: untrusted text
    redirectHost: str
    connectedAt: str
    lastUsedAt: str | None = None


class ConnectedAgentList(BaseModel):
    agents: list[ConnectedAgent]


# ---------------------------------------------------------------------------
# OAuth consent — web server ⇄ API only (/api/oauth/authorize/*)
# ---------------------------------------------------------------------------


class AuthorizeParams(BaseModel):
    responseType: str
    clientId: str
    redirectUri: str
    codeChallenge: str
    codeChallengeMethod: str
    state: str | None = None
    scope: str | None = None
    resource: str | None = None


class AuthorizeCheck(BaseModel):
    clientName: str
    redirectHost: str
    scopes: list[str]


class AuthorizeError(BaseModel):
    error: str
    errorDescription: str | None = None
    redirectTo: str | None = None  # only when it is safe to send the user back


class AuthorizeDecision(BaseModel):
    redirectTo: str


# ---------------------------------------------------------------------------
# Proposals: the Propose floor (Phase 5 contract §2), behind the `proposals` flag.
# Logins, titles, pitches, comments and messages are plain text, rendered as text.
# Limits apply to what members send (the *Request models and NewProposal), not to
# what the API answers.
# ---------------------------------------------------------------------------


class ProposalCard(BaseModel):
    """A proposal as the floor lists it."""

    id: int
    title: str
    state: ProposalState
    mover: str  # GitHub login
    movedAt: str
    seconder: str | None = None  # GitHub login, once seconded
    deadline: str | None = None  # when the current period (lapse, debate or vote) ends
    commentCount: int
    objectionCount: int


class ProposalList(BaseModel):
    """GET /api/proposals: newest first. Every active proposal (submitted, debate, voting)
    and the newest 100 decided ones; `?decidedBefore=<id>` pages the older decided ones."""

    proposals: list[ProposalCard]
    testTimers: bool  # deadlines are minutes, not days
    moreDecided: bool | None = None  # true: older decided proposals than these exist
    floorPaused: bool | None = None  # true: members can't act now, so deadlines wait


class ProposalComment(BaseModel):
    """One comment in the public debate thread."""

    id: int
    author: str  # GitHub login
    text: str
    at: str


class ProposalEvent(BaseModel):
    """One line of a proposal's public timeline."""

    at: str
    kind: ProposalEventKind
    actor: str | None = None  # GitHub login; the admin's, for an admin action
    message: str


class ProposalTally(BaseModel):
    """The vote's count, shown only after the close."""

    yes: int
    no: int
    abstain: int
    eligible: int  # the size of the eligible set
    quorumMet: bool  # a majority of the eligible set cast a ballot (Abstain counts)


class ProposalYou(BaseModel):
    """What the caller may do now, and where they stand."""

    canEdit: bool
    canWithdraw: bool
    canSecond: bool
    canConsent: bool
    consent: ConsentChoice | None = None  # once the caller has consented or objected
    canComment: bool
    canVote: bool
    vote: VoteChoice | None = None  # the caller's ballot, changeable until the close
    isAdmin: bool


class DraftTask(BaseModel):
    """The task a passed proposal becomes. It starts as the proposal's title, the pitch as
    the summary and no criteria, so it carries no limits; an admin finishes it
    (DraftTaskRequest) and publishes it to the Contribute board."""

    title: str
    civilianSummary: str
    acceptanceCriteria: list[str]
    size: Size
    tierFloor: TierFloor
    rewardClass: RewardClass
    taskId: int | None = None  # the Contribute task, once published


class ProposalDetail(BaseModel):
    """GET /api/proposals/{id}."""

    proposal: ProposalCard
    pitch: str
    eligibleCount: int | None = None  # the size of the eligible set, frozen at the second
    consentCount: int | None = None  # who has consented, the mover included
    turnout: int | None = None  # during voting: ballots cast (totals stay hidden)
    tally: ProposalTally | None = None  # after the close
    comments: list[ProposalComment]
    events: list[ProposalEvent]
    you: ProposalYou | None = None  # identified callers only
    draft: DraftTask | None = None  # admins only
    taskId: int | None = None  # the Contribute task, once published
    # The text's revision: 1, plus 1 for every edit. A second sends the one it read
    # (SecondRequest).
    revision: int
    moreComments: bool | None = None  # true: older comments than `comments` exist
    floorPaused: bool | None = None  # true: members can't act now, so deadlines wait


class ProposalCommentPage(BaseModel):
    """GET /api/proposals/{id}/comments?before=<commentId>: up to 100 comments older than
    that one (the newest 100 without it), oldest first."""

    comments: list[ProposalComment]
    moreComments: bool  # true: even older comments exist


class NewProposal(BaseModel):
    """POST /api/proposals, and PATCH /api/proposals/{id} (the mover, until seconded)."""

    title: _Title
    pitch: _Pitch  # plain English, plain text


class SecondRequest(BaseModel):
    """POST /api/proposals/{id}/second: the revision of the text the seconder read
    (ProposalDetail.revision). Another one is 409 proposal_changed. Strict, as zod's
    z.number().int() is: "2" or 2.0 is refused."""

    revision: Annotated[StrictInt, Field(ge=1)]


class ConsentRequest(BaseModel):
    """POST /api/proposals/{id}/consent: true consents, false objects (final). Strict, as
    zod's z.boolean() is: "false" or 0 is refused, never read as an objection."""

    consent: StrictBool


class VoteRequest(BaseModel):
    """POST /api/proposals/{id}/vote."""

    choice: VoteChoice


class CommentRequest(BaseModel):
    """POST /api/proposals/{id}/comments."""

    text: _CommentText


class DraftTaskRequest(BaseModel):
    """PUT /api/proposals/{id}/admin/draft-task: a DraftTask without taskId, within the
    limits."""

    title: _Title
    civilianSummary: _Summary
    acceptanceCriteria: list[_Criterion] = Field(
        min_length=1, max_length=PROPOSAL_LIMITS["criteria"]
    )
    size: Size
    tierFloor: TierFloor
    rewardClass: RewardClass


class ProposalSettings(BaseModel):
    """PUT /api/proposals/settings (admins): the Test timers switch. Strict, as zod's
    z.boolean() is."""

    testTimers: StrictBool


class ProposalMe(BaseModel):
    """GET /api/proposals/me."""

    isAdmin: bool
    activeProposalId: int | None = None  # the caller's proposal in an active state
    testTimers: bool


# ---------------------------------------------------------------------------
# Notifications: the in-app bell (/api/notifications*)
# ---------------------------------------------------------------------------


class Notification(BaseModel):
    id: int
    kind: NotificationKind
    message: str
    href: str  # a path on this site, such as /propose/12
    at: str
    read: bool


class NotificationList(BaseModel):
    """GET /api/notifications: the newest 30, and how many of all are unread."""

    notifications: list[Notification]
    unread: int


class NotificationReadRequest(BaseModel):
    """POST /api/notifications/read: marks these, or every one when `ids` is absent. Strict,
    as zod's z.array(z.number().int()).optional() is: "1", true or 1.0 is refused, and so is
    an explicit null, which must never read as "every one"."""

    ids: list[StrictInt] | None = None

    @field_validator("ids", mode="before")
    @classmethod
    def _sent_means_a_list(cls, value: object) -> object:
        # Only an `ids` the caller sent gets here: the default (absent) isn't validated.
        if value is None:
            raise ValueError("ids, when sent, is a list")
        return value


class PendingReward(BaseModel):
    pr: int
    rewardClass: RewardClass
    survivalEndsAt: str


class LedgerEvent(BaseModel):
    kind: str
    refPr: int | None = None
    refIssue: int | None = None
    points: float
    at: str


class ContributorProfile(BaseModel):
    """The friendlier clothes on Foreman's ledger (PRD §4.9, Settle row)."""

    login: str
    tier: Tier
    merged: int
    survivalRate: float
    pendingRewards: list[PendingReward] = Field(default_factory=list)
    ledger: list[LedgerEvent] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str


# ---------------------------------------------------------------------------
# Upland data app (ledger.upland.me) — gated by the `upland_data` flag
# ---------------------------------------------------------------------------


class UplandAction(BaseModel):
    """One decoded `playuplandme` chain action."""

    globalSequence: int
    ts: str  # ISO 8601 timestamp
    blockNum: int
    trxId: str
    contract: str
    actionName: str
    actionMeaning: str | None = None
    category: str | None = None
    actor: str | None = None
    propertyId: str | None = None
    priceUpx: float | None = None
    fromAccount: str | None = None
    toAccount: str | None = None


class UplandActionList(BaseModel):
    items: list[UplandAction]
    total: int
    hasMore: bool


class UplandProperty(BaseModel):
    propertyId: str
    address: str | None = None
    city: str | None = None
    firstSeenBlock: int | None = None
    firstSeenTs: str | None = None
    mintPriceUpx: float | None = None
    lastSalePriceUpx: float | None = None
    lastSaleTs: str | None = None
    totalSales: int = 0
    totalListings: int = 0


class UplandPropertyList(BaseModel):
    items: list[UplandProperty]
    total: int


class SalesVolumeDay(BaseModel):
    date: str  # YYYY-MM-DD
    count: int
    volumeUpx: float
    avgPrice: float
    minPrice: float
    maxPrice: float


class TimeSeriesPoint(BaseModel):
    bucket: str
    count: int
    volume: float


class PriceDistributionBucket(BaseModel):
    range: str
    count: int
    avgPrice: float


class ActionDistributionEntry(BaseModel):
    actionName: str
    actionMeaning: str | None = None
    category: str | None = None
    count: int


class ActiveAccount(BaseModel):
    actor: str
    txCount: int
    volumeUpx: float


class ChainInfo(BaseModel):
    headBlockNum: int
    headBlockTime: str
    chainId: str
    blocksPerDay: int


class UplandDateRange(BaseModel):
    min: str | None = None
    max: str | None = None


class UplandStatsOverview(BaseModel):
    totalActions: int
    dateRange: UplandDateRange
    byCategory: dict[str, int]
    byType: list[ActionDistributionEntry]
    totalProperties: int


class UplandHealth(BaseModel):
    """Scraper DB health and row counts."""

    status: Literal["ok"]
    actions: int
    properties: int
    latestBlock: int | None = None
    gcsConfigured: bool


class UplandEstimate(BaseModel):
    """Estimated action count for a timeframe; `relation` "gte" means the true count is higher."""

    estimatedActions: int
    relation: Literal["eq", "gte"]
    startBlock: int
    endBlock: int
    days: int


class ScrapeRequest(BaseModel):
    """Either `days` or both `startBlock` and `endBlock` (validated by the scraper service)."""

    days: int | None = Field(default=None, ge=1, le=365)
    startBlock: int | None = Field(default=None, ge=1)
    endBlock: int | None = Field(default=None, ge=1)
    chunkBlocks: int = Field(default=100_000, ge=1)


class ScrapeStatus(BaseModel):
    running: bool
    phase: str  # idle | starting | scraping | complete | cancelled | error
    currentBlock: int | None = None
    fetched: int = 0
    totalActions: int = 0
    startBlock: int | None = None
    endBlock: int | None = None
    error: str | None = None
    lastResult: dict[str, int] | None = None


class GcsSyncResult(BaseModel):
    synced: bool
    uploadedFiles: list[str]
    errors: list[str]


class GcsStatus(BaseModel):
    configured: bool
    running: bool
    lastResult: GcsSyncResult | None = None
