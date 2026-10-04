import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { DEMO_API_PORT } from './helpers/env';
import { demoSignIn, signInAs } from './helpers/session';
import { assertionClaims, json, listenWhenFree, withStandIn } from './helpers/standin';

/**
 * The Bridge BFF (`/bff/bridge/*`) and the connected-agents BFF
 * (`/bff/oauth/grants*`), on the demo server (project `chromium-demo`).
 *
 * This is where the BFFs can be watched end to end: the demo server's
 * FORGE_API_URL is 127.0.0.1:DEMO_API_PORT, so a stand-in API there sees
 * exactly what the BFF forwards, as in auth.spec.ts's header test (the live
 * server's points at a port nothing may listen on). The sessions are sealed
 * with `signInAs`, real and GitHub-shaped, so this is the code path a live
 * build runs; the practice account is signed in through its real button.
 *
 * The port is shared with auth.spec.ts and connect.spec.ts, and nothing
 * coordinates that across workers, so the stand-in (helpers/standin.ts)
 * waits for the port, holds it for one test at a time, and answers only its
 * own paths. (CI runs one worker, so there is no overlap there at all.)
 */

const CLAIM = { taskId: 1, claimedBy: 'bff-check', leaseEndsAt: '2026-10-03T12:00:00Z', leaseHours: 48 };

/** A POST the way this origin's own pages send one. */
function post(request: APIRequestContext, baseURL: string, path: string, data: unknown) {
  return request.post(path, { data, headers: { origin: baseURL, 'content-type': 'application/json' } });
}

test.describe('the Bridge BFF refuses before it forwards', () => {
  test('signed out: anything that needs to know who you are is 401', async ({ request, baseURL }) => {
    for (const response of [
      await post(request, baseURL ?? '', '/bff/bridge/claim', { taskId: 1 }),
      await request.get('/bff/bridge/me/keys'),
      await request.get('/bff/bridge/profile'),
      await request.get('/bff/oauth/grants'),
    ]) {
      expect(response.status()).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthenticated' });
      expect(response.headers()['cache-control']).toBe('no-store');
    }
  });

  test('the practice account is refused outright, even for the public reads', async ({ page, context, baseURL }) => {
    await page.goto('/signin');
    await demoSignIn(page);

    for (const response of [
      await context.request.get('/bff/bridge/rails'),
      await context.request.get('/bff/bridge/tasks/1'),
      await post(context.request, baseURL ?? '', '/bff/bridge/claim', { taskId: 1 }),
      await context.request.get('/bff/oauth/grants'),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: 'practice_session' });
    }
  });

  test('paths outside the list, and anything trying to climb out of /api/bridge, are 404', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100101', login: 'path-check' });
    for (const path of [
      '/bff/bridge/..%2F..%2Fupland%2Fhealth',
      '/bff/bridge/tasks%2F1',
      '/bff/bridge/tasks/1/..%2F..%2F..%2Fupland',
      '/bff/bridge/%252E%252E/upland/health',
      '/bff/bridge/Rails',
      '/bff/bridge/tasks/0',
      '/bff/bridge/tasks/one',
      '/bff/bridge/tasks/1/brief',
      '/bff/bridge/whatever',
      '/bff/oauth/grants/some-grant',
    ]) {
      const response = await context.request.get(path);
      expect(response.status(), path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'not_found' });
    }
    // Known paths, wrong method.
    expect((await context.request.get('/bff/bridge/claim')).status()).toBe(404);
    expect((await context.request.delete('/bff/oauth/grants', { headers: { origin: baseURL ?? '' } })).status()).toBe(404);
    expect(
      (await context.request.delete('/bff/oauth/grants/a.b', { headers: { origin: baseURL ?? '' } })).status(),
    ).toBe(404);
  });

  test('a write from another site is 403, and so is one without an Origin', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100102', login: 'origin-check' });

    const foreign = await context.request.post('/bff/bridge/claim', {
      data: { taskId: 1 },
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'bad_origin' });

    const bare = await context.request.post('/bff/bridge/claim', { data: { taskId: 1 } });
    expect(bare.status()).toBe(403);

    const disconnect = await context.request.delete('/bff/oauth/grants/grant-1', {
      headers: { origin: 'https://evil.example' },
    });
    expect(disconnect.status()).toBe(403);
  });

  test('a body over 16 KB is 413, and one that is not JSON is 415', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100103', login: 'body-check' });

    const big = await post(context.request, baseURL ?? '', '/bff/bridge/dispatch', {
      taskId: 1,
      rail: 'jules',
      credential: { key: 'x'.repeat(17 * 1024) },
    });
    expect(big.status()).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });

    const form = await context.request.post('/bff/bridge/claim', {
      form: { taskId: '1' },
      headers: { origin: baseURL ?? '' },
    });
    expect(form.status()).toBe(415);
  });
});

test.describe('with a stand-in API on the demo server’s API port', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('a claim goes up with a fresh assertion and none of the browser’s cookies or headers', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100201', login: 'bff-check' });
    await context.addCookies([{ name: 'planted', value: 'browser-only', url: baseURL ?? '' }]);

    await withStandIn(
      (request) =>
        request.method === 'POST' && request.path === '/api/bridge/claim'
          ? json(200, CLAIM, {
              'set-cookie': 'upstream=1; Path=/',
              'cache-control': 'public, max-age=3600',
              'x-upstream': 'leak',
            })
          : undefined,
      async (seen) => {
        const response = await context.request.post('/bff/bridge/claim', {
          data: { taskId: 1 },
          headers: { origin: baseURL ?? '', 'x-leak': 'from-the-browser', 'x-forwarded-for': '203.0.113.9' },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual(CLAIM);
        expect(response.headers()['content-type']).toMatch(/^application\/json/);
        expect(response.headers()['cache-control']).toBe('no-store');
        expect(response.headers()['set-cookie']).toBeUndefined();
        expect(response.headers()['x-upstream']).toBeUndefined();

        expect(seen).toHaveLength(1);
        const [upstream] = seen;
        expect(upstream?.headers.cookie).toBeUndefined();
        expect(upstream?.headers['x-leak']).toBeUndefined();
        expect(upstream?.headers['x-forwarded-for']).toBeUndefined();
        expect(upstream?.headers.origin).toBeUndefined();
        expect(upstream?.headers['content-type']).toBe('application/json');
        expect(JSON.parse(upstream?.body ?? 'null')).toEqual({ taskId: 1 });
        const claims = assertionClaims(upstream?.headers.authorization);
        expect(claims).toMatchObject({ iss: 'forge-web', aud: 'forge-api', sub: '4100201', login: 'bff-check' });
        expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(120);
      },
    );
  });

  test('a public read goes up as nobody when signed out, and as you when signed in', async ({
    playwright,
    context,
    baseURL,
  }) => {
    const rails = { rails: [], vault: false };
    await withStandIn(
      (request) => (request.method === 'GET' && request.path === '/api/bridge/rails' ? json(200, rails) : undefined),
      async (seen) => {
        const anonymous = await playwright.request.newContext({ baseURL });
        try {
          const response = await anonymous.get('/bff/bridge/rails');
          expect(response.status()).toBe(200);
          expect(await response.json()).toEqual(rails);
        } finally {
          await anonymous.dispose();
        }
        expect(seen[0]?.headers.authorization).toBeUndefined();

        await signInAs(context, baseURL ?? '', { sub: '4100202', login: 'reader' });
        expect((await context.request.get('/bff/bridge/rails')).status()).toBe(200);
        expect(assertionClaims(seen[1]?.headers.authorization)).toMatchObject({ sub: '4100202', login: 'reader' });
      },
    );
  });

  test('upstream refusals pass through, and anything but JSON is not rendered as a page', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100203', login: 'pass-through' });
    await withStandIn(
      (request) => {
        if (request.method === 'POST' && request.path === '/api/bridge/dispatch') {
          // The first start is refused; the second hits the hourly limit.
          return request.body.includes('"rail":"cursor"')
            ? json(429, { error: 'dispatch_limit', limit: 10 }, { 'retry-after': '600', 'x-ratelimit-remaining': '0' })
            : json(400, { error: 'credential_rejected' });
        }
        if (request.method === 'GET' && request.path === '/api/bridge/status/1') {
          return { status: 200, headers: { 'content-type': 'text/html' }, body: '<script>alert(1)</script>' };
        }
        if (request.method === 'DELETE' && request.path === '/api/bridge/me/keys/jules') {
          return json(200, { credentials: [], vault: true });
        }
        return undefined;
      },
      async (seen) => {
        const key = 'test-only-jules-credential';
        const dispatch = await post(context.request, baseURL ?? '', '/bff/bridge/dispatch', {
          taskId: 1,
          rail: 'jules',
          credential: { key },
          saveCredential: true,
        });
        expect(dispatch.status()).toBe(400);
        expect(await dispatch.json()).toEqual({ error: 'credential_rejected' });
        // The key went up once, unchanged, and nothing came back with it.
        expect(JSON.parse(seen[0]?.body ?? 'null')).toMatchObject({ credential: { key } });
        expect(await dispatch.text()).not.toContain(key);

        // A rate limit's Retry-After comes through, as whole seconds; nothing else does.
        const limited = await post(context.request, baseURL ?? '', '/bff/bridge/dispatch', { taskId: 1, rail: 'cursor' });
        expect(limited.status()).toBe(429);
        expect(limited.headers()['retry-after']).toBe('600');
        expect(limited.headers()['x-ratelimit-remaining']).toBeUndefined();

        const html = await context.request.get('/bff/bridge/status/1');
        expect(html.headers()['content-type']).toBe('application/octet-stream');
        expect(html.headers()['x-content-type-options']).toBe('nosniff');

        const removed = await context.request.delete('/bff/bridge/me/keys/jules', { headers: { origin: baseURL ?? '' } });
        expect(removed.status()).toBe(200);
        expect(await removed.json()).toEqual({ credentials: [], vault: true });
        expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
          'POST /api/bridge/dispatch',
          'POST /api/bridge/dispatch',
          'GET /api/bridge/status/1',
          'DELETE /api/bridge/me/keys/jules',
        ]);
      },
    );
  });

  test('connected agents: list and disconnect go to /api/oauth/grants as you', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100204', login: 'grants-check' });
    const agents = {
      agents: [{ id: 'grant_1', clientName: 'Stand-in agent', redirectHost: '127.0.0.1', connectedAt: '2026-10-01T00:00:00Z' }],
    };
    await withStandIn(
      (request) => {
        if (request.method === 'GET' && request.path === '/api/oauth/grants') return json(200, agents);
        if (request.method === 'DELETE' && request.path === '/api/oauth/grants/grant_1') return json(200, { agents: [] });
        return undefined;
      },
      async (seen) => {
        const list = await context.request.get('/bff/oauth/grants');
        expect(await list.json()).toEqual(agents);
        const gone = await context.request.delete('/bff/oauth/grants/grant_1', { headers: { origin: baseURL ?? '' } });
        expect(await gone.json()).toEqual({ agents: [] });
        expect(seen).toHaveLength(2);
        for (const entry of seen) {
          expect(assertionClaims(entry.headers.authorization)).toMatchObject({ sub: '4100204', login: 'grants-check' });
        }
      },
    );
  });

  test('an API that is not there is a 502, not a hang', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100205', login: 'down-check' });
    // The stand-in answers nothing here: every request is cut off, as by a closed port.
    await withStandIn(
      () => undefined,
      async () => {
        const response = await post(context.request, baseURL ?? '', '/bff/bridge/claim', { taskId: 1 });
        expect(response.status()).toBe(502);
        expect(await response.json()).toEqual({ error: 'service_unreachable' });
      },
    );
  });

  test('an API that took the request but never answers is a 504 upstream_timeout, not "unreachable"', async ({
    context,
    baseURL,
  }) => {
    // A start or a relay may still go through behind it, so the page must not
    // be told nothing changed (review-creds CR-3). A read shows the same rule
    // at its 25 s deadline; a start waits 45 s for the same answer.
    test.setTimeout(90_000);
    await signInAs(context, baseURL ?? '', { sub: '4100206', login: 'slow-check' });
    const held: ServerResponse[] = [];
    const server = createServer((_request, response) => {
      held.push(response);
    });
    await listenWhenFree(server, DEMO_API_PORT);
    try {
      const started = Date.now();
      const response = await context.request.get('/bff/bridge/rails', { timeout: 60_000 });
      expect(response.status()).toBe(504);
      expect(await response.json()).toEqual({ error: 'upstream_timeout' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(24_000);
      expect(held).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
