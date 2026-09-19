import { describe, expect, it } from 'vitest';
import {
  ActionCodesSchema,
  ActionDistributionEntrySchema,
  ActiveAccountSchema,
  BridgeStatusSchema,
  ChainInfoSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  ContributorProfileSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  EXPORT_COLUMNS,
  FLAG_NAMES,
  FlagConfigSchema,
  GcsStatusSchema,
  GcsSyncResultSchema,
  HistoryItemSchema,
  HistoryListSchema,
  PriceDistributionBucketSchema,
  RAILS,
  RailSchema,
  REWARD_CLASSES,
  SIZES,
  SalesVolumeDaySchema,
  ScrapeRequestSchema,
  ScrapeStatusSchema,
  TIERS,
  TaskCardSchema,
  TimeSeriesPointSchema,
  UPLAND_EXPORT_TYPES,
  UPLAND_INTERVALS,
  UPLAND_PROPERTY_SORTS,
  UplandActionListSchema,
  UplandActionSchema,
  UplandEstimateSchema,
  UplandHealthSchema,
  UplandPropertyListSchema,
  UplandPropertySchema,
  UplandStatsOverviewSchema,
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
    const result = FlagConfigSchema.safeParse({
      csv_export: true,
      contribute_bridge: false,
      upland_data: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config missing a required key', () => {
    const result = FlagConfigSchema.safeParse({ csv_export: true, contribute_bridge: false });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean values', () => {
    const result = FlagConfigSchema.safeParse({
      csv_export: 'true',
      contribute_bridge: false,
      upland_data: false,
    });
    expect(result.success).toBe(false);
  });

  it('exposes the flag names as a const tuple', () => {
    expect(FLAG_NAMES).toEqual(['csv_export', 'contribute_bridge', 'upland_data']);
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

/* --- Upland data app -------------------------------------------------------- */

/** A fully decoded secondary-market sale, exactly as the API serializes it. */
const SALE_ACTION = {
  globalSequence: 123456789,
  ts: '2026-09-18T12:34:56.000',
  blockNum: 400000123,
  trxId: 'abc123',
  contract: 'playuplandme',
  actionName: 'n5',
  actionMeaning: 'buy_property_secondary',
  category: 'market',
  actor: 'alice',
  propertyId: '1234567890123',
  priceUpx: 15000,
  fromAccount: 'seller',
  toAccount: 'buyer',
};

describe('UplandActionSchema', () => {
  it('accepts a fully decoded sale action', () => {
    expect(UplandActionSchema.safeParse(SALE_ACTION).success).toBe(true);
  });

  it('accepts explicit nulls for undecoded fields (the Upland wire uses null, not absence)', () => {
    const result = UplandActionSchema.safeParse({
      ...SALE_ACTION,
      actionMeaning: null,
      category: null,
      actor: null,
      propertyId: null,
      priceUpx: null,
      fromAccount: null,
      toAccount: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing nullable key — the field must still be present', () => {
    const withoutPrice: Record<string, unknown> = { ...SALE_ACTION };
    delete withoutPrice.priceUpx;
    expect(UplandActionSchema.safeParse(withoutPrice).success).toBe(false);
  });

  it('accepts Hyperion timestamps without a timezone suffix', () => {
    const result = UplandActionSchema.safeParse({ ...SALE_ACTION, ts: '2026-09-18T12:34:56.000' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer globalSequence', () => {
    expect(UplandActionSchema.safeParse({ ...SALE_ACTION, globalSequence: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('UplandActionListSchema', () => {
  it('accepts a page with hasMore', () => {
    const result = UplandActionListSchema.safeParse({
      items: [SALE_ACTION],
      total: 1400000,
      hasMore: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a list missing hasMore', () => {
    expect(UplandActionListSchema.safeParse({ items: [], total: 0 }).success).toBe(false);
  });
});

const PROPERTY = {
  propertyId: '1234567890123',
  address: '111 VENICE BLVD',
  city: 'Los Angeles',
  firstSeenBlock: 399000000,
  firstSeenTs: '2026-08-01T00:00:00.000',
  mintPriceUpx: 8000,
  lastSalePriceUpx: 15000,
  lastSaleTs: '2026-09-18T12:34:56.000',
  totalSales: 3,
  totalListings: 5,
};

describe('UplandPropertySchema', () => {
  it('accepts a fully known property', () => {
    expect(UplandPropertySchema.safeParse(PROPERTY).success).toBe(true);
  });

  it('accepts a property first seen through a bare listing (everything null but counts)', () => {
    const result = UplandPropertySchema.safeParse({
      propertyId: '999',
      address: null,
      city: null,
      firstSeenBlock: null,
      firstSeenTs: null,
      mintPriceUpx: null,
      lastSalePriceUpx: null,
      lastSaleTs: null,
      totalSales: 0,
      totalListings: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer totalSales', () => {
    expect(UplandPropertySchema.safeParse({ ...PROPERTY, totalSales: 1.5 }).success).toBe(false);
  });
});

describe('UplandPropertyListSchema', () => {
  it('accepts a list with a total', () => {
    const result = UplandPropertyListSchema.safeParse({ items: [PROPERTY], total: 42 });
    expect(result.success).toBe(true);
  });
});

describe('stats schemas', () => {
  it('SalesVolumeDaySchema accepts a daily volume row', () => {
    const result = SalesVolumeDaySchema.safeParse({
      date: '2026-09-18',
      count: 120,
      volumeUpx: 1500000.5,
      avgPrice: 12504.2,
      minPrice: 900,
      maxPrice: 250000,
    });
    expect(result.success).toBe(true);
  });

  it('TimeSeriesPointSchema accepts a bucket', () => {
    const result = TimeSeriesPointSchema.safeParse({
      bucket: '2026-09-18',
      count: 42,
      volume: 100000,
    });
    expect(result.success).toBe(true);
  });

  it('PriceDistributionBucketSchema accepts a histogram bucket', () => {
    const result = PriceDistributionBucketSchema.safeParse({
      range: '10K–25K',
      count: 400,
      avgPrice: 16000,
    });
    expect(result.success).toBe(true);
  });

  it('ActionDistributionEntrySchema accepts an unmapped code with null meaning/category', () => {
    const result = ActionDistributionEntrySchema.safeParse({
      actionName: 'n999',
      actionMeaning: null,
      category: null,
      count: 7,
    });
    expect(result.success).toBe(true);
  });

  it('ActiveAccountSchema accepts an account row', () => {
    const result = ActiveAccountSchema.safeParse({ actor: 'alice', txCount: 900, volumeUpx: 1e6 });
    expect(result.success).toBe(true);
  });

  it('UplandStatsOverviewSchema accepts the overview shape', () => {
    const result = UplandStatsOverviewSchema.safeParse({
      totalActions: 1400000,
      dateRange: { min: '2026-06-01T00:00:00.000', max: '2026-09-18T12:34:56.000' },
      byCategory: { market: 800000, mint: 100000 },
      byType: [{ actionName: 'n5', actionMeaning: 'buy_property_secondary', category: 'market', count: 500000 }],
      totalProperties: 250000,
    });
    expect(result.success).toBe(true);
  });

  it('UplandStatsOverviewSchema accepts an empty data set (null date range)', () => {
    const result = UplandStatsOverviewSchema.safeParse({
      totalActions: 0,
      dateRange: { min: null, max: null },
      byCategory: {},
      byType: [],
      totalProperties: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe('ChainInfoSchema / UplandHealthSchema / UplandEstimateSchema', () => {
  it('ChainInfoSchema accepts the live chain head', () => {
    const result = ChainInfoSchema.safeParse({
      headBlockNum: 400123456,
      headBlockTime: '2026-09-19T00:00:00.000',
      chainId: 'abcd',
      blocksPerDay: 172800,
    });
    expect(result.success).toBe(true);
  });

  it('UplandHealthSchema accepts an empty database (null latestBlock)', () => {
    const result = UplandHealthSchema.safeParse({
      status: 'ok',
      actions: 0,
      properties: 0,
      latestBlock: null,
      gcsConfigured: false,
    });
    expect(result.success).toBe(true);
  });

  it('UplandHealthSchema rejects a status other than ok', () => {
    const result = UplandHealthSchema.safeParse({
      status: 'down',
      actions: 0,
      properties: 0,
      latestBlock: null,
      gcsConfigured: false,
    });
    expect(result.success).toBe(false);
  });

  it('UplandEstimateSchema accepts a capped (gte) estimate and rejects other relations', () => {
    const estimate = {
      estimatedActions: 10000,
      relation: 'gte',
      startBlock: 1,
      endBlock: 15500000,
      days: 90,
    };
    expect(UplandEstimateSchema.safeParse(estimate).success).toBe(true);
    expect(UplandEstimateSchema.safeParse({ ...estimate, relation: 'approx' }).success).toBe(false);
  });
});

describe('scraper control schemas', () => {
  it('ScrapeRequestSchema accepts an empty body (all fields optional)', () => {
    expect(ScrapeRequestSchema.safeParse({}).success).toBe(true);
  });

  it('ScrapeRequestSchema accepts a days-based request and rejects out-of-range days', () => {
    expect(ScrapeRequestSchema.safeParse({ days: 90, chunkBlocks: 100000 }).success).toBe(true);
    expect(ScrapeRequestSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(ScrapeRequestSchema.safeParse({ days: 366 }).success).toBe(false);
  });

  it('ScrapeStatusSchema accepts an idle status', () => {
    const result = ScrapeStatusSchema.safeParse({
      running: false,
      phase: 'idle',
      currentBlock: null,
      fetched: 0,
      totalActions: 0,
      startBlock: null,
      endBlock: null,
      error: null,
      lastResult: null,
    });
    expect(result.success).toBe(true);
  });

  it('ScrapeStatusSchema accepts a finished run with a numeric lastResult', () => {
    const result = ScrapeStatusSchema.safeParse({
      running: false,
      phase: 'complete',
      currentBlock: 15500000,
      fetched: 1400000,
      totalActions: 1400000,
      startBlock: 1,
      endBlock: 15500000,
      error: null,
      lastResult: { stored: 1400000, skipped: 12 },
    });
    expect(result.success).toBe(true);
  });

  it('GcsSyncResultSchema / GcsStatusSchema accept the sync shapes', () => {
    const sync = { synced: true, uploadedFiles: ['actions/2026/09/18/part-0.jsonl'], errors: [] };
    expect(GcsSyncResultSchema.safeParse(sync).success).toBe(true);
    expect(
      GcsStatusSchema.safeParse({ configured: true, running: false, lastResult: sync }).success,
    ).toBe(true);
    expect(
      GcsStatusSchema.safeParse({ configured: false, running: false, lastResult: null }).success,
    ).toBe(true);
  });
});

describe('ActionCodesSchema', () => {
  it('accepts the decoder-ring record', () => {
    const result = ActionCodesSchema.safeParse({
      n5: { meaning: 'buy_property_secondary', confidence: 0.95, category: 'market' },
      a4: { meaning: 'mint_property', confidence: 0.9, category: 'mint' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an entry missing its category', () => {
    const result = ActionCodesSchema.safeParse({
      n5: { meaning: 'buy_property_secondary', confidence: 0.95 },
    });
    expect(result.success).toBe(false);
  });
});

describe('UPLAND const tuples', () => {
  it('are the frozen interval/sort/export vocabularies', () => {
    expect(UPLAND_INTERVALS).toEqual(['hour', 'day', 'week']);
    expect(UPLAND_PROPERTY_SORTS).toEqual(['sales', 'price']);
    expect(UPLAND_EXPORT_TYPES).toEqual(['actions', 'sales']);
  });
});
