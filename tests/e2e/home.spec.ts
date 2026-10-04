import { expect, test } from '@playwright/test';

import { gotoLobby } from './helpers/lobby';

/**
 * The splash and the main nav (PRD v0.2: Contribute / Propose / Apps). The
 * nav is shared chrome (`SiteChrome` renders it for every non-`/apps/<slug>`
 * route), so the `aria-current` check below visits each section rather than
 * asserting on the splash alone.
 */

test.describe('the main nav', () => {
  test('shows exactly Contribute, Propose and Apps, plus the account slot', async ({ page }) => {
    await page.goto('/');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Contribute', 'Propose', 'Apps']);
    await expect(nav.getByRole('link', { name: 'Contribute' })).toHaveAttribute('href', '/contribute');
    await expect(nav.getByRole('link', { name: 'Propose' })).toHaveAttribute('href', '/propose');
    await expect(nav.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/apps');

    // The account slot sits next to — not inside — <nav aria-label="Main">.
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin?next=%2F');
  });
});

test.describe('landing page', () => {
  test('shows the pitch, the three cards and both CTAs', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Nobody has to trust anybody.')).toBeVisible();

    const ctas = page.locator('.hero-actions');
    await expect(ctas.getByRole('link', { name: 'Find a task' })).toHaveAttribute('href', '/contribute');
    await expect(ctas.getByRole('link', { name: 'Enter the lobby' })).toHaveAttribute('href', '/apps');

    const cards = page.locator('.grid-3');

    const contributeCard = cards
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: 'Help build FORGE' }) });
    await expect(contributeCard).toHaveAttribute('href', '/contribute');
    await expect(contributeCard.getByText('01 · Contribute')).toBeVisible();
    await expect(contributeCard.getByText('Find an open contribution and point your AI at it.')).toBeVisible();

    const proposeCard = cards
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: 'Bring an idea' }) });
    await expect(proposeCard).toHaveAttribute('href', '/propose');
    await expect(proposeCard.getByText('02 · Propose')).toBeVisible();
    await expect(
      proposeCard.getByText("Pitch it in plain English. The community decides by Robert's Rules."),
    ).toBeVisible();

    const appsCard = cards
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: 'Enter the lobby' }) });
    await expect(appsCard).toHaveAttribute('href', '/apps');
    await expect(appsCard.getByText('03 · Apps')).toBeVisible();
    await expect(appsCard.getByText('Everything the community has built, on one wall.')).toBeVisible();

    // The repo link moved into the hero sub-line (v0.2 PRD addendum).
    await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app',
    );

    await expect(page.getByText('beta · testnet')).toBeVisible();
  });

  test('navigates to Contribute from the nav', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contribute' }).click();
    await expect(page).toHaveURL(/\/contribute$/);
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
  });
});

test.describe('aria-current tracks the active section', () => {
  const SECTIONS: ReadonlyArray<{ path: string; label: string }> = [
    { path: '/contribute', label: 'Contribute' },
    { path: '/propose', label: 'Propose' },
    { path: '/apps', label: 'Apps' },
  ];

  for (const { path, label } of SECTIONS) {
    test(`marks ${label} current on ${path}, and nothing else`, async ({ page }) => {
      if (path === '/apps') {
        // The lobby needs a sign-in (the middleware): the practice account.
        await gotoLobby(page);
      } else {
        await page.goto(path);
      }
      const nav = page.getByRole('navigation', { name: 'Main' });

      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
      for (const other of SECTIONS) {
        if (other.label !== label) {
          await expect(nav.getByRole('link', { name: other.label })).not.toHaveAttribute(
            'aria-current',
            'page',
          );
        }
      }
    });
  }
});
