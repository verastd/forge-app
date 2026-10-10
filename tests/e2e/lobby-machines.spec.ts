import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { encodeAction } from '../../packages/lobby/dist/index.js';
import { addGhost, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';
import { signInAs } from './helpers/session';

/**
 * The mechanic's machines in the cave, project `chromium-demo`.
 *
 * The machines BFF is answered in the browser (page.route) by a little shop
 * of its own (`Shop` below), so each answer can be held to show the state the
 * page is in while it waits. The page says what it's doing on its root:
 * `data-machines` (how many), `data-mechanic`, `data-machine-busy`,
 * `data-machine-chosen` (the chosen blueprint's file: loading, ready, error),
 * `data-machine-fits`, `data-machine-target`, `data-machine-take-down` and
 * `data-machine-assembling`. No assertion reads pixels.
 *
 * The blueprint is `fixtures/engine.glb`: a block, a head on it and a pulley
 * in front, as three meshes. The camera is seeded looking down at the floor a
 * couple of metres ahead, where it fits.
 */

const ME = 'gh:4242';
const ENGINE = readFileSync(join(__dirname, 'fixtures', 'engine.glb'));
/** Two boxes as a STEP file: a "Block" with a "Cap" on it, each its own part. */
const ENGINE_STEP = readFileSync(join(__dirname, 'fixtures', 'engine.step'));
const SHA = createHash('sha256').update(ENGINE).digest('hex');
const STAMP = '2026-10-10T00:00:00+00:00';

interface Blueprint {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  parts: number;
  size: [number, number, number];
  uploadedBy: string;
  createdAt: string;
}

interface Machine {
  id: string;
  blueprint: string;
  name: string;
  sha256: string;
  bytes: number;
  parts: number;
  size: [number, number, number];
  x: number;
  z: number;
  turn: number;
  scale: number;
  builtBy: string;
  builtAt: string;
  updatedAt: string;
}

const V8: Blueprint = { id: 'b00000000001', name: 'V8', sha256: SHA, bytes: ENGINE.length, parts: 8, size: [2, 1.5, 3.2], uploadedBy: ME, createdAt: STAMP };
const builtV8 = (id: string, x: number, z: number): Machine => ({
  id,
  blueprint: V8.id,
  name: 'V8',
  sha256: SHA,
  bytes: ENGINE.length,
  parts: 8,
  size: V8.size,
  x,
  z,
  turn: 0,
  scale: 1,
  builtBy: ME,
  builtAt: STAMP,
  updatedAt: STAMP,
});

/** The machines BFF, in the page. */
class Shop {
  rev = 1;
  machines = new Map<string, Machine>();
  blueprints: Blueprint[] = [];
  calls: string[] = [];
  /** The next write's answer waits for `release()` while set. */
  hold = false;
  private waiting: (() => void) | null = null;
  refuse: { status: number; body: unknown } | null = null;
  libraryStatus = 200;
  admin = false;
  standIn = false;
  uploads: { name: string; parts: number; size: number[] }[] = [];
  /** The files sent, decoded. */
  sent: Buffer[] = [];
  made = 0;

  constructor(
    private readonly mechanic: boolean,
    initial: Machine[] = [],
  ) {
    for (const m of initial) this.machines.set(m.id, m);
  }

  release(): void {
    this.waiting?.();
    this.waiting = null;
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/bff\/lobby\/machines\/?/, '');
    const method = request.method();
    this.calls.push(`${method} ${path}`);
    const reply = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const me = () => ({ memberId: ME, mechanic: this.mechanic || this.standIn, canStandIn: this.admin, standIn: this.standIn });

    if (method === 'GET' && path === 'me') return reply(200, me());
    if (method === 'GET' && path === '') return reply(200, { rev: this.rev, full: true, machines: [...this.machines.values()], gone: [], now: new Date().toISOString() });
    if (method === 'GET' && path === 'blueprints') {
      if (this.libraryStatus !== 200) return reply(this.libraryStatus, { error: 'service_unreachable' });
      return reply(200, { blueprints: this.blueprints });
    }
    if (method === 'GET' && path.startsWith('assets/')) {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: ENGINE });
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
    if (method === 'POST' && path === 'blueprints') {
      const body = JSON.parse(request.postData() ?? '{}') as { name: string; parts: number; size: number[]; bytes: number; sha256: string };
      this.uploads.push({ name: body.name, parts: body.parts, size: body.size });
      return reply(200, { id: 'b00000000002', chunkBytes: 3 * 1024 * 1024, chunks: 1 });
    }
    if (method === 'PUT' && /^blueprints\/[0-9a-f]{12}\/chunks\/0$/.test(path)) {
      this.sent.push(Buffer.from((JSON.parse(request.postData() ?? '{}') as { data: string }).data, 'base64'));
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && /^blueprints\/[0-9a-f]{12}\/finish$/.test(path)) {
      const last = this.uploads[this.uploads.length - 1]!;
      const blueprint: Blueprint = { ...V8, id: 'b00000000002', name: last.name, parts: last.parts, size: last.size as [number, number, number] };
      this.blueprints.unshift(blueprint);
      return reply(200, blueprint);
    }
    if (method === 'DELETE' && path.startsWith('blueprints/')) {
      this.blueprints = this.blueprints.filter((b) => b.id !== path.slice('blueprints/'.length));
      return route.fulfill({ status: 204 });
    }
    this.rev += 1;
    if (method === 'POST' && path === '') {
      const body = JSON.parse(request.postData() ?? '{}') as { blueprint: string; x: number; z: number; turn: number; scale: number };
      const blueprint = this.blueprints.find((b) => b.id === body.blueprint)!;
      this.made += 1;
      const machine: Machine = {
        ...builtV8(`a0000000000${this.made}`, body.x, body.z),
        name: blueprint.name,
        turn: body.turn,
        scale: body.scale,
        builtAt: new Date().toISOString(),
      };
      this.machines.set(machine.id, machine);
      return reply(200, { rev: this.rev, machine });
    }
    if (method === 'DELETE' && /^[0-9a-f]{12}$/.test(path)) {
      if (!this.machines.delete(path)) return reply(404, { error: 'machine_not_found' });
      return reply(200, { rev: this.rev });
    }
    return reply(404, { error: 'not_found' });
  }
}

const toast = (page: Page, text: string) => page.locator('[aria-live="polite"]').filter({ hasText: text });
const shop = (page: Page) => page.getByRole('region', { name: 'Blueprints' });
const note = (page: Page) => page.locator('[data-control="machines"] > [role="status"]');

/** Into the cave looking down at the floor ahead. */
async function enter(page: Page, machines: Shop, at = { x: 0.4, z: 2.4 }): Promise<void> {
  await serveFlags(page, { lobby_avatars: true });
  await page.route('**/bff/lobby/machines**', (route) => machines.handle(route));
  await seedCamera(page, { x: at.x, y: 1.7, z: at.z, yaw: 0, pitch: 0.63 });
  await openLobby(page);
  await expect(lobbyRoot(page)).toHaveAttribute('data-machine-sync', 'ready', { timeout: 30_000 });
}

test.describe('the mechanic’s machines', () => {
  test.describe.configure({ timeout: 120_000 });

  test('everyone sees the machines; only the mechanic gets the tools', async ({ page }) => {
    const machines = new Shop(false, [builtV8('a00000000009', 5, 5)]);
    await enter(page, machines);
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '1');
    // Its blueprint arrives and it stands there, built (it was built long ago).
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-loading', '0', { timeout: 30_000 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-assembling', '');
    await expect(page.locator('[data-control="machines"]')).toHaveCount(0);
    expect(machines.calls.filter((c) => c.startsWith('GET assets/'))).toEqual([`GET assets/${SHA}/0`]);
  });

  test('the mechanic uploads a blueprint, each stage saying so, and it joins the library', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    await enter(page, machines);
    await expect(lobbyRoot(page)).toHaveAttribute('data-mechanic', 'yes');
    await expect(shop(page).getByText('No blueprints yet: upload a .glb or a STEP file to build from.')).toBeVisible();

    // Not a model: said so, nothing sent.
    const input = shop(page).locator('input[type=file]');
    await input.setInputFiles({ name: 'engine.txt', mimeType: 'text/plain', buffer: Buffer.from('an engine') });
    await expect(shop(page).getByRole('alert')).toContainText('A blueprint is a .glb file');
    await shop(page).getByRole('button', { name: 'OK' }).click();
    await expect(shop(page).getByRole('alert')).toHaveCount(0);

    machines.hold = true;
    await input.setInputFiles({ name: 'small_block-V8.glb', mimeType: 'model/gltf-binary', buffer: ENGINE });
    const uploading = shop(page).getByRole('button', { name: 'Uploading…' });
    await expect(uploading).toBeDisabled();
    await expect(uploading).toHaveAttribute('aria-busy', 'true');
    await expect(shop(page).getByText(/Uploading small block V8 \(\d+ parts\)… 0%/)).toBeVisible();
    await expect(shop(page).getByRole('button', { name: 'Cancel' })).toBeVisible();
    machines.release();
    await expect(toast(page, 'Added small block V8 to the library')).toBeVisible();
    await expect(shop(page).getByRole('button', { name: /^small block V8 \d+ parts/ })).toBeVisible();
    expect(machines.uploads).toHaveLength(1);
    expect(machines.uploads[0]!.parts).toBeGreaterThanOrEqual(3);
    // Its size, in its own units: the block is 2 wide, the head on it reaches 1.5 up, the pulley out front makes it 3.4 deep.
    expect(machines.uploads[0]!.size.map((n) => +n.toFixed(2))).toEqual([2, 1.5, 3.4]);
  });

  test('a STEP file goes through the CAD reader, keeps its own parts, and joins the library', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    await enter(page, machines);
    machines.hold = true;
    await shop(page).locator('input[type=file]').setInputFiles({ name: 'engine.step', mimeType: 'model/step', buffer: ENGINE_STEP });
    await expect(shop(page).getByRole('button', { name: 'Uploading…' })).toHaveAttribute('aria-busy', 'true');
    // The CAD reader loads, reads and meshes it (each stage said), then it goes up like any blueprint.
    await expect(shop(page).getByText(/Uploading engine \(2 parts\)… 0%/)).toBeVisible({ timeout: 60_000 });
    machines.release();
    await expect(toast(page, 'Added engine to the library: 2 parts')).toBeVisible();
    // Its two solids stay two parts, by name, in the .glb that was sent.
    expect(machines.uploads[0]!.parts).toBe(2);
    const glb = machines.sent[0]!;
    expect(glb.subarray(0, 4).toString()).toBe('glTF');
    expect(glb.includes('"Block"')).toBe(true);
    expect(glb.includes('"Cap"')).toBe(true);
    // Block 200×100×300 mm with a 50 mm cap on it: 150 tall.
    expect(machines.uploads[0]!.size.map((n) => Math.round(n))).toEqual([200, 150, 300]);
  });

  test('a STEP file the CAD reader can’t open says so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    await enter(page, machines);
    await shop(page).locator('input[type=file]').setInputFiles({ name: 'broken.stp', mimeType: 'model/step', buffer: Buffer.from('ISO-10303-21;\nnot really\n') });
    await expect(shop(page).getByRole('alert')).toContainText(/STEP/, { timeout: 60_000 });
    expect(machines.uploads).toHaveLength(0);
  });

  test('the library failing to load says so and tries again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    machines.libraryStatus = 503;
    await enter(page, machines);
    await expect(shop(page).getByText('Couldn’t load the library.')).toBeVisible();
    machines.libraryStatus = 200;
    machines.blueprints = [V8];
    await shop(page).getByRole('button', { name: 'Try again' }).click();
    await expect(shop(page).getByRole('button', { name: /V8 8 parts/ })).toBeVisible();
  });

  test('the mechanic chooses a blueprint, sees it fit, builds it, and everyone watches it go up', async ({ page, context, baseURL }) => {
    // The parts fly in only for those who haven't asked for less motion.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    machines.blueprints = [V8];
    await enter(page, machines);
    await shop(page).getByRole('button', { name: /V8 8 parts/ }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-chosen', 'ready', { timeout: 30_000 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-fits', 'yes');
    await expect(note(page)).toContainText('It fits: E builds it (8 parts)');
    await expect(lobbyRoot(page)).toHaveAttribute('data-motion', 'full');

    // Turned and sized, it still fits.
    await page.keyboard.press('KeyR');
    await page.keyboard.press('Minus');
    await expect(page.getByText('Size ×0.90')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-fits', 'yes');

    machines.hold = true;
    await page.keyboard.press('KeyE');
    const building = page.getByRole('group', { name: 'Build V8' }).getByRole('button', { name: /Building…/ });
    await expect(building).toHaveAttribute('aria-busy', 'true');
    await expect(note(page)).toContainText('Sending V8…');
    machines.release();
    await expect(toast(page, 'Building V8')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '1');
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-assembling', 'on');
    await expect(note(page)).toContainText(/Building V8: part \d+ of \d+/);
    // Put away after building.
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-chosen', '');
    const built = [...machines.machines.values()][0]!;
    expect(built.turn).toBe(1);
    expect(built.scale).toBeCloseTo(0.9);
    // Finished, it stands still.
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-assembling', '', { timeout: 60_000 });
  });

  test('a build the API refuses says why, and the blueprint stays out', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true);
    machines.blueprints = [V8];
    await enter(page, machines);
    await shop(page).getByRole('button', { name: /V8 8 parts/ }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-fits', 'yes', { timeout: 30_000 });
    machines.refuse = { status: 409, body: { error: 'machine_limit', limit: 40 } };
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'The cave is full: it holds 40 machines.')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '0');
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-chosen', 'ready');

    // Asking for less motion, a build stands there finished at once.
    await expect(lobbyRoot(page)).toHaveAttribute('data-motion', 'reduced');
    await page.keyboard.press('KeyE');
    await expect(toast(page, 'Building V8')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '1');
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-loading', '0');
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-assembling', '');
  });

  test('the mechanic takes a machine down, asked first, each step saying so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'mechanic' });
    const machines = new Shop(true, [builtV8('a00000000009', 0.4, 0)]);
    await enter(page, machines);
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-target', 'a00000000009');
    const takeDown = page.getByRole('group', { name: 'Machines' }).getByRole('button', { name: /Take down V8/ });
    await expect(takeDown).toBeEnabled();

    // Asked first: Cancel calls it off.
    await page.keyboard.press('Shift+KeyX');
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-take-down', 'armed');
    await expect(toast(page, 'Take down V8? Shift+X again to confirm.')).toBeVisible();
    await page.getByRole('group', { name: 'Machines' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machine-take-down', '');

    await takeDown.click();
    await expect(page.getByRole('group', { name: 'Machines' }).getByRole('button', { name: /Take down V8\?/ })).toBeVisible();
    machines.hold = true;
    await page.keyboard.press('Shift+KeyX');
    await expect(page.getByRole('group', { name: 'Machines' }).getByRole('button', { name: /Taking down…/ })).toHaveAttribute('aria-busy', 'true');
    machines.release();
    await expect(toast(page, 'Took down V8')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '0');
    expect(machines.calls).toContain('DELETE a00000000009');
  });

  test('an admin becomes the mechanic to test, and back', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'admin' });
    const machines = new Shop(false);
    machines.admin = true;
    await enter(page, machines);
    const be = page.getByRole('group', { name: 'Testing the mechanic' }).getByRole('button');
    await expect(be).toHaveText('Be the mechanic');
    await expect(shop(page)).toHaveCount(0);
    machines.hold = true;
    await be.click();
    await expect(be).toHaveText('Switching…');
    await expect(be).toHaveAttribute('aria-busy', 'true');
    machines.release();
    await expect(be).toHaveText('Being the mechanic');
    await expect(toast(page, 'You’re the mechanic now')).toBeVisible();
    await expect(shop(page)).toBeVisible();
    await be.click();
    await expect(be).toHaveText('Be the mechanic');
    await expect(shop(page)).toHaveCount(0);
  });

  test('a ping from someone else brings their new machine', async ({ page }) => {
    const machines = new Shop(false);
    await enter(page, machines);
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '0');
    await addGhost(page, 'practice-0e0e0e', 'mechanic', { x: 0, y: 1.7, z: -4 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
    machines.machines.set('a00000000007', { ...builtV8('a00000000007', 3, 3), builtAt: new Date().toISOString() });
    machines.rev = 2;
    await page.evaluate(
      ({ id, act }) => {
        const ghost = (window as unknown as { __ghosts: Record<string, { channel: BroadcastChannel }> }).__ghosts[id];
        ghost?.channel.postMessage({ type: 'act', id, act });
      },
      { id: 'practice-0e0e0e', act: encodeAction({ kind: 'machines', rev: 2 }) },
    );
    await expect(lobbyRoot(page)).toHaveAttribute('data-machines', '1', { timeout: 5_000 });
    expect(machines.calls.filter((c) => c === 'GET ').length).toBeGreaterThanOrEqual(2);
  });
});
