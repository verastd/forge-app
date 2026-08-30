import { describe, expect, it } from 'vitest';
import {
  BridgeStatusSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  ContributorProfileSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  EXPORT_COLUMNS,
  FLAG_NAMES,
  FlagConfigSchema,
  HistoryItemSchema,
  HistoryListSchema,
  RAILS,
  RailSchema,
  REWARD_CLASSES,
  SIZES,
  TaskCardSchema,
  TIERS,
} from './index.js';

describe('HistoryItemSchema', () => {
  it('accepts a valid history item', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_1',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'earn',
      amount: 12.5,
      memo: 'first contribution',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid item without the optional memo', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_2',
      ts: '2026-01-01T00:00:00Z',
      type: 'spend',
      amount: -3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a type outside the earn/spend/transfer enum', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_3',
      ts: '2026-01-01T00:00:00Z',
      type: 'bonus',
      amount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO datetime string', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_4',
      ts: 'not-a-date',
      type: 'earn',
      amount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a date-only string (no time component)', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_5',
      ts: '2026-01-01',
      type: 'earn',
      amount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a datetime with a non-Z timezone offset', () => {
    const result = HistoryItemSchema.safeParse({
      id: 'h_6',
      ts: '2026-01-01T00:00:00+05:00',
      type: 'earn',
      amount: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('HistoryListSchema', () => {
  it('accepts a valid list with an integer total', () => {
    const result = HistoryListSchema.safeParse({
      items: [{ id: 'h_1', ts: '2026-01-01T00:00:00Z', type: 'earn', amount: 1 }],
      total: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer total', () => {
    const result = HistoryListSchema.safeParse({ items: [], total: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('EXPORT_COLUMNS', () => {
  it('is the frozen ts/type/amount tuple', () => {
    expect(EXPORT_COLUMNS).toEqual(['ts', 'type', 'amount']);
  });
});

describe('FlagConfigSchema', () => {
  it('accepts a fully specified boolean config', () => {
    const result = FlagConfigSchema.safeParse({ csv_export: true, contribute_bridge: false });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing a required key', () => {
    const result = FlagConfigSchema.safeParse({ csv_export: true });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean values', () => {
    const result = FlagConfigSchema.safeParse({ csv_export: 'true', contribute_bridge: false });
    expect(result.success).toBe(false);
  });

  it('exposes the flag names as a const tuple', () => {
    expect(FLAG_NAMES).toEqual(['csv_export', 'contribute_bridge']);
  });
});

describe('TaskCardSchema', () => {
  it('accepts a full valid open task card', () => {
    const result = TaskCardSchema.safeParse({
      id: 42,
      title: 'Make the history page load faster on mobile',
      civilianSummary: 'Speed up a slow page on phones.',
      size: 'S',
      rewardClass: 'R1',
      rewardUsd: 25,
      tierFloor: 'T0',
      status: 'open',
      url: 'https://github.com/verastd/forge-app/issues/42',
      labels: ['agent-ready', 'status:open'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a claimed card with the optional claim fields', () => {
    const result = TaskCardSchema.safeParse({
      id: 43,
      title: 'Fix flaky export test',
      civilianSummary: 'Make a test stop failing randomly.',
      size: 'XS',
      rewardClass: 'none',
      tierFloor: 'T1',
      status: 'claimed',
      url: 'https://github.com/verastd/forge-app/issues/43',
      labels: [],
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a size outside XS/S/M', () => {
    const result = TaskCardSchema.safeParse({
      id: 44,
      title: 'x',
      civilianSummary: 'x',
      size: 'L',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tierFloor of T3 (only T0/T1/T2 are valid floors)', () => {
    const result = TaskCardSchema.safeParse({
      id: 45,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T3',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const result = TaskCardSchema.safeParse({
      id: 46,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'merged',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer id', () => {
    const result = TaskCardSchema.safeParse({
      id: 46.5,
      title: 'x',
      civilianSummary: 'x',
      size: 'M',
      rewardClass: 'R1',
      tierFloor: 'T0',
      status: 'open',
      url: 'https://example.com',
      labels: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('SIZES / REWARD_CLASSES / TIERS', () => {
  it('are the frozen const tuples', () => {
    expect(SIZES).toEqual(['XS', 'S', 'M']);
    expect(REWARD_CLASSES).toEqual(['none', 'R1', 'R2', 'R3', 'R4']);
    expect(TIERS).toEqual(['T0', 'T1', 'T2', 'T3']);
  });
});

describe('RailSchema / RAILS', () => {
  it('accepts every declared rail', () => {
    for (const rail of RAILS) {
      expect(RailSchema.safeParse(rail).success).toBe(true);
    }
  });

  it('rejects an unknown rail', () => {
    expect(RailSchema.safeParse('chatgpt-desktop').success).toBe(false);
  });
});

describe('DispatchRequestSchema', () => {
  it('accepts a valid dispatch request', () => {
    const result = DispatchRequestSchema.safeParse({ taskId: 42, rail: 'jules' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid rail', () => {
    const result = DispatchRequestSchema.safeParse({ taskId: 42, rail: 'not-a-rail' });
    expect(result.success).toBe(false);
  });
});

describe('DispatchResultSchema', () => {
  it('accepts a handoff-mode result with only the required fields', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'handoff',
      compiledPrompt: 'Task Spec + AGENTS.md pointer...',
      instructions: ['Open claude.ai/code', 'Paste the compiled prompt'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an api-mode result with deepLink and sessionRef set', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'api',
      compiledPrompt: 'Task Spec...',
      deepLink: 'https://jules.google.com/session/abc',
      sessionRef: 'sess_abc123',
      instructions: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a mode outside api/handoff', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'manual',
      compiledPrompt: 'x',
      instructions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing instructions array', () => {
    const result = DispatchResultSchema.safeParse({
      mode: 'handoff',
      compiledPrompt: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('ClaimRequestSchema / ClaimResponseSchema', () => {
  it('accepts a valid claim request', () => {
    expect(ClaimRequestSchema.safeParse({ taskId: 42 }).success).toBe(true);
  });

  it('rejects a claim request with a string taskId', () => {
    expect(ClaimRequestSchema.safeParse({ taskId: '42' }).success).toBe(false);
  });

  it('accepts a valid claim response', () => {
    const result = ClaimResponseSchema.safeParse({
      taskId: 42,
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
      leaseHours: 48,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a claim response missing leaseHours', () => {
    const result = ClaimResponseSchema.safeParse({
      taskId: 42,
      claimedBy: 'maya',
      leaseEndsAt: '2026-08-12T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('BridgeStatusSchema', () => {
  it('accepts every declared bridge stage', () => {
    const stages = [
      'claimed',
      'agent_working',
      'ready_to_submit',
      'in_checks',
      'in_review',
      'shipping',
      'shipped',
    ] as const;
    for (const stage of stages) {
      const result = BridgeStatusSchema.safeParse({ taskId: 1, stage, detail: 'x' });
      expect(result.success).toBe(true);
    }
  });

  it('accepts checksPassed/checksTotal when present', () => {
    const result = BridgeStatusSchema.safeParse({
      taskId: 1,
      stage: 'in_checks',
      detail: '2 of 5 checks need another pass',
      checksPassed: 2,
      checksTotal: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown stage', () => {
    const result = BridgeStatusSchema.safeParse({ taskId: 1, stage: 'done', detail: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('ContributorProfileSchema', () => {
  it('accepts a full valid profile with nested arrays', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T1',
      merged: 7,
      survivalRate: 0.92,
      pendingRewards: [
        { pr: 101, rewardClass: 'R2', usdEquivalent: 50, survivalEndsAt: '2026-08-24T00:00:00Z' },
      ],
      ledger: [{ kind: 'merge', refPr: 101, points: 10, at: '2026-08-10T00:00:00Z' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty pendingRewards/ledger arrays', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T0',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [],
      ledger: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tier outside T0-T3', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T4',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [],
      ledger: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed pendingRewards entry', () => {
    const result = ContributorProfileSchema.safeParse({
      login: 'maya',
      tier: 'T0',
      merged: 0,
      survivalRate: 0,
      pendingRewards: [{ pr: 101, rewardClass: 'R9', usdEquivalent: 50, survivalEndsAt: 'x' }],
      ledger: [],
    });
    expect(result.success).toBe(false);
  });
});
