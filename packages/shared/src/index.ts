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
