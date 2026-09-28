import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { DEMO_API_PORT } from './helpers/env';
import { demoSignIn, signInAs } from './helpers/session';

/**
 * Sign-in on the demo build (project `chromium-demo`, API deliberately down).
 *
 * The practice account is this project's normal signed-in state: no GitHub
 * App is configured here, so `/signin` never offers "Continue with GitHub"
 * (see `live-auth.spec.ts` for that). What's under test is the plumbing
 * every session shares — the middleware gate, the account menu, `next`
 * safety, the BFF's own checks, and sign-out — using accessible names and
 * response bodies from notes-1D-1E.md, not implementation details.
 *
 * The account panel's own "@<login>" and "Profile" are ambiguous on their
 * own: the panel is always in the DOM (just `hidden`, which a role query
 * respects but a text locator does not), and the nav has its own unrelated
 * "Profile" link to /contribute/profile. Assertions below scope past both.
 */

/**
 * Right after a fresh navigation, the trigger button is paintable (and so
 * "actionable" to Playwright) before Next's client bundle finishes
 * hydrating and attaches its click handler — an inherent race under `next
 * dev`, worse with two dev servers and workers competing for CPU. Retrying
 * the whole click-and-check — a web-first assertion, not a fixed wait — is
 * the fix: `expect(trigger).toHaveAttribute` polls quickly on its own, and
 * `.toPass()` re-clicks if the first click was lost to that race.
 */
async function clickAndExpectExpanded(trigger: Locator, expanded: boolean): Promise<void> {
  await expect(async () => {
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', String(expanded), { timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

test.describe('signed out', () => {
  test('the header offers a sign-in link, and /me sends you to /signin', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/signin?next=%2F',
    );

    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
  });

  test('/upland sends you to /signin too', async ({ page }) => {
    await page.goto('/upland');
    await expect(page).toHaveURL(/\/signin\?next=%2Fupland$/);
  });
});

test.describe('signing in with the practice account', () => {
  test('from a redirect off /me, lands back on /me showing the practice account', async ({
    page,
  }) => {
    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
    await expect(
      page.getByRole('button', { name: 'Continue with the practice account' }),
    ).toBeVisible();

    await demoSignIn(page);

    await expect(page).toHaveURL(/\/me$/);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(main.getByText('@you')).toBeVisible();
    await expect(main.getByText('Practice account (demo)')).toBeVisible();
  });
});

test.describe('the "next" redirect target is checked, not trusted verbatim', () => {
  test('a protocol-relative next falls back to /', async ({ page, baseURL }) => {
    await page.goto(`/signin?next=${encodeURIComponent('//evil.example')}`);
    await demoSignIn(page);
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('a same-site next is honoured', async ({ page }) => {
    await page.goto(`/signin?next=${encodeURIComponent('/me/settings')}`);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/me\/settings$/);
  });
});

test.describe('the demo session cookie', () => {
  test('is HttpOnly, SameSite=Lax, Path=/', async ({ page, context }) => {
    await page.goto('/signin');
    await demoSignIn(page);

    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === 'forge_session');
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(session?.path).toBe('/');
  });
});

test.describe('the account menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signin');
    await demoSignIn(page);
  });

  test('the "Account: you" button toggles aria-expanded', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Account: you' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await clickAndExpectExpanded(trigger, true);
    await clickAndExpectExpanded(trigger, false);
  });

  test('Escape closes the panel and returns focus to the button', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Account: you' });
    await clickAndExpectExpanded(trigger, true);

    await page.keyboard.press('Escape');

    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('the Profile and Settings links work', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Account: you' });
    // The nav has its own, unrelated "Profile" link (to /contribute/profile);
    // href disambiguates the account panel's own link (to /me).
    const panelProfileLink = page.getByRole('link', { name: 'Profile' }).and(page.locator('[href="/me"]'));

    await clickAndExpectExpanded(trigger, true);
    await panelProfileLink.click();
    await expect(page).toHaveURL(/\/me$/);

    await clickAndExpectExpanded(trigger, true);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/me\/settings$/);
  });

  test('signing out returns to / signed out, and /me redirects again', async ({ page }) => {
    await clickAndExpectExpanded(page.getByRole('button', { name: 'Account: you' }), true);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
  });
});

test.describe('/me/settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signin');
    await demoSignIn(page);
    await page.goto('/me/settings');
  });

  test('shows the privacy statement and no GitHub revoke link', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(
      page.getByText(/FORGE stores only your GitHub id, login, name and avatar/),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: "Review or revoke FORGE's access on GitHub" }),
    ).toHaveCount(0);
  });
});

test.describe('the BFF (/bff/upland/*)', () => {
  test('signed out, GET .../health is 401 unauthenticated', async ({ request }) => {
    const response = await request.get('/bff/upland/health');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a demo session also gets 401 — demo accounts never reach the API', async ({
    page,
    context,
  }) => {
    await page.goto('/signin');
    await demoSignIn(page);

    const response = await context.request.get('/bff/upland/health');
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a path segment outside [a-z0-9_-] is 404', async ({ request }) => {
    const response = await request.get('/bff/upland/NOT-LOWERCASE');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('POST with a foreign Origin is 403', async ({ context, baseURL }) => {
    // Demo sessions 401 before the Origin check ever runs, so this needs a
    // real (non-demo) session — sealed directly, since only its claims are
    // in play here, never actual GitHub sign-in.
    await signInAs(context, baseURL ?? '', { sub: '4001001', login: 'origin-check' });

    const response = await context.request.post('/bff/upland/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad_origin' });
  });

  test('passes on only JSON or CSV types, and never upstream caching or cookies', async ({
    context,
    baseURL,
  }) => {
    // A hostile stand-in for the API, on the port this server's FORGE_API_URL
    // names: HTML for anything but an export, and headers the BFF must drop.
    const upstream = createServer((request, response) => {
      const csv = request.url?.startsWith('/api/upland/export') ?? false;
      response.writeHead(200, {
        'content-type': csv ? 'text/csv; charset=utf-8' : 'text/html',
        ...(csv ? { 'content-disposition': 'attachment; filename="upland-actions.csv"' } : {}),
        'cache-control': 'public, max-age=3600',
        'set-cookie': 'planted=1; Path=/',
      });
      response.end(csv ? 'a,b\n1,2\n' : '<script>document.title = "from upstream"</script>');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(DEMO_API_PORT, '127.0.0.1', resolve);
    });
    try {
      await signInAs(context, baseURL ?? '', { sub: '4001002', login: 'header-check' });

      const html = await context.request.get('/bff/upland/overview');
      expect(html.status()).toBe(200);
      expect(html.headers()['content-type']).toBe('application/octet-stream');
      expect(html.headers()['cache-control']).toBe('private, no-store');
      expect(html.headers()['x-content-type-options']).toBe('nosniff');
      expect(html.headers()['set-cookie']).toBeUndefined();

      const csv = await context.request.get('/bff/upland/export?type=actions');
      expect(csv.status()).toBe(200);
      expect(csv.headers()['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers()['content-disposition']).toBe('attachment; filename="upland-actions.csv"');
      expect(csv.headers()['cache-control']).toBe('private, no-store');
      expect(await csv.text()).toBe('a,b\n1,2\n');
    } finally {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

test.describe('sign-out is Origin-checked too', () => {
  test('a foreign Origin cannot sign the visitor out, and the session survives', async ({
    page,
    context,
  }) => {
    await page.goto('/signin');
    await demoSignIn(page);

    const response = await context.request.post('/auth/signout', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad_origin' });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Account: you' })).toBeVisible();
  });
});
