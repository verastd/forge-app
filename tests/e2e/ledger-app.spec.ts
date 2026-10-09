import { expect, test } from '@playwright/test';

import { demoSignIn } from './helpers/session';

/**
 * The Upland Ledger UI (/apps/ledger), project `chromium-demo`: the practice
 * build, API deliberately down, flags falling back to all-on.
 *
 * The path under test is the one a signed-out visitor takes: the middleware
 * sends them to /signin first; signing in with the practice account brings
 * them back; the BFF answers the practice session's ledger reads with a real
 * 401 (nothing is mocked here); and the page shows a sign-in prompt — never
 * data, never a demo. The practice account can't fix that by signing in
 * again, so the prompt offers no button that would only loop.
 */

test.describe('the Upland Ledger, signed out', () => {
  test('signed out → sign-in → the BFF 401s the practice account → the sign-in prompt, and no data', async ({ page }) => {
    const ledgerCalls: Array<{ url: string; status: number }> = [];
    page.on('response', (res) => {
      if (res.url().includes('/bff/ledger/')) ledgerCalls.push({ url: res.url(), status: res.status() });
    });

    await page.goto('/apps/ledger');
    await expect(page).toHaveURL(/\/signin\?next=%2Fapps%2Fledger$/);

    await demoSignIn(page);
    await expect(page).toHaveURL(/\/apps\/ledger$/);

    const prompt = page.getByRole('alert').filter({ hasText: 'Sign in with GitHub to open the Upland Ledger' });
    await expect(prompt.getByRole('heading', { name: 'Sign in with GitHub to open the Upland Ledger' })).toBeVisible();
    await expect(prompt.getByText('The practice account can’t open it')).toBeVisible();
    await expect(prompt.getByRole('link')).toHaveCount(0);
    await expect(prompt.getByRole('button')).toHaveCount(0);

    // The prompt came from real 401s through the same-origin BFF, and nothing else was shown.
    expect(ledgerCalls.length).toBeGreaterThan(0);
    expect(ledgerCalls.every((c) => new URL(c.url).origin === new URL(page.url()).origin)).toBe(true);
    expect(ledgerCalls.some((c) => c.status === 401)).toBe(true);
    await expect(page.getByText('Chain status')).toHaveCount(0);
    await expect(page.getByText('Top cities')).toHaveCount(0);
  });

  test('a deep link survives the sign-in and lands on the same page, still behind the prompt', async ({ page }) => {
    await page.goto('/apps/ledger/market?tab=listings');
    await expect(page).toHaveURL(/\/signin\?next=/);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/apps\/ledger\/market\?tab=listings$/);
    await expect(page.getByRole('heading', { name: 'Sign in with GitHub to open the Upland Ledger' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the lobby' })).toHaveAttribute('href', '/apps?from=ledger');
  });
});
