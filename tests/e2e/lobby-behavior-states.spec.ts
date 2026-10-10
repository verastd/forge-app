import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { behaviorById, encodeAction } from '../../packages/lobby/dist/index.js';
import type { BehaviorEntry } from '../../packages/lobby/dist/index.js';
import { addGhost, lobbyRoot, openLobby, seedCamera, serveFlags } from './helpers/lobby';

/**
 * Every behaviour's declared states, on screen (issue #49), project
 * `chromium-demo`, the practice build.
 *
 * A throw or wave shows its catalog state (`BEHAVIORS[...].states`) from the
 * press to the outcome. The root says which as `data-behavior-state`
 * (`<kind>:<state>`, the kind the behaviour's catalog id), the play controls
 * show the catalog's copy for it, and the people panel's live region reads
 * out a rejection. The other player is a ghost on the practice feed's
 * BroadcastChannel, as in lobby-catch.spec.ts.
 *
 * SwiftShader draws about a frame a second, so a state can come and go
 * between two polls: a MutationObserver installed before each press records
 * every value the attribute takes, and the order is asserted on that.
 */

const GHOST = 'practice-0c0c0c';
const NAME = 'robo friend';

function entry(id: string): BehaviorEntry {
  const found = behaviorById(id);
  if (found === null) throw new Error(`no ${id} behaviour in the catalog`);
  return found;
}
const WAVE = entry('wave');
const CATCH = entry('catch-and-throw');

/** Records every value `data-behavior-state` takes on the root from now on, and this page's own feed id. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as { __states: string[]; __me: string | null; __observer?: MutationObserver };
    host.__states = [];
    host.__me ??= null;
    const root = document.querySelector('[data-lobby]');
    if (root === null) throw new Error('no lobby root');
    host.__observer?.disconnect();
    host.__observer = new MutationObserver(() => {
      const value = root.getAttribute('data-behavior-state');
      if (value !== null && host.__states[host.__states.length - 1] !== value) host.__states.push(value);
    });
    host.__observer.observe(root, { attributes: true, attributeFilter: ['data-behavior-state'] });
  });
}

async function states(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __states: string[] }).__states);
}

/** This page's own feed id, as the ghost hears it. */
async function myId(page: Page): Promise<string> {
  await page.evaluate(() => {
    const host = window as unknown as { __me: string | null };
    host.__me = null;
    const channel = new BroadcastChannel('forge.lobby');
    channel.addEventListener('message', (event: MessageEvent<{ type?: string; id?: string }>) => {
      const { type, id } = event.data;
      if (typeof id === 'string' && !id.startsWith('practice-0c') && (type === 'hello' || type === 'pos')) host.__me = id;
    });
  });
  let id: string | null = null;
  await expect
    .poll(async () => {
      id = await page.evaluate(() => (window as unknown as { __me: string | null }).__me);
      return id;
    })
    .not.toBeNull();
  return id as unknown as string;
}

/** The ghost answers the next throw this page makes with `answer` (an encoded action), the moment it arrives. */
async function ghostAnswersThrow(page: Page, answer: string): Promise<void> {
  await page.evaluate(
    ({ ghost, answer }) => {
      const host = window as unknown as { __ghosts: Record<string, { channel: BroadcastChannel }> };
      const listen = new BroadcastChannel('forge.lobby');
      listen.addEventListener('message', (event: MessageEvent<{ type?: string; id?: string; act?: string }>) => {
        const { type, id, act } = event.data;
        if (type !== 'act' || typeof id !== 'string' || id.startsWith('practice-0c') || typeof act !== 'string') return;
        if (!act.includes('"k":"throw"')) return;
        listen.close();
        host.__ghosts[ghost]?.channel.postMessage({ type: 'act', id: ghost, act: answer });
      });
    },
    { ghost: GHOST, answer },
  );
}

function playButton(page: Page, name: RegExp) {
  return page.getByRole('group', { name: 'Play' }).getByRole('button', { name });
}

/** The play controls' state line. */
const stateLine = (page: Page) => page.locator('[data-control="play"] [data-behavior]');

/** The people panel's live region for a throw or wave that didn't happen. */
const rejectionRegion = (page: Page) => page.getByRole('complementary', { name: 'People nearby' }).locator('[data-live="behavior"]');

async function setUp(page: Page, ghostAt: { x: number; y: number; z: number }): Promise<void> {
  await serveFlags(page);
  // Facing -z from the origin: a ghost at z -5 is straight ahead, one at z +5 behind.
  await seedCamera(page, { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 });
  await openLobby(page);
  await addGhost(page, GHOST, NAME, ghostAt);
  await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
  await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'none', { timeout: 15_000 });
  await expect(lobbyRoot(page)).not.toHaveAttribute('data-behavior-state', /.+/);
}

async function getABall(page: Page): Promise<void> {
  await playButton(page, /Get a ball/).click();
  await expect(lobbyRoot(page)).toHaveAttribute('data-ball', 'holding');
}

test.describe('behaviour states on screen', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a throw with nobody in range shows outOfRange, in the catalog’s words', async ({ page }) => {
    await setUp(page, { x: 0, y: 1.7, z: 5 });
    await getABall(page);
    await expect(playButton(page, /^Throw/)).toHaveAccessibleName(/^Throw\b(?! to)/);

    await record(page);
    await playButton(page, /^Throw/).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-behavior-state', 'catch-and-throw:outOfRange');
    await expect(stateLine(page)).toHaveAttribute('data-state', 'outOfRange');
    await expect(stateLine(page)).toContainText(CATCH.states.outOfRange);
    // It still goes (to bounce and come back), and stays out of range: never requested, never rejected.
    await expect(lobbyRoot(page)).toHaveAttribute('data-ball', /throwing|in-flight/);
    expect(await states(page)).toEqual(['catch-and-throw:outOfRange']);
    await expect(rejectionRegion(page)).toBeEmpty();
  });

  test('a wave shows requested, then confirmed', async ({ page }) => {
    await setUp(page, { x: 0, y: 1.7, z: -5 });
    await record(page);

    await playButton(page, /^Wave/).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-behavior-state', 'wave:confirmed', { timeout: WAVE.confirmWithinMs + 5_000 });
    expect(await states(page)).toEqual(['wave:requested', 'wave:confirmed']);
    await expect(stateLine(page)).toHaveAttribute('data-state', 'confirmed');
    await expect(stateLine(page)).toContainText(WAVE.states.confirmed);
    await expect(rejectionRegion(page)).toBeEmpty();
  });

  test('a catch answered missed shows rejected with the catalog’s reason, and the people panel says it', async ({ page }) => {
    await setUp(page, { x: 0, y: 1.7, z: -5 });
    const me = await myId(page);
    await getABall(page);
    await expect(playButton(page, /Throw to robo friend/)).toBeEnabled();
    await ghostAnswersThrow(page, encodeAction({ kind: 'catch', thrower: me, caught: false }));

    await record(page);
    await playButton(page, /Throw to robo friend/).click();
    await expect(lobbyRoot(page)).toHaveAttribute('data-behavior-state', 'catch-and-throw:rejected', { timeout: 15_000 });
    const seen = await states(page);
    expect(seen[0]).toBe('catch-and-throw:requested');
    expect(seen).toContain('catch-and-throw:rejected');
    expect(seen).not.toContain('catch-and-throw:confirmed');

    await expect(stateLine(page)).toHaveAttribute('data-state', 'rejected');
    await expect(stateLine(page)).toContainText(CATCH.states.rejected);
    await expect(rejectionRegion(page)).toHaveAttribute('aria-live', 'polite');
    await expect(rejectionRegion(page)).toContainText(CATCH.states.rejected);
  });
});
