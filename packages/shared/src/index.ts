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

// ---------------------------------------------------------------------------
// Task card (the Bridge's plain-language task board — PRD Appendix I.2)
// ---------------------------------------------------------------------------

export const TaskCardSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  civilianSummary: z.string(),
  size: z.enum(SIZES),
  rewardClass: z.enum(REWARD_CLASSES),
  rewardUsd: z.number().optional(),
  tierFloor: z.enum(['T0', 'T1', 'T2']),
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
  key: z.string().min(1).max(4096),
  /** devin */
  orgId: z.string().max(200).optional(),
  /** claude-routine */
  routineUrl: z.string().max(500).optional(),
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
      usdEquivalent: z.number(),
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
