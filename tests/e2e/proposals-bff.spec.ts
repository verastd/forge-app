import { expect, test } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';

import { demoSignIn, signInAs } from './helpers/session';
import { assertionClaims, json, withStandIn } from './helpers/standin';

/**
 * The Proposals BFF (`/bff/proposals*`) and the notifications BFF
 * (`/bff/notifications*`), on the demo server (project `chromium-demo`).
 *
 * As in bridge-bff.spec.ts, this is where the forwarding can be watched end
 * to end: the demo server's FORGE_API_URL is 127.0.0.1:DEMO_API_PORT, so a
 * stand-in API there sees exactly what the BFF sends. The sessions are sealed
 * with `signInAs`, real and GitHub-shaped, which is the code path a live
 * build runs; the practice account is signed in through its real button.
 * The stand-in (helpers/standin.ts) holds the shared port for one test at a
 * time and answers only its own paths.
 */

const DRAFT = {
  title: 'Show my properties on a map',
  civilianSummary: 'Show each property as a pin on a map in the Data app.',
  acceptanceCriteria: ['A pin for every property'],
  size: 'S',
  tierFloor: 'T0',
  rewardClass: 'none',
};

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** A request the way this origin's own pages send one: same origin, JSON. */
function send(request: APIRequestContext, baseURL: string, method: Method, path: string, data?: unknown): Promise<APIResponse> {
  return request.fetch(path, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: method === 'GET' ? {} : { origin: baseURL, 'content-type': 'application/json' },
  });
}

test.describe('the Proposals and notifications BFFs refuse before they forward', () => {
  test('signed out: anything that needs to know who you are is 401, never cached', async ({ request, baseURL }) => {
    const base = baseURL ?? '';
    for (const [method, path, data] of [
      ['POST', '/bff/proposals', { title: 'A', pitch: 'B' }],
      ['GET', '/bff/proposals/me', undefined],
      ['PATCH', '/bff/proposals/7', { title: 'A', pitch: 'B' }],
      ['PUT', '/bff/proposals/settings', { testTimers: true }],
      ['POST', '/bff/proposals/7/second', {}],
      ['POST', '/bff/proposals/7/vote', { choice: 'yes' }],
      ['PUT', '/bff/proposals/7/admin/draft-task', DRAFT],
      ['GET', '/bff/notifications', undefined],
      ['POST', '/bff/notifications/read', {}],
    ] as const) {
      const response = await send(request, base, method, path, data);
      expect(response.status(), `${method} ${path}`).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthenticated' });
      expect(response.headers()['cache-control']).toBe('no-store');
    }
  });

  test('the practice account is refused outright, even for a public read', async ({ page, context, baseURL }) => {
    await page.goto('/signin');
    await demoSignIn(page);
    const base = baseURL ?? '';
    for (const [method, path, data] of [
      ['GET', '/bff/proposals/7', undefined],
      ['GET', '/bff/proposals', undefined],
      ['POST', '/bff/proposals/7/second', {}],
      ['POST', '/bff/proposals/7/consent', { consent: true }],
      ['PUT', '/bff/proposals/settings', { testTimers: true }],
      ['GET', '/bff/notifications', undefined],
    ] as const) {
      const response = await send(context.request, base, method, path, data);
      expect(response.status(), `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'practice_session' });
    }
  });

  test('paths and methods outside the list, and anything climbing out of /api/proposals, are 404', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200101', login: 'path-check' });
    const base = baseURL ?? '';
    for (const path of [
      '/bff/proposals/0',
      '/bff/proposals/abc',
      '/bff/proposals/Me',
      '/bff/proposals/7/admin',
      '/bff/proposals/7/history',
      '/bff/proposals/7/second/now',
      '/bff/proposals/7%2Fsecond',
      '/bff/proposals/..%2F..%2Fbridge%2Frails',
      '/bff/proposals/%252E%252E/bridge/rails',
      '/bff/notifications/all',
      '/bff/notifications/read/1',
    ]) {
      const response = await context.request.get(path);
      expect(response.status(), path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'not_found' });
    }
    // Known paths, wrong method.
    for (const [method, path] of [
      ['GET', '/bff/proposals/7/second'],
      ['POST', '/bff/proposals/me'],
      ['PATCH', '/bff/proposals/settings'],
      ['PUT', '/bff/proposals/7'],
      ['POST', '/bff/proposals/7/admin/draft-task'],
      ['PUT', '/bff/proposals/7/admin/publish-task'],
      ['GET', '/bff/notifications/read'],
      ['POST', '/bff/notifications'],
    ] as const) {
      const response = await send(context.request, base, method, path, method === 'GET' ? undefined : {});
      expect(response.status(), `${method} ${path}`).toBe(404);
    }
  });

  test('a write from another site, or with no Origin, is 403', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200102', login: 'origin-check' });
    for (const [method, path] of [
      ['POST', '/bff/proposals/7/second'],
      ['PATCH', '/bff/proposals/7'],
      ['PUT', '/bff/proposals/settings'],
      ['POST', '/bff/notifications/read'],
    ] as const) {
      const foreign = await context.request.fetch(path, {
        method,
        data: {},
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      });
      expect(foreign.status(), `${method} ${path}`).toBe(403);
      expect(await foreign.json()).toEqual({ error: 'bad_origin' });
      const bare = await context.request.fetch(path, { method, data: {} });
      expect(bare.status(), `${method} ${path} without an Origin`).toBe(403);
    }
  });

  test('a body over 32 KB is 413, and one that is not JSON is 415', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200103', login: 'body-check' });
    const big = await send(context.request, baseURL ?? '', 'POST', '/bff/proposals', { title: 'A', pitch: 'x'.repeat(33 * 1024) });
    expect(big.status()).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });

    const form = await context.request.post('/bff/proposals/7/comments', { form: { text: 'hi' }, headers: { origin: baseURL ?? '' } });
    expect(form.status()).toBe(415);
  });
});

test.describe('with a stand-in API on the demo server’s API port', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('every write goes up as you, with its body unchanged and none of the browser’s cookies or headers', async ({
    context,
    baseURL,
  }) => {
    const base = baseURL ?? '';
    await signInAs(context, base, { sub: '4200201', login: 'bff-writer' });
    await context.addCookies([{ name: 'planted', value: 'browser-only', url: base }]);

    const writes: Array<[Method, string, unknown, string]> = [
      ['POST', '/bff/proposals', { title: 'A map view', pitch: 'Pins on a map.\n\nThat is all.' }, '/api/proposals'],
      ['PATCH', '/bff/proposals/7', { title: 'A map view, please', pitch: 'Pins.' }, '/api/proposals/7'],
      ['POST', '/bff/proposals/7/withdraw', {}, '/api/proposals/7/withdraw'],
      ['POST', '/bff/proposals/7/second', {}, '/api/proposals/7/second'],
      ['POST', '/bff/proposals/7/consent', { consent: false }, '/api/proposals/7/consent'],
      ['POST', '/bff/proposals/7/comments', { text: 'Phones first.' }, '/api/proposals/7/comments'],
      ['POST', '/bff/proposals/7/vote', { choice: 'abstain' }, '/api/proposals/7/vote'],
      ['PUT', '/bff/proposals/settings', { testTimers: true }, '/api/proposals/settings'],
      ['POST', '/bff/proposals/7/admin/end-debate', {}, '/api/proposals/7/admin/end-debate'],
      ['POST', '/bff/proposals/7/admin/close-vote', {}, '/api/proposals/7/admin/close-vote'],
      ['PUT', '/bff/proposals/7/admin/draft-task', DRAFT, '/api/proposals/7/admin/draft-task'],
      ['POST', '/bff/proposals/7/admin/publish-task', {}, '/api/proposals/7/admin/publish-task'],
      ['POST', '/bff/notifications/read', { ids: [31, 30] }, '/api/notifications/read'],
    ];
    const upstream = new Set(writes.map(([method, , , path]) => `${method} ${path}`));

    await withStandIn(
      (request) =>
        upstream.has(`${request.method} ${request.path}`)
          ? json(200, { ok: request.path }, { 'set-cookie': 'upstream=1; Path=/', 'x-upstream': 'leak' })
          : undefined,
      async (seen) => {
        for (const [method, path, body] of writes) {
          const response = await context.request.fetch(path, {
            method,
            data: body,
            headers: { origin: base, 'content-type': 'application/json', 'x-leak': 'from-the-browser' },
          });
          expect(response.status(), `${method} ${path}`).toBe(200);
          expect(response.headers()['cache-control']).toBe('no-store');
          expect(response.headers()['set-cookie']).toBeUndefined();
          expect(response.headers()['x-upstream']).toBeUndefined();
        }

        expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(writes.map(([method, , , path]) => `${method} ${path}`));
        seen.forEach((entry, index) => {
          const [method, path, body] = writes[index] ?? [];
          expect(JSON.parse(entry.body), `${method} ${path}`).toEqual(body);
          expect(entry.headers.cookie, path).toBeUndefined();
          expect(entry.headers['x-leak'], path).toBeUndefined();
          expect(entry.headers.origin, path).toBeUndefined();
          expect(entry.headers['content-type'], path).toBe('application/json');
          const claims = assertionClaims(entry.authorization);
          expect(claims, path).toMatchObject({ iss: 'forge-web', aud: 'forge-api', sub: '4200201', login: 'bff-writer' });
          expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(120);
        });
      },
    );
  });

  test('reads: a proposal and the list go up as nobody signed out and as you signed in; me and the bell need you', async ({
    playwright,
    context,
    baseURL,
  }) => {
    const detail = { proposal: { id: 7 } };
    await withStandIn(
      (request) => {
        if (request.method !== 'GET') return undefined;
        if (request.path === '/api/proposals/7') return json(200, detail);
        if (request.path === '/api/proposals') return json(200, { proposals: [], testTimers: false });
        if (request.path === '/api/proposals/me') return json(200, { isAdmin: false, testTimers: false });
        if (request.path === '/api/notifications') return json(200, { notifications: [], unread: 0 });
        return undefined;
      },
      async (seen) => {
        const anonymous = await playwright.request.newContext({ baseURL });
        try {
          expect(await (await anonymous.get('/bff/proposals/7')).json()).toEqual(detail);
          // No query string is forwarded: the BFF lists the whole floor.
          expect((await anonymous.get('/bff/proposals?state=debate')).status()).toBe(200);
        } finally {
          await anonymous.dispose();
        }
        expect(seen.map((entry) => [entry.path, entry.authorization])).toEqual([
          ['/api/proposals/7', null],
          ['/api/proposals', null],
        ]);

        await signInAs(context, baseURL ?? '', { sub: '4200202', login: 'bff-reader' });
        for (const path of ['/bff/proposals/7', '/bff/proposals/me', '/bff/notifications']) {
          const response = await context.request.get(path);
          expect(response.status(), path).toBe(200);
        }
        expect(seen.slice(2).map((entry) => entry.path)).toEqual(['/api/proposals/7', '/api/proposals/me', '/api/notifications']);
        for (const entry of seen.slice(2)) {
          expect(assertionClaims(entry.authorization), entry.path).toMatchObject({ sub: '4200202', login: 'bff-reader' });
          expect(entry.headers.cookie).toBeUndefined();
        }
      },
    );
  });

  test('refusals pass through with their code, and a rate limit’s Retry-After in whole seconds', async ({ context, baseURL }) => {
    const base = baseURL ?? '';
    await signInAs(context, base, { sub: '4200203', login: 'pass-through' });
    await withStandIn(
      (request) => {
        if (request.path === '/api/proposals/7/comments') {
          return json(429, { error: 'rate_limited', message: 'Slow down.', retryAfter: 600 }, { 'retry-after': '600', 'x-ratelimit-remaining': '0' });
        }
        if (request.path === '/api/proposals/7/second') return json(409, { error: 'wrong_state', state: 'debate', message: 'No.' });
        if (request.path === '/api/proposals/7/admin/end-debate') return json(403, { error: 'admin_only' });
        if (request.path === '/api/proposals/9') return json(404, { error: 'proposals-disabled' });
        return undefined;
      },
      async () => {
        const limited = await send(context.request, base, 'POST', '/bff/proposals/7/comments', { text: 'Again.' });
        expect(limited.status()).toBe(429);
        expect(limited.headers()['retry-after']).toBe('600');
        expect(limited.headers()['x-ratelimit-remaining']).toBeUndefined();
        expect(await limited.json()).toMatchObject({ error: 'rate_limited' });

        const stale = await send(context.request, base, 'POST', '/bff/proposals/7/second', {});
        expect(stale.status()).toBe(409);
        expect(await stale.json()).toMatchObject({ error: 'wrong_state', state: 'debate' });

        const notAdmin = await send(context.request, base, 'POST', '/bff/proposals/7/admin/end-debate', {});
        expect(notAdmin.status()).toBe(403);
        expect(await notAdmin.json()).toEqual({ error: 'admin_only' });

        const off = await context.request.get('/bff/proposals/9');
        expect(off.status()).toBe(404);
        expect(await off.json()).toEqual({ error: 'proposals-disabled' });
      },
    );
  });

  test('a 4,000-character pitch of four-byte characters fits through, unchanged', async ({ context, baseURL }) => {
    const base = baseURL ?? '';
    await signInAs(context, base, { sub: '4200204', login: 'long-pitch' });
    const proposal = { title: '🏛'.repeat(100), pitch: '🏛'.repeat(4000) };
    // Past the 16 KB the other BFF routes allow, within this one's 32 KB.
    expect(Buffer.byteLength(JSON.stringify(proposal))).toBeGreaterThan(16 * 1024);
    await withStandIn(
      (request) => (request.method === 'POST' && request.path === '/api/proposals' ? json(201, { ok: true }) : undefined),
      async (seen) => {
        const response = await send(context.request, base, 'POST', '/bff/proposals', proposal);
        expect(response.status()).toBe(201);
        expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual(proposal);
      },
    );
  });

  test('an API that is not there is a 502, not a hang', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4200205', login: 'down-check' });
    await withStandIn(
      () => undefined,
      async () => {
        const response = await send(context.request, baseURL ?? '', 'POST', '/bff/proposals/7/second', {});
        expect(response.status()).toBe(502);
        expect(await response.json()).toEqual({ error: 'service_unreachable' });
        const bell = await context.request.get('/bff/notifications');
        expect(bell.status()).toBe(502);
      },
    );
  });
});
