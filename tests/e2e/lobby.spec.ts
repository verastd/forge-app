import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { INITIAL_CAMERA, appAt, slotFromIndex } from '../../packages/lobby/dist/index.js';
import {
  DATA_LINK,
  DATA_SLOT,
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
  radius,
  readCamera,
  savedCamera,
  seedCamera,
  serveFlags,
  signInToLobby,
  slotOnScreen,
  tapThrough,
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
 * over a BroadcastChannel, no server and no voice. The LiveKit feed is
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

function peopleNearby(page: Page) {
  return page.getByRole('complementary', { name: 'People nearby' });
}

test('the browser has WebGL2, or every scene test below fails for that reason', async ({ page }) => {
  await expectWebGL2(page);
});

test('signed in, the lobby comes up at the centre, facing the Data screen, alone', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Voice unavailable' })).toBeDisabled();
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

test('tapping a dark slot opens /propose for that slot', async ({ page }) => {
  test.setTimeout(90_000);
  expect(appAt(slotFromIndex(DARK_SLOT)), `slot ${DARK_SLOT} must hold no app`).toBeUndefined();
  await openLobby(page);

  await tapThrough(page, await slotOnScreen(page, DARK_SLOT), new RegExp(`/propose\\?slot=${DARK_SLOT}$`));
  await expect(page.getByText(`Slot ${DARK_SLOT} is free.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Propose', level: 1 })).toBeFocused();
});

test("/propose?slot= puts its note after the heading and lede, so a reader starting at the focused h1 reaches it", async ({
  page,
}) => {
  await page.goto(`/propose?slot=${DARK_SLOT}`);
  await expect(page.getByText(`Slot ${DARK_SLOT} is free.`)).toBeVisible();

  const texts = await page.locator('main').evaluate((main) => [...main.querySelectorAll('h1, p')].map((el) => el.textContent ?? ''));
  expect(texts.slice(0, 3)).toEqual([
    'Propose',
    'Where FORGE decides what to build next. A member brings an idea, another seconds it, and the floor decides it together, in the open.',
    `Slot ${DARK_SLOT} is free. Bring a proposal to fill it.`,
  ]);
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
    // The practice account's login, in the nearby list: both stand at the spawn point.
    await expect(tab.getByRole('complementary', { name: 'People nearby' })).toContainText('you');
    await expect(tab.getByRole('button', { name: 'Voice unavailable' })).toBeDisabled();
  }

  await other.close();
  // A closing tab says goodbye, but under SwiftShader that message can be
  // lost; then the peer goes when it has been silent for 3 s, seen on the
  // next software-rendered frame. Measured at 2 to 5 s: allow 10.
  await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '0', { timeout: 10_000 });
  await expect(page.getByRole('complementary', { name: 'People nearby' })).toContainText('nobody in range');
});

test('someone whose position has not arrived is listed as joining, with no orb, until it does', async ({ page }) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInToLobby(page);
  await expectReady(page);
  const root = lobbyRoot(page);
  await expect(peopleNearby(page)).toContainText('nobody in range');

  // Another practice tab as the local feed hears one: a hello every half
  // second, and no position yet (the feed drops a tab silent for 3 s).
  await page.evaluate(() => {
    const channel = new BroadcastChannel('forge.lobby');
    const hello = { type: 'hello', id: 'practice-0a0b0c', name: 'ghost' };
    channel.postMessage(hello);
    Object.assign(window, { __ghost: { channel, timer: setInterval(() => channel.postMessage(hello), 500) } });
  });
  await expect(peopleNearby(page)).toContainText('ghost · joining', { timeout: 20_000 });
  await expect(root).toHaveAttribute('data-peers', '0');

  // Its first position, 3 m ahead: now an orb, and a row with its distance.
  await page.evaluate(() => {
    const bytes = new Uint8Array(9);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 1);
    view.setInt16(3, 170, true);
    view.setInt16(5, -300, true);
    const { channel } = (window as unknown as { __ghost: { channel: BroadcastChannel } }).__ghost;
    channel.postMessage({ type: 'pos', id: 'practice-0a0b0c', name: 'ghost', pos: bytes });
  });
  await expect(root).toHaveAttribute('data-peers', '1', { timeout: 20_000 });
  await expect(peopleNearby(page)).toContainText('ghost');
  await expect(peopleNearby(page)).not.toContainText('joining');

  await page.evaluate(() => {
    const ghost = (window as unknown as { __ghost: { channel: BroadcastChannel; timer: number } }).__ghost;
    clearInterval(ghost.timer);
    ghost.channel.postMessage({ type: 'bye', id: 'practice-0a0b0c' });
  });
  await expect(root).toHaveAttribute('data-peers', '0', { timeout: 20_000 });
  await expect(peopleNearby(page)).toContainText('nobody in range');
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
