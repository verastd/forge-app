import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectReady, expectWebGL2, gotoLobby, holdFlags, lobbyRoot, openLobby } from './helpers/lobby';

/**
 * The page chrome around the 3D lobby at /apps (project `chromium-demo`):
 * the site nav, which steps out of the cave's way (LobbyNav.tsx).
 *
 * - A desktop: the bar is there on arrival, slides up once the wall is up,
 *   and comes back while the pointer is in a strip along the top edge or on
 *   the bar, while focus is in it, and while its account menu is open.
 * - A phone: a "Menu" button in the top left corner, which opens the nav as
 *   a panel.
 * - Every other page keeps the normal nav.
 *
 * playwright.config.ts asks every test for reduced motion, so the bar
 * appears and disappears without sliding here unless a test opts out.
 */

function lobbyHeader(page: Page): Locator {
  return page.locator('header[data-chrome="lobby"]');
}

function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

function account(page: Page): Locator {
  return page.getByRole('button', { name: 'Account: you' });
}

test.describe('on a desktop', () => {
  test('the nav is there on arrival, then slides up out of the way once the wall is up', async ({ page }) => {
    test.setTimeout(90_000);
    await expectWebGL2(page);
    // The flags answer held back: the lobby stays loading, as on arrival.
    const release = await holdFlags(page);
    await gotoLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav-mode', 'arrival');
    await expect(header).toHaveAttribute('data-nav', 'shown');
    await expect(mainNav(page)).toBeVisible();
    // Pinned, it is in the page's flow, as on any page: the lobby starts under it.
    expect((await lobbyRoot(page).boundingBox())?.y).toBeGreaterThanOrEqual(60);

    release();
    await expectReady(page);
    await expect(header).toHaveAttribute('data-nav-mode', 'slide');
    await expect(header).toHaveAttribute('data-nav', 'hidden');
    await expect(mainNav(page)).toBeHidden();
    // Away, it is out of the tab order and the accessibility tree, and above the top edge.
    await expect(header.locator('.nav-inner')).toHaveAttribute('inert', '');
    const box = await header.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 1)).toBeLessThanOrEqual(0);
    // It floats now, so its height no longer pushes the lobby down.
    await expect.poll(async () => (await lobbyRoot(page).boundingBox())?.y).toBe(0);
  });

  test('the strip along the top edge brings it down; it stays while the pointer is on it, and goes 600 ms after', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav', 'hidden');
    const width = page.viewportSize()?.width ?? 1280;

    await page.mouse.move(width / 2, 300);
    await page.mouse.move(width / 2, 6, { steps: 4 });
    await expect(header).toHaveAttribute('data-nav', 'shown');
    await expect(mainNav(page)).toBeVisible();

    // Down onto the bar itself, and a while there: it stays.
    await page.mouse.move(width / 2, 40, { steps: 2 });
    await page.waitForTimeout(1_200);
    await expect(header).toHaveAttribute('data-nav', 'shown');

    // Away from both: it goes, but not at once.
    await page.mouse.move(width / 2, 420, { steps: 4 });
    const left = Date.now();
    await expect(header).toHaveAttribute('data-nav', 'hidden', { timeout: 5_000 });
    expect(Date.now() - left).toBeGreaterThanOrEqual(450);
    await expect(mainNav(page)).toBeHidden();
  });

  test('Tab from the top lands in it and brings it down; Shift+Tab back out of the page lands on its last stop', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav', 'hidden');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'FORGE home' })).toBeFocused();
    await expect(header).toHaveAttribute('data-nav', 'shown');
    await expect(header.locator('.nav-inner')).not.toHaveAttribute('inert', /.*/);
    // Down for as long as focus is in it.
    await page.waitForTimeout(1_200);
    await expect(header).toHaveAttribute('data-nav', 'shown');

    for (const name of ['Contribute', 'Propose', 'Apps']) {
      await page.keyboard.press('Tab');
      await expect(mainNav(page).getByRole('link', { name })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(account(page)).toBeFocused();

    // On out of it, into the page: it goes.
    await page.keyboard.press('Tab');
    await expect(header).toHaveAttribute('data-nav', 'hidden', { timeout: 5_000 });

    // Back up the page: it comes down again, on its last stop.
    await page.keyboard.press('Shift+Tab');
    await expect(account(page)).toBeFocused();
    await expect(header).toHaveAttribute('data-nav', 'shown');
  });

  test('the account menu holds it down while open', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav', 'hidden');
    const width = page.viewportSize()?.width ?? 1280;

    await page.mouse.move(width / 2, 6, { steps: 2 });
    await expect(header).toHaveAttribute('data-nav', 'shown');
    await account(page).click();
    await expect(account(page)).toHaveAttribute('aria-expanded', 'true');

    // The pointer leaves; the open menu (and the focus on its button) keep it down.
    await page.mouse.move(width / 2, 520, { steps: 4 });
    await page.waitForTimeout(1_200);
    await expect(header).toHaveAttribute('data-nav', 'shown');

    // Escape closes the menu and puts focus back on its button, still in the nav.
    await page.keyboard.press('Escape');
    await expect(account(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(account(page)).toBeFocused();
    await page.waitForTimeout(1_000);
    await expect(header).toHaveAttribute('data-nav', 'shown');

    // Focus out (a click on the floor of the cave): it goes.
    await page.mouse.click(width / 2, 620);
    await expect(header).toHaveAttribute('data-nav', 'hidden', { timeout: 5_000 });
  });

  test('with reduced motion it appears and disappears without sliding', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav', 'hidden');
    expect(await header.evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('none');
  });

  test.describe('with no reduced-motion preference', () => {
    // Opts out of the suite-wide default; never visits `/`, whose splash would then play.
    test.use({ contextOptions: { reducedMotion: 'no-preference' } });

    test('it slides', async ({ page }) => {
      test.setTimeout(90_000);
      await openLobby(page);
      const header = lobbyHeader(page);
      await expect(header).toHaveAttribute('data-nav', 'hidden');
      const transition = await header.evaluate((element) => {
        const style = getComputedStyle(element);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
      expect(transition.property).toContain('transform');
      expect(transition.duration).toContain('0.24s');
    });
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the nav is a Menu button that opens it as a panel; Escape closes it, focus back on the button', async ({
    page,
  }) => {
    await gotoLobby(page);
    const header = lobbyHeader(page);
    await expect(header).toHaveAttribute('data-nav-mode', 'menu');
    const button = page.getByRole('button', { name: 'Menu' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const controls = await button.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const panel = page.locator(`[id="${controls ?? ''}"]`);
    // Closed, only the button is there: the rest is out of sight and out of reach.
    await expect(mainNav(page)).toBeHidden();
    await expect(panel).toHaveAttribute('inert', '');
    await expect(header).toHaveAttribute('data-nav', 'hidden');

    await button.tap();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(header).toHaveAttribute('data-nav', 'shown');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('link', { name: 'FORGE home' })).toBeVisible();
    for (const name of ['Contribute', 'Propose', 'Apps']) {
      await expect(mainNav(page).getByRole('link', { name })).toBeVisible();
    }
    await expect(account(page)).toBeVisible();
    // The panel keeps to the screen.
    const opened = await panel.boundingBox();
    expect((opened?.x ?? -1) >= 0 && (opened?.x ?? 0) + (opened?.width ?? 999) <= 390).toBe(true);

    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
    await expect(mainNav(page)).toBeHidden();
  });

  test('a tap outside closes it and goes no further; a link in it goes where it points', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const button = page.getByRole('button', { name: 'Menu' });

    await button.tap();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // A tap on the 3D view closes the menu, and is not a tap on the wall.
    await page.touchscreen.tap(300, 330);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/apps$/);

    await button.tap();
    await mainNav(page).getByRole('link', { name: 'Propose' }).tap();
    await expect(page).toHaveURL(/\/propose$/);
  });
});

test('every other page keeps the normal nav: no menu button, no strip, nothing that slides', async ({ page }) => {
  for (const path of ['/', '/contribute', '/propose']) {
    await page.goto(path);
    await expect(mainNav(page)).toBeVisible();
    await expect(page.locator('header[data-chrome]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show the site menu' })).toHaveCount(0);
  }
});
