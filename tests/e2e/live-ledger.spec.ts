import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * The Upland Ledger UI on the build production ships (`chromium-live`, API
 * deliberately down). A real-shaped GitHub session is sealed directly; the
 * flag service and the BFF are mocked per test.
 *
 * - The `upland_ledger` flag gates the whole UI and fails closed.
 * - A member whose ledger reads come back 401 (an expired session, say)
 *   gets a sign-in prompt with "Try again" and "Sign in again" — not data.
 * - A ledger that's down says so, with Retry, and Retry re-reads.
 */

async function flags(page: Page, uplandLedger: boolean): Promise<void> {
  await page.route('**/api/flags', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ upland_ledger: uplandLedger, github_signin: true }) }),
  );
}

test.beforeEach(async ({ context, baseURL }) => {
  await signInAs(context, baseURL!, { sub: '4242', login: 'ledger-reader' });
});

test('flag off: the UI stays closed and reads nothing from the ledger', async ({ page }) => {
  let reads = 0;
  await flags(page, false);
  await page.route('**/bff/ledger/**', (route) => {
    reads += 1;
    return route.abort();
  });
  await page.goto('/apps/ledger');
  await expect(page.getByRole('alert').filter({ hasText: 'isn’t switched on for you yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the lobby' }).first()).toHaveAttribute('href', '/apps?from=ledger');
  expect(reads).toBe(0);
});

test('a member the ledger answers with 401 gets a sign-in prompt, not data', async ({ page }) => {
  await flags(page, true);
  await page.route('**/bff/ledger/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }),
  );
  await page.goto('/apps/ledger');

  const prompt = page.getByRole('alert').filter({ hasText: 'The ledger didn’t accept your sign-in' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(prompt.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/signin?next=%2Fapps%2Fledger');
  await expect(page.getByText('Chain status')).toHaveCount(0);
});

test('the ledger down: each section says so with Retry, and Retry reads again', async ({ page }) => {
  await flags(page, true);
  let statusReads = 0;
  await page.route('**/bff/ledger/**', (route) => {
    if (new URL(route.request().url()).pathname === '/bff/ledger/status') statusReads += 1;
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"service_unreachable"}' });
  });
  await page.goto('/apps/ledger');

  const panel = page.getByRole('alert').filter({ hasText: 'The ledger is unreachable (502)' }).first();
  await expect(panel).toBeVisible();
  await expect(panel.getByText('502 service_unreachable')).toBeVisible();
  const before = statusReads;
  await page.getByRole('alert').filter({ hasText: 'Failed to load' }).first().getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => statusReads).toBeGreaterThan(before);
});
