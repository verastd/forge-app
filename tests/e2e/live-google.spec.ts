import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Google sign-in, the second way in beside GitHub, on the live build.
 * `playwright.config.ts` gives the live server a fake Google client, so
 * /signin offers it and `/auth/google` and its callback's error paths run for
 * real without reaching Google, through the `request` fixture with
 * `maxRedirects: 0`. A Google member's session is sealed directly
 * (`signInAs`, `google:<id>` and a `g.` handle).
 */

const GOOGLE = { sub: 'google:109876543210987654321', login: 'g.jane-doe', name: 'Jane Doe' };

async function startGoogle(request: APIRequestContext, next: string): Promise<URL> {
  const response = await request.get(`/auth/google?next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  return new URL(response.headers().location ?? '');
}

test('/signin offers GitHub and Google, and a pressed button says it is on its way', async ({ page }) => {
  // FORGE's own start route answers 204 here, so the browser stays on the page (a
  // redirect's next hop can't be intercepted, and the test must never reach Google),
  // showing the state a press left: on its way.
  let started = false;
  await page.route('**/auth/google?**', (route) => {
    started = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto('/signin?next=%2Fme');
  const github = page.getByRole('link', { name: 'Continue with GitHub' });
  const google = page.getByRole('link', { name: 'Continue with Google' });
  await expect(github).toBeVisible();
  await expect(google).toHaveAttribute('href', '/auth/google?next=%2Fme');
  await expect(page.getByText('Contributing code still needs GitHub.')).toBeVisible();
  // Once the page has hydrated (before that, a press is a plain link's).
  await page.waitForLoadState('networkidle');
  await google.click({ noWaitAfter: true });
  await expect.poll(() => started).toBe(true);
  const pending = page.getByRole('link', { name: 'Opening Google…' });
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await expect(pending).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
});

test('GET /auth/google redirects to Google with PKCE, openid email profile and the account chooser', async ({
  request,
  baseURL,
}) => {
  const location = await startGoogle(request, '/apps');
  expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(location.searchParams.get('client_id')).toBe('e2e-0000.apps.googleusercontent.com');
  expect(location.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/google/callback`);
  expect(location.searchParams.get('scope')).toBe('openid email profile');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect(location.searchParams.get('prompt')).toBe('select_account');
  const { cookies } = await request.storageState();
  expect(cookies.find((cookie) => cookie.name === 'forge_oauth')?.httpOnly).toBe(true);
});

test.describe('the Google callback', () => {
  test('no attempt -> expired', async ({ request }) => {
    const response = await request.get('/auth/google/callback', { maxRedirects: 0 });
    expect(response.headers().location).toBe('/signin?error=expired');
  });

  test('a wrong state -> state; a Google refusal -> google_denied', async ({ request }) => {
    await startGoogle(request, '/me');
    const wrong = await request.get('/auth/google/callback?state=nope', { maxRedirects: 0 });
    expect(wrong.headers().location).toBe('/signin?error=state');

    const state = (await startGoogle(request, '/me')).searchParams.get('state');
    const denied = await request.get(`/auth/google/callback?state=${state}&error=access_denied`, { maxRedirects: 0 });
    expect(denied.headers().location).toBe('/signin?error=google_denied');
  });

  test('neither callback takes the other’s attempt', async ({ request }) => {
    const google = (await startGoogle(request, '/me')).searchParams.get('state');
    const atGitHub = await request.get(`/auth/callback?state=${google}&code=x`, { maxRedirects: 0 });
    expect(atGitHub.headers().location).toBe('/signin?error=state');

    const githubStart = await request.get('/auth/signin?next=%2Fme', { maxRedirects: 0 });
    const github = new URL(githubStart.headers().location ?? '').searchParams.get('state');
    const atGoogle = await request.get(`/auth/google/callback?state=${github}&code=x`, { maxRedirects: 0 });
    expect(atGoogle.headers().location).toBe('/signin?error=state');
  });
});

test.describe('a Google member', () => {
  test('/me says Google, with no GitHub profile link, and that agents need GitHub', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', GOOGLE);
    await page.goto('/me');
    const main = page.getByRole('main');
    await expect(main.getByText('Signed in with Google', { exact: true })).toBeVisible();
    await expect(main.getByText('@g.jane-doe')).toBeVisible();
    await expect(main.getByRole('link', { name: /github\.com\// })).toHaveCount(0);
    await expect(main.getByRole('heading', { name: 'Agents and contributions' })).toBeVisible();
  });

  test('connecting an agent says it needs a GitHub account', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', GOOGLE);
    await page.goto('/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code');
    await expect(page.getByRole('heading', { name: 'Connecting an agent needs a GitHub account.' })).toBeVisible();
  });

  test('the lobby token makes them go:<id>, never gh:', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', GOOGLE);
    const response = await context.request.post('/api/lobby/token', { headers: { Origin: baseURL ?? '' } });
    expect(response.status()).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string; name: string };
    expect(claims.sub).toBe('go:109876543210987654321');
    expect(claims.name).toBe('g.jane-doe');
  });
});
