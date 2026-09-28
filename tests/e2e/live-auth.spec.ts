import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * Sign-in on the live build (project `chromium-live`, API deliberately down).
 *
 * This server alone carries a fake GitHub App config (see
 * `playwright.config.ts`), so `/auth/signin` and `/auth/callback`'s error
 * paths are exercised for real — without ever reaching github.com — using
 * the `request` fixture with `maxRedirects: 0` so redirects can be inspected
 * rather than followed. A real, GitHub-shaped signed-in session is sealed
 * directly with `signInAs`, the same way for the same reason.
 */

/** GitHub's own error code arrives with the original `state`, never a `code`. */
async function startSignIn(request: APIRequestContext, next: string): Promise<URL> {
  const response = await request.get(`/auth/signin?next=${encodeURIComponent(next)}`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  const location = response.headers().location;
  expect(location).toBeTruthy();
  return new URL(location ?? '');
}

/** True once `forge_oauth` is gone or already in the past — either is "cleared". */
async function oauthIsCleared(request: APIRequestContext): Promise<boolean> {
  const { cookies } = await request.storageState();
  const oauth = cookies.find((cookie) => cookie.name === 'forge_oauth');
  return oauth === undefined || oauth.expires <= Date.now() / 1000;
}

test('GET /auth/signin redirects to GitHub with PKCE, no scope, and a 10-minute transaction cookie', async ({
  request,
  baseURL,
}) => {
  const location = await startSignIn(request, '/me');

  expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
  expect(location.searchParams.get('client_id')).toBe('Iv1.e2e0000000000000');
  expect(location.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/callback`);
  expect(location.searchParams.get('code_challenge') ?? '').toHaveLength(43);
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect((location.searchParams.get('state') ?? '').length).toBeGreaterThan(0);
  expect(location.searchParams.has('scope')).toBe(false);

  const { cookies } = await request.storageState();
  const oauth = cookies.find((cookie) => cookie.name === 'forge_oauth');
  expect(oauth).toBeDefined();
  // Path=/ because production names it `__Host-forge_oauth`, which requires it.
  expect(oauth?.path).toBe('/');
  expect(oauth?.httpOnly).toBe(true);
  expect(oauth?.sameSite).toBe('Lax');
  const ttlSeconds = (oauth?.expires ?? 0) - Date.now() / 1000;
  expect(ttlSeconds).toBeGreaterThan(590);
  expect(ttlSeconds).toBeLessThanOrEqual(600);
});

test.describe('callback error paths', () => {
  // Exact targets confirmed against notes-1D-1E.md and apps/web/src/app/auth/callback/route.ts —
  // no adaptation needed.
  test('no transaction cookie -> /signin?error=expired', async ({ request }) => {
    const response = await request.get('/auth/callback', { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?error=expired');
    expect(await oauthIsCleared(request)).toBe(true);
  });

  test('a real transaction cookie with the wrong state -> /signin?error=state', async ({
    request,
  }) => {
    await startSignIn(request, '/me');

    const response = await request.get('/auth/callback?state=definitely-not-it', {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?error=state');
    expect(await oauthIsCleared(request)).toBe(true);
  });

  test('a GitHub-side denial (error=access_denied) -> /signin?error=denied', async ({ request }) => {
    const location = await startSignIn(request, '/me');
    const state = location.searchParams.get('state');

    const response = await request.get(`/auth/callback?state=${state}&error=access_denied`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?error=denied');
    expect(await oauthIsCleared(request)).toBe(true);
  });
});

test('POST /auth/demo is 404 on the live build', async ({ request }) => {
  const response = await request.post('/auth/demo', { maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({ error: 'not_found' });
});

test.describe('a practice session on the live build', () => {
  // The live build has no practice sign-in, so a practice cookie counts as
  // nobody, even sealed under this server's own secret (as a demo build
  // sharing the secret would seal it): not to the gate, the pages or the BFF.
  test.beforeEach(async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
  });

  test('does not get past the /me gate', async ({ page }) => {
    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
  });

  test('is shown as signed out', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: you' })).toHaveCount(0);
  });

  test('gets a 401 from the BFF', async ({ context }) => {
    const response = await context.request.get('/bff/upland/health');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });
});

test('/signin offers GitHub sign-in and no practice button', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue with the practice account' }),
  ).toHaveCount(0);
});

test.describe('a sealed, GitHub-shaped session', () => {
  const IDENTITY = {
    sub: '583231',
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  };

  test('/me shows the login and a link to the GitHub profile', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await page.goto('/me');

    // Scoped to <main>: the account menu panel is always in the DOM (just
    // hidden) and shows its own "@octocat", which a text locator would
    // otherwise match too.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(main.getByText('@octocat')).toBeVisible();
    await expect(main.getByRole('link', { name: 'github.com/octocat' })).toHaveAttribute(
      'href',
      'https://github.com/octocat',
    );
  });

  test('the account menu button is named for the login', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Account: octocat' })).toBeVisible();
  });

  test('/me/settings shows the GitHub revoke link', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await page.goto('/me/settings');

    await expect(
      page.getByRole('link', { name: "Review or revoke FORGE's access on GitHub" }),
    ).toHaveAttribute('href', 'https://github.com/settings/apps/authorizations');
  });

  test('the BFF mints an assertion and reaches the (deliberately unreachable) API', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);

    // 502 proves the session was accepted and an assertion was minted — a
    // missing/weak assertion secret would answer 503 `not_configured` instead.
    const response = await context.request.get('/bff/upland/health');
    expect(response.status()).toBe(502);
    expect(await response.json()).toEqual({ error: 'service_unreachable' });
  });

  test('a tampered session cookie is treated as signed out', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);

    const before = await context.cookies();
    const session = before.find((cookie) => cookie.name === 'forge_session');
    if (!session) {
      throw new Error('expected a forge_session cookie after signInAs');
    }
    // Flip one character in the middle of the sealed JWE — anywhere in a
    // compact token invalidates it, whether that lands in a segment or a
    // `.` separator.
    const middle = Math.floor(session.value.length / 2);
    const flipped = session.value[middle] === 'a' ? 'b' : 'a';
    const tampered = session.value.slice(0, middle) + flipped + session.value.slice(middle + 1);
    await context.addCookies([
      {
        name: session.name,
        value: tampered,
        domain: session.domain,
        path: session.path,
        httpOnly: session.httpOnly,
        secure: session.secure,
        sameSite: session.sameSite,
      },
    ]);

    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
  });

  test('an expired session (sealed 8 days ago) is treated as signed out', async ({
    page,
    context,
    baseURL,
  }) => {
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    await signInAs(context, baseURL ?? '', { ...IDENTITY, now: eightDaysAgo });

    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
  });
});
