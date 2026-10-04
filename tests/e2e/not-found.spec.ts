import { expect, test } from '@playwright/test';

import { demoSignIn } from './helpers/session';

/**
 * The 404 page (app/not-found.tsx) carries its own ways out, because the
 * chrome around it varies: under /apps/<slug> SiteChrome renders no site nav
 * at all ("app" mode), so without them a mistyped app URL is a dead end.
 *
 * Everything under /apps needs a sign-in first (the middleware), so the
 * "app" case signs in with the practice account before it looks.
 */

const CASES: ReadonlyArray<{ path: string; chrome: 'app' | 'site' }> = [
  { path: '/apps/nonexistent', chrome: 'app' },
  { path: '/nonexistent', chrome: 'site' },
];

for (const { path, chrome } of CASES) {
  test(`${path} is a 404 with a way back to the lobby and home (${chrome} chrome)`, async ({ page }) => {
    if (chrome === 'app') {
      await page.goto('/signin');
      await demoSignIn(page);
    }
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);

    await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: 'Go to the lobby' })).toHaveAttribute('href', '/apps');
    await expect(main.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');

    // The page's own links are the only way out exactly where the site nav is missing.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(chrome === 'app' ? 0 : 1);
  });
}
