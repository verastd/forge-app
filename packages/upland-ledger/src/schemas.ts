/**
 * Zod schemas for every Upland Ledger response, field-for-field as on the wire
 * (snake_case, except `/status` and `/chains`, which the ledger emits in
 * camelCase). `openapi.yaml` is the human-readable contract; these schemas are
 * the executable one, and `schemas.test.ts` checks both against the captured
 * responses in `examples/`.
 *
 * Conventions:
 * - Objects strip unknown keys (zod's default), so an additive upstream field
 *   never breaks a screen; the example tests use a deep-equality check to make
 *   sure no wire field is silently missing from a schema.
 * - No transforms: input and output types are identical, so `z.infer` is the
 *   wire type and nothing is substituted.
 * - Opaque upstream payloads (`data`, `raw`, `fields`, `evidence`) are typed as
 *   `unknown` / records — read them defensively.
 */
import { z } from 'zod';

// ------------------------------------------------------------- primitives

/** `2026-10-08T17:12:35.000Z` — ISO-8601 UTC with an explicit `Z`. */
export const IsoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'expected an ISO-8601 UTC instant');
/** `2026-10-08` */
export const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD day');
/**
 * `2026-10-05 00:00:00.000` — ClickHouse's own DateTime64 text, UTC, no zone.
 * Only `/signals` emits this (an upstream inconsistency; see README).
 */
export const ClickHouseDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/, 'expected a ClickHouse DateTime64 string');

const num = z.number();
const str = z.string();

// ----------------------------------------------------------------- errors

/** Error codes the ledger itself emits (`apps/api/src/errors.ts`). */
export const LEDGER_ERROR_CODES = [
  'validation_error',
  'not_found',
  'rate_limited',
  'request_timeout',
  'payload_too_large',
  'upstream_unavailable',
  'internal_error',
] as const;

/** `{"error": {"code", "message"}}` — every ledger error, 4xx and 5xx. */
export const LedgerErrorBodySchema = z.object({
  error: z.object({ code: str, message: str }),
});
export type LedgerErrorBody = z.infer<typeof LedgerErrorBodySchema>;

/** `{"error": "<code>"}` — errors produced by the gateway/BFF, never by the ledger. */
export const GatewayErrorBodySchema = z.object({ error: str });
export type GatewayErrorBody = z.infer<typeof GatewayErrorBodySchema>;

// -------------------------------------------------------------- envelopes

/** Keyset-paginated list: `/actions`, `/transfers`, `/contracts/:c/actions`, `/accounts/:a/actions`. */
export const cursorPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), next_cursor: str.nullable(), count: num });

/** Aggregate list: `/contracts`, `/stats/actions`. */
export const aggregatePage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), count: num, approximate: z.boolean() });

/** Offset-paginated list: every entity route (`/properties`, `/sales`, …). */
export const offsetPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), count: num, limit: num, offset: num, has_more: z.boolean() });

// ---------------------------------------------------------------- actions

export const AuthorizationSchema = z.object({ actor: str, permission: str });

/** A receipt is upstream JSON; extra keys are kept. `*_sequence` stay strings (UInt64). */
export const ReceiptSchema = z
  .object({
    receiver: str,
    global_sequence: str,
    recv_sequence: str,
    auth_sequence: z.array(z.object({ account: str, sequence: str }).passthrough()),
  })
  .passthrough();

export const ActionSchema = z.object({
  global_sequence: num,
  timestamp: IsoInstant.nullable(),
  block_num: num,
  block_id: str,
  trx_id: str,
  action_ordinal: num,
  creator_action_ordinal: num,
  contract: str,
  action: str,
  receiver: str,
  notified: z.array(str),
  actors: z.array(str),
  authorization: z.array(AuthorizationSchema),
  receipts: z.array(ReceiptSchema),
  /** ABI-decoded action data — shape depends on `contract`/`action`. */
  data: z.record(z.unknown()),
  producer: str,
  cpu_usage_us: num,
  irreversible: z.boolean(),
  source: str,
  stream: str,
  normalizer_version: num,
  ingested_at: IsoInstant.nullable(),
  /** Only with `include_raw=true`. */
  raw: z.unknown().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

export const ActionPageSchema = cursorPage(ActionSchema);
export type ActionPage = z.infer<typeof ActionPageSchema>;

export const ACCOUNT_ROLES = ['actor', 'receiver', 'notified'] as const;
export const AccountActionPageSchema = ActionPageSchema.extend({
  account: str,
  role: z.enum(ACCOUNT_ROLES),
});
export type AccountActionPage = z.infer<typeof AccountActionPageSchema>;

export const TransactionSchema = z.object({
  trx_id: str,
  timestamp: IsoInstant.nullable(),
  block_num: num,
  actions: z.array(ActionSchema),
});
export type Transaction = z.infer<typeof TransactionSchema>;

// -------------------------------------------------------------- transfers

export const TransferSchema = z.object({
  global_sequence: num,
  timestamp: IsoInstant.nullable(),
  block_num: num,
  trx_id: str,
  contract: str,
  from: str,
  to: str,
  /** Upstream text, e.g. `"375.00 UPX"`. */
  quantity: str,
  amount: num,
  symbol: str,
  memo: str,
});
export type Transfer = z.infer<typeof TransferSchema>;
export const TransferPageSchema = cursorPage(TransferSchema);
export type TransferPage = z.infer<typeof TransferPageSchema>;

// ---------------------------------------------------- contracts and stats

export const ContractSchema = z.object({
  contract: str,
  action_count: num,
  action_types: z.array(str),
  first_seen_at: IsoInstant.nullable(),
  last_seen_at: IsoInstant.nullable(),
});
export type Contract = z.infer<typeof ContractSchema>;
export const ContractListSchema = aggregatePage(ContractSchema);
export type ContractList = z.infer<typeof ContractListSchema>;

export const ActionStatSchema = z.object({
  contract: str,
  action: str,
  count: num,
  first_seen_at: IsoInstant.nullable(),
  last_seen_at: IsoInstant.nullable(),
});
export type ActionStat = z.infer<typeof ActionStatSchema>;
export const ActionStatListSchema = aggregatePage(ActionStatSchema);
export type ActionStatList = z.infer<typeof ActionStatListSchema>;

// ----------------------------------------------------------------- status

export const StatusSchema = z.object({
  clickhouse: z.object({ connected: z.boolean(), database: str, error: str.optional() }),
  upstream: z.object({ connected: z.boolean(), checkedAt: IsoInstant, error: str.optional() }),
  ingestion: z.object({
    latestTimestamp: IsoInstant.nullable(),
    latestBlock: num.nullable(),
    latestGlobalSequence: num.nullable(),
    lagSeconds: num.nullable(),
    checkpoint: z
      .object({
        stream: str,
        lastTimestamp: IsoInstant.nullable(),
        lastBlock: num,
        lastGlobalSequence: num,
        updatedAt: IsoInstant.nullable(),
      })
      .nullable(),
  }),
  history: z.object({
    chainName: str,
    chainStart: IsoInstant.nullable(),
    chainEnd: IsoInstant.nullable(),
    live: z.boolean(),
    earliestStoredTimestamp: IsoInstant.nullable(),
    backfillComplete: z.boolean(),
    completedWindows: num,
    pendingWindows: num,
    failedWindows: num,
    windowsByStatus: z.record(num),
  }),
});
export type Status = z.infer<typeof StatusSchema>;

// -------------------------------------------------------------- analytics

export const ChainSummarySchema = z.object({
  name: str,
  database: str,
  chainStart: IsoInstant.nullable(),
  chainEnd: IsoInstant.nullable(),
  live: z.boolean(),
  latestTimestamp: IsoInstant.nullable(),
  earliestTimestamp: IsoInstant.nullable(),
  actionCount: num,
  /** Present when the chain's database could not be read. */
  error: str.optional(),
});
export type ChainSummary = z.infer<typeof ChainSummarySchema>;
export const ChainListSchema = z.array(ChainSummarySchema);

export const OverviewSchema = z.object({
  chain: str,
  actions_total: num,
  actions_24h: num,
  contracts: num,
  action_types: num,
  transfers_24h_by_symbol: z.array(z.object({ symbol: str, transfers: num, amount: num })),
  lag_seconds: num.nullable(),
  backfill: z.object({ verified: num, pending: num, failed: num }),
  earliest: IsoInstant.nullable(),
  latest: IsoInstant.nullable(),
  top_actions_24h: z.array(z.object({ contract: str, action: str, count: num })),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const VALUE_TYPES = ['time', 'string', 'number'] as const;
export const ResultColumnSchema = z.object({ name: str, type: z.enum(VALUE_TYPES) });
export const QueryStatsSchema = z.object({
  rows: num,
  elapsed_ms: num,
  rows_read: num,
  bytes_read: num,
  truncated: z.boolean(),
  table: str,
  dedup: z.enum(['exact', 'approximate']),
});

/**
 * The analytics result shape (docs/ANALYTICS.md §3). `rows[i][j]` is typed by
 * `columns[j].type`: `time` cells are ISO instants, `number` cells numbers,
 * `string` cells strings; any cell may be null.
 */
export const AnalyticsResultSchema = z.object({
  columns: z.array(ResultColumnSchema),
  rows: z.array(z.array(z.union([str, num, z.null()]))),
  stats: QueryStatsSchema,
  sql: str,
});
export type AnalyticsResult = z.infer<typeof AnalyticsResultSchema>;

/** `POST /analytics/query` adds the chain it ran against. */
export const QueryResultSchema = AnalyticsResultSchema.extend({ chain: str });
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const DataKeySchema = z.object({
  contract: str,
  action: str,
  key: str,
  value_type: str,
  sample_count: num,
  present_count: num,
  distinct_estimate: num,
  sample_values: z.array(str),
  refreshed_at: IsoInstant.nullable(),
});
export type DataKey = z.infer<typeof DataKeySchema>;
export const DataKeyListSchema = z.array(DataKeySchema);

export const FlowsSchema = z.object({
  chain: str,
  symbol: str,
  range: z.object({ after: IsoInstant, before: IsoInstant }),
  nodes: z.array(z.object({ id: str, in: num, out: num })),
  links: z.array(z.object({ source: str, target: str, transfers: num, amount: num })),
});
export type Flows = z.infer<typeof FlowsSchema>;

export const TopAccountSchema = z.object({
  account: str,
  /** The metric `by` selected. */
  value: num,
  actions: num.optional(),
  transfers: num.optional(),
  amount: num.optional(),
});
export type TopAccount = z.infer<typeof TopAccountSchema>;
export const TopAccountListSchema = z.array(TopAccountSchema);

export const CalendarDaySchema = z.object({ day: IsoDay, value: num });
export type CalendarDay = z.infer<typeof CalendarDaySchema>;
export const CalendarSchema = z.array(CalendarDaySchema);

export const SalesAnalyticsSchema = z.object({
  /** columns `[<bucket>, median_price, sales]` */
  series: AnalyticsResultSchema,
  /** columns `[bin, sales]` */
  histogram: AnalyticsResultSchema,
  fields_used: z.array(str),
  note: str,
  chain: str,
  action: z.object({ contract: str, action: str, label: str.nullable(), confidence: num.nullable() }),
  range: z.object({ after: IsoInstant, before: IsoInstant }),
  bucket: str,
  matched: num,
  unmatched: num,
});
export type SalesAnalytics = z.infer<typeof SalesAnalyticsSchema>;

export const IngestWindowSchema = z.object({
  window_id: str,
  after: IsoInstant.nullable(),
  before: IsoInstant.nullable(),
  status: str,
  attempts: num,
  expected_count: num,
  received_count: num,
  unique_count: num,
  updated_at: IsoInstant.nullable(),
  min_global_sequence: num,
  max_global_sequence: num,
  min_block: num,
  max_block: num,
  started_at: IsoInstant.nullable(),
  completed_at: IsoInstant.nullable(),
  last_error: str,
  worker_id: str,
  parent_id: str,
  depth: num,
});
export type IngestWindow = z.infer<typeof IngestWindowSchema>;
export const IngestWindowListSchema = z.array(IngestWindowSchema);

// ----------------------------------------------------------------- market

export const RatePointSchema = z.object({
  day: IsoDay,
  method: str,
  upx_per_usd: num,
  usd_per_upx: num,
  upx_per_usd_smooth: num,
  p25: num,
  p75: num,
  upx_listings: num,
  fiat_listings: num,
  samples: num,
  cities: num,
});
export type RatePoint = z.infer<typeof RatePointSchema>;

export const UpxUsdSchema = z.object({
  methods: z.array(str),
  preferred: str,
  points: z.array(RatePointSchema),
  latest: z.record(num),
  spread: num.nullable(),
  notes: z.array(str),
});
export type UpxUsd = z.infer<typeof UpxUsdSchema>;

/** `market_city_daily`. Medians are null on a day with nothing to take a median of. */
export const CityDaySchema = z.object({
  day: IsoDay,
  city: str,
  sales: num,
  volume_upx: num,
  median_sale_upx: num.nullable(),
  median_ask_upx: num.nullable(),
  median_ask_usd: num.nullable(),
  listings_new: num,
  listings_removed: num,
  mints: num,
  median_mint_upx: num.nullable(),
  median_sale_to_mint: num.nullable(),
  yield_payout_upx: num,
  distinct_buyers: num,
  distinct_sellers: num,
});
export type CityDay = z.infer<typeof CityDaySchema>;
export const CityDayListSchema = z.array(CityDaySchema);

export const FiatSchema = z.object({
  window: z.object({ after: IsoInstant, before: IsoInstant, days: num }),
  totals: z.object({ listings: num, cleared: num, clear_rate: num, asked_usd: num, cleared_usd: num }),
  daily: z.array(z.object({ day: IsoDay, listings: num, cleared: num, asked_usd: num, cleared_usd: num })),
  by_city: z.array(
    z.object({ city: str, listings: num, cleared: num, cleared_usd: num, median_usd: num, clear_rate: num }),
  ),
  upx_equivalent: z.array(
    z.object({ category: str, sales: num, upx_volume: num, usd_equivalent: num, median_upx: num }),
  ),
  notes: z.array(str),
});
export type Fiat = z.infer<typeof FiatSchema>;

export const SIGNAL_TYPES = ['cross_book_arb', 'under_comps', 'regime_shift', 'yield_value', 'sub_mint_arb'] as const;

export const SignalSchema = z.object({
  /** ClickHouse text, not ISO — see {@link ClickHouseDateTime}. */
  observed_at: ClickHouseDateTime,
  signal_type: str,
  entity_type: str,
  entity_id: str,
  city: str,
  /** 0..1, comparable within a `signal_type`. */
  score: num,
  expected_edge_upx: num,
  expected_edge_usd: num,
  horizon_hours: num,
  /** Whatever the rule recorded; values are strings. */
  evidence: z.record(str),
  rule_version: num,
  expires_at: ClickHouseDateTime,
});
export type Signal = z.infer<typeof SignalSchema>;
export const SignalListSchema = z.array(SignalSchema);

// --------------------------------------------------------------- entities

export const PropertySchema = z.object({
  /** Up to 20 digits — keep it a string, it overflows a JS number's exact range. */
  property_id: str,
  address: str,
  city: str,
  region: str,
  neighborhood: str,
  neighborhood_id: num,
  mint_price_upx: num,
  mint_price_source: str,
  mint_kind: str,
  api_status: str,
  minted_at: IsoInstant.nullable(),
  sales: num,
  last_sale_upx: num,
  last_sale_at: IsoInstant.nullable(),
  observations: num,
  /** floor(log2(mint_price_upx)); null when there is no mint price. */
  mint_band: num.nullable(),
});
export type Property = z.infer<typeof PropertySchema>;
export const PropertyPageSchema = offsetPage(PropertySchema);
export type PropertyPage = z.infer<typeof PropertyPageSchema>;

/** The Upland Developers API row (`ext_upland_properties`), when the ledger has one. */
export const UplandApiPropertySchema = z.object({
  address: str,
  city: str,
  neighborhood: str,
  neighborhood_id: num,
  collection: str,
  status: str,
  mint_price_upx: num,
});

export const PropertyDetailSchema = PropertySchema.extend({
  /** False: the property has never traded inside the chain window; fields come from the API dimension. */
  chain_known: z.boolean(),
  upland_api: UplandApiPropertySchema.nullable(),
});
export type PropertyDetail = z.infer<typeof PropertyDetailSchema>;

export const PropertyEventSchema = z.object({
  timestamp: IsoInstant.nullable(),
  event_type: str,
  account: str,
  counterparty: str,
  amount_upx: num.nullable(),
  trx_id: str,
  /** Decoded event fields; keys depend on `event_type`. */
  fields: z.record(z.unknown()),
});
export type PropertyEvent = z.infer<typeof PropertyEventSchema>;
export const PropertyHistorySchema = offsetPage(PropertyEventSchema);
export type PropertyHistory = z.infer<typeof PropertyHistorySchema>;

export const AccountSchema = z.object({
  account: str,
  username: str,
  usernames: z.array(str),
  username_changes: num,
  first_seen: IsoInstant.nullable(),
  last_seen: IsoInstant.nullable(),
  active_days: num,
  events: num,
  buys: num,
  sells: num,
  upx_spent: num,
  upx_received: num,
  median_buy_latency_s: num,
  sub_5s_buys: num,
  pct_buys_under_1m: num,
  /** Advisory inference, not a fact (docs/MARKET.md). */
  likely_bot: z.boolean(),
  /** upx_received - upx_spent, rounded to 2 dp. */
  upx_net: num,
});
export type Account = z.infer<typeof AccountSchema>;
export const AccountPageSchema = offsetPage(AccountSchema);
export type AccountPage = z.infer<typeof AccountPageSchema>;

export const AccountDetailSchema = AccountSchema.extend({
  income: z.object({ yield_upx: num, visit_upx: num, yield_collections: num }),
});
export type AccountDetail = z.infer<typeof AccountDetailSchema>;

export const ListingSchema = z.object({
  timestamp: IsoInstant.nullable(),
  property_id: str,
  seller: str,
  address: str,
  city: str,
  neighborhood: str,
  mint_price_upx: num,
  /** Exactly one of `ask_upx` / `ask_fiat` is non-zero. */
  ask_upx: num,
  ask_fiat: num,
  ask_to_mint: num,
});
export type Listing = z.infer<typeof ListingSchema>;
export const ListingPageSchema = offsetPage(ListingSchema);

export const SaleSchema = z.object({
  timestamp: IsoInstant.nullable(),
  property_id: str,
  buyer: str,
  seller: str,
  trx_id: str,
  address: str,
  city: str,
  neighborhood: str,
  mint_price_upx: num,
  price_upx: num,
  buyer_paid_upx: num,
  seller_proceeds_upx: num,
  community_fee_upx: num,
  price_to_mint: num,
});
export type Sale = z.infer<typeof SaleSchema>;
export const SalePageSchema = offsetPage(SaleSchema);

export const OfferSchema = z.object({
  timestamp: IsoInstant.nullable(),
  property_id: str,
  trx_id: str,
  offer_id: str,
  seller: str,
  buyer: str,
  buyer_username: str,
  price_upx: num,
  seller_proceeds_upx: num,
  community_fee_upx: num,
  address: str,
  city: str,
  region: str,
  mint_price_upx: num,
  price_to_mint: num,
  /** `address` | `mint_trx` | `both` */
  resolved_by: str,
});
export type Offer = z.infer<typeof OfferSchema>;
export const OfferPageSchema = offsetPage(OfferSchema);

export const NeighborhoodSchema = z.object({
  neighborhood_id: num,
  name: str,
  city_id: num,
  city: str,
  area_m2: num,
  center_lat: num,
  center_lng: num,
  /** Only with `include_boundaries=true`: the polygon ring array as a JSON *string*. */
  boundaries: str.optional(),
});
export type Neighborhood = z.infer<typeof NeighborhoodSchema>;
export const NeighborhoodPageSchema = offsetPage(NeighborhoodSchema);

export const CollectionSchema = z.object({
  collection_id: num,
  name: str,
  city_id: num,
  amount: num,
  rarity_level: num,
  description: str,
  requirements: str,
  yield_boost: num,
  one_time_reward: num,
  image: str,
});
export type Collection = z.infer<typeof CollectionSchema>;
export const CollectionPageSchema = offsetPage(CollectionSchema);

export const TreasureSchema = z.object({
  /** Upland username, not a chain account. */
  user_name: str,
  reward_upx: num,
  full_address: str,
  treasure_type: str,
  lock_seconds: num,
  spawn_at: IsoInstant.nullable(),
  locked_at: IsoInstant.nullable(),
});
export type Treasure = z.infer<typeof TreasureSchema>;
export const TreasurePageSchema = offsetPage(TreasureSchema);

export const RateRowSchema = z.object({
  day: IsoDay,
  method: str,
  upx_per_usd: num,
  usd_per_upx: num,
  p25: num,
  p75: num,
  upx_listings: num,
  fiat_listings: num,
  samples: num,
  cities: num,
  method_version: num,
});
export type RateRow = z.infer<typeof RateRowSchema>;
/** NB: `limit` is per method, so `count` can exceed `limit` and `has_more` is unreliable. */
export const RatePageSchema = offsetPage(RateRowSchema);

export const SearchResultSchema = z.object({
  query: str,
  properties: z
    .array(z.object({ property_id: str, address: str, city: str, neighborhood: str, mint_price_upx: num, sales: num }))
    .optional(),
  accounts: z
    .array(
      z.object({
        account: str,
        username: str,
        buys: num,
        sells: num,
        /** 0 | 1 here (a boolean everywhere else). */
        likely_bot: num,
      }),
    )
    .optional(),
  neighborhoods: z
    .array(z.object({ neighborhood_id: num, name: str, city_id: num, center_lat: num, center_lng: num }))
    .optional(),
  collections: z
    .array(
      z.object({
        collection_id: num,
        name: str,
        city_id: num,
        yield_boost: num,
        one_time_reward: num,
        requirements: str,
      }),
    )
    .optional(),
  cities: z.array(z.object({ city_id: num, name: str, state_name: str, country_name: str })).optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
