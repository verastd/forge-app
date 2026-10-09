import { expect, test } from '@playwright/test';

import { demoSignIn, signInAs } from './helpers/session';
import { assertionClaims, json, withStandIn } from './helpers/standin';

/**
 * The Upland Ledger BFF (`/bff/ledger/*`), on the demo server (project
 * `chromium-demo`).
 *
 * As in bridge-bff.spec.ts, the demo server's FORGE_API_URL is
 * 127.0.0.1:DEMO_API_PORT, so a stand-in API there sees exactly what the BFF
 * sends to `/api/ledger/*`. The ledger itself is never in play: the API's
 * allowlist and the ledger call are covered in apps/api/tests/test_ledger.py.
 * Real sessions are sealed with `signInAs`; the practice account signs in
 * through its real button.
 */

const QUERY = { metric: 'count', groupBy: ['action'], chain: 'mainnet' };

test.describe('the Ledger BFF refuses before it forwards', () => {
  test('signed out is 401, never cached', async ({ request }) => {
    for (const path of ['/bff/ledger/status', '/bff/ledger/accounts/playuplandme']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthenticated' });
      expect(response.headers()['cache-control']).toBe('no-store');
    }
  });

  test('the practice account is 401 too: it never reaches the API', async ({ page, context }) => {
    await page.goto('/signin');
    await demoSignIn(page);
    const response = await context.request.get('/bff/ledger/status');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  // A dot segment (`..`, `%2e%2e`) never arrives: the URL is resolved before
  // it is sent, so the route's own refusal of one is a backstop, and the API
  // refuses one again (apps/api/tests/test_ledger.py).
  test('segments outside [a-z0-9._-], an encoded slash, or too many, are 404', async ({ request }) => {
    for (const path of [
      '/bff/ledger/NOT-LOWERCASE',
      '/bff/ledger/accounts/a%2Fb',
      '/bff/ledger/accounts/a%20b',
      '/bff/ledger/a/b/c/d/e/f/g/h/i',
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  test('a query string over 4 KiB is 414', async ({ request }) => {
    const response = await request.get(`/bff/ledger/actions?q=${'a'.repeat(4096)}`);
    expect(response.status()).toBe(414);
    expect(await response.json()).toEqual({ error: 'query_too_long' });
  });

  test('a POST from a foreign Origin is 403, not JSON is 415, over 16 KiB is 413', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200101', login: 'ledger-origin' });
    const foreign = await context.request.post('/bff/ledger/analytics/query', {
      data: QUERY,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'bad_origin' });

    const text = await context.request.post('/bff/ledger/analytics/query', {
      data: 'metric=count',
      headers: { origin: baseURL ?? '', 'content-type': 'text/plain' },
    });
    expect(text.status()).toBe(415);
    expect(await text.json()).toEqual({ error: 'unsupported_media_type' });

    const big = await context.request.post('/bff/ledger/analytics/query', {
      data: JSON.stringify({ pad: 'x'.repeat(16 * 1024) }),
      headers: { origin: baseURL ?? '', 'content-type': 'application/json' },
    });
    expect(big.status()).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
  });

  test('the API down is 502 service_unreachable', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200102', login: 'ledger-down' });
    // A path no stand-in answers: the port refuses it, as a down API would.
    const response = await context.request.get('/bff/ledger/ingest/windows');
    expect(response.status()).toBe(502);
    expect(await response.json()).toEqual({ error: 'service_unreachable' });
  });
});

test.describe('the Ledger BFF forwards to /api/ledger/*', () => {
  test('GET: the path with its dots, the query, an assertion and nothing of the browser', async ({
    context,
    baseURL,
  }) => {
    await withStandIn(
      (request) =>
        request.method === 'GET' && request.path === '/api/ledger/accounts/a.b.c/actions?limit=5000&role=receiver'
          ? json(
              400,
              { error: 'bad_request', message: 'limit must be at most 1000' },
              { 'set-cookie': 'upstream=1; Path=/', 'cache-control': 'public, max-age=3600', 'x-upstream': 'leak' },
            )
          : undefined,
      async (seen) => {
        await signInAs(context, baseURL ?? '', { sub: '4200201', login: 'ledger-reader' });
        const response = await context.request.get('/bff/ledger/accounts/a.b.c/actions?limit=5000&role=receiver', {
          headers: { 'x-leak': 'from-the-browser', 'x-forwarded-for': '203.0.113.9' },
        });
        expect(response.status()).toBe(400);
        expect(await response.json()).toEqual({ error: 'bad_request', message: 'limit must be at most 1000' });
        expect(response.headers()['content-type']).toMatch(/^application\/json/);
        expect(response.headers()['cache-control']).toBe('private, no-store');
        expect(response.headers()['set-cookie']).toBeUndefined();
        expect(response.headers()['x-upstream']).toBeUndefined();

        expect(seen).toHaveLength(1);
        const [upstream] = seen;
        expect(upstream?.path).toBe('/api/ledger/accounts/a.b.c/actions?limit=5000&role=receiver');
        expect(upstream?.headers.accept).toBe('application/json');
        expect(upstream?.headers.cookie).toBeUndefined();
        expect(upstream?.headers['x-leak']).toBeUndefined();
        expect(upstream?.headers['x-forwarded-for']).toBeUndefined();
        const claims = assertionClaims(upstream?.authorization);
        expect(claims).toMatchObject({ iss: 'forge-web', aud: 'forge-api', sub: '4200201', login: 'ledger-reader' });
        expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(120);
      },
    );
  });

  test('POST: the analytics query, as JSON', async ({ context, baseURL }) => {
    await withStandIn(
      (request) =>
        request.method === 'POST' && request.path === '/api/ledger/analytics/query'
          ? json(200, { rows: [] })
          : undefined,
      async (seen) => {
        await signInAs(context, baseURL ?? '', { sub: '4200202', login: 'ledger-query' });
        const response = await context.request.post('/bff/ledger/analytics/query', {
          data: QUERY,
          headers: { origin: baseURL ?? '', 'content-type': 'application/json; charset=utf-8' },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ rows: [] });

        expect(seen).toHaveLength(1);
        const [upstream] = seen;
        expect(upstream?.headers['content-type']).toBe('application/json');
        expect(JSON.parse(upstream?.body ?? '')).toEqual(QUERY);
        expect(assertionClaims(upstream?.authorization)).toMatchObject({ sub: '4200202' });
      },
    );
  });

  test('anything upstream says that is not JSON reaches the browser as octet-stream', async ({
    context,
    baseURL,
  }) => {
    await withStandIn(
      (request) =>
        request.path === '/api/ledger/status'
          ? { status: 200, headers: { 'content-type': 'text/html' }, body: '<script>document.title = "x"</script>' }
          : undefined,
      async () => {
        await signInAs(context, baseURL ?? '', { sub: '4200203', login: 'ledger-html' });
        const response = await context.request.get('/bff/ledger/status');
        expect(response.headers()['content-type']).toBe('application/octet-stream');
        expect(response.headers()['x-content-type-options']).toBe('nosniff');
      },
    );
  });
});
