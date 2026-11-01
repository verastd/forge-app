import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { addGhost, lobbyRoot, openLobby, removeGhost, serveFlags } from './helpers/lobby';
import { signInAs } from './helpers/session';

/**
 * The cave's helper bots (with `lobby_avatars`), project `chromium-demo`.
 *
 * One bot goes round the cave's edge, just outside where anyone can build,
 * until somebody comes up to it: then it stops for them, and once they've
 * gone it carries on. The page reports what it's doing as `data-helpers`
 * (`patrolling` or `stopped`), where it is as `data-helper-at` (`x,z`), and
 * whether it's drawn as a robot yet as `data-helper-robots`. Someone coming
 * up to it is a ghost: another practice tab, played from inside the page.
 * No assertion reads pixels.
 */

const GHOST = 'practice-0b07b0';
/** The loop's radius: the walking disk's edge (25.36 m) less a body (0.45 m). */
const LOOP = 24.91;

async function helperAt(root: Locator): Promise<{ x: number; z: number }> {
  const [x, z] = ((await root.getAttribute('data-helper-at')) ?? '').split(',').map(Number);
  return { x: x ?? Number.NaN, z: z ?? Number.NaN };
}

test.describe('the helper bot', () => {
  test.describe.configure({ timeout: 180_000 });

  test('goes round the cave’s edge as a robot, and isn’t counted among the people', async ({ page }) => {
    await serveFlags(page);
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-helper-robots', '1', { timeout: 90_000 });
    await expect(root).toHaveAttribute('data-helpers', 'patrolling');
    const start = await helperAt(root);
    expect(Math.hypot(start.x, start.z)).toBeCloseTo(LOOP, 1);
    // It moves on, along the loop.
    await expect
      .poll(async () => {
        const now = await helperAt(root);
        return Math.hypot(now.x - start.x, now.z - start.z);
      }, { timeout: 30_000 })
      .toBeGreaterThan(1);
    const later = await helperAt(root);
    expect(Math.hypot(later.x, later.z)).toBeCloseTo(LOOP, 1);
    // Nobody else is here: the bot is no person, and no member's robot.
    await expect(root).toHaveAttribute('data-peers', '0');
    await expect(root).toHaveAttribute('data-robots', '0');
  });

  test('stops for someone who comes up to it, and carries on once they’ve gone', async ({ page }) => {
    await serveFlags(page);
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-helpers', 'patrolling', { timeout: 90_000 });

    // Someone just inside its loop, where it is now: within reach whatever it does before they arrive.
    const at = await helperAt(root);
    await addGhost(page, GHOST, 'visitor', { x: at.x * 0.96, y: 1.7, z: at.z * 0.96 });
    await expect(root).toHaveAttribute('data-helpers', 'stopped', { timeout: 30_000 });
    // It waits where it stopped (once it has slowed to a halt, within a second).
    await page.waitForTimeout(2_000);
    const stopped = await helperAt(root);
    await page.waitForTimeout(4_000);
    const waited = await helperAt(root);
    expect(Math.hypot(waited.x - stopped.x, waited.z - stopped.z)).toBeLessThan(0.2);
    await expect(root).toHaveAttribute('data-helpers', 'stopped');

    // Gone: it lingers a moment, then turns back to its way and goes on.
    await removeGhost(page, GHOST);
    await expect(root).toHaveAttribute('data-helpers', 'patrolling', { timeout: 30_000 });
    await expect
      .poll(async () => {
        const now = await helperAt(root);
        return Math.hypot(now.x - waited.x, now.z - waited.z);
      }, { timeout: 30_000 })
      .toBeGreaterThan(1);
  });

  test('with lobby_avatars off, there is no helper bot', async ({ page }) => {
    await serveFlags(page, { lobby_avatars: false });
    await openLobby(page);
    const root = lobbyRoot(page);
    await page.waitForTimeout(2_000);
    await expect(root).not.toHaveAttribute('data-helpers', /.*/);
    await expect(root).not.toHaveAttribute('data-helper-robots', /.*/);
  });
});

test.describe('the avatar editor', () => {
  test.describe.configure({ timeout: 90_000 });

  test('lists the helper bot first, as a lobby bot that wears its own helper head', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    const members = {
      members: [
        { memberId: 'bot:helper', login: 'helper-bot' },
        { memberId: 'gh:1001', login: 'octo-alice' },
      ],
    };
    await page.route('**/bff/avatars/members', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(members) }),
    );
    await page.route('**/bff/avatars', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avatars: [], heads: [] }) }),
    );
    await page.goto('/me/avatars');
    await expect(page.getByRole('heading', { name: '@helper-bot', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /@helper-bot/ })).toContainText('Lobby bot');
    await expect(page.getByRole('button', { name: /@octo-alice/ })).not.toContainText('Lobby bot');
    await expect(page.getByRole('group', { name: 'Head' }).getByRole('button', { name: /Its own head/ })).toContainText(
      'The helper head, beacon and all',
    );
    // Its preview wears the head it ships with: loading, then ready (or saying it can't, with a way to try again).
    await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview', /^(ready|error)$/, { timeout: 60_000 });
  });
});
