/**
 * Request parameter types for every operation, mirroring the ledger's own zod
 * query schemas (`apps/api/src/**\/params.ts` in the ledger repo) and
 * `openapi.yaml`. All are optional unless marked; omitted values take the
 * server default documented on each field.
 *
 * Timestamps accept an ISO-8601 string (a missing zone is read as UTC) or a
 * `Date`. Day parameters (`/market/*`) accept `YYYY-MM-DD` or a `Date` (its UTC
 * day is sent).
 */
import type { ACCOUNT_ROLES, SIGNAL_TYPES } from './schemas.js';

/**
 * A real Antelope account name — the ledger's single account validator
 * (`ANTELOPE_ACCOUNT` in its params.ts): up to 12 of `[a-z1-5.]`, or 12 of
 * those plus a 13th from `[a-j1-5]`. The ledger answers 400 validation_error
 * for anything else on `/accounts/{account}`, `/accounts/{account}/actions`
 * and the `buyer`/`seller` filters of `/sales` and `/offers`. Use it to
 * validate user input before navigating or querying.
 */
export const ANTELOPE_ACCOUNT = /^(?:[a-z1-5.]{1,12}|[a-z1-5.]{12}[a-j1-5])$/;

export function isAntelopeAccount(value: string): boolean {
  return ANTELOPE_ACCOUNT.test(value);
}

export type Instant = string | Date;
export type Day = string | Date;
export type SortDir = 'asc' | 'desc';

/** `?chain=` — every route takes it; omitted means the ledger's default chain. */
export interface ChainParam {
  chain?: string;
}

// ------------------------------------------------------------ raw chain

/** Shared by `/actions`, `/contracts/{contract}/actions`, `/accounts/{account}/actions`. */
export interface ActionListParams extends ChainParam {
  after?: Instant;
  before?: Instant;
  contract?: string;
  action?: string;
  receiver?: string;
  actor?: string;
  notified?: string;
  /** 64 hex chars. */
  trx_id?: string;
  /** Decimal string or number (UInt64). */
  block_num?: string | number;
  min_global_sequence?: string | number;
  max_global_sequence?: string | number;
  /** 1..1000, default 100. */
  limit?: number;
  /** Opaque — pass back `next_cursor` exactly. */
  cursor?: string;
  /** Default `desc`. */
  sort?: SortDir;
  /** Default false. Raw documents are large. */
  include_raw?: boolean;
}

export interface AccountActionsParams extends ActionListParams {
  /** Default `actor`. */
  role?: (typeof ACCOUNT_ROLES)[number];
}

export interface LookupParams extends ChainParam {
  include_raw?: boolean;
}

export interface ContractsParams extends ChainParam {
  /** Passing after/before switches to an exact count (`approximate: false`). */
  after?: Instant;
  before?: Instant;
  /** 1..1000, default 1000. */
  limit?: number;
}

export interface StatsActionsParams extends ContractsParams {
  contract?: string;
}

export interface TransfersParams extends ChainParam {
  from?: string;
  to?: string;
  /** Alphanumeric, ≤16 chars, e.g. `UPX`. */
  symbol?: string;
  contract?: string;
  after?: Instant;
  before?: Instant;
  /** 1..1000, default 100. */
  limit?: number;
  cursor?: string;
  sort?: SortDir;
}

// ------------------------------------------------------------ analytics

export type TimeBucket = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type Metric = 'actions' | 'transactions' | 'transfers' | 'amount';

export interface TimeseriesParams extends ChainParam {
  /** Default `actions`. */
  metric?: Metric;
  /** Default `hour`. */
  bucket?: TimeBucket;
  /** Default: a bucket-dependent span before `before` (hour → 30 days). */
  after?: Instant;
  /** Default: now. */
  before?: Instant;
  contract?: string;
  /** Only for metric actions|transactions. */
  action?: string;
  /** Only for metric transfers|amount. */
  symbol?: string;
  /** Default `none`. `symbol` needs a transfers metric, `action` an actions metric. */
  split_by?: 'contract' | 'action' | 'symbol' | 'none';
  /** 1..50, default 10 — series kept when split, the rest folded into "others". */
  top?: number;
}

export interface KeysParams extends ChainParam {
  contract?: string;
  action?: string;
  /** 1..5000, default 1000. */
  limit?: number;
}

export interface FlowsParams extends ChainParam {
  /** Default `UPX`. */
  symbol?: string;
  contract?: string;
  after?: Instant;
  before?: Instant;
  min_amount?: number;
  /** Center on one account: only its in/out edges. */
  account?: string;
  /** 1..2000, default 200. */
  limit?: number;
}

export interface TopAccountsParams extends ChainParam {
  /** Default `actions`. */
  by?: 'actions' | 'sent' | 'received';
  symbol?: string;
  contract?: string;
  after?: Instant;
  before?: Instant;
  /** 1..500, default 50. */
  limit?: number;
}

export interface CalendarParams extends ChainParam {
  metric?: Metric;
  contract?: string;
  action?: string;
  symbol?: string;
  account?: string;
  after?: Instant;
  before?: Instant;
}

export interface SalesAnalyticsParams extends ChainParam {
  after?: Instant;
  before?: Instant;
  /** Default `day`. */
  bucket?: 'hour' | 'day' | 'week' | 'month';
  /** Default `playuplandme`. */
  contract?: string;
  /** Default `n5`. */
  action?: string;
  /** 4..100, default 24. */
  bins?: number;
}

export interface IngestWindowsParams extends ChainParam {
  after?: Instant;
  before?: Instant;
  status?: 'pending' | 'running' | 'complete' | 'verified' | 'failed' | 'split';
  /** 1..5000, default 500. */
  limit?: number;
  /** Default `asc`. */
  sort?: SortDir;
}

// --------------------------------------------- POST /analytics/query body

export const QUERY_SOURCES = [
  'actions',
  'transfers',
  'events',
  'properties',
  'accounts',
  'sales',
  'listings',
  'offers',
  'signals',
  'rates',
  'treasures',
  'city_daily',
] as const;
export type QuerySource = (typeof QUERY_SOURCES)[number];
export type MeasureFn = 'count' | 'uniq' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'p90' | 'p99';
export type Scalar = string | number;
export interface JsonRef {
  key: string;
  type: 'number' | 'string';
}
export type QueryFilter =
  | { field: 'actor' | 'notified'; op: 'has'; value: string }
  | { json: JsonRef; op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'between' | 'like'; value: Scalar | Scalar[] }
  | { field: string; op: 'eq' | 'neq' | 'in' | 'nin'; value: Scalar | Scalar[] }
  | { field: string; op: 'gte' | 'lte' | 'between'; value: Scalar | [Scalar, Scalar] };
export type BinTarget = string | { json: JsonRef };
export type QueryDimension =
  | { time: { bucket: TimeBucket } }
  | { json: JsonRef }
  | { bin: { field: BinTarget; width: number } | { field: BinTarget; edges: number[] } }
  | { field: string };
export interface QueryMeasure {
  fn: MeasureFn;
  /** Required for every fn except `count` (which takes none). */
  field?: string | { json: JsonRef };
  alias?: string;
}
export type QueryOrderBy =
  | { measure: string | number; dir?: SortDir }
  | { dimension: number; dir?: SortDir };

/** docs/ANALYTICS.md §3. Column allow-lists per source are enforced server-side. */
export interface QuerySpec {
  chain?: string;
  source: QuerySource;
  /** Required for every source except `properties` and `accounts`. */
  range?: { after: string; before: string };
  /** ≤24 */
  filters?: QueryFilter[];
  /** ≤4, at most one time dimension. */
  dimensions?: QueryDimension[];
  /** 1..8 */
  measures: QueryMeasure[];
  /** ≤4 */
  orderBy?: QueryOrderBy[];
  /** 1..10000, default 1000. */
  limit?: number;
  topN?: { dimension: number; n: number; others?: boolean };
}

// --------------------------------------------------------------- market

export const RATE_METHODS = [
  'global_comps',
  'city_comps',
  'city_band_comps',
  'paired_property',
  'settled_comps',
  'weighted_comps',
] as const;
export type RateMethod = (typeof RATE_METHODS)[number];

export interface UpxUsdParams extends ChainParam {
  method?: RateMethod;
  /** First day (inclusive). */
  after?: Day;
  /** Last day (inclusive). */
  before?: Day;
  /** Trailing-median days 1..30, default 7; 1 disables smoothing. */
  smooth?: number;
  /** The newest N days PER METHOD (returned oldest-first), 1..2000, default 1000. */
  limit?: number;
}

export interface CitiesParams extends ChainParam {
  city?: string;
  /** First day (inclusive). */
  after?: Day;
  /** Last day (inclusive). */
  before?: Day;
  /** 1..5000, default 2000. */
  limit?: number;
}

export interface FiatParams extends ChainParam {
  /** Trailing window 1..365, default 90. */
  days?: number;
  city?: string;
  /** Default 0.5. */
  min_usd?: number;
  /** Default 100000. */
  max_usd?: number;
  /** Default false. */
  cleared_only?: boolean;
}

export interface SignalsParams extends ChainParam {
  type?: (typeof SIGNAL_TYPES)[number];
  city?: string;
  entity_id?: string;
  /** 0..1, default 0. */
  min_score?: number;
  /** Default true: hide expired signals. */
  active_only?: boolean;
  /** 1..500, default 100. */
  limit?: number;
}

// ------------------------------------------------------------- entities

/** Offset pagination shared by every entity list. */
export interface OffsetParams {
  /** 1..1000, default 100. */
  limit?: number;
  /** ≥0, default 0. */
  offset?: number;
}

interface Ordered<S extends string> extends OffsetParams {
  sort?: S;
  /** Default `desc`. */
  order?: SortDir;
}

export const PROPERTY_SORTS = ['mint_price_upx', 'last_sale_upx', 'last_sale_at', 'minted_at', 'sales', 'address'] as const;
export interface PropertyListParams extends ChainParam, Ordered<(typeof PROPERTY_SORTS)[number]> {
  city?: string;
  neighborhood?: string;
  region?: string;
  /** Upland API status, e.g. `Owned`. */
  status?: string;
  mint_source?: 'chain' | 'api' | 'none';
  min_mint?: number;
  max_mint?: number;
  min_sales?: number;
  traded?: boolean;
  /** Case-insensitive substring. */
  address?: string;
}

export interface PropertyHistoryParams extends ChainParam, OffsetParams {
  event_type?: string;
  after?: Instant;
  before?: Instant;
}

export const ACCOUNT_SORTS = [
  'events',
  'buys',
  'sells',
  'upx_spent',
  'upx_received',
  'active_days',
  'first_seen',
  'last_seen',
  'median_buy_latency_s',
] as const;
export interface AccountListParams extends ChainParam, Ordered<(typeof ACCOUNT_SORTS)[number]> {
  /** Substring of the Upland username. */
  username?: string;
  likely_bot?: boolean;
  named?: boolean;
  min_buys?: number;
  min_sells?: number;
  min_events?: number;
  max_median_latency_s?: number;
}

export interface ListingParams extends ChainParam, Ordered<'timestamp' | 'ask_upx' | 'ask_fiat' | 'ask_to_mint'> {
  city?: string;
  neighborhood?: string;
  book?: 'upx' | 'fiat';
  /** Only listings still live (scans the last 180 days). */
  open?: boolean;
  min_ask?: number;
  max_ask?: number;
  min_ask_to_mint?: number;
  max_ask_to_mint?: number;
  after?: Instant;
  before?: Instant;
}

export interface SaleParams extends ChainParam, Ordered<'timestamp' | 'price_upx' | 'price_to_mint'> {
  city?: string;
  neighborhood?: string;
  /** Must match {@link ANTELOPE_ACCOUNT}, else 400. */
  buyer?: string;
  /** Must match {@link ANTELOPE_ACCOUNT}, else 400. */
  seller?: string;
  property_id?: string;
  min_price?: number;
  max_price?: number;
  max_price_to_mint?: number;
  after?: Instant;
  before?: Instant;
}

export interface OfferParams
  extends ChainParam,
    Ordered<'timestamp' | 'price_upx' | 'price_to_mint' | 'mint_price_upx'> {
  city?: string;
  /** Must match {@link ANTELOPE_ACCOUNT}, else 400. */
  buyer?: string;
  /** Must match {@link ANTELOPE_ACCOUNT}, else 400. */
  seller?: string;
  buyer_username?: string;
  property_id?: string;
  min_price_to_mint?: number;
  max_price_to_mint?: number;
  after?: Instant;
  before?: Instant;
}

export interface NeighborhoodParams extends ChainParam, OffsetParams {
  city?: string;
  city_id?: number;
  name?: string;
  /** Polygons are large; default false. */
  include_boundaries?: boolean;
}

export interface CollectionParams
  extends ChainParam,
    Ordered<'yield_boost' | 'one_time_reward' | 'amount' | 'rarity_level' | 'name'> {
  city_id?: number;
  name?: string;
  min_yield_boost?: number;
  min_reward?: number;
  rarity_level?: number;
}

export interface TreasureParams extends ChainParam, Ordered<'spawn_at' | 'reward_upx' | 'lock_seconds'> {
  user_name?: string;
  treasure_type?: string;
  min_reward?: number;
  max_lock_seconds?: number;
  after?: Instant;
  before?: Instant;
}

/** Rows ordered day DESC, then method; ordinary offset paging. */
export interface RateParams extends ChainParam, OffsetParams {
  method?: string;
  /** Bounds the day (inclusive). */
  after?: Instant;
  before?: Instant;
}

export interface SearchParams extends ChainParam {
  /** Required, 2..120 chars. A bare number is a property-id lookup. */
  q: string;
  kind?: 'property' | 'account' | 'neighborhood' | 'collection' | 'city';
  /** Per kind, 1..100, default 20. */
  limit?: number;
}
