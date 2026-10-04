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
 * playwright.config.ts asks every test for reduced motion (for the landing
 * page's splash), so the lobby runs with `data-motion=reduced` here unless a
 * test opts out, as the full-motion block below does (it never visits `/`).
 *
 * Presence on the practice build is the local feed: tabs of one browser
 * over a BroadcastChannel, no server and no voice. The people panel ("People
 * nearby") says so, and lists everyone else in the room with their
 * distance. Another tab is played from inside the page where one will do
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
  await expect(voiceLine(page)).toHaveText(PRACTICE);
  await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Deafen', exact: true })).toBeDisabled();
  // The practice feed sees the room (this browser's tabs), so it can say nobody is here.
  await expect(panel.getByText(NOBODY)).toBeVisible();
  // No room, so no cave sound to report, and no trouble to announce.
  await expect(panel.getByText(/cave sound/i)).toHaveCount(0);
  for (const which of ['problem', 'elsewhere', 'room-sound'] as const) {
    await expect(voiceLine(page, which)).toHaveText('');
  }
  // No voices, so no range to tell.
  await expect(page.getByText('Tap a panel to open', { exact: true })).toBeVisible();
  await expect(page.getByText(/Voices carry/)).toHaveCount(0);
  // At the right: the cave's top-left corner is its Exit.
  const box = await panel.boundingBox();
  expect(box !== null && box.x >= (page.viewportSize()?.width ?? 0) / 2, 'the panel stands in the right half').toBe(true);
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
  // 32 × 90 slots, one of them lit. Plain digits: no thousands separator.
  await expect(
    page
      .getByRole('navigation', { name: 'Apps', exact: true })
      .getByText('2879 empty slots are waiting for the next proposal.', { exact: true }),
  ).toHaveCount(1);
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

  // On out of it, and it steps out of sight again.
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
  await expectReady(page);

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
  await expectReady(page);
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
    // Opts out of the suite-wide default; never visits `/`, whose splash would then play.
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

  test('the people panel shows the nearest four and anyone speaking, then "and N more" opens the rest', async ({ page }) => {
    test.setTimeout(120_000);
    // The panel's fullest state (a development build's fixture on the practice feed).
    await openLobby(page, '/apps?voice-fixture=full');
    const panel = peopleNearby(page);
    const rows = panel.locator('li[data-person-id]');
    await expect(rows).toHaveCount(8);
    const shown = async () =>
      (await rows.evaluateAll((items) => items.filter((item) => item.getClientRects().length > 0).map((item) => item.getAttribute('data-person-id'))));
    // The nearest three, and the one speaking at 31 m, ahead of nearer people who are quiet.
    expect(await shown()).toEqual(['gh:1001', 'gh:1002', 'gh:1003', 'gh:1006']);
    const more = panel.getByRole('button', { name: 'and 4 more' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.focus();
    await page.keyboard.press('Enter');
    // Opened: everyone, and focus on the first of them that was out of sight.
    await expect(panel.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    expect(await shown()).toHaveLength(8);
    await expect(personRow(page, 'gh:1004').getByRole('button', { name: 'What you hear of octocat' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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
  await Promise.all([expectReady(page, 120_000), expectReady(other, 120_000)]);

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
    await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toBeDisabled();
    // The other tab, in the list, under the practice account's login and with
    // its distance: both stand at the spawn point. No voice, so no mute.
    const others = panel.getByRole('list', { name: 'People in the lobby' }).getByRole('listitem');
    await expect(others).toHaveCount(1);
    await expect(others.first()).toContainText('you');
    await expect(others.first().getByText('0 m', { exact: true })).toBeVisible();
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
  await expectReady(page);
  const root = lobbyRoot(page);
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

test("the panel's controls are reached by keyboard, in order, and say what they are", async ({ page }) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  await expectReady(page);
  await addGhost(page, GHOST, 'ghost', { x: 4, y: 1.7, z: 0 });
  const panel = peopleNearby(page);
  await expect(personRow(page, GHOST)).toContainText('4 m', { timeout: 20_000 });

  // No voice here, but the buttons stay in the tab order (aria-disabled), so a
  // keyboard finds them and the status line beside them says why.
  const mic = panel.getByRole('button', { name: 'Mic', exact: true });
  const deafen = panel.getByRole('button', { name: 'Deafen', exact: true });
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(mic).toHaveAttribute('aria-disabled', 'true');
  await expect(deafen).toHaveAttribute('aria-pressed', 'false');
  await mic.focus();
  await expect(mic).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(deafen).toBeFocused();
  // Next, the ghost's row: its level bar, the way to the numbers.
  await page.keyboard.press('Tab');
  await expect(personRow(page, GHOST).locator('[aria-describedby]')).toBeFocused();
  // Pressing a button that can't act does nothing, and says nothing new.
  await mic.focus();
  await page.keyboard.press('Enter');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(voiceLine(page)).toHaveText(PRACTICE);
});

test("a row's level bar shows what you hear as a tooltip, on focus or hover, and Escape hides it either way", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openLobby(page);
  await addGhost(page, GHOST, 'ghost', { x: 0, y: 1.7, z: -6 });
  const level = personRow(page, GHOST).getByRole('button', { name: 'What you hear of ghost' });
  const tip = personRow(page, GHOST).getByRole('tooltip');
  await expect(personRow(page, GHOST)).toContainText('6 m', { timeout: 20_000 });

  // The numbers stay out of sight until asked for.
  await expect(tip).toBeHidden();
  await level.focus();
  await expect(tip).toBeVisible();
  // The full name first, then the numbers. The practice build has no voice:
  // nothing direct, no reverb, and so no lowpass to report.
  await expect(tip).toHaveText('ghost Direct 0% · Reverb 0%');
  await expect(level).toHaveAccessibleDescription('ghost Direct 0% · Reverb 0%');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(level).toBeFocused();
  // Space is the bar's own (a button): it brings the tip back, and leaves the camera where it is.
  const before = await readCamera(page);
  await page.keyboard.press('Space');
  await expect(tip).toBeVisible();
  await page.waitForTimeout(1_500);
  expect((await readCamera(page)).y).toBe(before.y);
  // Focus again, or a hover, brings it back.
  await level.blur();
  await expect(tip).toBeHidden();
  await level.focus();
  await expect(tip).toBeVisible();
  await level.blur();
  await expect(tip).toBeHidden();

  // Hovered, with keyboard focus somewhere else: Escape still hides it (WCAG 1.4.13).
  await level.hover();
  await expect(tip).toBeVisible();
  await expect(level).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await page.waitForTimeout(300);
  await expect(tip).toBeHidden();
  // Off it and back on, it shows again; and the pointer can move onto the tip itself.
  await page.mouse.move(200, 500);
  await level.hover();
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(tip).toBeVisible();
});

test('a control that goes away under focus hands it on: to Mic, to the next row, or to the list', async ({ page }) => {
  test.setTimeout(150_000);
  // The fixture's "Turn on sound" and Retry go away when pressed, as the real ones do.
  await openLobby(page, '/apps?voice-fixture=full');
  const panel = peopleNearby(page);
  const mic = panel.getByRole('button', { name: 'Mic', exact: true });
  await panel.getByRole('button', { name: 'Turn on sound' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Turn on sound' })).toHaveCount(0);
  await expect(mic).toBeFocused();
  await expect(voiceLine(page)).toHaveText('Voice on');
  await panel.getByRole('button', { name: 'Retry' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(mic).toBeFocused();

  // Rows, on the practice feed: two other tabs, at 4 and 8 m.
  await openLobby(page);
  await addGhost(page, 'practice-0a0b01', 'ghost-a', { x: 0, y: 1.7, z: -4 });
  await addGhost(page, 'practice-0a0b02', 'ghost-b', { x: 0, y: 1.7, z: -8 });
  const a = personRow(page, 'practice-0a0b01').getByRole('button', { name: 'What you hear of ghost-a' });
  const b = personRow(page, 'practice-0a0b02').getByRole('button', { name: 'What you hear of ghost-b' });
  await expect(personRow(page, 'practice-0a0b02')).toContainText('8 m', { timeout: 20_000 });
  // The first leaves while its bar has focus: the next row's bar has it.
  await a.focus();
  await removeGhost(page, 'practice-0a0b01');
  await expect(personRow(page, 'practice-0a0b01')).toHaveCount(0, { timeout: 20_000 });
  await expect(b).toBeFocused();
  // The last leaves: the list goes with them, and Mic has focus.
  await removeGhost(page, 'practice-0a0b02');
  await expect(personRow(page, 'practice-0a0b02')).toHaveCount(0, { timeout: 20_000 });
  await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toBeFocused();
  await expect(panel.getByText(NOBODY)).toBeVisible();
});

test('the list holds its order while the pointer is over it, and takes the new order once it leaves', async ({ page }) => {
  test.setTimeout(150_000);
  await openLobby(page);
  await addGhost(page, 'practice-0a0b01', 'ghost-a', { x: 0, y: 1.7, z: -4 });
  await addGhost(page, 'practice-0a0b02', 'ghost-b', { x: 0, y: 1.7, z: -8 });
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

test("the panel's fullest state: every word, label and live region", async ({ page }) => {
  test.setTimeout(120_000);
  await openLobby(page, '/apps?voice-fixture=full');
  const panel = peopleNearby(page);
  const root = lobbyRoot(page);
  await expect(root).toHaveAttribute('data-voice', 'off');
  await expect(root).toHaveAttribute('data-sound', 'blocked');
  await expect(root).toHaveAttribute('data-room-sound', 'failed');

  // Sound held back: the status line says so, beside the button that fixes it.
  await expect(voiceLine(page)).toHaveText('Voice on. Sound is off until you press Turn on sound.');
  await expect(panel.getByRole('button', { name: 'Turn on sound' })).toBeVisible();
  await expect(voiceLine(page, 'room-sound')).toHaveText('Cave sound failed.');
  await expect(voiceLine(page, 'problem')).toHaveText(
    "Your browser blocked the mic. Allow the microphone in your browser's site settings, then press Mic again.",
  );
  await expect(voiceLine(page, 'elsewhere')).toHaveText('');

  // Toggles keep their words; aria-pressed says which way they are.
  const deafen = panel.getByRole('button', { name: 'Deafen', exact: true });
  await expect(deafen).toHaveAttribute('aria-pressed', 'false');
  await deafen.click();
  await expect(deafen).toHaveAttribute('aria-pressed', 'true');
  await expect(deafen).toHaveText('Deafen');
  await expect(root).toHaveAttribute('data-deafened', 'true');
  const muted = panel.getByRole('button', { name: 'Mute devon-kit' });
  await expect(muted).toHaveAttribute('aria-pressed', 'true');
  await expect(muted).toHaveText('Mute devon-kit');
  expect(await muted.evaluate((button) => (button.firstChild?.textContent ?? '').trim())).toBe('Mute');

  // Why you can't hear someone.
  const words = async (id: string) => (await personRow(page, id).locator('[class*="words"]').allTextContents()).join('');
  expect(await words('gh:1003')).toBe('muted by you');
  expect(await words('gh:1004')).toBe('mic off');
  expect(await words('gh:1005')).toBe('too many voices nearby');
  expect(await words('gh:1006')).toBe('');
  // Still received at 38 m (a voice is kept to 45 m), but past the 35 m falloff: nothing to hear.
  expect(await words('gh:1008')).toBe('out of range');
  // Joining: no distance yet, so no range word.
  await expect(personRow(page, 'gh:1007')).toContainText('joining');
  expect(await words('gh:1007')).toBe('');
  // Names: their own direction, and the whole of a long one on hover.
  const long = personRow(page, 'gh:1002').locator('[class*="name"]').first();
  await expect(long).toHaveAttribute('dir', 'auto');
  await expect(long).toHaveAttribute('title', 'a-login-as-long-as-github-allows-them-x');
  // The numbers: no lowpass for someone you hear nothing of.
  await expect(personRow(page, 'gh:1004').getByRole('button', { name: 'What you hear of octocat' })).toHaveAccessibleDescription(
    'octocat Direct 0% · Reverb 0%',
  );
  await expect(personRow(page, 'gh:1006').getByRole('button', { name: 'What you hear of far-talker' })).toHaveAccessibleDescription(
    'far-talker Direct 4% · Reverb 13% · 2.4 kHz',
  );
  await expect(personRow(page, 'gh:1008').getByRole('button', { name: 'What you hear of past-the-echo' })).toHaveAccessibleDescription(
    'past-the-echo Direct 0% · Reverb 0%',
  );
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
