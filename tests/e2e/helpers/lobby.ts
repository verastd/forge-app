/**
 * Driving the Apps lobby (`/apps`) from a test: its state, its camera, and
 * taps on its 3D view.
 *
 * The lobby is a WebGL2 scene (plain three.js) drawn by Chromium's software
 * GL, SwiftShader (`playwright.config.ts` pins it), so nothing here reads
 * pixels. The page reports on itself through its root element instead,
 * `<div data-lobby>` (apps/web/src/components/lobby/Lobby.tsx):
 * `data-lobby-state`, the camera as `data-x/y/z/yaw/pitch` (written by the frame
 * loop, so absent until the first frame), what the crosshair is on as
 * `data-focus`, and the presence feed as `data-feed`, `data-peers`,
 * `data-voice`, `data-sound`, `data-room-sound` and `data-deafened`. The
 * people panel ("People nearby") lists everyone else in the room, one row
 * per person, each marked `data-person-id`.
 *
 * SwiftShader renders this scene at about one frame a second, and the scene
 * only moves on frames: every wait below polls the attributes rather than
 * sleeping a fixed time.
 *
 * `/apps` needs a sign-in: `gotoLobby` and `openLobby` sign in with the
 * practice account when the visit lands on `/signin`.
 *
 * Module resolution: `@forge/lobby` is a dependency of `apps/web` only, so,
 * as `helpers/session.ts` does for `@forge/auth`, it is imported from its
 * built `dist` by relative path, which needs `make setup` first. That keeps
 * the wall's geometry and the camera's starting pose here the same numbers
 * the scene itself uses.
 */
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  CAMERA_STORAGE_ITEM,
  INITIAL_CAMERA,
  appAt,
  appBySlug,
  encodePosition,
  slotFromIndex,
  slotIndex,
  slotPose,
} from '../../../packages/lobby/dist/index.js';
import type { CameraState } from '../../../packages/lobby/dist/index.js';
import { demoSignIn } from './session';

/**
 * How long `/apps` may take to reach `ready`: the dev server compiles the
 * route and the scene's chunk on first use (about 30 s cold), then the scene
 * spreads its heavy build over a dozen software-rendered frames.
 */
export const READY_TIMEOUT = 75_000;

/** The directory link's exact accessible name, `${title}: ${description}` from the registry. */
export const DATA_LINK = 'Data: Upland blockchain data';

const data = appBySlug('data');
if (data === undefined) {
  throw new Error('the lobby registry has no Data app');
}
const dataSlot = data.slot;
/** The Data app's slot on the wall: 0, the bottom panel straight ahead of the spawn point. */
export const DATA_SLOT = slotIndex(dataSlot);

/**
 * An empty slot in view from the spawn point on any screen, a phone held
 * upright included: the panel straight above Data's (column 0, row 1).
 */
export const EMPTY_ABOVE_DATA = slotIndex({ col: data.slot.col, row: data.slot.row + 1 });

/** The scene camera's vertical field of view, in degrees (createCave.ts's PerspectiveCamera). */
const FOV_DEGREES = 60;

export interface Point {
  x: number;
  y: number;
}

/** The camera as the root element reports it: metres and radians, two decimals. */
export interface Camera {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export function lobbyRoot(page: Page): Locator {
  return page.locator('[data-lobby]');
}

/**
 * Fails, loudly, unless this browser can make a WebGL2 context. Without it
 * the lobby shows its no-3D fallback and every scene test would time out
 * waiting for `ready` instead of saying why. Never a skip: a CI runner that
 * lost SwiftShader must go red, not quietly stop testing the lobby.
 */
export async function expectWebGL2(page: Page): Promise<void> {
  const available = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  });
  expect(
    available,
    'no WebGL2 in this Chromium: the lobby specs need SwiftShader (--use-angle=swiftshader --enable-unsafe-swiftshader, set in playwright.config.ts)',
  ).toBe(true);
}

export async function expectReady(page: Page, timeout = READY_TIMEOUT): Promise<void> {
  await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'ready', { timeout });
}

/** The page's heading block (the h1 and its lede) and its directory, as Lobby.tsx wraps them. */
export function headingBlock(page: Page): Locator {
  return lobbyRoot(page).locator('[data-heading]');
}

export function directoryBlock(page: Page): Locator {
  return lobbyRoot(page).locator('[data-directory]');
}

/**
 * Out of sight the way a visually hidden element is: in the page (so in the
 * accessibility tree) but clipped to a box of a pixel at most. Playwright's
 * own `toBeVisible` counts a 1 px box as visible, so this reads the box.
 */
export async function expectOutOfSight(locator: Locator): Promise<void> {
  await expect(locator).toHaveCount(1);
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box === null ? 0 : Math.max(box.width, box.height);
    })
    .toBeLessThanOrEqual(1);
}

/** On screen: visible, and a real box, not a clipped pixel. */
export async function expectInSight(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(async () => (await locator.boundingBox())?.width ?? 0).toBeGreaterThan(40);
}

/** `path` as a pattern for the end of a URL, every regex character escaped. */
export function urlEndingWith(path: string): RegExp {
  return new RegExp(`${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);
}

/**
 * Visits `path` (default `/apps`) signed in. The lobby and everything under
 * it is behind sign-in (apps/web/src/middleware.ts), so a signed-out visit
 * lands on `/signin?next=<path>`: this signs in there with the practice
 * account, the demo build's own way in, and lands back on `path`. Already
 * signed in, it is just the visit. The live build has no practice account:
 * seal a session with `signInAs` before calling this there.
 */
export async function gotoLobby(page: Page, path = '/apps'): Promise<void> {
  await page.goto(path);
  if (new URL(page.url()).pathname === '/signin') {
    await demoSignIn(page);
  }
  await expect(page).toHaveURL(urlEndingWith(path));
}

/** Opens `path` (default `/apps`) signed in (see `gotoLobby`) and waits for the 3D view to be up. */
export async function openLobby(page: Page, path = '/apps'): Promise<void> {
  await expectWebGL2(page);
  await gotoLobby(page, path);
  await expectReady(page);
}

export type FlagName =
  | 'csv_export'
  | 'contribute_bridge'
  | 'upland_data'
  | 'github_signin'
  | 'apps_lobby'
  | 'mcp_connector'
  | 'agent_start'
  | 'proposals';

/**
 * Serves a full, schema-valid flags payload in place of the API's: every
 * flag on unless overridden. A partial payload would fail the schema and
 * read every missing flag as off, `apps_lobby` included.
 */
export async function serveFlags(page: Page, overrides: Partial<Record<FlagName, boolean>> = {}): Promise<void> {
  const flags = allFlags(overrides);
  await page.route('**/api/flags', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flags) }),
  );
}

function allFlags(overrides: Partial<Record<FlagName, boolean>> = {}): Record<FlagName, boolean> {
  return {
    csv_export: true,
    contribute_bridge: true,
    upland_data: true,
    github_signin: true,
    apps_lobby: true,
    mcp_connector: true,
    agent_start: true,
    proposals: true,
    ...overrides,
  };
}

/**
 * Holds the flags answer until the returned function is called, then serves
 * every flag on: until then the lobby stays where the server's first render
 * left it, `loading`. Release it within 8 s, the flag client's own timeout
 * (packages/flags), or the lobby goes on without the answer.
 */
export async function holdFlags(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/flags', async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(allFlags()) });
  });
  return release;
}

/** The practice account, signed in through the real `/signin` page, landing on `/apps`. */
export async function signInToLobby(page: Page): Promise<void> {
  await page.goto('/signin?next=%2Fapps');
  await demoSignIn(page);
  await expect(page).toHaveURL(/\/apps$/);
}

export async function readCamera(page: Page): Promise<Camera> {
  const root = lobbyRoot(page);
  await expect(root).toHaveAttribute('data-yaw', /^-?\d+\.\d\d$/);
  // One read, so all four come from the same frame.
  const [x = NaN, y = NaN, z = NaN, yaw = NaN] = await root.evaluate((element) => {
    const { x, y, z, yaw } = (element as HTMLElement).dataset;
    return [x, y, z, yaw].map(Number);
  });
  return { x, y, z, yaw };
}

/** How far the camera stands from the cave's axis. */
export function radius(camera: Camera): number {
  return Math.hypot(camera.x, camera.z);
}

/**
 * Where the centre of wall slot `index` is on screen, in page pixels,
 * projected through the scene's own camera: the position and yaw the root
 * reports, and `pitch`, which it doesn't (so the default is the spawn
 * pitch, right for any test that never tilts the view). The camera follows
 * three.js's rotation order YXZ with rotation (−pitch, −yaw, 0), so a world
 * point comes into view space by undoing the yaw, then the pitch.
 */
export async function slotOnScreen(page: Page, index: number, pitch = INITIAL_CAMERA.pitch): Promise<Point> {
  const camera = await readCamera(page);
  const point = project(camera, await canvasBox(page), index, pitch);
  if (point === null) {
    throw new Error(`slot ${index} is not in view from ${JSON.stringify(camera)}`);
  }
  return point;
}

/**
 * An empty slot that the 3D view itself shows here, the nearest to Data's
 * first: its centre on screen with nothing over it. For a test that needs a
 * tap on any empty slot (to bring the toast, say) while something large
 * floats over the view, such as the people panel at its fullest, which
 * covers most of a phone held upright. Spawn pitch, as `slotOnScreen`.
 */
export async function emptySlotInView(page: Page): Promise<Point> {
  const camera = await readCamera(page);
  const box = await canvasBox(page);
  const points: Point[] = [];
  for (let reach = 1; reach <= 4; reach += 1) {
    for (let row = dataSlot.row - reach; row <= dataSlot.row + reach; row += 1) {
      for (let col = dataSlot.col - reach; col <= dataSlot.col + reach; col += 1) {
        // Only the ring at this reach: the ones inside it came before.
        if (Math.max(Math.abs(row - dataSlot.row), Math.abs(col - dataSlot.col)) !== reach) {
          continue;
        }
        let index: number;
        try {
          index = slotIndex({ col, row });
        } catch {
          continue; // off the wall
        }
        const point = appAt(slotFromIndex(index)) === undefined ? project(camera, box, index, INITIAL_CAMERA.pitch) : null;
        if (point !== null) {
          points.push(point);
        }
      }
    }
  }
  const found = await page.evaluate(
    (points) => points.findIndex(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS'),
    points,
  );
  const point = points[found];
  if (point === undefined) {
    throw new Error(`no empty slot near Data is in view with nothing over it, from ${JSON.stringify(camera)}`);
  }
  return point;
}

type Box = { x: number; y: number; width: number; height: number };

async function canvasBox(page: Page): Promise<Box> {
  const box = await lobbyRoot(page).locator('canvas').boundingBox();
  if (box === null) {
    throw new Error('the lobby has no canvas on screen');
  }
  return box;
}

/** Where slot `index`'s centre is on a canvas at `box`, seen from `camera` at `pitch`, or null when out of view. */
function project(camera: Camera, box: Box, index: number, pitch: number): Point | null {
  const [px, py, pz] = slotPose(index).position;
  const dx = px - camera.x;
  const dy = py - camera.y;
  const dz = pz - camera.z;
  const ax = Math.cos(camera.yaw) * dx + Math.sin(camera.yaw) * dz;
  const az = -Math.sin(camera.yaw) * dx + Math.cos(camera.yaw) * dz;
  const vy = Math.cos(pitch) * dy - Math.sin(pitch) * az;
  const vz = Math.sin(pitch) * dy + Math.cos(pitch) * az;
  const f = Math.tan(((FOV_DEGREES / 2) * Math.PI) / 180);
  const ndcX = ax / -vz / (f * (box.width / box.height));
  const ndcY = vy / -vz / f;
  if (vz >= 0 || Math.abs(ndcX) >= 1 || Math.abs(ndcY) >= 1) {
    return null;
  }
  return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
}

/**
 * A tap on the 3D view: press and release on one pixel (controls.ts counts
 * anything under 8 px of travel as a tap, not a drag), with the mouse, or a
 * finger with `touch` (the page needs `hasTouch`). Checks first that the
 * canvas itself is what's under the point, so a heading or panel floating
 * over the view fails the test by name instead of eating the tap.
 */
export async function tapScene(page: Page, point: Point, { touch = false } = {}): Promise<void> {
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? 'nothing', point);
  expect(under, `the tap at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) must land on the 3D view`).toBe('CANVAS');
  if (touch) {
    await page.touchscreen.tap(point.x, point.y);
  } else {
    await page.mouse.click(point.x, point.y);
  }
}

/**
 * Taps the view and waits for the navigation it starts, tapping again only
 * while the page is still where it was: a route the dev server compiles on
 * first use can take longer than one wait allows. A tap that went somewhere
 * else is not retried, so it fails on the URL.
 */
export async function tapThrough(page: Page, point: Point, url: RegExp): Promise<void> {
  const from = page.url();
  await expect(async () => {
    if (page.url() === from) {
      await tapScene(page, point);
    }
    await expect(page).toHaveURL(url, { timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * Clicks a link and waits for where it goes, clicking again only while the
 * page never left (a click can land before Next has hydrated the page).
 */
export async function clickThrough(link: Locator, url: RegExp): Promise<void> {
  const page = link.page();
  const from = page.url();
  await expect(async () => {
    if (page.url() === from) {
      await link.click({ timeout: 5_000 });
    }
    await expect(page).toHaveURL(url, { timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * Holds `key` down for at least `atLeastMs`, and then until `done` says the
 * scene has moved far enough: a frame can take a second under SwiftShader,
 * so a fixed hold could end before a single step was taken.
 */
export async function holdKey(
  page: Page,
  key: string,
  atLeastMs: number,
  done: (camera: Camera) => boolean,
  timeout = 60_000,
): Promise<Camera> {
  let camera = await readCamera(page);
  await page.keyboard.down(key);
  const started = Date.now();
  try {
    await expect
      .poll(
        async () => {
          camera = await readCamera(page);
          return Date.now() - started >= atLeastMs && done(camera);
        },
        { timeout, intervals: [100] },
      )
      .toBe(true);
  } finally {
    await page.keyboard.up(key);
  }
  return camera;
}

/**
 * Plants a saved camera in this tab's session storage before any page
 * script runs, on every load in this tab, so any visit to `/apps` starts
 * from it: the lobby's own restore, used to put the camera somewhere exact
 * without walking there.
 */
export async function seedCamera(page: Page, camera: CameraState): Promise<void> {
  await page.addInitScript(
    ([item, value]) => window.sessionStorage.setItem(item, value),
    [CAMERA_STORAGE_ITEM, JSON.stringify(camera)] as const,
  );
}

/** The camera the lobby saved in this tab's session storage, or null. */
export async function savedCamera(page: Page): Promise<CameraState | null> {
  const raw = await page.evaluate((item) => window.sessionStorage.getItem(item), CAMERA_STORAGE_ITEM);
  return raw === null ? null : (JSON.parse(raw) as CameraState);
}

/** The people panel: the lobby's "People nearby" aside. */
export function peoplePanel(page: Page): Locator {
  return page.getByRole('complementary', { name: 'People nearby' });
}

/** Someone's row in the people panel, by their feed id. */
export function personRow(page: Page, id: string): Locator {
  return peoplePanel(page).locator(`li[data-person-id="${id}"]`);
}

/**
 * One of the people panel's live regions (VoicePanel.tsx), which are always in
 * the page with their text set and cleared: `status` (whether voice is on, and
 * why not), `problem` (why the mic didn't start), `elsewhere` (another tab or
 * device took the seat) and `room-sound` (the cave sound failed).
 */
export function voiceLine(page: Page, which: 'status' | 'problem' | 'elsewhere' | 'room-sound' = 'status'): Locator {
  return peoplePanel(page).locator(`[role="status"][data-live="${which}"]`);
}

/**
 * Another practice tab, as the local feed hears one: hellos on the
 * `forge.lobby` channel every half second (the feed drops a tab silent for
 * 3 s), and, given `at`, its position in the lobby's own packet. Played from
 * inside the page, so it needs no second scene. `id` must look like a
 * practice tab's (`practice-` and six hex digits).
 */
export async function addGhost(page: Page, id: string, name: string, at?: { x: number; y: number; z: number }): Promise<void> {
  const pos = at === undefined ? null : [...encodePosition({ ...at, yaw: 0 })];
  await page.evaluate(
    ({ id, name, pos }) => {
      const host = window as unknown as { __ghosts?: Record<string, { channel: BroadcastChannel; timer: number }> };
      host.__ghosts ??= {};
      host.__ghosts[id]?.channel.close();
      const channel = new BroadcastChannel('forge.lobby');
      const hello = pos === null ? { type: 'hello', id, name } : { type: 'hello', id, name, pos: new Uint8Array(pos) };
      channel.postMessage(hello);
      host.__ghosts[id] = { channel, timer: window.setInterval(() => channel.postMessage(hello), 500) };
    },
    { id, name, pos },
  );
}

/** A ghost from `addGhost` says goodbye, as a closing tab does. */
export async function removeGhost(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const host = window as unknown as { __ghosts?: Record<string, { channel: BroadcastChannel; timer: number }> };
    const ghost = host.__ghosts?.[id];
    if (ghost === undefined) {
      return;
    }
    window.clearInterval(ghost.timer);
    ghost.channel.postMessage({ type: 'bye', id });
    ghost.channel.close();
    delete host.__ghosts?.[id];
  }, id);
}
