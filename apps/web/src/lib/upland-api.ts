'use client';

/**
 * Typed client for `/api/upland/*` (the Upland data app, gated by the `upland_data` flag).
 *
 * Same fetch style as `./api`: one timeout, `cache: 'no-store'`, and a failure is
 * a thrown {@link RequestError} — never substituted data. These endpoints have no
 * demo fixtures; a page that cannot reach them says so.
 *
 * Every response is validated against the `@forge/shared` zod schemas (the wire
 * contract, mirrored field-for-field by `apps/api/src/forge_api/models.py`). A
 * payload the contract rejects is a {@link RequestError}, same as no answer.
 */

import {
  ActionCodesSchema,
  ActionDistributionEntrySchema,
  ActiveAccountSchema,
  ChainInfoSchema,
  GcsStatusSchema,
  GcsSyncResultSchema,
  PriceDistributionBucketSchema,
  SalesVolumeDaySchema,
  ScrapeStatusSchema,
  TimeSeriesPointSchema,
  UplandActionListSchema,
  UplandActionSchema,
  UplandEstimateSchema,
  UplandHealthSchema,
  UplandPropertyListSchema,
  UplandPropertySchema,
  UplandStatsOverviewSchema,
} from '@forge/shared';
import type {
  ActionCodes,
  ActionDistributionEntry,
  ActiveAccount,
  ChainInfo,
  GcsStatus,
  GcsSyncResult,
  PriceDistributionBucket,
  SalesVolumeDay,
  ScrapeRequest,
  ScrapeStatus,
  TimeSeriesPoint,
  UplandAction,
  UplandActionList,
  UplandEstimate,
  UplandExportType,
  UplandHealth,
  UplandInterval,
  UplandProperty,
  UplandPropertyList,
  UplandPropertySort,
  UplandStatsOverview,
} from '@forge/shared';

import { ConflictError, RequestError, apiBase } from './api';

export type {
  ActionCodes,
  ActionDistributionEntry,
  ActiveAccount,
  ChainInfo,
  GcsStatus,
  GcsSyncResult,
  PriceDistributionBucket,
  SalesVolumeDay,
  ScrapeRequest,
  ScrapeStatus,
  TimeSeriesPoint,
  UplandAction,
  UplandActionList,
  UplandEstimate,
  UplandHealth,
  UplandProperty,
  UplandPropertyList,
  UplandStatsOverview,
};

export type ExportType = UplandExportType;
export type TimeSeriesInterval = UplandInterval;
export type PropertySort = UplandPropertySort;

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

const TIMEOUT_MS = 8000;
/** Chain lookups go to Hyperion behind the API; give them longer. */
const CHAIN_TIMEOUT_MS = 20000;

/* --- transport --------------------------------------------------------------- */

/** Structural stand-in for a zod schema — `zod` is @forge/shared's dependency, not ours. */
interface Parser<T> {
  parse(input: unknown): T;
}

/** List endpoints return bare JSON arrays; zod's `z.array` stays in @forge/shared. */
function arrayOf<T>(item: Parser<T>): Parser<T[]> {
  return {
    parse(input: unknown): T[] {
      if (!Array.isArray(input)) {
        throw new Error('expected a JSON array');
      }
      return input.map((row) => item.parse(row));
    },
  };
}

async function request<T>(
  path: string,
  parser: Parser<T>,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
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
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new RequestError(path, 'answered with something that is not JSON');
    }
    try {
      return parser.parse(payload);
    } catch {
      throw new RequestError(path, 'answered with a payload the contract rejects');
    }
  } finally {
    clearTimeout(timer);
  }
}

function post<T>(path: string, parser: Parser<T>, body?: unknown): Promise<T> {
  return request(path, parser, {
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

export const fetchUplandHealth = (): Promise<UplandHealth> =>
  request('/api/upland/health', UplandHealthSchema);

export const fetchStatsOverview = (): Promise<UplandStatsOverview> =>
  request('/api/upland/stats/overview', UplandStatsOverviewSchema);

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
    UplandActionListSchema,
  );

export const fetchRecentSales = (limit?: number): Promise<UplandAction[]> =>
  request(`/api/upland/actions/sales${query({ limit })}`, arrayOf(UplandActionSchema));

export const fetchSalesVolume = (days = 90): Promise<SalesVolumeDay[]> =>
  request(`/api/upland/stats/sales_volume${query({ days })}`, arrayOf(SalesVolumeDaySchema));

export const fetchActionDistribution = (): Promise<ActionDistributionEntry[]> =>
  request('/api/upland/stats/action_distribution', arrayOf(ActionDistributionEntrySchema));

export const fetchTopProperties = (
  limit = 50,
  sort: PropertySort = 'sales',
): Promise<UplandPropertyList> =>
  request(`/api/upland/stats/top_properties${query({ limit, sort })}`, UplandPropertyListSchema);

export const fetchActiveAccounts = (limit = 50): Promise<ActiveAccount[]> =>
  request(`/api/upland/stats/active_accounts${query({ limit })}`, arrayOf(ActiveAccountSchema));

export const fetchTimeSeries = (
  interval: TimeSeriesInterval = 'day',
  filter = 'trade',
): Promise<TimeSeriesPoint[]> =>
  request(
    `/api/upland/stats/time_series${query({ interval, filter })}`,
    arrayOf(TimeSeriesPointSchema),
  );

export const fetchPriceDistribution = (): Promise<PriceDistributionBucket[]> =>
  request('/api/upland/stats/price_distribution', arrayOf(PriceDistributionBucketSchema));

export const fetchProperties = (limit?: number, offset?: number): Promise<UplandPropertyList> =>
  request(`/api/upland/properties${query({ limit, offset })}`, UplandPropertyListSchema);

export const fetchProperty = (propertyId: string): Promise<UplandProperty> =>
  request(`/api/upland/properties/${encodeURIComponent(propertyId)}`, UplandPropertySchema);

export const fetchActionCodes = (): Promise<ActionCodes> =>
  request('/api/upland/codes', ActionCodesSchema);

export const fetchChainInfo = (): Promise<ChainInfo> =>
  request('/api/upland/chain/info', ChainInfoSchema, undefined, CHAIN_TIMEOUT_MS);

export const fetchEstimate = (days = 90): Promise<UplandEstimate> =>
  request(`/api/upland/estimate${query({ days })}`, UplandEstimateSchema, undefined, CHAIN_TIMEOUT_MS);

/** Direct browser download, like `exportUrl` in `./api` — a link, not a fetch. */
export const uplandExportUrl = (type: ExportType = 'actions'): string =>
  `${apiBase}/api/upland/export${query({ type })}`;

/* --- scraper and GCS control ---------------------------------------------------- */

/** Throws {@link ConflictError} when a scrape is already running. */
export const startScrape = (body: ScrapeRequest): Promise<ScrapeStatus> =>
  post('/api/upland/scrape', ScrapeStatusSchema, body);

export const fetchScrapeStatus = (): Promise<ScrapeStatus> =>
  request('/api/upland/scrape/status', ScrapeStatusSchema);

export const cancelScrape = (): Promise<ScrapeStatus> =>
  post('/api/upland/scrape/cancel', ScrapeStatusSchema);

export const syncGcs = (): Promise<GcsSyncResult> =>
  post('/api/upland/gcs/sync', GcsSyncResultSchema);

export const fetchGcsStatus = (): Promise<GcsStatus> =>
  request('/api/upland/gcs/status', GcsStatusSchema);
