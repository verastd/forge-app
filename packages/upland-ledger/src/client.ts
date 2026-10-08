/**
 * Framework-agnostic typed client for the Upland Ledger REST API, as the
 * browser sees it: same-origin `/bff/ledger/<path after /v1>`.
 *
 * Every method builds its query string from typed params, sends the request
 * with the session cookie (`credentials: 'same-origin'`), validates the 2xx
 * body with the zod schema for that operation, and throws a {@link LedgerError}
 * on anything else. It never returns substituted or partial data.
 */
import type { z } from 'zod';

import { LedgerError } from './errors.js';
import type * as P from './params.js';
import * as S from './schemas.js';

export interface LedgerClientOptions {
  /** Default `/bff/ledger`. No trailing slash needed. */
  baseUrl?: string;
  /** Default `globalThis.fetch`. Inject for tests or SSR. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30000; 0 disables it. */
  timeoutMs?: number;
  /** Default `same-origin` — the BFF authenticates with the session cookie. */
  credentials?: RequestCredentials;
}

/** Per-call options. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Options for the `pages()` iterators. */
export interface PageOptions extends RequestOptions {
  /** Stop after this many pages (default: until the last page). */
  maxPages?: number;
}

type QueryValue = string | number | boolean | Date | null | undefined;
type QueryParams = { [key: string]: QueryValue };

/** Paths whose `after`/`before` are days (`YYYY-MM-DD`), not instants. */
const DAY_PARAMS_PATHS = new Set(['/market/upx-usd', '/market/cities']);

function encodeValue(value: Exclude<QueryValue, null | undefined>, asDay: boolean): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('invalid Date passed as a query parameter');
    const iso = value.toISOString();
    return asDay ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number passed as a query parameter: ${value}`);
    return String(value);
  }
  return String(value);
}

/**
 * `{a: 1, b: undefined, c: 'x y', d: true}` → `?a=1&c=x+y&d=true`.
 * `undefined` / `null` / `''` are omitted (the entity routes coerce `''` to 0).
 * Keys keep insertion order, so a given params object always yields the same
 * URL (good for caching layers keyed on it).
 */
export function buildQuery(params: object | undefined, opts: { dayParams?: boolean } = {}): string {
  if (params === undefined) return '';
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(params as QueryParams)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const asDay = opts.dayParams === true && (key === 'after' || key === 'before');
    qs.append(key, encodeValue(raw, asDay));
  }
  const s = qs.toString();
  return s.length === 0 ? '' : `?${s}`;
}

const seg = (value: string | number): string => encodeURIComponent(String(value));

function defaultMessage(status: number): string {
  if (status === 401) return 'signed out';
  if (status === 404) return 'not found';
  if (status === 502) return 'the ledger is unavailable';
  if (status === 503) return 'the ledger gateway is not configured';
  if (status === 504) return 'the ledger timed out';
  return `HTTP ${status}`;
}

function errorFromBody(status: number, path: string, body: unknown): LedgerError {
  const ledger = S.LedgerErrorBodySchema.safeParse(body);
  if (ledger.success) {
    return new LedgerError(status, ledger.data.error.code, ledger.data.error.message, 'ledger', path, body);
  }
  const gateway = S.GatewayErrorBodySchema.safeParse(body);
  if (gateway.success) {
    return new LedgerError(status, gateway.data.error, defaultMessage(status), 'gateway', path, body);
  }
  return new LedgerError(status, `http_${status}`, defaultMessage(status), 'gateway', path, body);
}

/** One page of a keyset-paginated list. */
export interface CursorPageLike<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Async iterator over the pages of a cursor endpoint. Stops when
 * `next_cursor` is null or after `maxPages`. Errors propagate on the page that
 * failed; pages already yielded stay valid.
 *
 * ```ts
 * for await (const page of paginate((p) => client.actions.list(p), { contract: 'playuplandme', limit: 500 })) {
 *   rows.push(...page.data);
 * }
 * ```
 */
export async function* paginate<Params extends { cursor?: string }, Page extends CursorPageLike<unknown>>(
  fetchPage: (params: Params) => Promise<Page>,
  params: NoInfer<Params>,
  opts: { maxPages?: number } = {},
): AsyncGenerator<Page, void, undefined> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  let cursor = params.cursor;
  for (let n = 0; n < maxPages; n++) {
    const page = await fetchPage({ ...params, ...(cursor === undefined ? {} : { cursor }) });
    yield page;
    if (page.next_cursor === null || page.next_cursor === cursor) return;
    cursor = page.next_cursor;
  }
}

/** One page of an offset-paginated (entity) list. */
export interface OffsetPageLike<T> {
  data: T[];
  limit: number;
  offset: number;
  has_more: boolean;
}

/**
 * Async iterator over an offset-paginated entity list (`/properties`, `/sales`,
 * …). Stops when `has_more` is false, a page is empty, or after `maxPages`.
 * Offset pages are not snapshot-stable: rows inserted while paging shift later
 * pages. Prefer filters (`after`/`before`) over deep paging.
 */
export async function* paginateOffset<
  Params extends { offset?: number; limit?: number },
  Page extends OffsetPageLike<unknown>,
>(
  fetchPage: (params: Params) => Promise<Page>,
  params: NoInfer<Params>,
  opts: { maxPages?: number } = {},
): AsyncGenerator<Page, void, undefined> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = params.offset ?? 0;
  for (let n = 0; n < maxPages; n++) {
    const page = await fetchPage({ ...params, offset });
    yield page;
    if (!page.has_more || page.data.length === 0) return;
    offset += page.data.length;
  }
}

export function createLedgerClient(options: LedgerClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '/bff/ledger').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const credentials = options.credentials ?? 'same-origin';
  const doFetch: typeof fetch | undefined = options.fetch ?? globalThis.fetch?.bind(globalThis);

  async function request<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST',
    path: string,
    query: string,
    schema: T,
    opts: RequestOptions | undefined,
    body?: unknown,
  ): Promise<z.infer<T>> {
    if (doFetch === undefined) {
      throw new LedgerError(0, 'network_error', 'no fetch implementation available', 'client', path);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const outer = opts?.signal;
    const onAbort = () => controller.abort();
    if (outer !== undefined) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }

    let res: Response;
    let text: string;
    try {
      if (controller.signal.aborted) throw new DOMException('aborted before sending', 'AbortError');
      const init: RequestInit = {
        method,
        credentials,
        signal: controller.signal,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      res = await doFetch(`${baseUrl}${path}${query}`, init);
      text = await res.text();
    } catch (err) {
      if (timedOut) throw new LedgerError(0, 'timeout', `request timed out after ${timeoutMs} ms`, 'client', path);
      if (controller.signal.aborted) throw new LedgerError(0, 'aborted', 'request was aborted', 'client', path);
      const message = err instanceof Error ? err.message : String(err);
      throw new LedgerError(0, 'network_error', message, 'client', path, err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (!res.ok) {
      throw errorFromBody(res.status, path, parseFailed ? text.slice(0, 500) : parsed);
    }
    if (parseFailed || parsed === undefined) {
      throw new LedgerError(res.status, 'invalid_response', 'response body is not JSON', 'client', path, text.slice(0, 500));
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues;
      const first = issues[0];
      const where = first === undefined ? '' : `${first.path.join('.') || '(root)'}: ${first.message}`;
      throw new LedgerError(
        res.status,
        'schema_mismatch',
        `response did not match the contract (${issues.length} issue${issues.length === 1 ? '' : 's'}; ${where})`,
        'client',
        path,
        issues,
      );
    }
    return result.data as z.infer<T>;
  }

  const get = <T extends z.ZodTypeAny>(path: string, schema: T, params?: object, opts?: RequestOptions) =>
    request('GET', path, buildQuery(params, { dayParams: DAY_PARAMS_PATHS.has(path) }), schema, opts);

  // The four keyset-paginated lists, defined once so `pages()` can reuse them.
  const listActions = (params?: P.ActionListParams, opts?: RequestOptions) =>
    get('/actions', S.ActionPageSchema, params, opts);
  const listContractActions = (contract: string, params?: Omit<P.ActionListParams, 'contract'>, opts?: RequestOptions) =>
    get(`/contracts/${seg(contract)}/actions`, S.ActionPageSchema, params, opts);
  const listTransfers = (params?: P.TransfersParams, opts?: RequestOptions) =>
    get('/transfers', S.TransferPageSchema, params, opts);
  const listAccountActions = (account: string, params?: P.AccountActionsParams, opts?: RequestOptions) =>
    get(`/accounts/${seg(account)}/actions`, S.AccountActionPageSchema, params, opts);

  return {
    /** Base URL every request is relative to. */
    baseUrl,

    // --------------------------------------------------------- system
    /** `GET /status` — ingestion freshness and backfill state. */
    status: (params?: P.ChainParam, opts?: RequestOptions) => get('/status', S.StatusSchema, params, opts),
    /** `GET /chains` — configured chains, default first. */
    chains: (params?: P.ChainParam, opts?: RequestOptions) => get('/chains', S.ChainListSchema, params, opts),

    // ------------------------------------------------------ raw chain
    actions: {
      /** `GET /actions` — cursor-paginated raw actions. */
      list: listActions,
      /** Async iterator over every page of `/actions` (follows `next_cursor`). */
      pages: (params: P.ActionListParams = {}, opts: PageOptions = {}) =>
        paginate((p: P.ActionListParams) => listActions(p, opts), params, opts),
      /** `GET /actions/{globalSequence}` */
      get: (globalSequence: string | number, params?: P.LookupParams, opts?: RequestOptions) =>
        get(`/actions/${seg(globalSequence)}`, S.ActionSchema, params, opts),
    },
    transactions: {
      /** `GET /transactions/{trxId}` — every stored action of one transaction. */
      get: (trxId: string, params?: P.LookupParams, opts?: RequestOptions) =>
        get(`/transactions/${seg(trxId)}`, S.TransactionSchema, params, opts),
    },
    contracts: {
      /** `GET /contracts` */
      list: (params?: P.ContractsParams, opts?: RequestOptions) =>
        get('/contracts', S.ContractListSchema, params, opts),
      /** `GET /contracts/{contract}/actions` */
      actions: listContractActions,
      /** Async iterator over every page of `/contracts/{contract}/actions`. */
      actionPages: (contract: string, params: Omit<P.ActionListParams, 'contract'> = {}, opts: PageOptions = {}) =>
        paginate((p: Omit<P.ActionListParams, 'contract'>) => listContractActions(contract, p, opts), params, opts),
    },
    transfers: {
      /** `GET /transfers` — cursor-paginated token transfers. */
      list: listTransfers,
      /** Async iterator over every page of `/transfers`. */
      pages: (params: P.TransfersParams = {}, opts: PageOptions = {}) =>
        paginate((p: P.TransfersParams) => listTransfers(p, opts), params, opts),
    },
    stats: {
      /** `GET /stats/actions` — per (contract, action) counts. */
      actions: (params?: P.StatsActionsParams, opts?: RequestOptions) =>
        get('/stats/actions', S.ActionStatListSchema, params, opts),
    },

    // ------------------------------------------------------- accounts
    accounts: {
      /** `GET /accounts` — derived account dimension, offset-paginated. */
      list: (params?: P.AccountListParams, opts?: RequestOptions) =>
        get('/accounts', S.AccountPageSchema, params, opts),
      /** `GET /accounts/{account}` — profile + income. */
      get: (account: string, params?: P.ChainParam, opts?: RequestOptions) =>
        get(`/accounts/${seg(account)}`, S.AccountDetailSchema, params, opts),
      /** `GET /accounts/{account}/actions` — raw actions involving the account. */
      actions: listAccountActions,
      /** Async iterator over every page of `/accounts/{account}/actions`. */
      actionPages: (account: string, params: P.AccountActionsParams = {}, opts: PageOptions = {}) =>
        paginate((p: P.AccountActionsParams) => listAccountActions(account, p, opts), params, opts),
    },

    // ------------------------------------------------------ analytics
    analytics: {
      overview: (params?: P.ChainParam, opts?: RequestOptions) =>
        get('/analytics/overview', S.OverviewSchema, params, opts),
      timeseries: (params?: P.TimeseriesParams, opts?: RequestOptions) =>
        get('/analytics/timeseries', S.AnalyticsResultSchema, params, opts),
      keys: (params?: P.KeysParams, opts?: RequestOptions) =>
        get('/analytics/keys', S.DataKeyListSchema, params, opts),
      flows: (params?: P.FlowsParams, opts?: RequestOptions) => get('/analytics/flows', S.FlowsSchema, params, opts),
      topAccounts: (params?: P.TopAccountsParams, opts?: RequestOptions) =>
        get('/analytics/accounts/top', S.TopAccountListSchema, params, opts),
      calendar: (params?: P.CalendarParams, opts?: RequestOptions) =>
        get('/analytics/calendar', S.CalendarSchema, params, opts),
      sales: (params?: P.SalesAnalyticsParams, opts?: RequestOptions) =>
        get('/analytics/sales', S.SalesAnalyticsSchema, params, opts),
      /** `POST /analytics/query` — the general aggregation endpoint. */
      query: (spec: P.QuerySpec, opts?: RequestOptions) =>
        request('POST', '/analytics/query', '', S.QueryResultSchema, opts, spec),
    },
    ingest: {
      /** `GET /ingest/windows` — backfill window ledger. */
      windows: (params?: P.IngestWindowsParams, opts?: RequestOptions) =>
        get('/ingest/windows', S.IngestWindowListSchema, params, opts),
    },

    // --------------------------------------------------------- market
    market: {
      /** `GET /market/upx-usd` — implied UPX/USD rate series per method. */
      upxUsd: (params?: P.UpxUsdParams, opts?: RequestOptions) =>
        get('/market/upx-usd', S.UpxUsdSchema, params, opts),
      /** `GET /market/cities` — per-city daily market state. */
      cities: (params?: P.CitiesParams, opts?: RequestOptions) =>
        get('/market/cities', S.CityDayListSchema, params, opts),
      /** `GET /market/fiat` — FIAT asks and what cleared. */
      fiat: (params?: P.FiatParams, opts?: RequestOptions) => get('/market/fiat', S.FiatSchema, params, opts),
    },
    signals: {
      /** `GET /signals` — opportunity feed, ranked by score. */
      list: (params?: P.SignalsParams, opts?: RequestOptions) => get('/signals', S.SignalListSchema, params, opts),
    },

    // ------------------------------------------------------- entities
    properties: {
      list: (params?: P.PropertyListParams, opts?: RequestOptions) =>
        get('/properties', S.PropertyPageSchema, params, opts),
      get: (propertyId: string, params?: P.ChainParam, opts?: RequestOptions) =>
        get(`/properties/${seg(propertyId)}`, S.PropertyDetailSchema, params, opts),
      history: (propertyId: string, params?: P.PropertyHistoryParams, opts?: RequestOptions) =>
        get(`/properties/${seg(propertyId)}/history`, S.PropertyHistorySchema, params, opts),
    },
    listings: {
      list: (params?: P.ListingParams, opts?: RequestOptions) => get('/listings', S.ListingPageSchema, params, opts),
    },
    sales: {
      list: (params?: P.SaleParams, opts?: RequestOptions) => get('/sales', S.SalePageSchema, params, opts),
    },
    offers: {
      list: (params?: P.OfferParams, opts?: RequestOptions) => get('/offers', S.OfferPageSchema, params, opts),
    },
    neighborhoods: {
      list: (params?: P.NeighborhoodParams, opts?: RequestOptions) =>
        get('/neighborhoods', S.NeighborhoodPageSchema, params, opts),
    },
    collections: {
      list: (params?: P.CollectionParams, opts?: RequestOptions) =>
        get('/collections', S.CollectionPageSchema, params, opts),
    },
    treasures: {
      list: (params?: P.TreasureParams, opts?: RequestOptions) =>
        get('/treasures', S.TreasurePageSchema, params, opts),
    },
    rates: {
      list: (params?: P.RateParams, opts?: RequestOptions) => get('/rates', S.RatePageSchema, params, opts),
    },
    /** `GET /search` — one box over properties, accounts, neighborhoods, collections, cities. */
    search: (params: P.SearchParams, opts?: RequestOptions) => get('/search', S.SearchResultSchema, params, opts),
  };
}

export type LedgerClient = ReturnType<typeof createLedgerClient>;
