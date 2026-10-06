import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { INITIAL_CAMERA, appAt, facing, slotFromIndex } from '../../packages/lobby/dist/index.js';
import {
  DATA_LINK,
  DATA_SLOT,
  EMPTY_ABOVE_DATA,
  addGhost,
  clickThrough,
  directoryBlock,
  enterLobby,
  expectInSight,
  expectOutOfSight,
  expectReady,
  expectWebGL2,
  gotoLobby,
  headingBlock,
  holdFlags,
  holdKey,
  lobbyRoot,
  openLobby,
  openPeople,
  peopleCount,
  peoplePanel,
  personRow,
  radius,
  readCamera,
  removeGhost,
  savedCamera,
  seedCamera,
  serveFlags,
  signInToLobby,
  slotOnScreen,
  tapScene,
  tapThrough,
  voiceLine,
} from './helpers/lobby';
import { demoSignIn, signInAs } from './helpers/session';

/**
 * The Apps lobby at /apps (project `chromium-demo`: the practice build, API
 * deliberately down): the operator's cave, a free-roam 3D room whose wall is
 * a 32 × 90 grid of app slots, with the Data app lit in slot 0, straight
 * ahead of where everyone starts.
 *
 * The view is WebGL2, drawn here by SwiftShader (see playwright.config.ts),
 * so no assertion reads pixels: the page reports its state on
 * `<div data-lobby>` (helpers/lobby.ts), and taps are aimed by projecting a
 * slot's centre through the camera the page reports. SwiftShader draws this
 * scene at about a frame a second and the scene only moves on frames, so
 * the scene tests get long timeouts and poll the camera rather than sleep.
 *
 * The page itself, meaning the heading, the lede and the directory, is
 * rendered on the server and has to work with no 3D at all: no WebGL, the
 * `apps_lobby` flag off, or a view that broke. Those paths are tested as
 * carefully as the scene.
 *
 * playwright.config.ts asks every test for reduced motion, so the lobby runs
 * with `data-motion=reduced` here unless a test opts out, as the full-motion
 * block below does.
 *
 * Presence on the practice build is the local feed: tabs of one browser
 * over a BroadcastChannel, no server and no voice. The HUD ("People
 * nearby") says so, and its people drawer lists everyone else in the room
 * with their distance.
 *
 * Every visit starts at the Enter gate; `openLobby` presses Enter
 * (`enterLobby`), which also stands in for the browser's gesture for sound. Another tab is played from inside the page where one will do
 * (`addGhost`), which saves building a second scene. The LiveKit feed is
 * live-lobby.spec.ts's; this server is never given LiveKit settings
 * (playwright.config.ts blanks them), so its token route says voice is
 * unavailable.
 *
 * `/apps` needs a sign-in (the middleware), so every visit here signs in
 * with the practice account first (`gotoLobby` and `openLobby` in
 * helpers/lobby.ts). Signed out, the lobby is a redirect to /signin.
 */

/** A dark slot on the bottom row, three columns right of Data: in view from the spawn point. */
const DARK_SLOT = 3;

function directoryLink(page: Page) {
  return page
    .getByRole('navigation', { name: 'Apps', exact: true })
    .getByRole('link', { name: DATA_LINK, exact: true });
}

const peopleNearby = peoplePanel;
const PRACTICE = 'This practice copy has no voice. Voice is on the live site, signed in with GitHub.';
const NOBODY = 'Nobody else is here yet.';
/** Another practice tab, played by `addGhost`. */
const GHOST = 'practice-0a0b0c';

test('the browser has WebGL2, or every scene test below fails for that reason', async ({ page }) => {
  await expectWebGL2(page);
});

test('signed in, the lobby comes up at the centre, facing the Data screen, alone, and the panel says why there is no voice', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openLobby(page);

  const root = lobbyRoot(page);
  await expect(root.locator('canvas')).toHaveCount(1);
  expect(await readCamera(page)).toEqual({
    x: INITIAL_CAMERA.x,
    y: INITIAL_CAMERA.y,
    z: INITIAL_CAMERA.z,
    yaw: INITIAL_CAMERA.yaw,
  });
  await expect(root).toHaveAttribute('data-focus', 'data');
  await expect(root).toHaveAttribute('data-motion', 'reduced');
  // The practice account in one tab: the local feed, nobody else, and no voice.
  await expect(root).toHaveAttribute('data-feed', 'local');
  await expect(root).toHaveAttribute('data-peers', '0');
  await expect(root).toHaveAttribute('data-voice', 'unavailable');
  await expect(root).toHaveAttribute('data-sound', 'none');
  await expect(root).toHaveAttribute('data-deafened', 'false');
  const panel = peopleNearby(page);
  // The practice build has no voice, and says so in the one notice over the dock.
  await expect(voiceLine(page)).toHaveText(PRACTICE);
  await expect(voiceLine(page)).toBeVisible();
  // No voice whatever is pressed: no Mic, no Deafen, the dock is the people count alone.
  await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Deafen', exact: true })).toHaveCount(0);
  const count = peopleCount(page);
  await expect(count).toHaveAccessibleName('1 here');
  await expect(count).toHaveAttribute('aria-expanded', 'false');
  for (const which of ['problem', 'elsewhere'] as const) {
    await expect(voiceLine(page, which)).toHaveText('');
  }
  // No hint line and no cave-sound pill: the cave is left clear.
  await expect(page.getByText('Tap a panel to open')).toHaveCount(0);
  await expect(page.getByText(/Voices carry/)).toHaveCount(0);
  await expect(panel.getByText(/cave sound/i)).toHaveCount(0);
  // Bottom centre, like a game's HUD: the cave's top-left corner is its Exit.
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const box = await count.boundingBox();
  expect(box !== null && box.y > viewport.height - 100, 'the count sits along the bottom edge').toBe(true);
  expect(box !== null && Math.abs(box.x + box.width / 2 - viewport.width / 2) < 120, 'the dock is centred').toBe(true);
  // The practice feed sees the room (this browser's tabs), so the drawer can say nobody is here.
  const drawer = await openPeople(page);
  await expect(drawer.getByText(NOBODY)).toBeVisible();
  await expect(drawer.getByRole('searchbox')).toHaveCount(0);
});

test.describe('the Enter gate', () => {
  test("it says who's here and holds the HUD back; pressed before the view is up it says it's entering, then goes", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await expectWebGL2(page);
    // Animation frames held back until released: the scene builds over frames,
    // so the view stays loading for as long as this test needs.
    await page.addInitScript(() => {
      const held: FrameRequestCallback[] = [];
      const real = window.requestAnimationFrame.bind(window);
      const host = window as unknown as { __holdFrames: boolean; __releaseFrames(): void };
      host.__holdFrames = true;
      host.__releaseFrames = () => {
        host.__holdFrames = false;
        for (const callback of held.splice(0)) {
          real(callback);
        }
      };
      window.requestAnimationFrame = (callback) => {
        if (host.__holdFrames) {
          held.push(callback);
          return 0;
        }
        return real(callback);
      };
    });
    await gotoLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-gate', 'open', { timeout: 60_000 });
    const enter = page.getByRole('button', { name: 'Enter', exact: true });
    await expect(enter).toBeVisible();
    // The gate's line (the drawer's head, behind it, says the same out of sight).
    await expect(page.getByText('1 here · 0 talking', { exact: true }).first()).toBeVisible();
    // Under Enter, the way to the 2D lobby instead.
    await expect(page.getByRole('link', { name: 'Take me to the 2D lobby instead' })).toHaveAttribute('href', '/apps?view=2d');
    // Behind the gate: no dock, no stick, no drawer.
    await expect(peopleCount(page)).toBeHidden();
    // Exit stays, over the gate.
    await expect(page.getByRole('link', { name: 'Exit the cave' })).toBeVisible();

    // Pressed while the view still builds: it says so, busy, until the view is up.
    await enter.click();
    await expect(root).toHaveAttribute('data-gate', 'entering');
    await expect(root).toHaveAttribute('data-lobby-state', 'loading');
    const entering = page.getByRole('button', { name: 'Entering', exact: true });
    await expect(entering).toBeVisible();
    await expect(entering).toHaveAttribute('aria-busy', 'true');
    await expect(entering).toHaveAttribute('aria-disabled', 'true');

    await page.evaluate(() => (window as unknown as { __releaseFrames(): void }).__releaseFrames());
    await expectReady(page);
    await expect(root).toHaveAttribute('data-gate', 'gone');
    await expect(page.getByRole('button', { name: /^Enter/ })).toHaveCount(0);
    await expect(peopleCount(page)).toBeVisible();
  });
});

test('while the wall is the page the heading, the lede and the directory are out of sight, from the first render on', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await expectWebGL2(page);
  // The flags answer held back: the lobby stays as the server rendered it, loading.
  const release = await holdFlags(page);
  await gotoLobby(page);
  const root = lobbyRoot(page);
  await expect(root).toHaveAttribute('data-lobby-state', 'loading');
  await expectOutOfSight(headingBlock(page));
  await expectOutOfSight(directoryBlock(page));

  // Already so in the server's markup, so nothing flashes before the client takes over.
  const html = await (await page.context().request.get('/apps')).text();
  expect(html).toContain('data-heading="aside"');
  expect(html).toContain('data-directory="aside"');

  release();
  await expectReady(page);
  await expectOutOfSight(headingBlock(page));
  await expectOutOfSight(directoryBlock(page));

  // Still the page, for a screen reader: its h1, its lede, and the list of apps and empty slots.
  await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toHaveCount(1);
  await expect(page.getByText('Everything the community has built, on one wall.')).toHaveCount(1);
  const link = directoryLink(page);
  await expect(link).toHaveAttribute('href', '/apps/data');
  await expect(link).toHaveAttribute('data-slug', 'data');
  // 32 × 90 slots, one of them lit, and the way to fill the next.
  const directory = page.getByRole('navigation', { name: 'Apps', exact: true });
  await expect(directory.getByText('2,879 empty slots', { exact: true })).toHaveCount(1);
  await expect(directory.getByRole('link', { name: /Propose the next app/ })).toHaveAttribute(
    'href',
    '/propose',
  );
});

test('a keyboard Tab into the directory shows it, for as long as focus is in it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openLobby(page);
  const directory = directoryBlock(page);
  await expectOutOfSight(directory);

  // From the page's h1, where a keyboard user arriving from an app starts, Tab goes into the directory.
  await page.getByRole('heading', { name: 'Apps', level: 1 }).evaluate((h1) => {
    h1.setAttribute('tabindex', '-1');
    (h1 as HTMLElement).focus();
  });
  await page.keyboard.press('Tab');
  await expect(directoryLink(page)).toBeFocused();
  await expectInSight(directory);
  // The heading block never shows on the wall.
  await expectOutOfSight(headingBlock(page));

  // On to the Propose card, still in it; then out of it, and it steps out of sight again.
  await page.keyboard.press('Tab');
  await expect(directory.getByRole('link', { name: /Propose the next app/ })).toBeFocused();
  await expectInSight(directory);
  await page.keyboard.press('Tab');
  await expect(directoryLink(page)).not.toBeFocused();
  await expectOutOfSight(directory);
});

test.describe('signed out, the lobby asks for a sign-in first', () => {
  test('/apps goes to /signin and, signed in with the practice account, comes back', async ({ page }) => {
    await page.goto('/apps');
    await expect(page).toHaveURL(/\/signin\?next=%2Fapps$/);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/apps$/);
    await expect(lobbyRoot(page)).toHaveCount(1);
  });

  test("an app's way back, /apps?from=data, keeps its ?from= through the sign-in", async ({ page }) => {
    await page.goto('/apps?from=data');
    await expect(page).toHaveURL(/\/signin\?next=%2Fapps%3Ffrom%3Ddata$/);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/apps\?from=data$/);
    await expect(lobbyRoot(page)).toHaveCount(1);
  });
});

test.describe('signed in, the Data app opens', () => {
  test('from the directory link, by keyboard: the way in once the wall is up', async ({ page }) => {
    await gotoLobby(page);
    await directoryLink(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/apps\/data$/, { timeout: 30_000 });
  });

  test('from a tap on its lit screen', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    await expect(lobbyRoot(page)).toHaveAttribute('data-focus', 'data');

    await tapThrough(page, await slotOnScreen(page, DATA_SLOT), /\/apps\/data$/);
  });
});

test.describe('moving around', () => {
  test('the arrow keys turn the view and W walks forward', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const start = await readCamera(page);

    // Yaw grows turning right (packages/lobby camera.ts).
    const turned = await holdKey(page, 'ArrowRight', 200, (camera) => camera.yaw !== start.yaw);
    expect(turned.yaw).toBeGreaterThan(start.yaw);

    // Still facing mostly down −Z, so forward shows as z falling.
    const before = await readCamera(page);
    const walked = await holdKey(page, 'KeyW', 200, (camera) => camera.z < before.z);
    expect(walked.z).toBeLessThan(before.z);
  });

  test('a drag pulls the cave: dragging right turns the view left, dragging down tilts it up', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-pitch', /^-?\d+\.\d\d$/);
    const yawOf = async (): Promise<number> => Number(await root.getAttribute('data-yaw'));
    const pitchOf = async (): Promise<number> => Number(await root.getAttribute('data-pitch'));
    const box = await root.locator('canvas').boundingBox();
    if (box === null) {
      throw new Error('the lobby has no canvas on screen');
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // 150 px right: about 0.48 rad of yaw, and yaw grows turning right, so it falls.
    const startYaw = await yawOf();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 150, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(yawOf, { timeout: 10_000 }).toBeLessThan(startYaw - 0.3);

    // 100 px down: about 0.32 rad of pitch, and pitch grows looking down, so it falls.
    const startPitch = await pitchOf();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 100, { steps: 6 });
    await page.mouse.up();
    await expect.poll(pitchOf, { timeout: 10_000 }).toBeLessThan(startPitch - 0.2);
  });

  test('walking into the wall stops at its edge', async ({ page }) => {
    test.setTimeout(120_000);
    // A step from the wall, facing it, through the lobby's own restore: any
    // visit to /apps starts from the camera this tab saved.
    await seedCamera(page, { ...INITIAL_CAMERA, z: -25 });
    await openLobby(page);
    expect((await readCamera(page)).z).toBe(-25);

    // Five seconds of W at least, and on until it has reached the wall.
    const pressed = await holdKey(page, 'KeyW', 5_000, (camera) => radius(camera) > 25.3);
    expect(radius(pressed)).toBeLessThanOrEqual(25.5);
    // Let the walk coast out, then check it is still held at the edge.
    await expect.poll(async () => radius(await readCamera(page)), { timeout: 20_000 }).toBeGreaterThan(25.3);
    expect(radius(await readCamera(page))).toBeLessThanOrEqual(25.5);
  });
});

test('a round trip to the Data app comes back to the spot it left from', async ({ page }) => {
  // Two scene builds, a sign-in and the Data app: several times one scene's budget.
  test.setTimeout(180_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  await enterLobby(page);

  // Walk first, so there is somewhere other than the spawn point to come back to.
  const start = await readCamera(page);
  await holdKey(page, 'KeyW', 500, (camera) => camera.z < start.z);

  await tapThrough(page, await slotOnScreen(page, DATA_SLOT), /\/apps\/data$/);
  // Swapping the page chrome moves focus to the new page's heading (SiteChrome.tsx).
  await expect(page.getByRole('heading', { name: 'Data — Private Beta', level: 1 })).toBeFocused();
  const saved = await savedCamera(page);
  if (saved === null) {
    throw new Error('opening the Data app saved no camera');
  }
  expect(saved.z).toBeLessThan(0);

  await clickThrough(page.getByRole('link', { name: 'Back to the lobby' }), /\/apps\?from=data$/);
  // Entered once in this page load: no gate the second time.
  await expect(lobbyRoot(page)).not.toHaveAttribute('data-gate', 'open');
  await expectReady(page);
  await expect(lobbyRoot(page)).toHaveAttribute('data-gate', 'gone');
  // Back from an app to the wall, focus goes to the page's h1 (SiteChrome), not into the
  // directory, so nothing that is out of sight shows itself on arrival.
  await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeFocused();
  await expectOutOfSight(headingBlock(page));
  await expectOutOfSight(directoryBlock(page));

  const back = await readCamera(page);
  for (const axis of ['x', 'y', 'z', 'yaw'] as const) {
    const off = Math.abs(back[axis] - saved[axis]);
    expect(off, `${axis}: back at ${back[axis]}, saved ${saved[axis]}`).toBeLessThanOrEqual(0.01);
  }

  // From the h1 the wall answers the keyboard as before: the arrow keys turn the view.
  const turned = await holdKey(page, 'ArrowRight', 200, (camera) => camera.yaw !== back.yaw);
  expect(turned.yaw).not.toBe(back.yaw);
});

test('opened at /apps?from=data, the wall is the page: nothing out of sight shows, and focus stays put', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openLobby(page, '/apps?from=data');
  await expectOutOfSight(headingBlock(page));
  await expectOutOfSight(directoryBlock(page));
  await expect(directoryLink(page)).not.toBeFocused();
});

test('a tap on an empty slot stays in the cave, and only says so', async ({ page }) => {
  test.setTimeout(90_000);
  expect(appAt(slotFromIndex(DARK_SLOT)), `slot ${DARK_SLOT} must hold no app`).toBeUndefined();
  await openLobby(page);

  await tapScene(page, await slotOnScreen(page, DARK_SLOT));
  await expect(page.getByRole('status').filter({ hasText: 'Empty slot' })).toBeVisible();
  await expect(lobbyRoot(page)).toHaveAttribute('data-focus', `empty:${DARK_SLOT}`);
  // Nowhere to go: still the lobby a moment later, still up.
  await page.waitForTimeout(1_500);
  await expect(page).toHaveURL(/\/apps$/);
  await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'ready');
});

test.describe("an empty slot's readout, and its light on the rock", () => {
  /** The middle of the 3D view, where the crosshair is. */
  async function viewCentre(page: Page): Promise<{ x: number; y: number }> {
    const box = await lobbyRoot(page).locator('canvas').boundingBox();
    if (box === null) {
      throw new Error('the lobby has no canvas on screen');
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test('the mouse over an empty slot puts its readout in it and lights the rock; off it, both go', async ({ page }) => {
    test.setTimeout(120_000);
    // Facing the dark slot from the spawn point, so it is under the crosshair.
    await seedCamera(page, { ...INITIAL_CAMERA, yaw: facing(DARK_SLOT) });
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-focus', `empty:${DARK_SLOT}`);
    await expect(root).toHaveAttribute('data-hover-slot', '');
    await expect(root).toHaveAttribute('data-hover-glow', 'off');

    const centre = await viewCentre(page);
    await page.mouse.move(centre.x, centre.y + 40, { steps: 2 });
    await page.mouse.move(centre.x, centre.y, { steps: 2 });
    await expect(root).toHaveAttribute('data-hover-slot', String(DARK_SLOT));
    await expect(root).toHaveAttribute('data-hover-glow', 'on');

    // Down onto the floor: nothing under the mouse, so no readout and no light.
    await page.mouse.move(centre.x, centre.y * 1.8, { steps: 3 });
    await expect(root).toHaveAttribute('data-hover-slot', '');
    await expect(root).toHaveAttribute('data-hover-glow', 'off');

    // Back on it, then off the 3D view altogether (onto Exit): gone again.
    await page.mouse.move(centre.x, centre.y, { steps: 3 });
    await expect(root).toHaveAttribute('data-hover-slot', String(DARK_SLOT));
    await page.getByRole('link', { name: 'Exit the cave' }).hover();
    await expect(root).toHaveAttribute('data-hover-slot', '');
    await expect(root).toHaveAttribute('data-hover-glow', 'off');
  });

  test('a lit panel never shows one', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-focus', 'data');

    const centre = await viewCentre(page);
    await page.mouse.move(centre.x, centre.y + 30, { steps: 2 });
    await page.mouse.move(centre.x, centre.y, { steps: 2 });
    // The hover was read (the Data screen takes the pointer cursor), and still no readout.
    await expect
      .poll(() => lobbyRoot(page).locator('canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).style.cursor))
      .toBe('pointer');
    await page.waitForTimeout(2_000);
    await expect(root).toHaveAttribute('data-hover-slot', '');
    await expect(root).toHaveAttribute('data-hover-glow', 'off');
  });
});

test.describe('reduced motion', () => {
  test('data-motion follows the preference: reduced, then full, then reduced again', async ({ page }) => {
    await gotoLobby(page);
    const root = lobbyRoot(page);

    await expect(root).toHaveAttribute('data-motion', 'reduced');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(root).toHaveAttribute('data-motion', 'full');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(root).toHaveAttribute('data-motion', 'reduced');
  });

  test.describe('with no reduced-motion preference', () => {
    // Opts out of the suite-wide default.
    test.use({ contextOptions: { reducedMotion: 'no-preference' } });

    test('data-motion is full, and turns reduced when the preference does', async ({ page }) => {
      await gotoLobby(page);
      const root = lobbyRoot(page);

      await expect(root).toHaveAttribute('data-motion', 'full');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(root).toHaveAttribute('data-motion', 'reduced');
    });
  });
});

test.describe('the 2D lobby', () => {
  test("the Enter gate's link goes there: the heading and the tiles, no cave, no voice, the normal nav", async ({ page }) => {
    test.setTimeout(90_000);
    await expectWebGL2(page);
    await gotoLobby(page);
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-gate', 'open', { timeout: 60_000 });
    await clickThrough(page.getByRole('link', { name: 'Take me to the 2D lobby instead' }), /\/apps\?view=2d$/);

    await expect(root).toHaveAttribute('data-lobby-state', 'flat');
    await expect(root.locator('canvas')).toHaveCount(0);
    await expect(root).toHaveAttribute('data-feed', 'none');
    await expect(peoplePanel(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Exit the cave' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeFocused();
    await expectInSight(headingBlock(page));
    await expectInSight(directoryBlock(page));
    await expect(page.locator('header[data-chrome="lobby"]')).toHaveAttribute('data-nav-mode', 'bar');
    await clickThrough(directoryLink(page), /\/apps\/data$/);
  });

  test('/apps?view=2d opens straight into it, and never starts the 3D view', async ({ page }) => {
    await gotoLobby(page, '/apps?view=2d');
    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-lobby-state', 'flat');
    await expect(page.getByRole('button', { name: 'Enter', exact: true })).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(root.locator('canvas')).toHaveCount(0);
    await expect(root).not.toHaveAttribute('data-gate', /.*/);
    await expect(page.getByRole('link', { name: /Propose the next app/ })).toBeVisible();
  });
});

test.describe('without the 3D view', () => {
  test('no WebGL: the page says so and the directory still works', async ({ page }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      const blocked = ['webgl', 'webgl2', 'experimental-webgl'];
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          return blocked.includes(type) ? null : Reflect.apply(getContext, this, [type, ...rest]);
        },
      });
    });
    await gotoLobby(page);

    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-lobby-state', 'unsupported');
    await expect(page.getByText("This browser can't show the 3D lobby.")).toBeVisible();
    await expect(root.locator('canvas')).toHaveCount(0);
    // The list is the only way in now, so the page is its heading, lede and directory.
    await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
    await expectInSight(headingBlock(page));
    await expectInSight(directoryBlock(page));
    await clickThrough(directoryLink(page), /\/apps\/data$/);
  });

  test('the apps_lobby flag off: the heading, the directory and one line saying so', async ({ page }) => {
    // The practice build's fallback is every flag on, so off has to be served.
    await serveFlags(page, { apps_lobby: false });
    await gotoLobby(page);

    const root = lobbyRoot(page);
    await expect(root).toHaveAttribute('data-lobby-state', 'off');
    await expect(page.getByText('The 3D lobby is switched off right now.')).toBeVisible();
    await expect(root.locator('canvas')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
    await expect(page.getByText('Everything the community has built, on one wall.')).toBeVisible();
    await expectInSight(directoryBlock(page));
    await expect(directoryLink(page)).toHaveAttribute('href', '/apps/data');
    // The flat lobby: a tile per lit app, a card to propose the next, and no cave, no voice, no Enter.
    await expect(directoryLink(page)).toContainText('Slot 0 · Live');
    await expect(page.getByRole('link', { name: /Propose the next app/ })).toHaveAttribute('href', '/propose');
    await expect(page.getByRole('button', { name: 'Enter', exact: true })).toHaveCount(0);
    await expect(peoplePanel(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Exit the cave' })).toHaveCount(0);
  });

  test('the apps_lobby flag off, back from an app: focus goes to its directory link, the way in here', async ({
    page,
  }) => {
    await serveFlags(page, { apps_lobby: false });
    await gotoLobby(page, '/apps?from=data');
    await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'off');
    await expect(directoryLink(page)).toBeFocused();
    await expect(directoryLink(page)).toHaveAttribute('data-arrival-focus', '');
  });

  test('a lost WebGL context stops the view and says so; the directory stays', async ({ page }) => {
    test.setTimeout(90_000);
    await openLobby(page);
    await lobbyRoot(page)
      .locator('canvas')
      .evaluate((canvas) => {
        (canvas as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      });

    await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'lost');
    await expect(page.getByText('The 3D view stopped. Reload to try again.')).toBeVisible();
    await expectInSight(headingBlock(page));
    await expectInSight(directoryBlock(page));
    await expect(directoryLink(page)).toHaveAttribute('href', '/apps/data');
  });

  test('a view that fails while it builds ends in the same stopped state', async ({ page }) => {
    await expectWebGL2(page);
    // The shell's probe (memoised: one call per page load) gets WebGL2; the
    // scene's own renderer, which asks next, gets nothing, so the build throws.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      let calls = 0;
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          if (type === 'webgl2' && ++calls > 1) {
            return null;
          }
          return Reflect.apply(getContext, this, [type, ...rest]);
        },
      });
    });
    await gotoLobby(page);

    await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'lost', { timeout: 60_000 });
    await expect(page.getByText('The 3D view stopped. Reload to try again.')).toBeVisible();
    await expectInSight(headingBlock(page));
    await expectInSight(directoryBlock(page));
    await expect(directoryLink(page)).toHaveAttribute('href', '/apps/data');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the stick shows, nothing scrolls sideways, the light video loads, and dragging the stick walks', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const videos: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('.mp4')) {
        videos.push(path);
      }
    });
    await openLobby(page);

    // A phone gets the screen video's 640×360 encode, never the full one.
    await expect.poll(() => videos, { timeout: 30_000 }).toContain('/lobby/lobby-screen-360.mp4');
    expect(videos).not.toContain('/lobby/lobby-screen.mp4');

    // Coarse pointers get the touch stick and the lift buttons (Lobby.module.css).
    const stick = lobbyRoot(page).locator('[class*="stick"]');
    await expect(stick).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rise' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fall' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // A real touch drag (Playwright's touchscreen only taps): press the
    // stick's centre, push to its top edge, and hold there while it walks.
    const box = await stick.boundingBox();
    if (box === null) {
      throw new Error('the stick has no box');
    }
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const start = await readCamera(page);
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [centre] });
    try {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: centre.x, y: box.y + 4 }],
      });
      await expect.poll(async () => (await readCamera(page)).z, { timeout: 60_000 }).toBeLessThan(start.z);
    } finally {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  });

  test('a tap on an empty slot stays in the cave, says so, and shows its readout for about 3 s', async ({ page }) => {
    test.setTimeout(90_000);
    expect(appAt(slotFromIndex(EMPTY_ABOVE_DATA)), `slot ${EMPTY_ABOVE_DATA} must hold no app`).toBeUndefined();
    await openLobby(page);
    const root = lobbyRoot(page);

    await tapScene(page, await slotOnScreen(page, EMPTY_ABOVE_DATA), { touch: true });
    const tapped = Date.now();
    await expect(page.getByRole('status').filter({ hasText: 'Empty slot' })).toBeVisible();
    // No hover on a touch screen: the tap itself shows the readout, and the light behind it.
    await expect(root).toHaveAttribute('data-hover-slot', String(EMPTY_ABOVE_DATA));
    await expect(root).toHaveAttribute('data-hover-glow', 'on');
    // ...for about three seconds.
    await expect(root).toHaveAttribute('data-hover-slot', '', { timeout: 15_000 });
    expect(Date.now() - tapped).toBeGreaterThanOrEqual(2_500);
    await expect(root).toHaveAttribute('data-hover-glow', 'off');
    await expect(page).toHaveURL(/\/apps$/);
  });

  test('the people sheet: the count up top opens it, every line carries its Mute, the far ones fold, and the scrim closes it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The HUD's fullest state (a development build's fixture on the practice feed).
    await openLobby(page, '/apps?voice-fixture=full');
    const count = peopleCount(page);
    // Top right, across from Exit.
    const countBox = await count.boundingBox();
    expect(countBox !== null && countBox.y < 80 && countBox.x > 390 / 2, 'the count sits top right').toBe(true);
    // Mic and Deafen stay in the dock at the bottom, between the stick and the lift.
    await expect(peoplePanel(page).getByRole('button', { name: 'Mic', exact: true })).toBeVisible();

    const drawer = await openPeople(page);
    const box = await drawer.boundingBox();
    expect(box !== null && Math.round(box.y + box.height) === 844 && box.width === 390, 'a bottom sheet, edge to edge').toBe(true);
    // Nine here: a search. The two out of range stay folded behind their count.
    await expect(drawer.getByRole('searchbox', { name: 'Find a name' })).toBeVisible();
    await expect(personRow(page, 'gh:1008')).toHaveCount(0);
    // Every line shows its Mute, no opening first.
    await expect(personRow(page, 'gh:1001').getByRole('button', { name: 'Mute mara' })).toBeVisible();
    await expect(personRow(page, 'gh:1004').getByRole('button', { name: 'Mute octocat' })).toBeVisible();
    // A search unfolds what it finds.
    await drawer.getByRole('searchbox', { name: 'Find a name' }).fill('echo');
    await expect(drawer.locator('li[data-person-id]')).toHaveCount(1);
    await expect(personRow(page, 'gh:1008')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // A tap above the sheet, on the scrim, closes it.
    await page.touchscreen.tap(195, 120);
    await expect(drawer).toBeHidden();
    await expect(count).toHaveAttribute('aria-expanded', 'false');

  });
});

test('two tabs signed in with the practice account see each other, and a closed one leaves', async ({
  page,
  context,
}) => {
  // Two scenes at once share the CPU, so each builds and draws at about half speed.
  test.setTimeout(180_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  const other = await context.newPage();
  await other.goto('/apps');
  await Promise.all([enterLobby(page, 120_000), enterLobby(other, 120_000)]);

  // Once both views are up, each finds the other within ten seconds.
  const tabs = [page, other];
  await Promise.all(
    tabs.map((tab) => expect(lobbyRoot(tab)).toHaveAttribute('data-peers', '1', { timeout: 10_000 })),
  );
  for (const tab of tabs) {
    const root = lobbyRoot(tab);
    await expect(root).toHaveAttribute('data-feed', 'local');
    await expect(root).toHaveAttribute('data-voice', 'unavailable');
    const panel = peopleNearby(tab);
    // The practice build carries no voice, and says so.
    await expect(voiceLine(tab)).toHaveText(PRACTICE);
    await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toHaveCount(0);
    await expect(peopleCount(tab)).toHaveAccessibleName('2 here');
    // The other tab, in the list, under the practice account's login and with
    // its distance: both start at the spawn point, and their robots bump each
    // other a step apart (collideBodies), so within a couple of metres. No
    // voice, so no mute, and no groups by what you hear: one list.
    const drawer = await openPeople(tab);
    const others = drawer.getByRole('list', { name: 'Here' }).getByRole('listitem');
    await expect(others).toHaveCount(1);
    await expect(others.first()).toContainText('you');
    await expect(others.first().getByText(/^[0-2] m$/)).toBeVisible();
    await expect(others.first().getByRole('button', { name: /^Mute/ })).toHaveCount(0);
  }

  await other.close();
  // A closing tab says goodbye, but under SwiftShader that message can be
  // lost; then the peer goes when it has been silent for 3 s, seen on the
  // next software-rendered frame. Measured at 2 to 5 s: allow 10.
  await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '0', { timeout: 10_000 });
  await expect(peopleNearby(page)).toContainText(NOBODY);
});

test('someone whose position has not arrived is listed as joining, with no orb, until it does', async ({ page }) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  await enterLobby(page);
  const root = lobbyRoot(page);
  await openPeople(page);
  await expect(peopleNearby(page)).toContainText(NOBODY);

  // Another practice tab as the local feed hears one, with no position yet.
  await addGhost(page, GHOST, 'ghost');
  const row = personRow(page, GHOST);
  await expect(row).toContainText('ghost', { timeout: 20_000 });
  await expect(row).toContainText('joining');
  await expect(root).toHaveAttribute('data-peers', '0');

  // Its first position, 3 m ahead: now an orb, and a row with its distance.
  await addGhost(page, GHOST, 'ghost', { x: 0, y: 1.7, z: -3 });
  await expect(root).toHaveAttribute('data-peers', '1', { timeout: 20_000 });
  await expect(row).toContainText('3 m');
  await expect(row).not.toContainText('joining');

  await removeGhost(page, GHOST);
  await expect(root).toHaveAttribute('data-peers', '0', { timeout: 20_000 });
  await expect(peopleNearby(page)).toContainText(NOBODY);
});

test("the HUD by keyboard: the count opens the drawer, Tab goes into it, a row opens, and Escape closes it back to the count", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  await enterLobby(page);
  await addGhost(page, GHOST, 'ghost', { x: 4, y: 1.7, z: 0 });
  const count = peopleCount(page);
  await expect(count).toHaveAccessibleName('2 here', { timeout: 20_000 });

  await count.focus();
  await page.keyboard.press('Enter');
  await expect(count).toHaveAttribute('aria-expanded', 'true');
  const drawer = peoplePanel(page).getByRole('region', { name: 'People in the lobby' });
  await expect(drawer).toBeVisible();
  // Next after the count: the drawer, its Close first, then the rows.
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  const row = personRow(page, GHOST).locator('[data-control="row"]');
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(personRow(page, GHOST)).toContainText('4 m');
  // Space is the row's own (a button): it opens it, and leaves the camera where it is.
  const before = await readCamera(page);
  await page.keyboard.press('Space');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(1_500);
  expect((await readCamera(page)).y).toBe(before.y);
  // No voice here, so no Mute in it: the full name only.
  await expect(personRow(page, GHOST).getByRole('button', { name: /^Mute/ })).toHaveCount(0);
  // Escape closes the drawer, focus back on the count.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(count).toBeFocused();
  await expect(count).toHaveAttribute('aria-expanded', 'false');
  await expect(voiceLine(page)).toHaveText(PRACTICE);
});

test('a press opens a row to the full name and Mute, one row at a time', async ({ page }) => {
  test.setTimeout(120_000);
  await openLobby(page, '/apps?voice-fixture=full');
  const drawer = await openPeople(page);
  const long = personRow(page, 'gh:1002');
  const mara = personRow(page, 'gh:1001');
  // Folded, a line is the name, why you can't hear them, and the distance; Mute waits.
  await expect(long.getByRole('button', { name: /^Mute/ })).toBeHidden();
  await long.locator('[data-control="row"]').click();
  await expect(long.locator('[data-control="row"]')).toHaveAttribute('aria-expanded', 'true');
  // The whole of a long name, as text, under the line.
  await expect(long.getByText('a-login-as-long-as-github-allows-them-x', { exact: true }).last()).toBeVisible();
  await expect(long.getByRole('button', { name: 'Mute a-login-as-long-as-github-allows-them-x' })).toBeVisible();
  // Another row opens, and this one folds.
  await mara.locator('[data-control="row"]').click();
  await expect(mara.getByRole('button', { name: 'Mute mara' })).toBeVisible();
  await expect(long.locator('[data-control="row"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(long.getByRole('button', { name: /^Mute/ })).toBeHidden();
  // Mute moves them to the bottom group at once, and back.
  await mara.getByRole('button', { name: 'Mute mara' }).click();
  await expect(drawer.getByRole('list', { name: 'Muted by you' }).locator('li[data-person-id="gh:1001"]')).toHaveCount(1);
  await expect(mara.getByRole('button', { name: 'Mute mara' })).toHaveAttribute('aria-pressed', 'true');
  await mara.getByRole('button', { name: 'Mute mara' }).click();
  await expect(drawer.getByRole('list', { name: 'In earshot' }).locator('li[data-person-id="gh:1001"]')).toHaveCount(1);
});

test('a row that goes away under focus hands it on: to the next row, or, with the last, to the count', async ({ page }) => {
  test.setTimeout(150_000);
  // Rows, on the practice feed: two other tabs, at 4 and 8 m.
  await openLobby(page);
  await addGhost(page, 'practice-0a0b01', 'ghost-a', { x: 0, y: 1.7, z: -4 });
  await addGhost(page, 'practice-0a0b02', 'ghost-b', { x: 0, y: 1.7, z: -8 });
  const drawer = await openPeople(page);
  const a = personRow(page, 'practice-0a0b01').locator('[data-control="row"]');
  const b = personRow(page, 'practice-0a0b02').locator('[data-control="row"]');
  await expect(personRow(page, 'practice-0a0b02')).toContainText('8 m', { timeout: 20_000 });
  // The first leaves while its row has focus: the next row has it.
  await a.focus();
  await removeGhost(page, 'practice-0a0b01');
  await expect(personRow(page, 'practice-0a0b01')).toHaveCount(0, { timeout: 20_000 });
  await expect(b).toBeFocused();
  // The last leaves: the list goes with them, and the count has focus.
  await removeGhost(page, 'practice-0a0b02');
  await expect(personRow(page, 'practice-0a0b02')).toHaveCount(0, { timeout: 20_000 });
  await expect(peopleCount(page)).toBeFocused();
  await expect(drawer.getByText(NOBODY)).toBeVisible();
});

test('the list holds its order while the pointer is over it, and takes the new order once it leaves', async ({ page }) => {
  test.setTimeout(150_000);
  await openLobby(page);
  await addGhost(page, 'practice-0a0b01', 'ghost-a', { x: 0, y: 1.7, z: -4 });
  await addGhost(page, 'practice-0a0b02', 'ghost-b', { x: 0, y: 1.7, z: -8 });
  await openPeople(page);
  const rows = peopleNearby(page).locator('li[data-person-id]');
  const order = () => rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-person-id')));
  await expect.poll(order, { timeout: 20_000 }).toEqual(['practice-0a0b01', 'practice-0a0b02']);

  // The pointer on the second row, about to press something there; then the first walks past it.
  await rows.nth(1).hover();
  await addGhost(page, 'practice-0a0b01', 'ghost-a', { x: 0, y: 1.7, z: -12 });
  await expect(personRow(page, 'practice-0a0b01')).toContainText('12 m', { timeout: 20_000 });
  await page.waitForTimeout(1_000);
  expect(await order()).toEqual(['practice-0a0b01', 'practice-0a0b02']);
  // Off the list: half a second later it takes the new order.
  await page.mouse.move(200, 500);
  await expect.poll(order, { timeout: 5_000 }).toEqual(['practice-0a0b02', 'practice-0a0b01']);
});

test("the HUD's fullest state: every word, label, group and live region", async ({ page }) => {
  test.setTimeout(120_000);
  await openLobby(page, '/apps?voice-fixture=full');
  const panel = peopleNearby(page);
  const root = lobbyRoot(page);
  await expect(root).toHaveAttribute('data-voice', 'off');
  // Enter was the browser's gesture: sound is on from the first step, so no "Turn on sound".
  await expect(root).toHaveAttribute('data-sound', 'on');
  await expect(panel.getByRole('button', { name: 'Turn on sound' })).toHaveCount(0);
  await expect(voiceLine(page)).toHaveText('Voice on');
  // The one notice: why the mic didn't start, in --danger, and Mic says so too.
  await expect(voiceLine(page, 'problem')).toHaveText(
    'Your browser blocked the mic. Allow it in the site settings, then press the mic.',
  );
  await expect(voiceLine(page, 'problem')).toBeVisible();
  await expect(voiceLine(page, 'elsewhere')).toHaveText('');
  const mic = panel.getByRole('button', { name: 'Mic', exact: true });
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(mic).toHaveAttribute('title', 'Mic');

  // Toggles keep their words; aria-pressed says which way they are.
  const deafen = panel.getByRole('button', { name: 'Deafen', exact: true });
  await expect(deafen).toHaveAttribute('aria-pressed', 'false');
  await deafen.click();
  await expect(deafen).toHaveAttribute('aria-pressed', 'true');
  await expect(deafen).toHaveAccessibleName('Deafen');
  await expect(root).toHaveAttribute('data-deafened', 'true');

  // The count: everyone, you included, lit while someone is talking.
  await expect(peopleCount(page)).toHaveAccessibleName('9 here');
  const drawer = await openPeople(page);
  await expect(drawer).toContainText('9 here · 1 talking');
  await expect(drawer.getByRole('searchbox', { name: 'Find a name' })).toBeVisible();
  // Grouped by what you hear: out of range folded behind its count until asked for.
  const group = (name: string) => drawer.getByRole('list', { name, exact: true }).locator('li[data-person-id]');
  const ids = (name: string) => group(name).evaluateAll((items) => items.map((item) => item.getAttribute('data-person-id')));
  expect(await ids('Talking')).toEqual(['gh:1006']);
  expect(await ids('In earshot')).toEqual(['gh:1001', 'gh:1002', 'gh:1004', 'gh:1005']);
  expect(await ids('Muted by you')).toEqual(['gh:1003']);
  await expect(drawer.getByRole('list', { name: 'Out of range', exact: true })).toHaveCount(0);
  const show = drawer.getByRole('button', { name: 'Show', exact: true });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(drawer.getByRole('button', { name: 'Hide', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect(await ids('Out of range')).toEqual(['gh:1008', 'gh:1007']);
  await expect(drawer).toContainText('within 35 m');

  // Why you can't hear someone, where the group's own heading doesn't say it.
  const words = async (id: string) => (await personRow(page, id).locator('[class*="words"]').allTextContents()).join('');
  expect(await words('gh:1003')).toBe('');
  expect(await words('gh:1004')).toBe('mic off');
  expect(await words('gh:1005')).toBe('too many voices nearby');
  expect(await words('gh:1006')).toBe('');
  expect(await words('gh:1008')).toBe('');
  // Joining: no distance yet, and it says so.
  expect(await words('gh:1007')).toBe('joining');

  // Mute keeps its word; aria-pressed and the person's name say the rest.
  await personRow(page, 'gh:1003').locator('[data-control="row"]').click();
  const muted = panel.getByRole('button', { name: 'Mute devon-kit' });
  await expect(muted).toHaveAttribute('aria-pressed', 'true');
  await expect(muted).toHaveText('Mute devon-kit');
  expect(await muted.evaluate((button) => (button.firstChild?.textContent ?? '').trim())).toBe('Mute');
  // Names: their own direction, and the whole of a long one on hover.
  const long = personRow(page, 'gh:1002').locator('[class*="name"]').first();
  await expect(long).toHaveAttribute('dir', 'auto');
  await expect(long).toHaveAttribute('title', 'a-login-as-long-as-github-allows-them-x');
  // No numbers about the sound anywhere: no levels, no reverb, no kHz.
  await expect(panel.getByText(/Reverb|Direct|kHz/)).toHaveCount(0);

  // The search: by name, anywhere in the room.
  await drawer.getByRole('searchbox', { name: 'Find a name' }).fill('zzz');
  await expect(drawer.getByText('Nobody here by that name.')).toBeVisible();
  await drawer.getByRole('searchbox', { name: 'Find a name' }).fill('kit');
  expect(await drawer.locator('li[data-person-id]').evaluateAll((items) => items.map((item) => item.getAttribute('data-person-id')))).toEqual([
    'gh:1003',
  ]);
});

test("the practice build's token route has no LiveKit settings: even a GitHub session gets 503", async ({
  context,
  baseURL,
}) => {
  await signInAs(context, baseURL ?? '', { sub: '583231', login: 'octocat' });
  // A browser's own POST carries Origin; Playwright's request API sends none unless told.
  const response = await context.request.post('/api/lobby/token', { headers: { origin: baseURL ?? '' } });
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ error: 'voice_unavailable' });
});

test('/apps/nope asks for a sign-in, then is a 404 with the not-found page', async ({ page }) => {
  await page.goto('/apps/nope');
  await expect(page).toHaveURL(/\/signin\?next=%2Fapps%2Fnope$/);
  await demoSignIn(page);
  const response = await page.goto('/apps/nope');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Go to the lobby' })).toHaveAttribute('href', '/apps');
});
