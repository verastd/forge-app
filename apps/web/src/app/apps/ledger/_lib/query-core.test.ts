import { describe, expect, it } from 'vitest';
import { LedgerError, createLedgerClient } from '@forge/upland-ledger';

import { example } from './fixtures.test-helper';
import { HeavySlot, describeError, isAbort, queryKey, toLedgerError, viewState } from './query-core';
import type { QuerySnapshot } from './query-core';

const snap = <T>(over: Partial<QuerySnapshot<T>>): QuerySnapshot<T> => ({
  status: 'idle',
  data: undefined,
  error: undefined,
  fetching: false,
  updatedAt: undefined,
  ...over,
});

/** A client whose fetch answers from a table of status + body, like the BFF would. */
function clientAnswering(answer: (path: string) => { status: number; body: unknown }) {
  return createLedgerClient({
    fetch: async (input) => {
      const url = new URL(String(input), 'http://app.test');
      const { status, body } = answer(url.pathname.replace(/^\/bff\/ledger/, ''));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
}

describe('HeavySlot', () => {
  it('runs heavy reads one at a time, in order', async () => {
    const slot = new HeavySlot(1);
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = slot.run(async () => {
      log.push('first:start');
      await gate;
      log.push('first:end');
      return 1;
    });
    const second = slot.run(async () => {
      log.push('second:start');
      return 2;
    });

    await Promise.resolve();
    expect(slot.active).toBe(1);
    expect(slot.queued).toBe(1);
    expect(log).toEqual(['first:start']);

    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(log).toEqual(['first:start', 'first:end', 'second:start']);
    expect(slot.active).toBe(0);
  });

  it('drops a queued read whose signal aborts, without ever running it', async () => {
    const slot = new HeavySlot(1);
    let release!: () => void;
    const blocker = slot.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    let ran = false;
    const queued = slot.run(async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await expect(queued).rejects.toSatisfy(isAbort);
    expect(slot.queued).toBe(0);
    release();
    await blocker;
    expect(ran).toBe(false);
  });

  it('rejects at once when the signal is already aborted, and keeps going after a failure', async () => {
    const slot = new HeavySlot(1);
    const controller = new AbortController();
    controller.abort();
    await expect(slot.run(async () => 1, controller.signal)).rejects.toSatisfy(isAbort);
    await expect(slot.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(slot.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('describeError', () => {
  const err = (status: number, code: string, source: 'ledger' | 'gateway' | 'client' = 'gateway', message = '') =>
    new LedgerError(status, code, message, source, '/x');

  it.each([
    [err(401, 'unauthenticated'), 'unauthenticated', false],
    [err(404, 'not_found', 'ledger'), 'not-found', false],
    [err(404, 'ledger-disabled'), 'disabled', true],
    [err(404, 'not_found'), 'route-blocked', false],
    [err(400, 'validation_error', 'ledger', 'limit must be <= 1000'), 'invalid-input', false],
    [err(429, 'rate_limited', 'ledger'), 'busy', true],
    [err(502, 'service_unreachable'), 'down', true],
    [err(504, 'upstream_timeout'), 'slow', true],
    [err(0, 'timeout', 'client'), 'slow', true],
    [err(503, 'not_configured'), 'not-configured', true],
    [err(0, 'network_error', 'client'), 'offline', true],
    [err(200, 'schema_mismatch', 'client'), 'contract', true],
    [err(500, 'internal_error', 'ledger', 'kaboom'), 'other', true],
  ] as const)('%s → %s', (e, kind, retryable) => {
    const copy = describeError(e);
    expect(copy.kind).toBe(kind);
    expect(copy.retryable).toBe(retryable);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.detail.length).toBeGreaterThan(0);
  });

  it('carries the status and code for the small print, and the ledger message for bad input', () => {
    const copy = describeError(err(400, 'validation_error', 'ledger', 'limit must be <= 1000'));
    expect(copy.code).toBe('400 validation_error');
    expect(copy.detail).toBe('limit must be <= 1000');
    expect(describeError(err(0, 'network_error', 'client')).code).toBe('network_error');
  });

  it('wraps anything that is not a LedgerError', () => {
    expect(toLedgerError(new Error('nope')).message).toBe('nope');
    expect(toLedgerError('weird').code).toBe('unexpected');
    const original = err(502, 'service_unreachable');
    expect(toLedgerError(original)).toBe(original);
  });
});

describe('viewState', () => {
  it('walks loading → ready → refreshing → ready', () => {
    expect(viewState(snap({ status: 'loading', fetching: true }))).toBe('loading');
    expect(viewState(snap({ status: 'success', data: [1] }))).toBe('ready');
    expect(viewState(snap({ status: 'success', data: [1], fetching: true }))).toBe('refreshing');
    expect(viewState(snap({}))).toBe('idle');
  });

  it('knows empty lists, offset pages and custom emptiness', () => {
    expect(viewState(snap({ status: 'success', data: [] }))).toBe('empty');
    expect(viewState(snap({ status: 'success', data: { data: [], has_more: false } }))).toBe('empty');
    expect(viewState(snap({ status: 'success', data: { points: [] } }), (d) => d.points.length === 0)).toBe('empty');
    expect(viewState(snap({ status: 'success', data: { ok: true } }))).toBe('ready');
  });

  it('lets an error win over data still on screen, and routes 401 and 404 to their own states', () => {
    const e502 = new LedgerError(502, 'service_unreachable', '', 'gateway', '/x');
    expect(viewState(snap({ status: 'error', data: [1], error: e502 }))).toBe('error');
    expect(viewState(snap({ status: 'error', error: new LedgerError(401, 'unauthenticated', '', 'gateway', '/x') }))).toBe('unauthenticated');
    expect(viewState(snap({ status: 'error', error: new LedgerError(404, 'not_found', '', 'ledger', '/x') }))).toBe('not-found');
  });
});

describe('the client path the hooks run (captured responses through createLedgerClient)', () => {
  it('a 401 from the BFF reads as the sign-in state, never as data', async () => {
    const client = clientAnswering(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    const error = await client.status().catch((e: unknown) => toLedgerError(e));
    expect(error).toBeInstanceOf(LedgerError);
    expect(viewState(snap({ status: 'error', error: error as LedgerError }))).toBe('unauthenticated');
  });

  it('a captured ledger 404 reads as not found', async () => {
    const client = clientAnswering(() => ({ status: 404, body: example('ERROR_not_found') }));
    const error = toLedgerError(await client.properties.get('1').catch((e: unknown) => e));
    expect(describeError(error).kind).toBe('not-found');
  });

  it('a captured 200 validates and lands as ready data', async () => {
    const client = clientAnswering(() => ({ status: 200, body: example('GET_status') }));
    const status = await client.status();
    expect(viewState(snap({ status: 'success', data: status }))).toBe('ready');
    expect(status.ingestion.lagSeconds).toBe(1);
  });

  it('a body that drifted from the contract is an error, not partial data', async () => {
    const client = clientAnswering(() => ({ status: 200, body: { clickhouse: 'yes' } }));
    const error = toLedgerError(await client.status().catch((e: unknown) => e));
    expect(describeError(error).kind).toBe('contract');
  });
});

describe('queryKey', () => {
  it('is stable across param order and drops empty values', () => {
    expect(queryKey('/sales', { city: 'Rome', limit: 25 })).toBe(queryKey('/sales', { limit: 25, city: 'Rome', buyer: undefined, seller: '' }));
    expect(queryKey('/sales', {})).toBe('/sales');
    expect(queryKey('/sales')).toBe('/sales');
    expect(queryKey('/x', { at: new Date('2026-10-09T00:00:00Z') })).toContain('2026-10-09T00:00:00.000Z');
    expect(queryKey('/sales', { city: 'Rome' })).not.toBe(queryKey('/sales', { city: 'Miami' }));
  });
});
