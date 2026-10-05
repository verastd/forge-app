import { expect, test } from '@playwright/test';

import { gotoLobby } from './helpers/lobby';

/**
 * The landing page, its animated hero, and the main nav (PRD v0.2:
 * Contribute / Propose / Apps). The nav is shared chrome (`SiteChrome`
 * renders it for every non-`/apps/<slug>` route), so the `aria-current` check
 * below visits each section rather than asserting on the landing page alone.
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

test.describe('the animated hero', () => {
  test('draws the grid behind the copy, and no intro video plays', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('section.forge-hero');
    await expect(hero).toHaveAttribute('data-hero', 'ready', { timeout: 20_000 });
    await expect(hero.locator('canvas')).toHaveCount(1);
    await expect(hero.getByText('Nobody has to trust anybody.')).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.locator('.splash')).toHaveCount(0);
    // The copy is on top: the CTA is the element under its own centre.
    const cta = hero.getByRole('link', { name: 'Find a task' });
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    const onTop = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.textContent?.trim() ?? null,
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(onTop).toBe('Find a task');
    // A click on the grid itself strikes a lot, and goes nowhere.
    const heroBox = await hero.boundingBox();
    await page.mouse.click(heroBox!.x + heroBox!.width * 0.85, heroBox!.y + heroBox!.height * 0.8);
    await expect(page).toHaveURL(/\/$/);
  });

  test('without WebGL2 it shows the brand gradient, and the page is whole', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind === 'webgl2' ? null : (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await page.goto('/');
    const hero = page.locator('section.forge-hero');
    await expect(hero).toHaveAttribute('data-hero', 'unsupported');
    await expect(hero.locator('.forge-hero-fallback')).toBeVisible();
    await expect(hero.getByRole('link', { name: 'Enter the lobby' })).toBeVisible();
  });

  test('never scrolls the page sideways', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `at ${width}px`).toBeLessThanOrEqual(0);
    }
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
      // The lobby needs a sign-in (the middleware): the practice account. Its nav
      // slides out of sight once the 3D wall is up, so it is read even then.
      const lobby = path === '/apps';
      if (lobby) {
        await gotoLobby(page);
      } else {
        await page.goto(path);
      }
      const nav = page.getByRole('navigation', { name: 'Main', includeHidden: lobby });

      await expect(nav.getByRole('link', { name: label, includeHidden: lobby })).toHaveAttribute('aria-current', 'page');
      for (const other of SECTIONS) {
        if (other.label !== label) {
          await expect(nav.getByRole('link', { name: other.label, includeHidden: lobby })).not.toHaveAttribute(
            'aria-current',
            'page',
          );
        }
      }
    });
  }
});
