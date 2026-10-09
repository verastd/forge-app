import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { encodeAction, parseAction } from '../../packages/lobby/dist/index.js';
import type { LobbyAction } from '../../packages/lobby/dist/index.js';
import { addGhost, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';

/**
 * Playing catch and waving, project `chromium-demo`.
 *
 * The other player is a ghost (helpers/lobby.ts `addGhost`): another
 * practice tab as the local feed hears one, on the `forge.lobby`
 * BroadcastChannel. A listener on the same channel records what this page
 * sends (its own id included), and the ghost answers on it. The page says
 * where it is in a game as `data-ball` and whether it's waving as
 * `data-wave`; no assertion reads pixels.
 */

const GHOST = 'practice-0c0c0c';
const NAME = 'robo friend';

/** Listens on the lobby's channel from inside the page: every action this page sends, and its own id. */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as { __heard: { id: string; act: string }[]; __me: string | null };
    host.__heard = [];
    host.__me = null;
    const channel = new BroadcastChannel('forge.lobby');
    channel.addEventListener('message', (event: MessageEvent<{ type?: string; id?: string; act?: string }>) => {
      const { type, id, act } = event.data;
      if (typeof id !== 'string' || id.startsWith('practice-0c')) return;
      if (type === 'hello' || type === 'pos') host.__me = id;
      if (type === 'act' && typeof act === 'string') host.__heard.push({ id, act });
    });
  });
}

async function myId(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(async () => {
      id = await page.evaluate(() => (window as unknown as { __me: string | null }).__me);
      return id;
    })
    .not.toBeNull();
  return id as unknown as string;
}

/** The actions this page has sent, parsed. */
async function heard(page: Page): Promise<LobbyAction[]> {
  const raw = await page.evaluate(() => (window as unknown as { __heard: { act: string }[] }).__heard.map((h) => h.act));
  return raw.map((act) => parseAction(act)).filter((a): a is LobbyAction => a !== null);
}

/** The ghost sends an action, as its tab would. */
async function ghostActs(page: Page, action: LobbyAction): Promise<void> {
  await page.evaluate(
    ({ id, act }) => {
      const ghost = (window as unknown as { __ghosts: Record<string, { channel: BroadcastChannel }> }).__ghosts[id];
      ghost?.channel.postMessage({ type: 'act', id, act });
    },
    { id: GHOST, act: encodeAction(action) },
  );
}

function playButton(page: Page, name: RegExp) {
  return page.getByRole('group', { name: 'Play' }).getByRole('button', { name });
}

const toast = (page: Page, text: string) => page.locator('[aria-live="polite"]').filter({ hasText: text });

async function setUp(page: Page): Promise<void> {
  await serveFlags(page);
  await seedCamera(page, { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 });
  await openLobby(page);
  await listen(page);
  await addGhost(page, GHOST, NAME, { x: 0, y: 1.7, z: -5 });
  await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
  await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'none', { timeout: 15_000 });
}

test.describe('playing catch', () => {
  test.describe.configure({ timeout: 150_000 });

  test('get a ball, throw it to whoever is ahead, and hear that they caught it', async ({ page }) => {
    await setUp(page);
    const me = await myId(page);

    await playButton(page, /Get a ball/).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'holding');
    await expect(toast(page, 'Got a ball')).toBeVisible();
    await expect(playButton(page, /Throw to robo friend/)).toBeEnabled();
    await expect.poll(async () => (await heard(page)).some((a) => a.kind === 'ball' && a.holding)).toBe(true);

    await page.keyboard.press('KeyF');
    // Winding up, then in the air: the button held, with a spinner, until the catcher says.
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', /throwing|in-flight/);
    await expect(playButton(page, /Throwing…|In the air…/)).toBeDisabled();
    await expect.poll(async () => (await heard(page)).find((a) => a.kind === 'throw')).toMatchObject({ kind: 'throw', to: GHOST });
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'in-flight');

    await ghostActs(page, { kind: 'catch', thrower: me, caught: true });
    await expect(toast(page, 'robo friend caught it!')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'none');
    await expect(playButton(page, /Get a ball/)).toBeEnabled();
  });

  test('a throw at you is caught standing still, and you say so', async ({ page }) => {
    await setUp(page);
    const me = await myId(page);
    await ghostActs(page, { kind: 'ball', holding: true });
    await ghostActs(page, { kind: 'throw', to: me, from: { x: 0, y: 1.4, z: -5 }, dest: { x: 0, y: 1.35, z: -0.35 }, time: 1.5 });

    await expect(toast(page, 'Incoming from robo friend!')).toBeVisible();
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'incoming');
    await expect(playButton(page, /Incoming!/)).toBeDisabled();
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'holding', { timeout: 15_000 });
    await expect(toast(page, 'You caught it!')).toBeVisible();
    await expect.poll(async () => (await heard(page)).find((a) => a.kind === 'catch')).toEqual({ kind: 'catch', thrower: GHOST, caught: true });
  });

  test('a throw that comes down out of reach is missed, then picked up', async ({ page }) => {
    await setUp(page);
    const me = await myId(page);
    await ghostActs(page, { kind: 'throw', to: me, from: { x: 0, y: 1.4, z: -5 }, dest: { x: 3, y: 1.35, z: 1 }, time: 1 });

    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'incoming');
    await expect.poll(async () => (await heard(page)).find((a) => a.kind === 'catch'), { timeout: 15_000 }).toEqual({
      kind: 'catch',
      thrower: GHOST,
      caught: false,
    });
    // It bounces and rolls to a stop, and then it's yours.
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'holding', { timeout: 30_000 });
    await expect(toast(page, 'You picked it up')).toBeVisible();
  });

  test('a wave goes out, and the button says so until it’s done', async ({ page }) => {
    await setUp(page);
    await playButton(page, /^Wave/).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-wave', 'on');
    await expect(playButton(page, /Waving…/)).toBeDisabled();
    await expect.poll(async () => (await heard(page)).some((a) => a.kind === 'wave')).toBe(true);
    await expect(lobbyRoot(page)).toHaveAttribute('data-wave', 'off', { timeout: 15_000 });
    await expect(playButton(page, /^Wave/)).toBeEnabled();
  });

  test('with robots off there is no catch to play', async ({ page }) => {
    await serveFlags(page, { lobby_avatars: false });
    await openLobby(page);
    await expect(page.getByRole('group', { name: 'Play' })).toHaveCount(0);
    await page.keyboard.press('KeyF');
    await expect(lobbyRoot(page)).not.toHaveAttribute('data-ball', /.+/);
  });
});
