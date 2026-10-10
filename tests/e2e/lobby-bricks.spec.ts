import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { encodeAction } from '../../packages/lobby/dist/index.js';
import { addGhost, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';
import { signInAs } from './helpers/session';

/**
 * Building with bricks in the cave, project `chromium-demo`.
 *
 * The bricks BFF is answered in the browser (page.route) by a little cave of
 * its own (`Cave` below), so each answer can be held to show the state the
 * page is in while it waits. The page says what it's doing on its root:
 * `data-bricks` (how many), `data-held` (the shape in your hand),
 * `data-brick-busy`, `data-aim` (fits / blocked) and `data-brick-target`
 * (pick / frozen). No assertion reads pixels.
 *
 * The camera is seeded looking down at the floor a couple of metres ahead,
 * well within reach.
 */

interface Brick {
  id: string;
  shape: string;
  color: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  holder?: string;
  updatedAt: string;
}

const ME = 'gh:4242';
const STAMP = '2026-10-10T00:00:00+00:00';
const brick = (id: string, x: number, y: number, z: number, shape = 'brick-2x4'): Brick => ({
  id,
  shape,
  color: 'red',
  x,
  y,
  z,
  rot: 0,
  updatedAt: STAMP,
});

/** The bricks BFF, in the page: its bricks, its revision, and every call it was asked. */
class Cave {
  rev = 1;
  bricks = new Map<string, Brick>();
  calls: string[] = [];
  /** The next write's answer waits for `release()` while set. */
  hold = false;
  private waiting: (() => void) | null = null;
  /** What the next write is answered with instead, once. */
  refuse: { status: number; body: unknown } | null = null;
  listStatus = 200;
  made = 0;

  constructor(
    private readonly maker: boolean,
    initial: Brick[] = [],
  ) {
    for (const b of initial) this.bricks.set(b.id, b);
  }

  release(): void {
    this.waiting?.();
    this.waiting = null;
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/bff\/lobby\/bricks\/?/, '');
    const method = request.method();
    this.calls.push(`${method} ${path}${url.search}`);
    const reply = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (method === 'GET' && path === 'me') return reply(200, { memberId: ME, maker: this.maker });
    if (method === 'GET' && path === '') {
      if (this.listStatus !== 200) return reply(this.listStatus, { error: 'service_unreachable' });
      return reply(200, { rev: this.rev, full: true, bricks: [...this.bricks.values()], gone: [] });
    }
    if (this.hold) {
      this.hold = false;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
    if (this.refuse) {
      const { status, body } = this.refuse;
      this.refuse = null;
      return reply(status, body);
    }
    this.rev += 1;
    if (method === 'POST' && path === '') {
      const body = JSON.parse(request.postData() ?? '{}') as { shape: string; color: string };
      this.made += 1;
      const made: Brick = { ...brick(`00000000000${this.made}`, 0, 0, 0, body.shape), color: body.color, holder: ME };
      this.bricks.set(made.id, made);
      return reply(200, { rev: this.rev, brick: made });
    }
    const [id, verb] = path.split('/');
    const found = id ? this.bricks.get(id) : undefined;
    if (!found) return reply(404, { error: 'brick_not_found' });
    if (method === 'PUT' && verb === 'pick') {
      found.holder = ME;
      return reply(200, { rev: this.rev, brick: found });
    }
    if (method === 'PUT' && verb === 'place') {
      const at = JSON.parse(request.postData() ?? '{}') as { x: number; y: number; z: number; rot: number };
      const placed: Brick = { ...found, ...at };
      delete placed.holder;
      this.bricks.set(found.id, placed);
      return reply(200, { rev: this.rev, brick: placed });
    }
    if (method === 'DELETE') {
      this.bricks.delete(found.id);
      return reply(200, { rev: this.rev });
    }
    return reply(404, { error: 'not_found' });
  }
}

const toast = (page: Page, text: string) => page.locator('[aria-live="polite"]').filter({ hasText: text });
const build = (page: Page) => page.getByRole('group', { name: 'Build' });
const note = (page: Page) => page.locator('[data-control="build"] [role="status"]');

/** Into the cave looking down at the floor ahead (a 2×4 at the origin is right under the crosshair). */
async function enter(page: Page, cave: Cave, at = { x: 0.4, z: 2.4 }): Promise<void> {
  await serveFlags(page, { lobby_avatars: true });
  await page.route('**/bff/lobby/bricks**', (route) => cave.handle(route));
  await seedCamera(page, { x: at.x, y: 1.7, z: at.z, yaw: 0, pitch: 0.63 });
  await openLobby(page);
  await expect(lobbyRoot(page)).toHaveAttribute('data-brick-sync', 'ready', { timeout: 30_000 });
}

test.describe('building with bricks', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the practice account sees the build and is told how to join in', async ({ page }) => {
    // The demo server's lobby is the practice account's: it only looks.
    const cave = new Cave(false, [brick('aaaaaaaaaaaa', 0, 0, 0)]);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '1');
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-access', 'practice');
    await expect(note(page)).toContainText('The practice account can only look: sign in with GitHub to build.');
    await expect(note(page)).toContainText('1 / 5,000 bricks');
    await expect(build(page).getByRole('button', { name: /Pick up/ })).toBeDisabled();
    // The keys say so too, rather than doing nothing.
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'The practice account can’t build')).toBeVisible();
    expect(cave.calls.some((c) => c.startsWith('PUT') || c === 'GET me')).toBe(false);
  });

  test('the Lego bot makes a brick, places it, and removes it, each step saying so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'lego-bot' });
    const cave = new Cave(true);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-access', 'member');
    const maker = page.getByRole('group', { name: 'Make bricks' });
    await expect(maker).toBeVisible();
    await expect(note(page)).toContainText('You’re the Lego bot: B makes a brick.');

    // Choose a 2×2 (key 4) in blue (C), then make it: Making… until the API answers.
    await page.keyboard.press('Digit4');
    await page.keyboard.press('KeyC');
    await expect(maker.getByLabel('Brick shape')).toHaveValue('3');
    await expect(maker.getByLabel('Brick colour')).toHaveValue('1');
    cave.hold = true;
    await page.keyboard.press('KeyB');
    const making = maker.getByRole('button', { name: /Making…/ });
    await expect(making).toBeDisabled();
    await expect(making).toHaveAttribute('aria-busy', 'true');
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-busy', 'making');
    cave.release();
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', 'brick-2x2');
    await expect(toast(page, 'Blue 2×2 brick made')).toBeVisible();
    expect(cave.calls).toContain('POST ');

    // Held: the ghost fits on the floor ahead. Placing… until the API answers, then on the floor.
    await expect(lobbyRoot(page)).toHaveAttribute('data-aim', 'fits');
    await expect(note(page)).toContainText('It fits: E to place it');
    cave.hold = true;
    await build(page).getByRole('button', { name: /Place/ }).click();
    await expect(build(page).getByRole('button', { name: /Placing…/ })).toHaveAttribute('aria-busy', 'true');
    cave.release();
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', '');
    await expect(toast(page, 'Placed')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '1');
    const placed = [...cave.bricks.values()][0]!;
    expect(placed.holder).toBeUndefined();

    // Pointing at it now: the Lego bot can remove it.
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-target', 'pick');
    cave.hold = true;
    await page.keyboard.press('KeyX');
    await expect(build(page).getByRole('button', { name: /Removing…/ })).toHaveAttribute('aria-busy', 'true');
    cave.release();
    await expect(toast(page, 'Removed a 2×2 brick')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '0');
  });

  test('a visitor picks up a loose brick; a refused place puts it back in their hand, in words', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'visitor' });
    const cave = new Cave(false, [brick('aaaaaaaaaaaa', 0, 0, 0)]);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-access', 'member');
    await expect(page.getByRole('group', { name: 'Make bricks' })).toHaveCount(0);
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-target', 'pick');
    await expect(note(page)).toContainText('A 2×4 brick: E to pick it up.');

    cave.hold = true;
    await page.keyboard.press('KeyE');
    await expect(build(page).getByRole('button', { name: /Picking up…/ })).toHaveAttribute('aria-busy', 'true');
    cave.release();
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', 'brick-2x4');
    await expect(toast(page, 'Picked up a 2×4 brick')).toBeVisible();

    // Turn it, then the API refuses the spot: back in the hand, and why.
    await page.keyboard.press('KeyR');
    await expect(lobbyRoot(page)).toHaveAttribute('data-aim', 'fits');
    cave.refuse = { status: 409, body: { error: 'wont_fit', problem: 'overlap' } };
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'It would overlap a brick.')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', 'brick-2x4');

    // Q drops it on the floor in front.
    await page.keyboard.press('KeyQ');
    await expect(toast(page, 'Dropped on the floor')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', '');
  });

  test('a brick fastened to another is frozen for visitors', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'visitor' });
    const cave = new Cave(false, [brick('aaaaaaaaaaaa', 0, 0, 0), brick('bbbbbbbbbbbb', 0, 3, 0)]);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-target', 'frozen');
    await expect(note(page)).toContainText('Part of a build: only the Lego bot can take it out.');
    await expect(build(page).getByRole('button', { name: /Pick up/ })).toBeDisabled();
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'Part of a build')).toBeVisible();
    expect(cave.calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  test('the build failing to load says so, and Try again loads it', async ({ page }) => {
    const cave = new Cave(false, [brick('aaaaaaaaaaaa', 0, 0, 0)]);
    cave.listStatus = 502;
    await serveFlags(page, { lobby_avatars: true });
    await page.route('**/bff/lobby/bricks**', (route) => cave.handle(route));
    await seedCamera(page, { x: 0.4, y: 1.7, z: 2.4, yaw: 0, pitch: 0.63 });
    await openLobby(page);
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-sync', 'error', { timeout: 30_000 });
    await expect(note(page)).toContainText('Couldn’t load the bricks.');
    cave.listStatus = 200;
    await page.locator('[data-control="build"]').getByRole('button', { name: 'Try again' }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-sync', 'ready');
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '1');
  });

  test('a ping from someone else brings their change at once', async ({ page }) => {
    const cave = new Cave(false);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '0');
    await addGhost(page, 'practice-0e0e0e', 'builder', { x: 0, y: 1.7, z: -4 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
    cave.bricks.set('cccccccccccc', brick('cccccccccccc', 5, 0, 5));
    cave.rev = 7;
    await page.evaluate(
      ({ id, act }) => {
        const ghost = (window as unknown as { __ghosts: Record<string, { channel: BroadcastChannel }> }).__ghosts[id];
        ghost?.channel.postMessage({ type: 'act', id, act });
      },
      { id: 'practice-0e0e0e', act: encodeAction({ kind: 'bricks', rev: 7 }) },
    );
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '1', { timeout: 5_000 });
    expect(cave.calls.some((c) => c.startsWith('GET ?since='))).toBe(true);
  });
});
