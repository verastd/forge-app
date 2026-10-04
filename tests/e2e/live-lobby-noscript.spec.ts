import { expect, test } from '@playwright/test';

import { DATA_LINK } from './helpers/lobby';
import { signInAs } from './helpers/session';

/**
 * A browser that runs no script never gets the 3D wall, so /apps is its
 * heading and its directory: the `<noscript>` style in Lobby.tsx undoes the
 * hiding they get while the wall is the page. With scripts on they stay out
 * of sight from the first render (lobby.spec.ts).
 */
test.use({ javaScriptEnabled: false });

test('with scripts off, a signed-in member sees the heading and can see and follow the directory', async ({
  context,
  page,
  baseURL,
}) => {
  await signInAs(context, baseURL ?? '', { sub: '583231', login: 'octocat' });
  await page.goto('/apps');

  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible();
  const link = page.getByRole('link', { name: DATA_LINK });
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(40);
  expect(box?.height ?? 0).toBeGreaterThan(8);
  await expect(link).toHaveAttribute('href', '/apps/data');
});
