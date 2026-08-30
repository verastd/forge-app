"""API contract models.

Mirrors packages/shared/src/index.ts — change both sides together or not at all (AGENTS.md)

Field names are camelCase on purpose: these models ARE the JSON wire contract the
Next.js app (via @forge/shared zod schemas) is coded against. Renaming a field here
without renaming it there is a cross-boundary drift bug the Gauntlet should catch
(PRD Appendix H.1).
"""

from typing import Literal

from pydantic import BaseModel, Field

# Columns of the CSV export, in order. The header row is exactly ",".join(EXPORT_COLUMNS)
# (Task Spec issue #1, acceptance criterion 1).
EXPORT_COLUMNS: list[str] = ["ts", "type", "amount"]

HistoryType = Literal["earn", "spend", "transfer"]
Size = Literal["XS", "S", "M"]
RewardClass = Literal["none", "R1", "R2", "R3", "R4"]
TierFloor = Literal["T0", "T1", "T2"]
Tier = Literal["T0", "T1", "T2", "T3"]
TaskStatus = Literal["open", "claimed"]
DispatchMode = Literal["api", "handoff"]
Rail = Literal["copilot", "jules", "cursor", "devin", "openhands", "claude-code", "codex"]
BridgeStage = Literal[
    "claimed",
    "agent_working",
    "ready_to_submit",
    "in_checks",
    "in_review",
    "shipping",
    "shipped",
]


class HistoryItem(BaseModel):
    """One row of the token activity feed."""

    id: str
    ts: str  # ISO 8601 timestamp
    type: HistoryType
    amount: float
    memo: str | None = None


class HistoryList(BaseModel):
    items: list[HistoryItem]
    total: int


class FlagConfig(BaseModel):
    """Feature flags (PRD Appendix H.2 — the deploy-safety linchpin)."""

    csv_export: bool
    contribute_bridge: bool


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


class DispatchRequest(BaseModel):
    taskId: int
    rail: Rail


class DispatchResult(BaseModel):
    """Result of handing a task to the contributor's own agent (PRD I.3 adapter matrix)."""

    mode: DispatchMode
    compiledPrompt: str
    deepLink: str | None = None
    sessionRef: str | None = None
    instructions: list[str]


class ClaimRequest(BaseModel):
    taskId: int


class ClaimResponse(BaseModel):
    taskId: int
    claimedBy: str
    leaseEndsAt: str
    leaseHours: int


class BridgeStatus(BaseModel):
    """Translated pipeline status — plain English, no CI jargon (PRD I.2, Watch row)."""

    taskId: int
    stage: BridgeStage
    detail: str
    checksPassed: int | None = None
    checksTotal: int | None = None


class FeedbackResponse(BaseModel):
    relayed: bool
    prompt: str


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
