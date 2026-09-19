'use client';

/**
 * Typed client for `/api/upland/*` (the Upland data app, gated by the `upland_data` flag).
 *
 * Same fetch style as `./api`: one timeout, `cache: 'no-store'`, and a failure is
 * a thrown {@link RequestError} — never substituted data. These endpoints have no
 * demo fixtures; a page that cannot reach them says so.
 *
 * The response types mirror `apps/api/src/forge_api/models.py` (camelCase wire
 * contract). They are not yet zod schemas in `@forge/shared`, so payloads are
 * typed, not runtime-validated.
 */

import { ConflictError, RequestError, apiBase } from './api';

const TIMEOUT_MS = 8000;
/** Chain lookups go to Hyperion behind the API; give them longer. */
const CHAIN_TIMEOUT_MS = 20000;

/* --- wire types ------------------------------------------------------------ */

export interface UplandAction {
  globalSequence: number;
  ts: string;
  blockNum: number;
  trxId: string;
  contract: string;
  actionName: string;
  actionMeaning: string | null;
  category: string | null;
  actor: string | null;
  propertyId: string | null;
  priceUpx: number | null;
  fromAccount: string | null;
  toAccount: string | null;
}

export interface UplandActionList {
  items: UplandAction[];
  total: number;
  hasMore: boolean;
}

export interface UplandProperty {
  propertyId: string;
  address: string | null;
  city: string | null;
  firstSeenBlock: number | null;
  firstSeenTs: string | null;
  mintPriceUpx: number | null;
  lastSalePriceUpx: number | null;
  lastSaleTs: string | null;
  totalSales: number;
  totalListings: number;
}

export interface UplandPropertyList {
  items: UplandProperty[];
  total: number;
}

export interface SalesVolumeDay {
  date: string;
  count: number;
  volumeUpx: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
}

export interface TimeSeriesPoint {
  bucket: string;
  count: number;
  volume: number;
}

export interface PriceDistributionBucket {
  range: string;
  count: number;
  avgPrice: number;
}

export interface ActionDistributionEntry {
  actionName: string;
  actionMeaning: string | null;
  category: string | null;
  count: number;
}

export interface ActiveAccount {
  actor: string;
  txCount: number;
  volumeUpx: number;
}

export interface ChainInfo {
  headBlockNum: number;
  headBlockTime: string;
  chainId: string;
  blocksPerDay: number;
}

export interface UplandStatsOverview {
  totalActions: number;
  dateRange: { min: string | null; max: string | null };
  byCategory: Record<string, number>;
  byType: ActionDistributionEntry[];
  totalProperties: number;
}

export interface UplandHealth {
  status: 'ok';
  actions: number;
  properties: number;
  latestBlock: number | null;
  gcsConfigured: boolean;
}

export interface UplandEstimate {
  estimatedActions: number;
  /** "gte" means Hyperion capped the count, so the true total is higher. */
  relation: 'eq' | 'gte';
  startBlock: number;
  endBlock: number;
  days: number;
}

export interface ScrapeRequest {
  days?: number;
  startBlock?: number;
  endBlock?: number;
  chunkBlocks?: number;
}

export interface ScrapeStatus {
  running: boolean;
  phase: string;
  currentBlock: number | null;
  fetched: number;
  totalActions: number;
  startBlock: number | null;
  endBlock: number | null;
  error: string | null;
  lastResult: Record<string, number> | null;
}

export interface GcsSyncResult {
  synced: boolean;
  uploadedFiles: string[];
  errors: string[];
}

export interface GcsStatus {
  configured: boolean;
  running: boolean;
  lastResult: GcsSyncResult | null;
}

export type ActionCodes = Record<string, { meaning: string; confidence: number; category: string }>;

export interface ActionFilters {
  category?: string;
  actionName?: string;
  actor?: string;
  propertyId?: string;
  /** ISO timestamps, inclusive. */
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
}

export type ExportType = 'actions' | 'sales';
export type TimeSeriesInterval = 'hour' | 'day' | 'week';
export type PropertySort = 'sales' | 'price';

/* --- transport --------------------------------------------------------------- */

async function request<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw new RequestError(path, 'did not answer');
    }
    if (response.status === 409) {
      throw new ConflictError('conflict');
    }
    if (!response.ok) {
      throw new RequestError(path, `responded with ${response.status}`, response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new RequestError(path, 'answered with something that is not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** `?a=1&b=2` from the defined values only; '' when there are none. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/* --- data queries ---------------------------------------------------------- */

export const fetchUplandHealth = (): Promise<UplandHealth> => request('/api/upland/health');

export const fetchStatsOverview = (): Promise<UplandStatsOverview> =>
  request('/api/upland/stats/overview');

export const fetchActions = (filters: ActionFilters = {}): Promise<UplandActionList> =>
  request(
    `/api/upland/actions${query({
      category: filters.category,
      action_name: filters.actionName,
      actor: filters.actor,
      property_id: filters.propertyId,
      start: filters.start,
      end: filters.end,
      limit: filters.limit,
      offset: filters.offset,
    })}`,
  );

export const fetchRecentSales = (limit?: number): Promise<UplandAction[]> =>
  request(`/api/upland/actions/sales${query({ limit })}`);

export const fetchSalesVolume = (days = 90): Promise<SalesVolumeDay[]> =>
  request(`/api/upland/stats/sales_volume${query({ days })}`);

export const fetchActionDistribution = (): Promise<ActionDistributionEntry[]> =>
  request('/api/upland/stats/action_distribution');

export const fetchTopProperties = (
  limit = 50,
  sort: PropertySort = 'sales',
): Promise<UplandPropertyList> => request(`/api/upland/stats/top_properties${query({ limit, sort })}`);

export const fetchActiveAccounts = (limit = 50): Promise<ActiveAccount[]> =>
  request(`/api/upland/stats/active_accounts${query({ limit })}`);

export const fetchTimeSeries = (
  interval: TimeSeriesInterval = 'day',
  filter = 'trade',
): Promise<TimeSeriesPoint[]> =>
  request(`/api/upland/stats/time_series${query({ interval, filter })}`);

export const fetchPriceDistribution = (): Promise<PriceDistributionBucket[]> =>
  request('/api/upland/stats/price_distribution');

export const fetchProperties = (limit?: number, offset?: number): Promise<UplandPropertyList> =>
  request(`/api/upland/properties${query({ limit, offset })}`);

export const fetchProperty = (propertyId: string): Promise<UplandProperty> =>
  request(`/api/upland/properties/${encodeURIComponent(propertyId)}`);

export const fetchActionCodes = (): Promise<ActionCodes> => request('/api/upland/codes');

export const fetchChainInfo = (): Promise<ChainInfo> =>
  request('/api/upland/chain/info', undefined, CHAIN_TIMEOUT_MS);

export const fetchEstimate = (days = 90): Promise<UplandEstimate> =>
  request(`/api/upland/estimate${query({ days })}`, undefined, CHAIN_TIMEOUT_MS);

/** Direct browser download, like `exportUrl` in `./api` — a link, not a fetch. */
export const uplandExportUrl = (type: ExportType = 'actions'): string =>
  `${apiBase}/api/upland/export${query({ type })}`;

/* --- scraper and GCS control ---------------------------------------------------- */

/** Throws {@link ConflictError} when a scrape is already running. */
export const startScrape = (body: ScrapeRequest): Promise<ScrapeStatus> =>
  post('/api/upland/scrape', body);

export const fetchScrapeStatus = (): Promise<ScrapeStatus> => request('/api/upland/scrape/status');

export const cancelScrape = (): Promise<ScrapeStatus> => post('/api/upland/scrape/cancel');

export const syncGcs = (): Promise<GcsSyncResult> => post('/api/upland/gcs/sync');

export const fetchGcsStatus = (): Promise<GcsStatus> => request('/api/upland/gcs/status');
