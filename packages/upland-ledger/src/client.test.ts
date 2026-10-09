import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildQuery, createLedgerClient, paginate, paginateOffset } from './client.js';
import { LedgerError, isLedgerError } from './errors.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stub answering each call with the next queued response. */
function stubFetch(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    return typeof next === 'function' ? next() : next;
  };
  return { fetch: fn as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const emptyActionPage = { data: [], next_cursor: null, count: 0 };

async function caught(p: Promise<unknown>): Promise<LedgerError> {
  try {
    await p;
  } catch (err) {
    if (isLedgerError(err)) return err;
    throw err;
  }
  throw new Error('expected a LedgerError');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildQuery', () => {
  it('omits undefined, null and empty values and keeps insertion order', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', e: 'x y', f: true, g: false })).toBe('?a=1&e=x+y&f=true&g=false');
  });

  it('returns an empty string when nothing is left', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });

  it('encodes a Date as an ISO instant, or as a UTC day for day params', () => {
    const d = new Date('2026-10-08T17:12:35.000Z');
    expect(buildQuery({ after: d })).toBe('?after=2026-10-08T17%3A12%3A35.000Z');
    expect(buildQuery({ after: d, before: d, other: d }, { dayParams: true })).toBe(
      '?after=2026-10-08&before=2026-10-08&other=2026-10-08T17%3A12%3A35.000Z',
    );
  });

  it('escapes reserved characters', () => {
    expect(buildQuery({ q: 'a&b=c', cursor: 'eyJ0Ijo+/=' })).toBe('?q=a%26b%3Dc&cursor=eyJ0Ijo%2B%2F%3D');
  });

  it('rejects invalid dates and non-finite numbers instead of sending garbage', () => {
    expect(() => buildQuery({ after: new Date('nope') })).toThrow(TypeError);
    expect(() => buildQuery({ limit: Number.NaN })).toThrow(TypeError);
    expect(() => buildQuery({ limit: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});

describe('request building', () => {
  it('defaults to same-origin /bff/ledger with the session cookie', async () => {
    const { fetch, calls } = stubFetch(json(emptyActionPage));
    await createLedgerClient({ fetch }).actions.list({ contract: 'playuplandme', limit: 3, include_raw: false });
    expect(calls[0]?.url).toBe('/bff/ledger/actions?contract=playuplandme&limit=3&include_raw=false');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('honours a custom base URL (trailing slashes trimmed) and credentials', async () => {
    const { fetch, calls } = stubFetch(json(emptyActionPage));
    const client = createLedgerClient({ fetch, baseUrl: 'https://app.example/bff/ledger//', credentials: 'include' });
    expect(client.baseUrl).toBe('https://app.example/bff/ledger');
    await client.transfers.list({ symbol: 'UPX' });
    expect(calls[0]?.url).toBe('https://app.example/bff/ledger/transfers?symbol=UPX');
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('encodes path segments', async () => {
    const { fetch, calls } = stubFetch(json({ error: { code: 'not_found', message: 'x' } }, 404));
    await caught(createLedgerClient({ fetch }).accounts.get('a/b?c'));
    expect(calls[0]?.url).toBe('/bff/ledger/accounts/a%2Fb%3Fc');
  });

  it('sends day params as YYYY-MM-DD on the market routes only', async () => {
    const d = new Date('2026-10-05T12:00:00Z');
    const { fetch, calls } = stubFetch(json([]), json({ data: [], count: 0, limit: 1, offset: 0, has_more: false }));
    const client = createLedgerClient({ fetch });
    await client.market.cities({ after: d, city: 'Rome' });
    await client.rates.list({ after: d });
    expect(calls[0]?.url).toBe('/bff/ledger/market/cities?after=2026-10-05&city=Rome');
    expect(calls[1]?.url).toBe('/bff/ledger/rates?after=2026-10-05T12%3A00%3A00.000Z');
  });

  it('POSTs the query spec as JSON', async () => {
    const result = {
      columns: [{ name: 'actions', type: 'number' }],
      rows: [[5]],
      stats: { rows: 1, elapsed_ms: 1, rows_read: 1, bytes_read: 1, truncated: false, table: 'actions_hourly', dedup: 'exact' },
      sql: 'SELECT 1',
      chain: 'upland',
    };
    const { fetch, calls } = stubFetch(json(result));
    const spec = {
      source: 'actions' as const,
      range: { after: '2026-10-01T00:00:00Z', before: '2026-10-02T00:00:00Z' },
      measures: [{ fn: 'count' as const, alias: 'actions' }],
    };
    await expect(createLedgerClient({ fetch }).analytics.query(spec)).resolves.toEqual(result);
    expect(calls[0]?.url).toBe('/bff/ledger/analytics/query');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(spec);
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('uses globalThis.fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([]));
    try {
      await expect(createLedgerClient().signals.list({ type: 'regime_shift', active_only: false })).resolves.toEqual([]);
      expect(String(spy.mock.calls[0]?.[0])).toBe('/bff/ledger/signals?type=regime_shift&active_only=false');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('errors', () => {
  it('maps a ledger error body (passed through by the gateway)', async () => {
    const { fetch } = stubFetch(json({ error: { code: 'validation_error', message: 'limit: limit must be at most 1000' } }, 400));
    const err = await caught(createLedgerClient({ fetch }).actions.list({ limit: 5000 }));
    expect(err).toBeInstanceOf(LedgerError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 400, code: 'validation_error', source: 'ledger', path: '/actions' });
    expect(err.message).toBe('limit: limit must be at most 1000');
    expect(err.isNotFound).toBe(false);
    expect(err.isRetryable).toBe(false);
  });

  it('flags a ledger 404 as isNotFound', async () => {
    const { fetch } = stubFetch(json({ error: { code: 'not_found', message: 'no property 1' } }, 404));
    const err = await caught(createLedgerClient({ fetch }).properties.get('1'));
    expect(err.isNotFound).toBe(true);
    expect(err.source).toBe('ledger');
  });

  it.each([
    [401, 'unauthenticated', 'signed out'],
    [404, 'not_found', 'not found'],
    [502, 'ledger_unavailable', 'the ledger is unavailable'],
    [503, 'ledger_not_configured', 'the ledger gateway is not configured'],
    [504, 'ledger_timeout', 'the ledger timed out'],
  ])('maps a gateway %i {"error": "%s"}', async (status, code, message) => {
    const { fetch } = stubFetch(json({ error: code }, status));
    const err = await caught(createLedgerClient({ fetch }).status());
    expect(err).toMatchObject({ status, code, source: 'gateway', message });
    expect(err.isUnauthenticated).toBe(status === 401);
    expect(err.isNotFound).toBe(false);
    expect(err.isRetryable).toBe(status === 502 || status === 504);
  });

  it('maps a non-JSON error page', async () => {
    const { fetch } = stubFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await caught(createLedgerClient({ fetch }).status());
    expect(err).toMatchObject({ status: 502, code: 'http_502', source: 'gateway' });
    expect(err.details).toBe('<html>Bad Gateway</html>');
  });

  it('maps an unrecognised JSON error body and an empty one', async () => {
    const { fetch } = stubFetch(json({ message: 'nope' }, 418), new Response('', { status: 500 }));
    const client = createLedgerClient({ fetch });
    expect(await caught(client.status())).toMatchObject({ status: 418, code: 'http_418', message: 'HTTP 418' });
    expect(await caught(client.status())).toMatchObject({ status: 500, code: 'http_500' });
  });

  it('throws schema_mismatch on a 2xx body that breaks the contract — never returns it', async () => {
    const { fetch } = stubFetch(json({ data: [{ property_id: 123 }], count: 1, limit: 1, offset: 0, has_more: false }));
    const err = await caught(createLedgerClient({ fetch }).properties.list({ limit: 1 }));
    expect(err).toMatchObject({ status: 200, code: 'schema_mismatch', source: 'client', path: '/properties' });
    expect(err.message).toMatch(/data\.0\.property_id/);
    expect(Array.isArray(err.details)).toBe(true);
  });

  it('reports a root-level schema mismatch', async () => {
    const { fetch } = stubFetch(json({ not: 'an array' }));
    const err = await caught(createLedgerClient({ fetch }).chains());
    expect(err.code).toBe('schema_mismatch');
    expect(err.message).toMatch(/\(root\)/);
  });

  it('throws invalid_response on a 2xx that is not JSON, or empty', async () => {
    const { fetch } = stubFetch(new Response('<html>login</html>', { status: 200 }), new Response('', { status: 200 }));
    const client = createLedgerClient({ fetch });
    expect(await caught(client.status())).toMatchObject({ status: 200, code: 'invalid_response', source: 'client' });
    expect(await caught(client.status())).toMatchObject({ code: 'invalid_response' });
  });

  it('throws network_error when fetch rejects', async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await caught(createLedgerClient({ fetch }).status());
    expect(err).toMatchObject({ status: 0, code: 'network_error', source: 'client', message: 'Failed to fetch' });
    expect(err.isRetryable).toBe(true);
  });

  it('stringifies a non-Error rejection', async () => {
    const fetch = (async () => {
      throw 'boom';
    }) as unknown as typeof globalThis.fetch;
    expect(await caught(createLedgerClient({ fetch }).status())).toMatchObject({ code: 'network_error', message: 'boom' });
  });

  it('throws network_error when no fetch exists at all', async () => {
    const original = globalThis.fetch;
    // @ts-expect-error — simulate a runtime without fetch
    delete globalThis.fetch;
    try {
      const err = await caught(createLedgerClient().status());
      expect(err.code).toBe('network_error');
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** A fetch that never settles until its signal aborts. */
const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;

describe('timeouts and cancellation', () => {
  it('times out after timeoutMs', async () => {
    vi.useFakeTimers();
    const p = caught(createLedgerClient({ fetch: hangingFetch, timeoutMs: 50 }).status());
    await vi.advanceTimersByTimeAsync(60);
    const err = await p;
    expect(err).toMatchObject({ status: 0, code: 'timeout', source: 'client' });
    expect(err.isRetryable).toBe(true);
  });

  it('aborts when the caller signal aborts', async () => {
    const controller = new AbortController();
    const p = caught(createLedgerClient({ fetch: hangingFetch, timeoutMs: 0 }).status(undefined, { signal: controller.signal }));
    controller.abort();
    expect(await p).toMatchObject({ code: 'aborted' });
  });

  it('aborts immediately with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await caught(createLedgerClient({ fetch: hangingFetch }).status(undefined, { signal: controller.signal }));
    expect(err.code).toBe('aborted');
  });
});

describe('paginate (cursor)', () => {
  const page = (ids: number[], next: string | null) => ({ data: ids, next_cursor: next, count: ids.length });

  it('follows next_cursor until null', async () => {
    const seen: Array<string | undefined> = [];
    const pages = [page([1, 2], 'c1'), page([3, 4], 'c2'), page([5], null)];
    const out: number[] = [];
    for await (const p of paginate(async (params: { limit: number; cursor?: string }) => {
      seen.push(params.cursor);
      expect(params.limit).toBe(2);
      return pages.shift() ?? page([], null);
    }, { limit: 2 })) {
      out.push(...p.data);
    }
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([undefined, 'c1', 'c2']);
  });

  it('starts from a given cursor and respects maxPages', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const it = paginate(
      async (params: { cursor?: string }) => {
        seen.push(params.cursor);
        n += 1;
        return page([n], `c${n}`);
      },
      { cursor: 'start' },
      { maxPages: 2 },
    );
    const got: number[] = [];
    for await (const p of it) got.push(...p.data);
    expect(got).toEqual([1, 2]);
    expect(seen).toEqual(['start', 'c1']);
  });

  it('stops if the server repeats a cursor (defensive)', async () => {
    let calls = 0;
    const all = [];
    for await (const p of paginate(async (_params: { cursor?: string }) => {
      calls += 1;
      return page([1], 'same');
    }, { cursor: 'same' })) {
      all.push(p);
    }
    expect(all).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('works with a real client method and propagates errors', async () => {
    const { fetch, calls } = stubFetch(
      json({ data: [], next_cursor: 'abc', count: 0 }),
      json({ error: { code: 'validation_error', message: 'cursor: cursor payload is not JSON' } }, 400),
    );
    const client = createLedgerClient({ fetch });
    const pages = client.transfers.pages({ symbol: 'UPX', limit: 1 });
    await expect(pages.next()).resolves.toMatchObject({ done: false });
    await expect(pages.next()).rejects.toMatchObject({ code: 'validation_error' });
    expect(calls.map((c) => c.url)).toEqual([
      '/bff/ledger/transfers?symbol=UPX&limit=1',
      '/bff/ledger/transfers?symbol=UPX&limit=1&cursor=abc',
    ]);
  });
});

describe('pages() helpers on the client', () => {
  it('iterates /actions, /contracts/{c}/actions and /accounts/{a}/actions', async () => {
    const { fetch, calls } = stubFetch(
      json({ data: [], next_cursor: 'n1', count: 0 }),
      json({ data: [], next_cursor: null, count: 0 }),
      json({ data: [], next_cursor: null, count: 0 }),
      json({ data: [], next_cursor: null, count: 0, account: 'abc', role: 'receiver' }),
    );
    const client = createLedgerClient({ fetch });
    const got: unknown[] = [];
    for await (const p of client.actions.pages({ sort: 'asc', limit: 2 })) got.push(p);
    for await (const p of client.contracts.actionPages('eosio', { action: 'onblock' }, { maxPages: 1 })) got.push(p);
    for await (const p of client.accounts.actionPages('abc', { role: 'receiver' })) got.push(p);
    expect(got).toHaveLength(4);
    expect(calls.map((c) => c.url)).toEqual([
      '/bff/ledger/actions?sort=asc&limit=2',
      '/bff/ledger/actions?sort=asc&limit=2&cursor=n1',
      '/bff/ledger/contracts/eosio/actions?action=onblock',
      '/bff/ledger/accounts/abc/actions?role=receiver',
    ]);
  });

  it('defaults params and passes the signal through', async () => {
    const { fetch, calls } = stubFetch(json({ data: [], next_cursor: null, count: 0 }));
    const controller = new AbortController();
    for await (const p of createLedgerClient({ fetch }).transfers.pages(undefined, { signal: controller.signal })) {
      expect(p.data).toEqual([]);
    }
    expect(calls[0]?.url).toBe('/bff/ledger/transfers');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('paginateOffset composes with an entity list', async () => {
    const { fetch, calls } = stubFetch(
      json({ data: [], count: 0, limit: 2, offset: 0, has_more: false }),
    );
    const client = createLedgerClient({ fetch });
    for await (const p of paginateOffset((q: { limit?: number; offset?: number }) => client.sales.list(q), { limit: 2 })) {
      expect(p.has_more).toBe(false);
    }
    expect(calls[0]?.url).toBe('/bff/ledger/sales?limit=2&offset=0');
  });

  it('paginates /rates by offset now that it has one', async () => {
    const row = { day: '2026-10-08', method: 'm', upx_per_usd: 1, usd_per_upx: 1, p25: 1, p75: 1, upx_listings: 0, fiat_listings: 0, samples: 1, cities: 0, method_version: 2 };
    const { fetch, calls } = stubFetch(
      json({ data: [row, row], count: 2, limit: 2, offset: 0, has_more: true }),
      json({ data: [row], count: 1, limit: 2, offset: 2, has_more: false }),
    );
    const client = createLedgerClient({ fetch });
    const rows = [];
    for await (const p of paginateOffset((q: { limit?: number; offset?: number }) => client.rates.list(q), { limit: 2 })) rows.push(...p.data);
    expect(rows).toHaveLength(3);
    expect(calls.map((c) => c.url)).toEqual(['/bff/ledger/rates?limit=2&offset=0', '/bff/ledger/rates?limit=2&offset=2']);
  });
});

describe('paginateOffset', () => {
  const page = (ids: number[], offset: number, limit: number) => ({
    data: ids,
    count: ids.length,
    limit,
    offset,
    has_more: ids.length === limit,
  });

  it('advances offset by rows received until has_more is false', async () => {
    const offsets: number[] = [];
    const out: number[] = [];
    for await (const p of paginateOffset(async (params: { limit: number; offset?: number }) => {
      const offset = params.offset ?? 0;
      offsets.push(offset);
      const ids = [offset + 1, offset + 2].filter((v) => v <= 5);
      return page(ids, offset, params.limit);
    }, { limit: 2 })) {
      out.push(...p.data);
    }
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(offsets).toEqual([0, 2, 4]);
  });

  it('starts at a given offset, stops on an empty page and on maxPages', async () => {
    const offsets: number[] = [];
    const empties = [];
    for await (const p of paginateOffset(async (params: { offset?: number }) => {
      offsets.push(params.offset ?? -1);
      return { data: [], limit: 10, offset: params.offset ?? 0, has_more: true };
    }, { offset: 40 })) {
      empties.push(p);
    }
    expect(empties).toHaveLength(1);
    expect(offsets).toEqual([40]);

    let n = 0;
    for await (const p of paginateOffset(async (_params: { offset?: number }) => {
      n += 1;
      return page([1], 0, 1);
    }, {}, { maxPages: 3 })) {
      expect(p.data).toEqual([1]);
    }
    expect(n).toBe(3);
  });
});
