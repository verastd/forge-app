import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { encodeAction } from '../../packages/lobby/dist/index.js';
import { addGhost, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';
import { demoSignIn, signInAs } from './helpers/session';
import { assertionClaims, json, withStandIn } from './helpers/standin';

/**
 * Building with bricks in the cave, project `chromium-demo`.
 *
 * The bricks BFF is answered in the browser (page.route) by a little cave of
 * its own (`Cave` below), so each answer can be held to show the state the
 * page is in while it waits. The page says what it's doing on its root:
 * `data-bricks` (how many), `data-held` (the shape in your hand),
 * `data-brick-busy`, `data-aim` (fits / blocked), `data-brick-target`
 * (pick / frozen) and `data-brick-take-down` (how many bricks a take-down
 * waiting to be confirmed would take). No assertion reads pixels.
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
  build?: string;
  updatedAt: string;
}

const ME = 'gh:4242';
const TOWER = readFileSync(join(__dirname, 'fixtures', 'tower.ldr'));
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
  /** The blueprints built, by name. */
  builds: string[] = [];

  /** An admin's "Be the Lego bot", for testing (`admin` says whether they may). */
  admin = false;
  standIn = false;

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

    const me = () => ({ memberId: ME, maker: this.maker || this.standIn, canStandIn: this.admin, standIn: this.standIn });
    if (method === 'GET' && path === 'me') return reply(200, me());
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
    if (method === 'PUT' && path === 'me/stand-in') {
      if (!this.admin) return reply(403, { error: 'admin_only' });
      this.standIn = (JSON.parse(request.postData() ?? '{}') as { on: boolean }).on;
      return reply(200, me());
    }
    this.rev += 1;
    if (method === 'POST' && path === 'build') {
      const body = JSON.parse(request.postData() ?? '{}') as { name: string; bricks: Omit<Brick, 'id' | 'updatedAt'>[] };
      this.builds.push(body.name);
      const buildId = (0xbd0000000000 + this.builds.length).toString(16);
      for (const piece of body.bricks) {
        this.made += 1;
        const id = (0xb00000000000 + this.made).toString(16);
        this.bricks.set(id, { ...piece, id, build: buildId, updatedAt: STAMP });
      }
      return reply(200, { rev: this.rev, built: body.bricks.length, build: buildId });
    }
    if (method === 'DELETE' && path.startsWith('builds/')) {
      const buildId = path.slice('builds/'.length);
      const of = [...this.bricks.values()].filter((b) => b.build === buildId);
      if (of.length === 0) return reply(404, { error: 'build_not_found' });
      for (const b of of) this.bricks.delete(b.id);
      return reply(200, { rev: this.rev, removed: of.length });
    }
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

  test('an admin can be the Lego bot to test it, and stop, each switch saying so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    const cave = new Cave(false);
    cave.admin = true;
    await enter(page, cave);
    const testing = page.getByRole('group', { name: 'Testing' });
    const toggle = testing.getByRole('button', { name: /Be the Lego bot/ });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('group', { name: 'Make bricks' })).toHaveCount(0);

    cave.hold = true;
    await toggle.click();
    const switching = testing.getByRole('button', { name: /Switching…/ });
    await expect(switching).toHaveAttribute('aria-busy', 'true');
    await expect(switching).toBeDisabled();
    await expect(note(page)).toContainText('Switching…');
    cave.release();
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-stand-in', 'on');
    await expect(toast(page, 'You’re the Lego bot now (testing)')).toBeVisible();
    await expect(testing.getByRole('button', { name: /Being the Lego bot/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Make bricks' })).toBeVisible();
    await expect(note(page)).toContainText('Testing as the Lego bot: B makes a brick.');
    // The Lego bot's keys work now.
    await page.keyboard.press('KeyB');
    await expect(lobbyRoot(page)).toHaveAttribute('data-held', 'brick-2x4');

    await testing.getByRole('button', { name: /Being the Lego bot/ }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-stand-in', 'off');
    await expect(toast(page, 'Back to yourself')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Make bricks' })).toHaveCount(0);
  });

  test('a visitor has no Lego bot switch', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'visitor' });
    await enter(page, new Cave(false));
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-access', 'member');
    await expect(page.getByRole('group', { name: 'Testing' })).toHaveCount(0);
  });

  test('the Lego bot loads a blueprint, sees it fit, builds it all at once, and puts it away', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'lego-bot' });
    const cave = new Cave(true);
    await enter(page, cave);
    const group = page.getByRole('group', { name: 'Blueprint' });
    await expect(group.getByRole('button', { name: 'Load blueprint…' })).toBeEnabled();
    await group.locator('input[type=file]').setInputFiles({ name: 'tower.ldr', mimeType: 'text/plain', buffer: TOWER });
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint', 'out');
    await expect(toast(page, 'Tower: 4 bricks · E builds it where the ghost is')).toBeVisible();
    await expect(page.locator('[data-control="build"]').getByText('1 part skipped: 1 not one of our shapes.')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint-fits', 'yes');
    await expect(note(page)).toContainText('It fits: E builds all 4 bricks');
    // While it's out, the hands wait, and B says why.
    await expect(build(page).getByRole('button', { name: /Pick up/ })).toBeDisabled();
    await page.keyboard.press('KeyB');
    await expect(toast(page, 'Put the blueprint away first')).toBeVisible();

    // R turns it; it still fits.
    await page.keyboard.press('KeyR');
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint-fits', 'yes');

    cave.hold = true;
    await page.keyboard.press('KeyE');
    const building = group.getByRole('button', { name: /Building…/ });
    await expect(building).toHaveAttribute('aria-busy', 'true');
    await expect(building).toBeDisabled();
    await expect(note(page)).toContainText('Building Tower: 4 bricks…');
    cave.release();
    await expect(toast(page, 'Built Tower: 4 bricks')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '4');
    expect(cave.builds).toEqual(['Tower']);
    // Built, the same spot is taken: the ghost says so.
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint-fits', 'no');
    await expect(note(page)).toContainText('won’t fit here: It would overlap a brick.');

    await page.keyboard.press('KeyQ');
    await expect(toast(page, 'Blueprint put away')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint', '');
  });

  test('a file that isn’t a blueprint, and a build the API refuses, each say why', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'lego-bot' });
    const cave = new Cave(true);
    await enter(page, cave);
    const input = page.getByRole('group', { name: 'Blueprint' }).locator('input[type=file]');
    await input.setInputFiles({ name: 'notes.ldr', mimeType: 'text/plain', buffer: Buffer.from('0 just some notes\n') });
    await expect(toast(page, 'That file has no LDraw parts in it.')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint', '');

    await input.setInputFiles({ name: 'tower.ldr', mimeType: 'text/plain', buffer: TOWER });
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint-fits', 'yes');
    cave.refuse = { status: 409, body: { error: 'brick_limit', limit: 5000, room: 2 } };
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'The cave is full')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '0');
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint', 'out');
  });

  test('a blueprint with bricks in the air (their support a part we skip) still goes down on the floor and builds', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'lego-bot' });
    const cave = new Cave(true);
    await enter(page, cave);
    // A 2×4 on the floor, a 1×6 we don't make on it, and a 2×2 on that: the 2×2 rests on nothing we build.
    const gappy = ['0 Name: Gappy', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '1 15 0 -24 10 1 0 0 0 1 0 0 0 1 3009.dat', '1 1 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat'].join('\n');
    await page.getByRole('group', { name: 'Blueprint' }).locator('input[type=file]').setInputFiles({ name: 'gappy.ldr', mimeType: 'text/plain', buffer: Buffer.from(gappy) });
    await expect(lobbyRoot(page)).toHaveAttribute('data-blueprint-fits', 'yes');
    await expect(note(page)).toContainText('It fits: E builds all 2 bricks');
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'Built Gappy: 2 bricks')).toBeVisible();
    const bricks = [...cave.bricks.values()];
    expect(bricks.map((b) => b.y).sort((x, y) => x - y)).toEqual([0, 6]);
  });

  test('the Lego bot takes down a whole blueprint build at once, asked first, each step saying so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'lego-bot' });
    const BUILD = 'bd0000000009';
    const ofBuild = (id: string, y: number): Brick => ({ ...brick(id, 0, y, 0), build: BUILD });
    const cave = new Cave(true, [ofBuild('a00000000001', 0), ofBuild('a00000000002', 3), ofBuild('a00000000003', 6), brick('a00000000004', 30, 0, 30)]);
    await enter(page, cave);
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '4');
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-target', 'pick');
    await expect(note(page)).toContainText('of a 3-brick build: E to pick it up, X to remove it, Shift+X to take down the whole build.');
    const takeDown = build(page).getByRole('button', { name: /Take down build/ });
    await expect(takeDown).toBeEnabled();

    // Asked first: Cancel calls it off.
    await page.keyboard.press('Shift+KeyX');
    await build(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-take-down', '');
    await expect(takeDown).toBeVisible();
    expect(cave.calls.some((call) => call.startsWith('DELETE'))).toBe(false);

    // Asked again: the button, the line and a toast say how many.
    await page.keyboard.press('Shift+KeyX');
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-take-down', '3');
    await expect(build(page).getByRole('button', { name: /Take down all 3\?/ })).toHaveAttribute('data-take-down', 'confirm');
    await expect(note(page)).toContainText('Take down all 3 bricks of the outlined build?');
    await expect(toast(page, 'Take down all 3 bricks of this build? Shift+X again to confirm.')).toBeVisible();

    // Refused: every brick comes back, and the toast says why.
    cave.refuse = { status: 404, body: { error: 'build_not_found' } };
    await page.keyboard.press('Shift+KeyX');
    await expect(toast(page, 'That build is already gone.')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '4');

    // Confirmed with the button: Taking down… until the API answers, then all of it is gone at once.
    await page.keyboard.press('Shift+KeyX');
    cave.hold = true;
    await build(page).getByRole('button', { name: /Take down all 3\?/ }).click();
    const taking = build(page).getByRole('button', { name: /Taking down…/ });
    await expect(taking).toHaveAttribute('aria-busy', 'true');
    await expect(taking).toBeDisabled();
    await expect(note(page)).toContainText('Taking down the build…');
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-busy', 'taking-down');
    cave.release();
    await expect(toast(page, 'Took down a build: 3 bricks')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-bricks', '1');
    expect(cave.calls).toContain(`DELETE builds/${BUILD}`);
    expect([...cave.bricks.keys()]).toEqual(['a00000000004']);
    // Nothing of a build to point at now: the button waits, and Shift+X says what it needs.
    await expect(takeDown).toBeDisabled();
    await page.keyboard.press('Shift+KeyX');
    await expect(toast(page, 'Point at a brick of a blueprint build')).toBeVisible();
  });

  test('only the Lego bot gets blueprints', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'visitor' });
    await enter(page, new Cave(false));
    await expect(lobbyRoot(page)).toHaveAttribute('data-brick-access', 'member');
    await expect(page.getByRole('group', { name: 'Blueprint' })).toHaveCount(0);
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

test.describe('the bricks BFF, against a stand-in API', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  const LIST = { rev: 3, full: true, bricks: [brick('aaaaaaaaaaaa', 0, 0, 0)], gone: [] };

  test('the build goes up as nobody, even for the practice account; building needs you, as you', async ({ page, context, baseURL }) => {
    const base = baseURL ?? '';
    await withStandIn(
      (request) =>
        request.path.startsWith('/api/lobby/bricks?') || request.path === '/api/lobby/bricks'
          ? request.method === 'GET'
            ? json(200, LIST)
            : json(200, { rev: 4, brick: { ...brick('dddddddddddd', 0, 0, 0), holder: 'gh:4242' } })
          : request.path === '/api/lobby/bricks/me'
            ? json(200, { memberId: 'gh:4242', maker: true, canStandIn: false, standIn: false })
            : request.path === '/api/lobby/bricks/build'
              ? json(200, { rev: 9, built: 900 })
              : request.path === '/api/lobby/bricks/me/stand-in'
              ? json(200, { memberId: 'gh:4242', maker: true, canStandIn: true, standIn: true })
            : undefined,
      async (seen) => {
        // Signed out: the build, as nobody; a since is passed on, anything else is refused here.
        const list = await context.request.get('/bff/lobby/bricks?since=2');
        expect(list.status()).toBe(200);
        expect(await list.json()).toEqual(LIST);
        expect(seen.at(-1)?.path).toBe('/api/lobby/bricks?since=2');
        expect(seen.at(-1)?.authorization).toBeNull();
        expect((await context.request.get('/bff/lobby/bricks?since=-1')).status()).toBe(400);
        expect((await context.request.get('/bff/lobby/bricks/me')).status()).toBe(401);
        expect((await context.request.get('/bff/lobby/bricks/nope')).status()).toBe(404);

        // The practice account: still sees the build (as nobody), still can't build.
        await page.goto('/signin');
        await demoSignIn(page);
        const practice = await context.request.get('/bff/lobby/bricks');
        expect(practice.status()).toBe(200);
        expect(seen.at(-1)?.authorization).toBeNull();
        expect((await context.request.get('/bff/lobby/bricks/me')).status()).toBe(403);

        // Signed in with GitHub: who you are, and a brick made as you.
        await context.clearCookies();
        await signInAs(context, base, { sub: '4242', login: 'lego-bot' });
        expect(await (await context.request.get('/bff/lobby/bricks/me')).json()).toEqual({
          memberId: 'gh:4242',
          maker: true,
          canStandIn: false,
          standIn: false,
        });
        const blueprint = { name: 'Wall', bricks: Array.from({ length: 900 }, (_, i) => ({ shape: 'brick-1x1', color: 'red', x: i % 30, y: 0, z: Math.floor(i / 30), rot: 0 })) };
        const built = await context.request.post('/bff/lobby/bricks/build', { data: blueprint, headers: { origin: base } });
        expect(built.status()).toBe(200);
        expect(seen.at(-1)?.path).toBe('/api/lobby/bricks/build');
        expect(JSON.parse(seen.at(-1)?.body ?? '{}').bricks).toHaveLength(900);
        const standIn = await context.request.put('/bff/lobby/bricks/me/stand-in', { data: { on: true }, headers: { origin: base } });
        expect(standIn.status()).toBe(200);
        expect(seen.at(-1)?.method).toBe('PUT');
        expect(seen.at(-1)?.path).toBe('/api/lobby/bricks/me/stand-in');
        expect(assertionClaims(seen.at(-1)?.authorization)).toMatchObject({ sub: '4242' });
        expect(assertionClaims(seen.at(-1)?.authorization)).toMatchObject({ sub: '4242' });
        const made = await context.request.post('/bff/lobby/bricks', {
          data: { shape: 'brick-1x1', color: 'red' },
          headers: { origin: base },
        });
        expect(made.status()).toBe(200);
        expect(seen.at(-1)?.method).toBe('POST');
        expect(assertionClaims(seen.at(-1)?.authorization)).toMatchObject({ sub: '4242' });
      },
    );
  });
});
