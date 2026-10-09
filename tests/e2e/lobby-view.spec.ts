import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { holdKey, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';

/**
 * First person, third person or front, project `chromium-demo`.
 *
 * With robots on, the camera can sit behind your own robot, or in front of
 * it, so you can see what you're wearing: the View control under Exit, or V
 * to step through them. The page reports
 * the view as `data-view` and how your robot is doing as `data-self` on the
 * lobby root; no assertion reads pixels.
 */

const VIEW_STORAGE_ITEM = 'forge.lobby.view.v1';

function viewButton(page: Page, which: '1st person' | '3rd person' | 'Front') {
  return page.getByRole('group', { name: 'Camera view' }).getByRole('button', { name: which, exact: true });
}

function viewNote(page: Page) {
  return page.locator('[data-control="view"] [role="status"]');
}

test.describe('first or third person', () => {
  test.describe.configure({ timeout: 150_000 });

  test('V steps to third person (your robot shows), to the front, and back to first', async ({ page }) => {
    await serveFlags(page);
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-view', 'first');
    await expect(viewButton(page, '1st person')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('KeyV');
    await expect(root).toHaveAttribute('data-view', 'third');
    await expect(viewButton(page, '3rd person')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Third person · V to switch')).toBeVisible();
    // Loading, then your robot: the body is in.
    await expect(root).toHaveAttribute('data-self', 'ready', { timeout: 60_000 });
    await expect(viewNote(page)).toHaveText('Press V to switch.');

    await page.keyboard.press('KeyV');
    await expect(root).toHaveAttribute('data-view', 'front');
    await expect(viewButton(page, 'Front')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Front view · V to switch')).toBeVisible();
    await expect(root).toHaveAttribute('data-self', 'ready');

    await page.keyboard.press('KeyV');
    await expect(root).toHaveAttribute('data-view', 'first');
    await expect(root).toHaveAttribute('data-self', 'off', { timeout: 15_000 });
    await expect(viewButton(page, '1st person')).toHaveAttribute('aria-pressed', 'true');
  });

  test('your robot says it’s loading until the body is in', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/lobby/robot.glb', async (route) => {
      await held;
      await route.continue();
    });
    await serveFlags(page);
    await openLobby(page);
    await viewButton(page, '3rd person').click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-self', 'loading', { timeout: 15_000 });
    await expect(viewNote(page)).toContainText('Loading your robot…');
    release();
    await expect(lobbyRoot(page)).toHaveAttribute('data-self', 'ready', { timeout: 60_000 });
  });

  test('the choice is kept for next time', async ({ page }) => {
    await serveFlags(page);
    await openLobby(page);
    await viewButton(page, '3rd person').click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-view', 'third');
    expect(await page.evaluate((key) => window.localStorage.getItem(key), VIEW_STORAGE_ITEM)).toBe('third');

    await page.reload();
    await openLobby(page);
    await expect(lobbyRoot(page)).toHaveAttribute('data-view', 'third');
    await expect(viewButton(page, '3rd person')).toHaveAttribute('aria-pressed', 'true');
  });

  test('you still walk from your own eye in third person', async ({ page }) => {
    await serveFlags(page);
    await seedCamera(page, { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 });
    await openLobby(page);
    await viewButton(page, '3rd person').click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-view', 'third');
    const camera = await holdKey(page, 'KeyW', 300, (now) => now.z < -1);
    expect(camera.z).toBeLessThan(-1);
  });

  test('if the body can’t load, it says so, and Try again brings your robot', async ({ page }) => {
    let failing = true;
    await page.route('**/lobby/robot.glb', (route) => (failing ? route.abort('failed') : route.continue()));
    await serveFlags(page);
    await openLobby(page);
    await viewButton(page, '3rd person').click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-self', 'failed', { timeout: 60_000 });
    await expect(viewNote(page)).toContainText('Your robot didn’t load.');

    failing = false;
    await viewNote(page).getByRole('button', { name: 'Try again' }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-self', 'ready', { timeout: 60_000 });
    await expect(viewNote(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('with robots off, third person is disabled and says why', async ({ page }) => {
    await serveFlags(page, { lobby_avatars: false });
    await openLobby(page);
    await expect(viewButton(page, '3rd person')).toBeDisabled();
    await expect(viewButton(page, 'Front')).toBeDisabled();
    await expect(viewNote(page)).toHaveText('Robots are off in this lobby, so there’s no third person.');
    await page.keyboard.press('KeyV');
    await expect(page.getByText('No third person: robots are off in this lobby')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-view', 'first');
  });
});
