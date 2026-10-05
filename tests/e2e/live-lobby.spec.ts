import { expect, test } from '@playwright/test';

import {
  DATA_LINK,
  enterLobby,
  expectWebGL2,
  holdKey,
  lobbyRoot,
  peoplePanel,
  readCamera,
  serveFlags,
  voiceLine,
} from './helpers/lobby';
import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * The Apps lobby on the build we deploy (project `chromium-live`, API
 * deliberately down), and the LiveKit room token behind its presence and
 * voice.
 *
 * Two things only this build has. Its flags fail closed, so with the flag
 * service down the lobby is switched off and /apps is just its directory.
 * And its presence feed is LiveKit's: a member signed in with GitHub asks
 * `POST /api/lobby/token` for a one-hour token to the `lobby` room, then
 * joins it. This server is given dummy LiveKit settings
 * (playwright.config.ts): enough for the route to mint a real token, while
 * the room's URL (`wss://example.invalid`) can never be reached, so a join
 * fails the way it would with LiveKit down. Nothing here needs, or reaches,
 * a real LiveKit server.
 *
 * The token is only decoded, never verified: the claims are what's under
 * test, and the secret is a dummy.
 *
 * One test stands in for LiveKit's signal server itself (Playwright's
 * WebSocket routing, on the unreachable room URL), to make the room evict a
 * member the way it does when they open the lobby in a second tab. Another
 * stands in for the token route's refusals, to check the people panel says
 * why there's no voice, and that a refused lobby never downloads LiveKit.
 *
 * Two members hearing each other needs a LiveKit server: that proof runs by
 * hand against a local one (ADR-004, "Voice v2").
 */

const MEMBER = { sub: '583231', login: 'octocat' };
const TOKEN = '/api/lobby/token';
const ELSEWHERE = "You're in the lobby in another tab or device.";

/**
 * Just enough protobuf to speak LiveKit's signal protocol (livekit_rtc.proto
 * in @livekit/protocol): varints, and length-delimited fields.
 */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}
const field = (no: number, bytes: number[]): number[] => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const text = (no: number, value: string): number[] => field(no, [...Buffer.from(value, 'utf8')]);
const enumValue = (no: number, value: number): number[] => [...varint(no << 3), ...varint(value)];

/** SignalResponse.join (1): JoinResponse { room (1) { sid, name }, participant (2) { sid, identity, name (9) }, server_version (4) }. */
function joinResponse(identity: string, name: string): Buffer {
  const room = [...text(1, 'RM_e2e'), ...text(2, 'lobby')];
  const participant = [...text(1, 'PA_e2e'), ...text(2, identity), ...text(9, name)];
  return Buffer.from(field(1, [...field(1, room), ...field(2, participant), ...text(4, '1.9.4')]));
}

/** SignalResponse.leave (8): LeaveRequest { reason (2): DUPLICATE_IDENTITY (2) }, action DISCONNECT (0, the default). */
const DUPLICATE_IDENTITY_LEAVE = Buffer.from(field(8, enumValue(2, 2)));

/** A JWT's payload, read as-is (base64url JSON); no signature check. */
function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (payload === undefined) {
    throw new Error('not a JWT');
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('with the API down the flags fail closed: no 3D view, just the directory', async ({ page, context, baseURL }) => {
  // The lobby needs a sign-in; this build's is GitHub's, sealed directly, so nothing calls the API.
  await signInAs(context, baseURL ?? '', MEMBER);
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/apps');

  const root = lobbyRoot(page);
  await expect(root).toHaveAttribute('data-lobby-state', 'off');
  await expect(page.getByText('The 3D lobby is switched off right now.')).toBeVisible();
  await expect(root.locator('canvas')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Apps', exact: true }).getByRole('link', { name: DATA_LINK, exact: true }),
  ).toHaveAttribute('href', '/apps/data');
});

test.describe('POST /api/lobby/token', () => {
  test('signed out: 401 with a Bearer challenge', async ({ request }) => {
    const response = await request.post(TOKEN);
    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toBe('Bearer');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a practice session counts as nobody on this build: 401 too', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await context.request.post(TOKEN, { headers: { origin: baseURL ?? '' } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a GitHub session gets a one-hour token for the lobby room, as gh:<id> under its login', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    // A browser's own POST carries Origin; Playwright's request API sends none unless told.
    const response = await context.request.post(TOKEN, { headers: { origin: baseURL ?? '' } });
    const issuedAt = Date.now() / 1000;

    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const body = (await response.json()) as { url: string; token: string };
    expect(Object.keys(body).sort()).toEqual(['token', 'url']);
    expect(body.url).toBe('wss://example.invalid');

    const claims = jwtClaims(body.token);
    // LiveKit's participant identity is the token's `sub`.
    expect(claims.sub).toBe(`gh:${MEMBER.sub}`);
    expect(claims.name).toBe(MEMBER.login);
    // Exactly these grants: a microphone is the only thing a member may publish.
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'lobby',
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    const lifetime = Number(claims.exp) - issuedAt;
    expect(lifetime).toBeGreaterThan(3600 - 60);
    expect(lifetime).toBeLessThanOrEqual(3600 + 5);
  });

  test('from another origin: 403 bad_origin', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    const response = await context.request.post(TOKEN, { headers: { origin: 'https://evil.example' } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad_origin' });
  });

  test('GET is 405, and names POST', async ({ request }) => {
    const response = await request.get(TOKEN);
    expect(response.status()).toBe(405);
    expect(response.headers().allow).toBe('POST');
    expect(await response.json()).toEqual({ error: 'method_not_allowed' });
  });
});

test("a member's lobby tries LiveKit, tries once more when the scene is up, and with the room out of reach carries on alone", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await expectWebGL2(page);
  await signInAs(context, baseURL ?? '', MEMBER);
  // This build's flags fail closed, and the flag service is down: switch the lobby on.
  await serveFlags(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Every try at the room starts by asking the token route (the first with
  // the grant the feed fetched itself), so the asks count the tries.
  let tokenAsks = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === TOKEN) {
      tokenAsks += 1;
    }
  });
  // Records, from inside the page: every value data-feed takes, in order,
  // after the server's markup; and every WebSocket the page opens. (A socket
  // that dies at DNS or a proxy never reaches Playwright's `websocket` event.)
  await page.addInitScript(() => {
    const feeds: string[] = [];
    const sockets: string[] = [];
    Object.assign(window, { __lobbyFeeds: feeds, __lobbySockets: sockets });
    new MutationObserver((records) => {
      for (const record of records) {
        const feed = (record.target as Element).getAttribute('data-feed');
        if (feed !== null && feeds[feeds.length - 1] !== feed) {
          feeds.push(feed);
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-feed'] });
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args: unknown[]) {
        sockets.push(String(args[0]));
        return Reflect.construct(target, args) as object;
      },
    });
  });
  const token = page.waitForResponse(
    (response) => response.url().endsWith(TOKEN) && response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await page.goto('/apps');

  // The route minted a token (so the feed's reason can't be signed-out,
  // practice or unavailable), and the browser went for the room with it.
  expect((await token).status()).toBe(200);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __lobbySockets: string[] }).__lobbySockets), {
      timeout: 60_000,
    })
    .toContainEqual(expect.stringMatching(/^wss:\/\/example\.invalid\/rtc/));

  // The room can't be reached: the feed gives up, the scene doesn't. The
  // route answered, so it's this browser's join that failed, and it tries
  // once more by itself once the scene is up: a second ask for a token. When
  // the first try fails after the scene is up, the second starts in the same
  // task, so data-feed need never show `none` in between: the asks count.
  await enterLobby(page);
  const root = lobbyRoot(page);
  const sockets = () =>
    page.evaluate(() => (window as unknown as { __lobbySockets: string[] }).__lobbySockets.filter((url) => url.startsWith('wss://example.invalid/rtc')).length);
  const feeds = () => page.evaluate(() => (window as unknown as { __lobbyFeeds: string[] }).__lobbyFeeds);
  await expect.poll(() => tokenAsks, { timeout: 60_000 }).toBe(2);
  const panel = peoplePanel(page);
  await expect(voiceLine(page)).toHaveText("Couldn't connect to voice.", { timeout: 60_000 });
  expect(await sockets()).toBeGreaterThanOrEqual(2);
  expect((await feeds())[0]).toBe('livekit');
  await expect(root).toHaveAttribute('data-feed', 'none');
  await expect(root).toHaveAttribute('data-peers', '0');
  await expect(root).toHaveAttribute('data-voice', 'unavailable');
  await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toBeDisabled();
  // It can't see the room, so it claims nobody is in it.
  await expect(panel.getByText('Nobody else is here yet.')).toHaveCount(0);
  // Only once by itself: "Try again" is the member's.
  await page.waitForTimeout(3_000);
  expect(tokenAsks).toBe(2);
  const tries = await sockets();
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => tokenAsks, { timeout: 30_000 }).toBe(3);
  await expect.poll(sockets, { timeout: 30_000 }).toBeGreaterThan(tries);
  await expect(voiceLine(page)).toHaveText("Couldn't connect to voice.", { timeout: 60_000 });

  // Still running: it walks, and nothing threw.
  const start = await readCamera(page);
  await holdKey(page, 'KeyW', 200, (camera) => camera.z < start.z);
  await expect(root).toHaveAttribute('data-lobby-state', 'ready');
  expect(errors).toEqual([]);
});

test("refused a token, the lobby says why there's no voice, and never downloads LiveKit", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInAs(context, baseURL ?? '', MEMBER);
  await serveFlags(page);
  // In development, the engine and livekit-client arrive as their own chunks, named for their modules.
  const voiceChunks: string[] = [];
  page.on('request', (request) => {
    if (/livekit|voice_engine/i.test(new URL(request.url()).pathname)) {
      voiceChunks.push(new URL(request.url()).pathname);
    }
  });
  const panel = peoplePanel(page);
  for (const [status, error, says] of [
    [401, 'unauthenticated', 'Sign in with GitHub to hear and talk to people here.'],
    [403, 'practice_session', 'The practice account has no voice. Sign in with GitHub to talk.'],
    [503, 'voice_unavailable', "Voice isn't set up on this site yet."],
  ] as const) {
    await page.unroute(`**${TOKEN}`);
    await page.route(`**${TOKEN}`, (route) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) }),
    );
    await page.goto('/apps');
    // The HUD waits behind the Enter gate; past it, the notice says why.
    await enterLobby(page);
    await expect(voiceLine(page), `after a ${status}`).toHaveText(says, { timeout: 60_000 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-feed', 'none');
    await expect(lobbyRoot(page)).toHaveAttribute('data-voice', 'unavailable');
    // No voice on this visit whatever is pressed: the dock is the people count alone.
    await expect(panel.getByRole('button', { name: 'Mic', exact: true })).toHaveCount(0);
    // No room to see, so no claim that nobody is in it, and the route's refusal is not one to try again.
    await expect(panel.getByText('Nobody else is here yet.')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
  expect(voiceChunks).toEqual([]);
});

test('opened in another tab or device, the lobby gives up its seat, says so, and "Rejoin here" takes it back', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await expectWebGL2(page);
  await signInAs(context, baseURL ?? '', MEMBER);
  await serveFlags(page);
  // The room's signal server, played here: accept the join, then evict it as
  // LiveKit evicts the older of two connections with one identity (a Leave,
  // reason DUPLICATE_IDENTITY). The second connection, the rejoin, is
  // accepted and left open.
  let joins = 0;
  await page.routeWebSocket(/^wss:\/\/example\.invalid\/rtc/, (ws) => {
    joins += 1;
    const first = joins === 1;
    ws.onMessage(() => undefined);
    ws.send(joinResponse(`gh:${MEMBER.sub}`, MEMBER.login));
    if (first) {
      setTimeout(() => ws.send(DUPLICATE_IDENTITY_LEAVE), 500);
    }
  });
  await page.goto('/apps');
  await enterLobby(page);

  const root = lobbyRoot(page);
  const people = page.getByRole('complementary', { name: 'People nearby' });
  await expect(people.getByText(ELSEWHERE, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(root).toHaveAttribute('data-feed', 'none');
  await expect(root).toHaveAttribute('data-voice', 'unavailable');
  expect(joins).toBe(1);

  await expect(voiceLine(page, 'elsewhere')).toHaveText(ELSEWHERE);
  // By keyboard: the button goes once pressed, and hands focus to Mic.
  await people.getByRole('button', { name: 'Rejoin here' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => joins, { timeout: 30_000 }).toBe(2);
  await expect(people.getByText(ELSEWHERE, { exact: true })).toHaveCount(0);
  await expect(voiceLine(page, 'elsewhere')).toHaveText('');
  await expect(people.getByRole('button', { name: 'Rejoin here' })).toHaveCount(0);
  await expect(people.getByRole('button', { name: 'Mic', exact: true })).toBeFocused();
  await expect(root).toHaveAttribute('data-feed', 'livekit');
  // The stand-in never completes the media connection, so the rejoin is still connecting.
  await expect(voiceLine(page)).toHaveText('Connecting…');
});
