/**
 * @forge/shared — zod schemas + inferred types.
 *
 * This is the single source of API truth for FORGE (PRD Appendix A.1,
 * H.1). `apps/web` and `apps/api` are coded against these exact names in
 * parallel: change a schema and both sides together, or not at all.
 *
 * Optional fields are `.optional()`, never `.nullable()`: the API leaves an
 * unset field out of the JSON instead of sending null (the Upland schemas are
 * the documented exception). The rail registry (`./rails`) and the brief
 * (`./brief`) are re-exported at the bottom of this file.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export const FLAG_NAMES = [
  'csv_export',
  'contribute_bridge',
  'upland_data',
  'github_signin',
  'apps_lobby',
  'mcp_connector',
  'agent_start',
  'proposals',
  'house_spec',
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

export const FlagConfigSchema = z.object({
  csv_export: z.boolean(),
  contribute_bridge: z.boolean(),
  upland_data: z.boolean(),
  github_signin: z.boolean(),
  apps_lobby: z.boolean(),
  /** The FORGE connector: /mcp, its OAuth endpoints and the consent page. */
  mcp_connector: z.boolean(),
  /** FORGE starting agents through vendor APIs (start rails), with FORGE_START_RAILS. */
  agent_start: z.boolean(),
  /** Proposals: /propose, /api/proposals* and the bell's proposal notifications. */
  proposals: z.boolean(),
  /**
   * The house model: FORGE's own model drafts the task of every passed proposal
   * (ProposalDetail.house). It also needs `proposals` on, and ANTHROPIC_API_KEY
   * set on the API.
   */
  house_spec: z.boolean(),
});
export type FlagConfig = z.infer<typeof FlagConfigSchema>;

// ---------------------------------------------------------------------------
// Task board enums
// ---------------------------------------------------------------------------

export const SIZES = ['XS', 'S', 'M'] as const;
export type Size = (typeof SIZES)[number];

export const REWARD_CLASSES = ['none', 'R1', 'R2', 'R3', 'R4'] as const;
export type RewardClass = (typeof REWARD_CLASSES)[number];

export const TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type Tier = (typeof TIERS)[number];

/** The lowest tier that may take a task: T3 is never a floor. */
export const TIER_FLOORS = ['T0', 'T1', 'T2'] as const;
export type TierFloor = (typeof TIER_FLOORS)[number];

// ---------------------------------------------------------------------------
// Length limits. Every limit on the wire counts characters as Unicode code
// points, as Python's len() and pydantic's max_length do in apps/api, not as
// UTF-16 units (zod's own .max()): an emoji is one character on both sides.
// ---------------------------------------------------------------------------

/** The characters in `text`, counted the way every limit here counts them. Use it for counters. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

/** A string of `min` to `max` characters (textLength). */
function characters(min: number, max: number) {
  const message = min > 0 ? `Use ${min} to ${max} characters.` : `Use at most ${max} characters.`;
  return z.string().refine((value) => {
    const length = textLength(value);
    return length >= min && length <= max;
  }, message);
}

// ---------------------------------------------------------------------------
// Task card (the Bridge's plain-language task board — PRD Appendix I.2)
// ---------------------------------------------------------------------------

export const TaskCardSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  civilianSummary: z.string(),
  size: z.enum(SIZES),
  rewardClass: z.enum(REWARD_CLASSES),
  tierFloor: z.enum(TIER_FLOORS),
  status: z.enum(['open', 'claimed']),
  url: z.string(),
  labels: z.array(z.string()),
  claimedBy: z.string().optional(),
  leaseEndsAt: z.string().optional(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

/** GET /api/bridge/tasks. */
export const TaskListSchema = z.object({
  tasks: z.array(TaskCardSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;

// ---------------------------------------------------------------------------
// Rails: the agents a contributor can hand a task to (Phase 4 contract §2).
// Display order: the rails FORGE starts for you, then the ones it opens.
// The copy for each lives in ./rails (RAIL_REGISTRY).
// ---------------------------------------------------------------------------

/** FORGE starts these through the vendor's API, on the contributor's account. */
export const START_RAILS = [
  'copilot',
  'jules',
  'cursor',
  'devin',
  'openhands',
  'claude-routine',
] as const;
export type StartRail = (typeof START_RAILS)[number];

/** FORGE opens these as a link (or, for Antigravity, a few steps). */
export const OPEN_RAILS = [
  'claude-code',
  'claude-cli',
  'codex',
  'vscode',
  'cursor-app',
  'antigravity',
] as const;
export type OpenRail = (typeof OPEN_RAILS)[number];

export const RAILS = [...START_RAILS, ...OPEN_RAILS] as const;
export const RailSchema = z.enum(RAILS);
export type Rail = z.infer<typeof RailSchema>;

export const RAIL_MODES = ['start', 'open'] as const;
export const RailModeSchema = z.enum(RAIL_MODES);
export type RailMode = z.infer<typeof RailModeSchema>;

/** github: one-time GitHub authorization (nothing pasted, never stored);
 * api_key: one key; devin: key + organization id; routine: fire URL + token. */
export const CREDENTIAL_KINDS = ['github', 'api_key', 'devin', 'routine'] as const;
export const CredentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/** One rail's static description, as RAIL_REGISTRY holds it. */
export const RailMetaSchema = z.object({
  id: RailSchema,
  mode: RailModeSchema,
  label: z.string(),
  vendor: z.string(),
  /** One plain sentence. */
  blurb: z.string(),
  /** Plain one-time steps, in order. */
  setup: z.array(z.string()),
  /** Start rails only. */
  credential: CredentialKindSchema.optional(),
  /** Where the key comes from: start rails except copilot. */
  keyUrl: z.string().optional(),
  /** One line about cost and plan. */
  plan: z.string().optional(),
});
export type RailMeta = z.infer<typeof RailMetaSchema>;

/** A rail as GET /api/bridge/rails serves it. */
export const RailInfoSchema = RailMetaSchema.extend({
  /** Open rails: always. Start rails: flag agent_start AND the id is in FORGE_START_RAILS. */
  enabled: z.boolean(),
  /** Present only when the caller is identified. */
  savedCredential: z.boolean().optional(),
});
export type RailInfo = z.infer<typeof RailInfoSchema>;

export const RailListSchema = z.object({
  rails: z.array(RailInfoSchema),
  /** FORGE can save keys (FORGE_VAULT_KEY is set). */
  vault: z.boolean(),
});
export type RailList = z.infer<typeof RailListSchema>;

/** GET /api/bridge/tasks/{id}: the card plus what an agent needs; `brief` is
 * personalized with the caller's login. */
export const TaskDetailSchema = z.object({
  task: TaskCardSchema,
  acceptanceCriteria: z.array(z.string()),
  branch: z.string(),
  brief: z.string(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

/** GET /api/bridge/me/fork: whether the caller has a fork of verastd/forge-app. */
export const ForkStatusSchema = z.object({
  exists: z.boolean(),
  url: z.string().optional(),
});
export type ForkStatus = z.infer<typeof ForkStatusSchema>;

// ---------------------------------------------------------------------------
// Dispatch (POST /api/bridge/dispatch)
// ---------------------------------------------------------------------------

/** What a contributor pastes for a start rail. Never logged, never echoed. */
export const CredentialSchema = z.object({
  key: characters(1, 4096),
  /** devin */
  orgId: characters(0, 200).optional(),
  /** claude-routine */
  routineUrl: characters(0, 500).optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;

export const DispatchRequestSchema = z.object({
  taskId: z.number().int(),
  rail: RailSchema,
  credential: CredentialSchema.optional(),
  saveCredential: z.boolean().optional(),
});
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const DispatchResultSchema = z.object({
  mode: RailModeSchema,
  rail: RailSchema,
  brief: z.string(),
  startedAt: z.string(),
  sessionUrl: z.string().optional(),
  sessionRef: z.string().optional(),
  credentialSaved: z.boolean().optional(),
});
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

// ---------------------------------------------------------------------------
// Claim / lease (PRD Stage 3, Appendix E)
// ---------------------------------------------------------------------------

export const ClaimRequestSchema = z.object({
  taskId: z.number().int(),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimResponseSchema = z.object({
  taskId: z.number().int(),
  claimedBy: z.string(),
  leaseEndsAt: z.string(),
  leaseHours: z.number(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

// ---------------------------------------------------------------------------
// Bridge status translator (PRD Appendix I.2), with the task's history
// ---------------------------------------------------------------------------

export const BRIDGE_STAGES = [
  'claimed',
  'agent_working',
  'ready_to_submit',
  'in_checks',
  'in_review',
  'shipping',
  'shipped',
] as const;
export const BridgeStageSchema = z.enum(BRIDGE_STAGES);
export type BridgeStage = z.infer<typeof BridgeStageSchema>;

/** What an agent may report through the connector's report_progress. */
export const PROGRESS_STAGES = ['started', 'working', 'pushed', 'pr_opened', 'blocked', 'done'] as const;
export const ProgressStageSchema = z.enum(PROGRESS_STAGES);
export type ProgressStage = z.infer<typeof ProgressStageSchema>;

export const BRIDGE_EVENT_KINDS = [
  'claimed',
  'dispatched',
  'opened',
  'progress',
  'submitted',
  'released',
  'relayed',
] as const;
export const BridgeEventKindSchema = z.enum(BRIDGE_EVENT_KINDS);
export type BridgeEventKind = z.infer<typeof BridgeEventKindSchema>;

export const BRIDGE_EVENT_SOURCES = ['forge', 'agent'] as const;
export const BridgeEventSourceSchema = z.enum(BRIDGE_EVENT_SOURCES);
export type BridgeEventSource = z.infer<typeof BridgeEventSourceSchema>;

/** One line of a task's history. An agent's `message` is untrusted: render it as text. */
export const BridgeEventSchema = z.object({
  at: z.string(),
  kind: BridgeEventKindSchema,
  source: BridgeEventSourceSchema,
  message: z.string(),
  rail: RailSchema.optional(),
  stage: ProgressStageSchema.optional(),
});
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const BridgeStatusSchema = z.object({
  taskId: z.number().int(),
  stage: BridgeStageSchema,
  detail: z.string(),
  events: z.array(BridgeEventSchema),
  /** The lease holder's GitHub login. */
  holder: z.string().optional(),
  leaseEndsAt: z.string().optional(),
  rail: RailSchema.optional(),
  /** Holder only. */
  sessionUrl: z.string().optional(),
  prUrl: z.string().optional(),
  /** Holder only. */
  compareUrl: z.string().optional(),
  checksPassed: z.number().int().optional(),
  checksTotal: z.number().int().optional(),
  /**
   * Holder only: POST /feedback would really send the notes on (the last start
   * went to a rail that takes follow-ups, with the same saved credential).
   */
  canRelay: z.boolean().optional(),
});
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;

// ---------------------------------------------------------------------------
// Checks, feedback and submit (/api/bridge/checks|feedback|submit)
// ---------------------------------------------------------------------------

export const CHECK_RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export const CheckRunStatusSchema = z.enum(CHECK_RUN_STATUSES);
export type CheckRunStatus = z.infer<typeof CheckRunStatusSchema>;

export const CHECK_STATES = ['no_pr', 'pending', 'passed', 'failed'] as const;
export const CheckStateSchema = z.enum(CHECK_STATES);
export type CheckState = z.infer<typeof CheckStateSchema>;

export const CheckRunSchema = z.object({
  name: z.string(),
  status: CheckRunStatusSchema,
  /** GitHub's conclusion once completed (success, failure, ...). */
  conclusion: z.string().optional(),
  summary: z.string().optional(),
  url: z.string().optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const CheckResultsSchema = z.object({
  taskId: z.number().int(),
  state: CheckStateSchema,
  checks: z.array(CheckRunSchema),
  notes: z.string(),
  prUrl: z.string().optional(),
  headSha: z.string().optional(),
});
export type CheckResults = z.infer<typeof CheckResultsSchema>;

export const FeedbackResponseSchema = z.object({
  relayed: z.boolean(),
  notes: z.string(),
  relayedTo: RailSchema.optional(),
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

export const SubmitRequestSchema = z.object({
  /** https://github.com/verastd/forge-app/pull/<n> */
  prUrl: z.string(),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

// ---------------------------------------------------------------------------
// The caller's saved keys and connected agents (/api/bridge/me/*)
// ---------------------------------------------------------------------------

export const SavedCredentialSchema = z.object({
  rail: RailSchema,
  /** The last 4 characters, e.g. "…a1b2" — never the key. */
  hint: z.string(),
  savedAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type SavedCredential = z.infer<typeof SavedCredentialSchema>;

export const SavedCredentialListSchema = z.object({
  credentials: z.array(SavedCredentialSchema),
  vault: z.boolean(),
});
export type SavedCredentialList = z.infer<typeof SavedCredentialListSchema>;

export const ConnectedAgentSchema = z.object({
  id: z.string(),
  /** Self-declared by the client: untrusted, render as text. */
  clientName: z.string(),
  redirectHost: z.string(),
  connectedAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type ConnectedAgent = z.infer<typeof ConnectedAgentSchema>;

export const ConnectedAgentListSchema = z.object({
  agents: z.array(ConnectedAgentSchema),
});
export type ConnectedAgentList = z.infer<typeof ConnectedAgentListSchema>;

// ---------------------------------------------------------------------------
// OAuth consent — web server ⇄ API only (/api/oauth/authorize/*)
// ---------------------------------------------------------------------------

export const AuthorizeParamsSchema = z.object({
  responseType: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});
export type AuthorizeParams = z.infer<typeof AuthorizeParamsSchema>;

/** 200 from /api/oauth/authorize/check. */
export const AuthorizeCheckSchema = z.object({
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(z.string()),
});
export type AuthorizeCheck = z.infer<typeof AuthorizeCheckSchema>;

/** 400 from /api/oauth/authorize/*. */
export const AuthorizeErrorSchema = z.object({
  error: z.string(),
  errorDescription: z.string().optional(),
  /** Only when it is safe to send the user back to the client. */
  redirectTo: z.string().optional(),
});
export type AuthorizeError = z.infer<typeof AuthorizeErrorSchema>;

export const AuthorizeDecisionSchema = z.object({
  redirectTo: z.string(),
});
export type AuthorizeDecision = z.infer<typeof AuthorizeDecisionSchema>;

// ---------------------------------------------------------------------------
// Proposals: the Propose floor (Phase 5 contract §2), behind the `proposals`
// flag. Robert's Rules: a member moves, another seconds, debate (with a
// unanimous-consent fast path), a vote when anyone objects, then the outcome.
// Logins, titles, pitches, comments and messages are plain text: render them
// as text. Limits apply to what members send, not to what the API answers.
// ---------------------------------------------------------------------------

/**
 * Stored states. `seconded` is momentary: seconding opens debate at once, so a
 * proposal goes `submitted` -> `debate` and its timeline records the second.
 * `lapsed`: nobody seconded in time; `withdrawn`: the mover withdrew before a
 * decision.
 */
export const PROPOSAL_STATES = [
  'submitted',
  'debate',
  'voting',
  'passed',
  'failed',
  'building',
  'shipped',
  'lapsed',
  'withdrawn',
] as const;
export const ProposalStateSchema = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

/**
 * A member whose proposal is in one of these can't move another (409
 * one_active_proposal). The floor shows them as "Needs a second", "In debate"
 * and "Voting"; every other state is decided.
 */
export const ACTIVE_PROPOSAL_STATES: readonly ProposalState[] = ['submitted', 'debate', 'voting'];

/** Every kind of line in a proposal's timeline. */
export const PROPOSAL_EVENT_KINDS = [
  'moved',
  'edited',
  'seconded',
  'consented',
  'objected',
  'commented',
  'debate_ended',
  'vote_opened',
  'voted',
  'vote_closed',
  'passed',
  'failed',
  'lapsed',
  'withdrawn',
  'task_drafted',
  'task_published',
  'shipped',
  'admin_ended_debate',
  'admin_closed_vote',
  'test_timers_on',
  'test_timers_off',
  // The floor closed while members couldn't act (`proposals` or `github_signin`
  // off), then opened again with every running deadline moved later by the time
  // it was closed.
  'floor_paused',
  'floor_resumed',
  // The house model drafted the task of a passed proposal (HouseDraft). Public;
  // its failures are not.
  'house_drafted',
] as const;
export const ProposalEventKindSchema = z.enum(PROPOSAL_EVENT_KINDS);
export type ProposalEventKind = z.infer<typeof ProposalEventKindSchema>;

export const VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;
export const VoteChoiceSchema = z.enum(VOTE_CHOICES);
export type VoteChoice = z.infer<typeof VoteChoiceSchema>;

/** Where a member of the eligible set stands in debate (ProposalYou.consent). Objecting is final. */
export const CONSENT_CHOICES = ['consented', 'objected'] as const;
export const ConsentChoiceSchema = z.enum(CONSENT_CHOICES);
export type ConsentChoice = z.infer<typeof ConsentChoiceSchema>;

/**
 * The most characters (textLength) each text a member writes may have, and the
 * most acceptance criteria a draft task lists. Each needs at least one.
 */
export const PROPOSAL_LIMITS = {
  title: 100,
  pitch: 4000,
  comment: 2000,
  /** A draft task's civilianSummary. */
  summary: 500,
  /** Acceptance criteria per draft task. */
  criteria: 10,
  /** Characters per acceptance criterion. */
  criterion: 300,
} as const;

/**
 * A proposal's eligible set, frozen at its second, is the members seen in the
 * last this many days, plus the mover and the seconder. Quorum is a majority of
 * it. ELIGIBLE_ACTIVITY_DAYS in apps/api models.py.
 */
export const ELIGIBLE_ACTIVITY_DAYS = 30;

/** A proposal as the floor lists it. */
export const ProposalCardSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: ProposalStateSchema,
  /** The mover's GitHub login. */
  mover: z.string(),
  movedAt: z.string(),
  /** The seconder's GitHub login, once seconded. */
  seconder: z.string().optional(),
  /** When the current period (lapse, debate or vote) ends. */
  deadline: z.string().optional(),
  commentCount: z.number().int(),
  objectionCount: z.number().int(),
});
export type ProposalCard = z.infer<typeof ProposalCardSchema>;

/**
 * GET /api/proposals: newest first. Every active proposal (submitted, debate,
 * voting) and the newest 100 decided ones; `?decidedBefore=<id>` pages the
 * older decided ones.
 */
export const ProposalListSchema = z.object({
  proposals: z.array(ProposalCardSchema),
  /** Test timers are on: deadlines are minutes, not days. */
  testTimers: z.boolean(),
  /** True: older decided proposals than these exist. */
  moreDecided: z.boolean().optional(),
  /** True: members can't act now (sign-in is off), so every deadline waits. */
  floorPaused: z.boolean().optional(),
});
export type ProposalList = z.infer<typeof ProposalListSchema>;

/** One comment in the public debate thread. */
export const ProposalCommentSchema = z.object({
  id: z.number().int(),
  /** The commenter's GitHub login. */
  author: z.string(),
  text: z.string(),
  at: z.string(),
});
export type ProposalComment = z.infer<typeof ProposalCommentSchema>;

/** One line of a proposal's public timeline. */
export const ProposalEventSchema = z.object({
  at: z.string(),
  kind: ProposalEventKindSchema,
  /** Who did it (a GitHub login; the admin's, for an admin action). */
  actor: z.string().optional(),
  message: z.string(),
});
export type ProposalEvent = z.infer<typeof ProposalEventSchema>;

/** The vote's count, shown only after the close. */
export const ProposalTallySchema = z.object({
  yes: z.number().int(),
  no: z.number().int(),
  abstain: z.number().int(),
  /** The size of the eligible set. */
  eligible: z.number().int(),
  /** A majority of the eligible set cast a ballot (Abstain counts). */
  quorumMet: z.boolean(),
});
export type ProposalTally = z.infer<typeof ProposalTallySchema>;

/** What the caller may do now, and where they stand. */
export const ProposalYouSchema = z.object({
  canEdit: z.boolean(),
  canWithdraw: z.boolean(),
  canSecond: z.boolean(),
  canConsent: z.boolean(),
  /** Once the caller has consented or objected. */
  consent: ConsentChoiceSchema.optional(),
  canComment: z.boolean(),
  canVote: z.boolean(),
  /** The caller's ballot, changeable until the vote closes. */
  vote: VoteChoiceSchema.optional(),
  isAdmin: z.boolean(),
});
export type ProposalYou = z.infer<typeof ProposalYouSchema>;

/**
 * The task a passed proposal becomes. It starts as the proposal's title, the
 * pitch as the summary and no criteria, so it carries no limits; an admin
 * finishes it (DraftTaskRequest) and publishes it to the Contribute board.
 */
export const DraftTaskSchema = z.object({
  title: z.string(),
  civilianSummary: z.string(),
  acceptanceCriteria: z.array(z.string()),
  size: z.enum(SIZES),
  tierFloor: z.enum(TIER_FLOORS),
  rewardClass: z.enum(REWARD_CLASSES),
  /** The Contribute task, once published. */
  taskId: z.number().int().optional(),
});
export type DraftTask = z.infer<typeof DraftTaskSchema>;

// ---------------------------------------------------------------------------
// The house model (Phase 6 contract §2), behind the `house_spec` flag: FORGE's
// own model drafts the task of every passed proposal, and an admin checks it
// before it goes on the Contribute board. A spec is model output, cleaned:
// render every string in it as text. Unlike the rest of what the API answers,
// it carries limits, because the API holds the model's output to them.
// ---------------------------------------------------------------------------

/** What the house makes of a request. */
export const HOUSE_VERDICTS = ['ready', 'needs_clarification', 'not_feasible'] as const;
export const HouseVerdictSchema = z.enum(HOUSE_VERDICTS);
export type HouseVerdict = z.infer<typeof HouseVerdictSchema>;

/** Where the house stands on one proposal. */
export const HOUSE_STATUSES = ['off', 'queued', 'running', 'done', 'failed'] as const;
export const HouseStatusSchema = z.enum(HOUSE_STATUSES);
export type HouseStatus = z.infer<typeof HouseStatusSchema>;

/** Why the house is `off`: no ANTHROPIC_API_KEY on the API, or its flag is off. */
export const HOUSE_OFF_REASONS = ['not_configured', 'switched_off'] as const;
/** Why the latest job `failed`. */
export const HOUSE_FAILURE_REASONS = [
  'refused',
  'invalid_output',
  'unavailable',
  'too_large',
  'bad_request',
  'daily_limit',
] as const;
/** Every HouseDraft.reason: the off reasons, then the failure reasons. */
export const HOUSE_REASONS = [...HOUSE_OFF_REASONS, ...HOUSE_FAILURE_REASONS] as const;
export const HouseReasonSchema = z.enum(HOUSE_REASONS);
export type HouseReason = z.infer<typeof HouseReasonSchema>;

/**
 * The most characters (textLength) each text in a house spec may have, and the
 * most entries each list may hold. Every text needs at least one character and
 * every spec at least one acceptance criterion; the other lists may be empty.
 * The title, summary and criteria limits are the draft task's (PROPOSAL_LIMITS),
 * so a spec always fits the draft it fills.
 */
export const HOUSE_SPEC_LIMITS = {
  title: PROPOSAL_LIMITS.title,
  /** civilianSummary. */
  summary: PROPOSAL_LIMITS.summary,
  /** Acceptance criteria per spec. */
  criteria: PROPOSAL_LIMITS.criteria,
  /** Characters per acceptance criterion. */
  criterion: PROPOSAL_LIMITS.criterion,
  /** Entries in scopeIn, and in scopeOut. */
  scope: 20,
  /** Characters per scope entry: a repo path or glob. */
  path: 200,
  /** Entries in risks. */
  risks: 10,
  /** Characters per risk. */
  risk: 300,
  /** Entries in questions. */
  questions: 10,
  /** Characters per question. */
  question: 300,
  verdictReason: 500,
} as const;

/**
 * What the house model writes for one passed proposal, once cleaned. Its title,
 * summary, criteria and size fill the draft task unless an admin has saved the
 * draft already; tierFloor is only a suggestion (the draft's floor stays T0).
 * The title must also show a visible character: the API's cleaner checks that,
 * as it does for Proposals, while the schemas count characters only.
 */
export const HouseSpecSchema = z.object({
  title: characters(1, HOUSE_SPEC_LIMITS.title),
  /** Plain English, for members. */
  civilianSummary: characters(1, HOUSE_SPEC_LIMITS.summary),
  /** Each one checkable by a test, a CI check or a behaviour a reviewer can see. */
  acceptanceCriteria: z
    .array(characters(1, HOUSE_SPEC_LIMITS.criterion))
    .min(1)
    .max(HOUSE_SPEC_LIMITS.criteria),
  size: z.enum(SIZES),
  /** A suggestion. */
  tierFloor: z.enum(TIER_FLOORS),
  /** Repo paths or globs the task expects to change. */
  scopeIn: z.array(characters(1, HOUSE_SPEC_LIMITS.path)).max(HOUSE_SPEC_LIMITS.scope),
  /** Repo paths or globs it must not touch. */
  scopeOut: z.array(characters(1, HOUSE_SPEC_LIMITS.path)).max(HOUSE_SPEC_LIMITS.scope),
  risks: z.array(characters(1, HOUSE_SPEC_LIMITS.risk)).max(HOUSE_SPEC_LIMITS.risks),
  /** What the mover should answer. */
  questions: z.array(characters(1, HOUSE_SPEC_LIMITS.question)).max(HOUSE_SPEC_LIMITS.questions),
  verdict: HouseVerdictSchema,
  verdictReason: characters(1, HOUSE_SPEC_LIMITS.verdictReason),
});
export type HouseSpec = z.infer<typeof HouseSpecSchema>;

/** The house's work on one proposal, as an admin sees it (ProposalDetail.house). */
export const HouseDraftSchema = z.object({
  status: HouseStatusSchema,
  /** Why it is `off` (HOUSE_OFF_REASONS), or why the latest job `failed` (HOUSE_FAILURE_REASONS). */
  reason: HouseReasonSchema.optional(),
  /** The latest spec that succeeded, kept while a new draft is queued or running. */
  spec: HouseSpecSchema.optional(),
  /** The model that wrote `spec`. */
  model: z.string().optional(),
  /** When `spec` was written (ISO 8601). */
  draftedAt: z.string().optional(),
  /** Whether `spec` filled the draft task: not when an admin had saved the draft first. */
  appliedToDraft: z.boolean().optional(),
});
export type HouseDraft = z.infer<typeof HouseDraftSchema>;

/** GET /api/proposals/{id}. */
export const ProposalDetailSchema = z.object({
  proposal: ProposalCardSchema,
  pitch: z.string(),
  /** The size of the eligible set, frozen at the second. */
  eligibleCount: z.number().int().optional(),
  /** Members of the eligible set who have consented, the mover included. */
  consentCount: z.number().int().optional(),
  /** During voting: ballots cast so far (the totals stay hidden until the close). */
  turnout: z.number().int().optional(),
  /** After the close. */
  tally: ProposalTallySchema.optional(),
  comments: z.array(ProposalCommentSchema),
  events: z.array(ProposalEventSchema),
  /** Identified callers only. */
  you: ProposalYouSchema.optional(),
  /** Admins only. */
  draft: DraftTaskSchema.optional(),
  /** Admins only, like `draft`: from the moment it passes, so also once building or shipped. */
  house: HouseDraftSchema.optional(),
  /** The Contribute task, once published. */
  taskId: z.number().int().optional(),
  /**
   * The text's revision: 1, plus 1 for every edit. A second sends the one it
   * read (SecondRequest).
   */
  revision: z.number().int().min(1),
  /** True: older comments than `comments` exist (GET .../comments?before=). */
  moreComments: z.boolean().optional(),
  /** True: members can't act now (sign-in is off), so every deadline waits. */
  floorPaused: z.boolean().optional(),
});
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;

/**
 * GET /api/proposals/{id}/comments?before=<commentId>: up to 100 comments
 * older than that one (the newest 100 without it), oldest first.
 */
export const ProposalCommentPageSchema = z.object({
  comments: z.array(ProposalCommentSchema),
  /** True: even older comments exist. */
  moreComments: z.boolean(),
});
export type ProposalCommentPage = z.infer<typeof ProposalCommentPageSchema>;

/** POST /api/proposals, and PATCH /api/proposals/{id} (the mover, until seconded). */
export const NewProposalSchema = z.object({
  title: characters(1, PROPOSAL_LIMITS.title),
  /** Plain English, plain text. */
  pitch: characters(1, PROPOSAL_LIMITS.pitch),
});
export type NewProposal = z.infer<typeof NewProposalSchema>;

/**
 * POST /api/proposals/{id}/second: the revision of the text the seconder read
 * (ProposalDetail.revision). Another one is 409 proposal_changed.
 */
export const SecondRequestSchema = z.object({
  revision: z.number().int().min(1),
});
export type SecondRequest = z.infer<typeof SecondRequestSchema>;

/** POST /api/proposals/{id}/consent: true consents, false objects (final). */
export const ConsentRequestSchema = z.object({
  consent: z.boolean(),
});
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;

/** POST /api/proposals/{id}/vote. */
export const VoteRequestSchema = z.object({
  choice: VoteChoiceSchema,
});
export type VoteRequest = z.infer<typeof VoteRequestSchema>;

/** POST /api/proposals/{id}/comments. */
export const CommentRequestSchema = z.object({
  text: characters(1, PROPOSAL_LIMITS.comment),
});
export type CommentRequest = z.infer<typeof CommentRequestSchema>;

/** PUT /api/proposals/{id}/admin/draft-task: a DraftTask without taskId, within the limits. */
export const DraftTaskRequestSchema = z.object({
  title: characters(1, PROPOSAL_LIMITS.title),
  civilianSummary: characters(1, PROPOSAL_LIMITS.summary),
  acceptanceCriteria: z
    .array(characters(1, PROPOSAL_LIMITS.criterion))
    .min(1)
    .max(PROPOSAL_LIMITS.criteria),
  size: z.enum(SIZES),
  tierFloor: z.enum(TIER_FLOORS),
  rewardClass: z.enum(REWARD_CLASSES),
});
export type DraftTaskRequest = z.infer<typeof DraftTaskRequestSchema>;

/** PUT /api/proposals/settings (admins): the Test timers switch. */
export const ProposalSettingsSchema = z.object({
  testTimers: z.boolean(),
});
export type ProposalSettings = z.infer<typeof ProposalSettingsSchema>;

/** GET /api/proposals/me. */
export const ProposalMeSchema = z.object({
  isAdmin: z.boolean(),
  /** The caller's proposal in an active state, if any. */
  activeProposalId: z.number().int().optional(),
  testTimers: z.boolean(),
});
export type ProposalMe = z.infer<typeof ProposalMeSchema>;

// ---------------------------------------------------------------------------
// Notifications: the in-app bell (/api/notifications*)
// ---------------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  'proposal_moved',
  'proposal_seconded',
  'your_proposal_seconded',
  'proposal_passed',
  'proposal_failed',
  'proposal_lapsed',
  'vote_opened',
  'task_published',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  id: z.number().int(),
  kind: NotificationKindSchema,
  message: z.string(),
  /** Where the item leads: a path on this site, such as /propose/12. */
  href: z.string(),
  at: z.string(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** GET /api/notifications: the newest 30, and how many of all are unread. */
export const NotificationListSchema = z.object({
  notifications: z.array(NotificationSchema),
  unread: z.number().int(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

/** POST /api/notifications/read: marks these, or every one when `ids` is absent. */
export const NotificationReadRequestSchema = z.object({
  ids: z.array(z.number().int()).optional(),
});
export type NotificationReadRequest = z.infer<typeof NotificationReadRequestSchema>;

// ---------------------------------------------------------------------------
// Upland data app (ledger.upland.me) — gated by the `upland_data` flag
//
// Two deliberate departures from the rest of this file, both because the wire
// really looks that way (mirror of apps/api/src/forge_api/models.py):
// - Absent values are explicit JSON nulls (`.nullable()`), not missing keys:
//   the Pydantic models declare `field: X | None = None` and FastAPI
//   serializes the None.
// - Timestamps are plain strings, not `.datetime()`: they pass through from
//   Hyperion/SQLite without a timezone suffix ("2026-09-18T12:34:56.000").
// ---------------------------------------------------------------------------

export const UPLAND_INTERVALS = ['hour', 'day', 'week'] as const;
export type UplandInterval = (typeof UPLAND_INTERVALS)[number];

export const UPLAND_PROPERTY_SORTS = ['sales', 'price'] as const;
export type UplandPropertySort = (typeof UPLAND_PROPERTY_SORTS)[number];

export const UPLAND_EXPORT_TYPES = ['actions', 'sales'] as const;
export type UplandExportType = (typeof UPLAND_EXPORT_TYPES)[number];

export const UplandActionSchema = z.object({
  globalSequence: z.number().int(),
  ts: z.string(),
  blockNum: z.number().int(),
  trxId: z.string(),
  contract: z.string(),
  actionName: z.string(),
  actionMeaning: z.string().nullable(),
  category: z.string().nullable(),
  actor: z.string().nullable(),
  propertyId: z.string().nullable(),
  priceUpx: z.number().nullable(),
  fromAccount: z.string().nullable(),
  toAccount: z.string().nullable(),
});
export type UplandAction = z.infer<typeof UplandActionSchema>;

export const UplandActionListSchema = z.object({
  items: z.array(UplandActionSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
});
export type UplandActionList = z.infer<typeof UplandActionListSchema>;

export const UplandPropertySchema = z.object({
  propertyId: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  firstSeenBlock: z.number().int().nullable(),
  firstSeenTs: z.string().nullable(),
  mintPriceUpx: z.number().nullable(),
  lastSalePriceUpx: z.number().nullable(),
  lastSaleTs: z.string().nullable(),
  totalSales: z.number().int(),
  totalListings: z.number().int(),
});
export type UplandProperty = z.infer<typeof UplandPropertySchema>;

export const UplandPropertyListSchema = z.object({
  items: z.array(UplandPropertySchema),
  total: z.number().int(),
});
export type UplandPropertyList = z.infer<typeof UplandPropertyListSchema>;

export const SalesVolumeDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  count: z.number().int(),
  volumeUpx: z.number(),
  avgPrice: z.number(),
  minPrice: z.number(),
  maxPrice: z.number(),
});
export type SalesVolumeDay = z.infer<typeof SalesVolumeDaySchema>;

export const TimeSeriesPointSchema = z.object({
  bucket: z.string(),
  count: z.number().int(),
  volume: z.number(),
});
export type TimeSeriesPoint = z.infer<typeof TimeSeriesPointSchema>;

export const PriceDistributionBucketSchema = z.object({
  range: z.string(),
  count: z.number().int(),
  avgPrice: z.number(),
});
export type PriceDistributionBucket = z.infer<typeof PriceDistributionBucketSchema>;

export const ActionDistributionEntrySchema = z.object({
  actionName: z.string(),
  actionMeaning: z.string().nullable(),
  category: z.string().nullable(),
  count: z.number().int(),
});
export type ActionDistributionEntry = z.infer<typeof ActionDistributionEntrySchema>;

export const ActiveAccountSchema = z.object({
  actor: z.string(),
  txCount: z.number().int(),
  volumeUpx: z.number(),
});
export type ActiveAccount = z.infer<typeof ActiveAccountSchema>;

export const ChainInfoSchema = z.object({
  headBlockNum: z.number().int(),
  headBlockTime: z.string(),
  chainId: z.string(),
  blocksPerDay: z.number().int(),
});
export type ChainInfo = z.infer<typeof ChainInfoSchema>;

export const UplandDateRangeSchema = z.object({
  min: z.string().nullable(),
  max: z.string().nullable(),
});
export type UplandDateRange = z.infer<typeof UplandDateRangeSchema>;

export const UplandStatsOverviewSchema = z.object({
  totalActions: z.number().int(),
  dateRange: UplandDateRangeSchema,
  byCategory: z.record(z.string(), z.number().int()),
  byType: z.array(ActionDistributionEntrySchema),
  totalProperties: z.number().int(),
});
export type UplandStatsOverview = z.infer<typeof UplandStatsOverviewSchema>;

export const UplandHealthSchema = z.object({
  status: z.literal('ok'),
  actions: z.number().int(),
  properties: z.number().int(),
  latestBlock: z.number().int().nullable(),
  gcsConfigured: z.boolean(),
});
export type UplandHealth = z.infer<typeof UplandHealthSchema>;

export const UplandEstimateSchema = z.object({
  estimatedActions: z.number().int(),
  /** "gte" means Hyperion capped the count, so the true total is higher. */
  relation: z.enum(['eq', 'gte']),
  startBlock: z.number().int(),
  endBlock: z.number().int(),
  days: z.number().int(),
});
export type UplandEstimate = z.infer<typeof UplandEstimateSchema>;

export const ScrapeRequestSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
  startBlock: z.number().int().min(1).optional(),
  endBlock: z.number().int().min(1).optional(),
  chunkBlocks: z.number().int().min(1).optional(),
});
export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

export const ScrapeStatusSchema = z.object({
  running: z.boolean(),
  phase: z.string(), // idle | starting | scraping | complete | cancelled | error
  currentBlock: z.number().int().nullable(),
  fetched: z.number().int(),
  totalActions: z.number().int(),
  startBlock: z.number().int().nullable(),
  endBlock: z.number().int().nullable(),
  error: z.string().nullable(),
  lastResult: z.record(z.string(), z.number()).nullable(),
});
export type ScrapeStatus = z.infer<typeof ScrapeStatusSchema>;

export const GcsSyncResultSchema = z.object({
  synced: z.boolean(),
  uploadedFiles: z.array(z.string()),
  errors: z.array(z.string()),
});
export type GcsSyncResult = z.infer<typeof GcsSyncResultSchema>;

export const GcsStatusSchema = z.object({
  configured: z.boolean(),
  running: z.boolean(),
  lastResult: GcsSyncResultSchema.nullable(),
});
export type GcsStatus = z.infer<typeof GcsStatusSchema>;

/** `/api/upland/codes` — the obfuscated-action decoder ring, keyed by chain name. */
export const ActionCodesSchema = z.record(
  z.string(),
  z.object({ meaning: z.string(), confidence: z.number(), category: z.string() }),
);
export type ActionCodes = z.infer<typeof ActionCodesSchema>;

// ---------------------------------------------------------------------------
// Contributor profile (PRD Stage 8, Appendix E.4/F)
// ---------------------------------------------------------------------------

export const ContributorProfileSchema = z.object({
  login: z.string(),
  tier: z.enum(TIERS),
  merged: z.number().int(),
  survivalRate: z.number(),
  pendingRewards: z.array(
    z.object({
      pr: z.number().int(),
      rewardClass: z.enum(REWARD_CLASSES),
      survivalEndsAt: z.string(),
    }),
  ),
  ledger: z.array(
    z.object({
      kind: z.string(),
      refPr: z.number().int().optional(),
      refIssue: z.number().int().optional(),
      points: z.number(),
      at: z.string(),
    }),
  ),
});
export type ContributorProfile = z.infer<typeof ContributorProfileSchema>;

// ---------------------------------------------------------------------------
// The rail registry and the brief, mirrored in apps/api (services/rails.py,
// services/brief.py) and held to tests/fixtures/{rails,brief}-golden.json.
// ---------------------------------------------------------------------------

export * from './rails.js';
export * from './brief.js';
