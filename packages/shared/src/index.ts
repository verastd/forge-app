/**
 * @forge/shared — zod schemas + inferred types.
 *
 * This is the single source of API truth for FORGE (PRD Appendix A.1,
 * H.1). `apps/web` and `apps/api` are coded against these exact names in
 * parallel: change a schema and both sides together, or not at all.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const HistoryItemSchema = z.object({
  id: z.string(),
  ts: z.string().datetime(),
  type: z.enum(['earn', 'spend', 'transfer']),
  amount: z.number(),
  memo: z.string().optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryListSchema = z.object({
  items: z.array(HistoryItemSchema),
  total: z.number().int(),
});
export type HistoryList = z.infer<typeof HistoryListSchema>;

export const EXPORT_COLUMNS = ['ts', 'type', 'amount'] as const;

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export const FLAG_NAMES = ['csv_export', 'contribute_bridge', 'upland_data'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

export const FlagConfigSchema = z.object({
  csv_export: z.boolean(),
  contribute_bridge: z.boolean(),
  upland_data: z.boolean(),
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

// ---------------------------------------------------------------------------
// Dispatch rails (PRD Appendix I.3)
// ---------------------------------------------------------------------------

export const RAILS = [
  'copilot',
  'jules',
  'cursor',
  'devin',
  'openhands',
  'claude-code',
  'codex',
] as const;
export const RailSchema = z.enum(RAILS);
export type Rail = z.infer<typeof RailSchema>;

export const DispatchRequestSchema = z.object({
  taskId: z.number().int(),
  rail: RailSchema,
});
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const DispatchResultSchema = z.object({
  mode: z.enum(['api', 'handoff']),
  compiledPrompt: z.string(),
  deepLink: z.string().optional(),
  sessionRef: z.string().optional(),
  instructions: z.array(z.string()),
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
// Bridge status translator (PRD Appendix I.2)
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

export const BridgeStatusSchema = z.object({
  taskId: z.number().int(),
  stage: BridgeStageSchema,
  detail: z.string(),
  checksPassed: z.number().int().optional(),
  checksTotal: z.number().int().optional(),
});
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;

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
