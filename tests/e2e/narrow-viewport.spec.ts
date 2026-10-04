import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoLobby } from './helpers/lobby';
import { demoSignIn } from './helpers/session';

/**
 * At 390 px (a common phone width) no page may be wider than the screen. The
 * nav is the tight spot: three links and the account slot fit on one row, and
 * the "offline demo data" pill, which only this demo build with the API down
 * shows, wraps to a second row rather than being hidden or pushing the page
 * sideways (see the <= 640 px block in globals.css).
 */

test.use({ viewport: { width: 390, height: 844 } });

async function goOffline(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

async function expectNoSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

async function expectPillOnScreen(page: Page): Promise<void> {
  const pill = page.getByRole('banner').getByText('offline demo data');
  await expect(pill).toBeVisible();
  const box = await pill.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
}

for (const path of ['/', '/propose']) {
  test(`${path}, signed out, fits the screen`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expectNoSideScroll(page);
  });
}

test('/apps, signed in (it needs a sign-in), fits the screen', async ({ page }) => {
  await gotoLobby(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('/contribute with the API down fits the screen, pill and all', async ({ page }) => {
  await goOffline(page);
  await page.goto('/contribute');
  await expectPillOnScreen(page);
  await expectNoSideScroll(page);
});

test('/me, signed in, fits the screen', async ({ page }) => {
  await goOffline(page);
  await page.goto('/signin?next=%2Fme');
  await demoSignIn(page);
  await expect(page.getByRole('heading', { name: 'Your contributions' })).toBeVisible();
  await expectPillOnScreen(page);
  await expectNoSideScroll(page);
});
