/**
 * The contract, end to end: every operation in openapi.yaml has a client
 * method, a captured example, and a zod schema that accepts that example
 * without dropping a single field.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createLedgerClient, type LedgerClient } from './client.js';
import * as S from './schemas.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'examples');
const readExample = (file: string): unknown => JSON.parse(readFileSync(join(EXAMPLES, file), 'utf8'));

interface Operation {
  method: 'GET' | 'POST';
  /** OpenAPI path template. */
  path: string;
  example: string;
  schema: z.ZodTypeAny;
  /** Calls the client; the mock fetch answers with the example. */
  call: (c: LedgerClient) => Promise<unknown>;
  /** The URL path the call must hit (relative to the base URL). */
  hits: string;
}

const PID = '78641749916331';
const ACCT = 'smfvx4j4dqsb';
const TRX = '97cbf835eb8eef2e043f05758c54cbdf91fe4a7a4e65173ab068dfc3927eef70';

const OPERATIONS: Operation[] = [
  { method: 'GET', path: '/status', example: 'GET_status.json', schema: S.StatusSchema, call: (c) => c.status(), hits: '/status' },
  { method: 'GET', path: '/chains', example: 'GET_chains.json', schema: S.ChainListSchema, call: (c) => c.chains(), hits: '/chains' },
  { method: 'GET', path: '/actions', example: 'GET_actions.json', schema: S.ActionPageSchema, call: (c) => c.actions.list(), hits: '/actions' },
  {
    method: 'GET',
    path: '/actions/{globalSequence}',
    example: 'GET_actions_{globalSequence}.json',
    schema: S.ActionSchema,
    call: (c) => c.actions.get(350804370),
    hits: '/actions/350804370',
  },
  {
    method: 'GET',
    path: '/transactions/{trxId}',
    example: 'GET_transactions_{trxId}.json',
    schema: S.TransactionSchema,
    call: (c) => c.transactions.get(TRX),
    hits: `/transactions/${TRX}`,
  },
  { method: 'GET', path: '/contracts', example: 'GET_contracts.json', schema: S.ContractListSchema, call: (c) => c.contracts.list(), hits: '/contracts' },
  {
    method: 'GET',
    path: '/contracts/{contract}/actions',
    example: 'GET_contracts_{contract}_actions.json',
    schema: S.ActionPageSchema,
    call: (c) => c.contracts.actions('upxtokenacct'),
    hits: '/contracts/upxtokenacct/actions',
  },
  { method: 'GET', path: '/transfers', example: 'GET_transfers.json', schema: S.TransferPageSchema, call: (c) => c.transfers.list(), hits: '/transfers' },
  { method: 'GET', path: '/stats/actions', example: 'GET_stats_actions.json', schema: S.ActionStatListSchema, call: (c) => c.stats.actions(), hits: '/stats/actions' },
  {
    method: 'GET',
    path: '/accounts/{account}/actions',
    example: 'GET_accounts_{account}_actions.json',
    schema: S.AccountActionPageSchema,
    call: (c) => c.accounts.actions(ACCT),
    hits: `/accounts/${ACCT}/actions`,
  },
  { method: 'GET', path: '/analytics/overview', example: 'GET_analytics_overview.json', schema: S.OverviewSchema, call: (c) => c.analytics.overview(), hits: '/analytics/overview' },
  { method: 'GET', path: '/analytics/timeseries', example: 'GET_analytics_timeseries.json', schema: S.AnalyticsResultSchema, call: (c) => c.analytics.timeseries(), hits: '/analytics/timeseries' },
  { method: 'GET', path: '/analytics/keys', example: 'GET_analytics_keys.json', schema: S.DataKeyListSchema, call: (c) => c.analytics.keys(), hits: '/analytics/keys' },
  { method: 'GET', path: '/analytics/flows', example: 'GET_analytics_flows.json', schema: S.FlowsSchema, call: (c) => c.analytics.flows(), hits: '/analytics/flows' },
  {
    method: 'GET',
    path: '/analytics/accounts/top',
    example: 'GET_analytics_accounts_top.json',
    schema: S.TopAccountListSchema,
    call: (c) => c.analytics.topAccounts(),
    hits: '/analytics/accounts/top',
  },
  { method: 'GET', path: '/analytics/calendar', example: 'GET_analytics_calendar.json', schema: S.CalendarSchema, call: (c) => c.analytics.calendar(), hits: '/analytics/calendar' },
  { method: 'GET', path: '/analytics/sales', example: 'GET_analytics_sales.json', schema: S.SalesAnalyticsSchema, call: (c) => c.analytics.sales(), hits: '/analytics/sales' },
  {
    method: 'POST',
    path: '/analytics/query',
    example: 'POST_analytics_query.json',
    schema: S.QueryResultSchema,
    call: (c) => c.analytics.query({ source: 'actions', range: { after: '2026-10-01', before: '2026-10-02' }, measures: [{ fn: 'count' }] }),
    hits: '/analytics/query',
  },
  { method: 'GET', path: '/ingest/windows', example: 'GET_ingest_windows.json', schema: S.IngestWindowListSchema, call: (c) => c.ingest.windows(), hits: '/ingest/windows' },
  { method: 'GET', path: '/market/upx-usd', example: 'GET_market_upx-usd.json', schema: S.UpxUsdSchema, call: (c) => c.market.upxUsd(), hits: '/market/upx-usd' },
  { method: 'GET', path: '/market/cities', example: 'GET_market_cities.json', schema: S.CityDayListSchema, call: (c) => c.market.cities(), hits: '/market/cities' },
  { method: 'GET', path: '/market/fiat', example: 'GET_market_fiat.json', schema: S.FiatSchema, call: (c) => c.market.fiat(), hits: '/market/fiat' },
  { method: 'GET', path: '/signals', example: 'GET_signals.json', schema: S.SignalListSchema, call: (c) => c.signals.list(), hits: '/signals' },
  { method: 'GET', path: '/properties', example: 'GET_properties.json', schema: S.PropertyPageSchema, call: (c) => c.properties.list(), hits: '/properties' },
  {
    method: 'GET',
    path: '/properties/{propertyId}',
    example: 'GET_properties_{propertyId}.json',
    schema: S.PropertyDetailSchema,
    call: (c) => c.properties.get(PID),
    hits: `/properties/${PID}`,
  },
  {
    method: 'GET',
    path: '/properties/{propertyId}/history',
    example: 'GET_properties_{propertyId}_history.json',
    schema: S.PropertyHistorySchema,
    call: (c) => c.properties.history(PID),
    hits: `/properties/${PID}/history`,
  },
  { method: 'GET', path: '/accounts', example: 'GET_accounts.json', schema: S.AccountPageSchema, call: (c) => c.accounts.list(), hits: '/accounts' },
  {
    method: 'GET',
    path: '/accounts/{account}',
    example: 'GET_accounts_{account}.json',
    schema: S.AccountDetailSchema,
    call: (c) => c.accounts.get(ACCT),
    hits: `/accounts/${ACCT}`,
  },
  { method: 'GET', path: '/listings', example: 'GET_listings.json', schema: S.ListingPageSchema, call: (c) => c.listings.list(), hits: '/listings' },
  { method: 'GET', path: '/sales', example: 'GET_sales.json', schema: S.SalePageSchema, call: (c) => c.sales.list(), hits: '/sales' },
  { method: 'GET', path: '/offers', example: 'GET_offers.json', schema: S.OfferPageSchema, call: (c) => c.offers.list(), hits: '/offers' },
  { method: 'GET', path: '/neighborhoods', example: 'GET_neighborhoods.json', schema: S.NeighborhoodPageSchema, call: (c) => c.neighborhoods.list(), hits: '/neighborhoods' },
  { method: 'GET', path: '/collections', example: 'GET_collections.json', schema: S.CollectionPageSchema, call: (c) => c.collections.list(), hits: '/collections' },
  { method: 'GET', path: '/treasures', example: 'GET_treasures.json', schema: S.TreasurePageSchema, call: (c) => c.treasures.list(), hits: '/treasures' },
  { method: 'GET', path: '/rates', example: 'GET_rates.json', schema: S.RatePageSchema, call: (c) => c.rates.list(), hits: '/rates' },
  { method: 'GET', path: '/search', example: 'GET_search.json', schema: S.SearchResultSchema, call: (c) => c.search({ q: 'main' }), hits: '/search' },
];

/** `METHOD path` → x-example, read from openapi.yaml without a YAML dependency. */
function specOperations(): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  let path: string | undefined;
  let current: string | undefined;
  for (const line of readFileSync(join(ROOT, 'openapi.yaml'), 'utf8').split('\n')) {
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) {
      path = p[1];
      continue;
    }
    if (/^\S/.test(line)) path = undefined;
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m && path !== undefined) {
      current = `${(m[1] ?? '').toUpperCase()} ${path}`;
      out.set(current, undefined);
      continue;
    }
    const x = /^ {6}x-example:\s*(\S+)\s*$/.exec(line);
    if (x && current !== undefined) out.set(current, x[1]);
  }
  return out;
}

describe('openapi.yaml', () => {
  const spec = specOperations();

  it('documents exactly the operations the client implements (36, no /health or /metrics)', () => {
    const fromClient = OPERATIONS.map((o) => `${o.method} ${o.path}`).sort();
    expect([...spec.keys()].sort()).toEqual(fromClient);
    expect(spec.size).toBe(36);
    expect([...spec.keys()].some((k) => k.endsWith('/health') || k.endsWith('/metrics'))).toBe(false);
  });

  it('points every operation at its captured example', () => {
    for (const op of OPERATIONS) {
      expect(spec.get(`${op.method} ${op.path}`), op.path).toBe(`examples/${op.example}`);
    }
  });
});

describe('captured examples', () => {
  it('has one example per operation plus the error samples, and nothing else', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).sort();
    const expected = [...OPERATIONS.map((o) => o.example), 'ERROR_not_found.json', 'ERROR_validation_error.json'].sort();
    expect(files).toEqual(expected);
  });

  for (const op of OPERATIONS) {
    it(`${op.method} ${op.path} matches its schema field-for-field`, () => {
      const example = readExample(op.example);
      const result = op.schema.safeParse(example);
      if (!result.success) throw new Error(JSON.stringify(result.error.issues.slice(0, 3), null, 2));
      // Unknown keys are stripped on parse, so equality proves no wire field is unmodelled.
      expect(result.data).toEqual(example);
    });
  }

  it('error samples are ledger error bodies', () => {
    for (const f of ['ERROR_validation_error.json', 'ERROR_not_found.json']) {
      const body = readExample(f);
      expect(S.LedgerErrorBodySchema.parse(body)).toEqual(body);
    }
    expect(S.LEDGER_ERROR_CODES).toContain((readExample('ERROR_validation_error.json') as S.LedgerErrorBody).error.code);
  });
});

describe('client methods', () => {
  for (const op of OPERATIONS) {
    it(`${op.method} ${op.path} hits ${op.hits} and returns the validated example`, async () => {
      const example = readExample(op.example);
      const seen: Array<{ url: string; method: string | undefined }> = [];
      const client = createLedgerClient({
        fetch: async (input, init) => {
          seen.push({ url: String(input), method: init?.method });
          return new Response(JSON.stringify(example), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      await expect(op.call(client)).resolves.toEqual(example);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe(op.method);
      expect(seen[0]?.url.split('?')[0]).toBe(`/bff/ledger${op.hits}`);
    });
  }
});
