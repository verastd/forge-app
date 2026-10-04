"""API contract models.

Mirrors packages/shared/src/index.ts — change both sides together or not at all (AGENTS.md)

Field names are camelCase on purpose: these models ARE the JSON wire contract the
Next.js app (via @forge/shared zod schemas) is coded against. Renaming a field here
without renaming it there is a cross-boundary drift bug the Gauntlet should catch
(PRD Appendix H.1).

Optional fields are `X | None = None` and Bridge routes serialize with
`response_model_exclude_none`: zod's `.optional()` accepts a missing key but rejects an
explicit null, so None must never reach the wire (Upland is the documented exception).
The rail registry and the brief have their own mirrors: services/rails.py ⇄
packages/shared/src/rails.ts and services/brief.py ⇄ packages/shared/src/brief.ts.
"""

from typing import Literal, get_args

from pydantic import BaseModel, Field, SecretStr

Size = Literal["XS", "S", "M"]
RewardClass = Literal["none", "R1", "R2", "R3", "R4"]
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

#: The runtime tuples behind the literals above — START_RAILS, OPEN_RAILS, RAILS and
#: PROGRESS_STAGES in packages/shared, in the same order.
START_RAILS: tuple[StartRail, ...] = get_args(StartRail)
OPEN_RAILS: tuple[OpenRail, ...] = get_args(OpenRail)
RAILS: tuple[Rail, ...] = get_args(Rail)
PROGRESS_STAGES: tuple[ProgressStage, ...] = get_args(ProgressStage)


class FlagConfig(BaseModel):
    """Feature flags (PRD Appendix H.2 — the deploy-safety linchpin)."""

    csv_export: bool
    contribute_bridge: bool
    upland_data: bool
    github_signin: bool
    apps_lobby: bool
    mcp_connector: bool
    agent_start: bool


class TaskCard(BaseModel):
    """A Bridge task card: an Issue rendered in plain language (PRD I.2, Browse row)."""

    id: int
    title: str
    civilianSummary: str
    size: Size
    rewardClass: RewardClass
    rewardUsd: float | None = None
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


class PendingReward(BaseModel):
    pr: int
    rewardClass: RewardClass
    usdEquivalent: float
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
