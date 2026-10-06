import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { addGhost, lobbyRoot, openLobby, serveFlags } from './helpers/lobby';
import type { FlagName } from './helpers/lobby';
import { demoSignIn, signInAs } from './helpers/session';
import { assertionClaims, json, withStandIn } from './helpers/standin';

/**
 * Robot avatars (`lobby_avatars`), project `chromium-demo`.
 *
 * In the lobby, another member is a robot once the shared body
 * (/lobby/robot.glb) is in, and an orb until then, or for good when the flag
 * is off or the body can't load. The page reports how many people are
 * robots as `data-robots`; no assertion reads pixels.
 *
 * The admin's editor (/me/avatars) is driven with its BFF answered in the
 * browser (page.route), so each answer can be held to show the state the
 * page is in while it waits: loading, saving, uploading. The BFF itself is
 * checked against the stand-in API on the demo server's API port.
 */

const SHA = 'a'.repeat(64);
const MEMBERS = {
  members: [
    { memberId: 'gh:1001', login: 'octo-alice' },
    { memberId: 'gh:1003', login: 'bob-builds' },
  ],
};
const LIST = {
  avatars: [
    {
      memberId: 'gh:1003',
      colors: { shell: '#d6452f', trim: '#2b2d33', accent: '#ffd36e', eye: '#ffe066' },
      updatedAt: '2026-10-05T08:00:00+00:00',
    },
  ],
  heads: [
    {
      id: 'phantom',
      name: 'Phantom mask',
      sha256: SHA,
      bytes: 192_000,
      fit: 'accessory',
      eyes: false,
      updatedAt: '2026-10-05T08:00:00+00:00',
    },
  ],
};

/** A route that answers when `release` is called: the page shows its waiting state meanwhile. */
function held(): { handler: (route: Route) => Promise<void>; release: (status: number, body: unknown) => void } {
  let answer: (value: [number, unknown]) => void = () => undefined;
  const ready = new Promise<[number, unknown]>((resolve) => {
    answer = resolve;
  });
  return {
    handler: async (route) => {
      const [status, body] = await ready;
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    },
    release: (status, body) => answer([status, body]),
  };
}

async function openEditor(page: Page): Promise<void> {
  await page.route('**/bff/avatars/members', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) }),
  );
  await page.route('**/bff/avatars', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) }),
  );
  await page.goto('/me/avatars');
  await expect(page.getByRole('heading', { name: '@octo-alice' })).toBeVisible({ timeout: 60_000 });
}

test.describe('robots in the lobby', () => {
  test.describe.configure({ timeout: 150_000 });

  test('another member is a robot once the body is in', async ({ page }) => {
    await serveFlags(page);
    await openLobby(page);
    await addGhost(page, 'practice-0a0a0a', 'robo friend', { x: 0, y: 1.7, z: -3 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-robots', '1', { timeout: 60_000 });
  });

  test('with lobby_avatars off, everyone stays an orb', async ({ page }) => {
    let bodyRequested = false;
    await page.route('**/lobby/robot.glb', (route) => {
      bodyRequested = true;
      return route.continue();
    });
    await serveFlags(page, { lobby_avatars: false });
    await openLobby(page);
    await addGhost(page, 'practice-0b0b0b', 'orb friend', { x: 0, y: 1.7, z: -3 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
    await page.waitForTimeout(3_000);
    await expect(lobbyRoot(page)).toHaveAttribute('data-robots', '0');
    expect(bodyRequested).toBe(false);
  });

  test('if the body can’t load, everyone stays an orb and the lobby carries on', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.route('**/lobby/robot.glb', (route) => route.abort('failed'));
    await serveFlags(page);
    await openLobby(page);
    await addGhost(page, 'practice-0c0c0c', 'still an orb', { x: 0, y: 1.7, z: -3 });
    await expect(lobbyRoot(page)).toHaveAttribute('data-peers', '1', { timeout: 15_000 });
    await expect.poll(() => warnings.some((w) => w.includes('robot avatars could not load')), { timeout: 20_000 }).toBe(true);
    await expect(lobbyRoot(page)).toHaveAttribute('data-robots', '0');
    await expect(lobbyRoot(page)).toHaveAttribute('data-lobby-state', 'ready');
  });
});

test.describe('the avatar editor', () => {
  test.describe.configure({ timeout: 90_000 });

  test('the practice account is told it can’t change avatars', async ({ page }) => {
    await page.goto('/signin?next=%2Fme%2Favatars');
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/me\/avatars$/);
    await expect(page.getByText('The practice account can’t change avatars')).toBeVisible();
  });

  test('it shows it is loading, then the members and the first robot', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    const members = held();
    await page.route('**/bff/avatars/members', members.handler);
    await page.route('**/bff/avatars', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) }),
    );
    await page.goto('/me/avatars');
    await expect(page.getByText('Loading members and the head library…')).toBeVisible();
    members.release(200, MEMBERS);
    await expect(page.getByRole('heading', { name: '@octo-alice' })).toBeVisible();
    await expect(page.getByRole('button', { name: /@bob-builds/ })).toContainText('(customised)');
    // The preview loads, then is ready (or says it can't, with a way to try again).
    await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview', /^(ready|error)$/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /Phantom mask/ })).toContainText('Face accessory');
  });

  test('it sits under the site nav, and its old address leads to it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await page.route('**/bff/avatars/members', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) }),
    );
    await page.route('**/bff/avatars', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) }),
    );
    await page.goto('/apps/avatars');
    await expect(page).toHaveURL(/\/me\/avatars$/);
    await expect(page.getByRole('heading', { name: 'Robot avatars', level: 1 })).toBeVisible();
    // The way back: the site nav and the account menu are both there.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Apps' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: trent-admin' })).toBeVisible();
  });

  test('a refusal says why, with no way to retry what can’t change', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '1001', login: 'not-an-admin' });
    await page.route('**/bff/avatars/members', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'admin_only' }) }),
    );
    await page.route('**/bff/avatars', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) }),
    );
    await page.goto('/me/avatars');
    await expect(page.getByText('Only admins can change avatars.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('a failed load can be tried again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    let calls = 0;
    await page.route('**/bff/avatars/members', (route) => {
      calls += 1;
      return calls === 1
        ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) });
    });
    await page.route('**/bff/avatars', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIST) }),
    );
    await page.goto('/me/avatars');
    await expect(page.getByText('Couldn’t reach the server.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: '@octo-alice' })).toBeVisible();
  });

  test('Save shows Saving…, then Saved; a failed save says why and tries again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await page.getByRole('button', { name: /Phantom mask/ }).click();
    await page.getByRole('button', { name: 'Use palette 6' }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    const first = held();
    await page.route('**/bff/avatars/members/gh%3A1001', first.handler);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saving = page.getByRole('button', { name: 'Saving…' });
    await expect(saving).toBeVisible();
    await expect(saving).toBeDisabled();
    await expect(saving).toHaveAttribute('aria-busy', 'true');
    first.release(502, { error: 'service_unreachable' });
    await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t reach the server' })).toBeVisible();
    await page.unroute('**/bff/avatars/members/gh%3A1001');

    const second = held();
    let body: unknown = null;
    await page.route('**/bff/avatars/members/gh%3A1001', async (route) => {
      body = route.request().postDataJSON();
      await second.handler(route);
    });
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
    second.release(200, {
      memberId: 'gh:1001',
      colors: { shell: '#f4f1ea', trim: '#e0457b', accent: '#ff8fb5', eye: '#ff4f8b' },
      head: 'phantom',
      updatedAt: '2026-10-05T09:00:00+00:00',
    });
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    expect(body).toEqual({ colors: { shell: '#f4f1ea', trim: '#e0457b', accent: '#ff8fb5', eye: '#ff4f8b' }, head: 'phantom' });
  });

  test('a chestplate upload saves the colours first, then shows its progress', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    const saved = {
      memberId: 'gh:1001',
      colors: { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' },
      updatedAt: '2026-10-05T09:00:00+00:00',
    };
    await page.route('**/bff/avatars/members/gh%3A1001', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...saved, colors: route.request().postDataJSON().colors }) }),
    );
    const upload = held();
    await page.route('**/bff/avatars/members/gh%3A1001/chest', upload.handler);
    // A 1×1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: 'chest.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('progressbar', { name: 'the chestplate upload' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    upload.release(200, { ...saved, chest: SHA });
    await expect(page.getByText('An uploaded image')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  });

  test('a chestplate the API refuses says why, in words', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await page.getByRole('button', { name: /@bob-builds/ }).click();
    await page.route('**/bff/avatars/members/gh%3A1003/chest', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_request', fields: ['data'], reason: 'not_png' }),
      }),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: 'chest.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('alert').filter({ hasText: 'That file isn’t really a PNG.' })).toBeVisible();
  });

  test('a file of the wrong kind is refused before it is sent', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await page
      .locator('input[type=file][accept^="image"]')
      .setInputFiles({ name: 'chest.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await expect(page.getByRole('alert').filter({ hasText: 'Use a PNG, JPEG or WebP image.' })).toBeVisible();
    await page
      .getByLabel(/File \(\.glb/)
      .setInputFiles({ name: 'head.obj', mimeType: 'text/plain', buffer: Buffer.from('o head') });
    await expect(page.getByRole('alert').filter({ hasText: 'Choose a .glb file' })).toBeVisible();
  });
});

test.describe('a head that fails to load', () => {
  test.describe.configure({ timeout: 120_000 });

  test('is tried again while the robot still wears it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    // A glTF 2.0 head with nothing in it but its two eye empties: enough to load.
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ name: 'EyeL' }, { name: 'EyeR' }] }));
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(20);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + padded.length, 8);
    header.writeUInt32LE(padded.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const head = Buffer.concat([header, padded]);
    const tries: number[] = [];
    await page.route(`**/bff/avatars/assets/${SHA}`, (route) => {
      tries.push(Date.now());
      return tries.length === 1
        ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) })
        : route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: head });
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Phantom mask/ }).click();
    await expect.poll(() => tries.length, { timeout: 15_000 }).toBe(1);
    // It keeps its own head meanwhile, and asks again about half a minute later.
    await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview', 'ready', { timeout: 30_000 });
    await expect.poll(() => tries.length, { timeout: 60_000, intervals: [1_000] }).toBe(2);
    expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(30_000);
  });
});

test.describe('the account menu', () => {
  /**
   * Opens the account panel. A click that lands before the page has hydrated
   * does nothing, so it is clicked again until Profile shows.
   */
  async function openPanel(page: Page, name: string | RegExp): Promise<void> {
    await expect(async () => {
      const profile = page.getByRole('link', { name: 'Profile' });
      if (!(await profile.isVisible())) await page.getByRole('button', { name }).click();
      await expect(profile).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }

  /** Signs in as `login`, answers the access check with `canEdit`, and opens the menu. */
  async function openMenu(
    page: Page,
    context: BrowserContext,
    baseURL: string | undefined,
    canEdit: boolean,
    flags: Partial<Record<FlagName, boolean>> = {},
  ): Promise<{ asked: () => number }> {
    let asked = 0;
    await serveFlags(page, flags);
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await page.route('**/bff/avatars/me', (route) => {
      asked += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canEdit }) });
    });
    await page.goto('/');
    await openPanel(page, 'Account: trent-admin');
    return { asked: () => asked };
  }

  test('an admin gets Robot avatars, which opens the editor', async ({ page, context, baseURL }) => {
    await openMenu(page, context, baseURL, true);
    const link = page.getByRole('link', { name: 'Robot avatars' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/me/avatars');
    await link.click();
    await expect(page).toHaveURL(/\/me\/avatars$/);
  });

  test('anyone else gets no such link', async ({ page, context, baseURL }) => {
    const menu = await openMenu(page, context, baseURL, false);
    await expect.poll(menu.asked).toBe(1);
    await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toHaveCount(0);
  });

  test('with robot avatars off, nobody is asked and nobody gets the link', async ({ page, context, baseURL }) => {
    const menu = await openMenu(page, context, baseURL, true, { lobby_avatars: false });
    await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(menu.asked()).toBe(0);
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toHaveCount(0);
  });

  test('an API from before /me asks the member list instead', async ({ page, context, baseURL }) => {
    await serveFlags(page);
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await page.route('**/bff/avatars/me', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Not Found' }) }),
    );
    await page.route('**/bff/avatars/members', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ members: [] }) }),
    );
    await page.goto('/');
    await openPanel(page, 'Account: trent-admin');
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toBeVisible();
  });

  test('on that older API, admin_only from the member list means no link', async ({ page, context, baseURL }) => {
    await serveFlags(page);
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await page.route('**/bff/avatars/me', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Not Found' }) }),
    );
    let listed = 0;
    await page.route('**/bff/avatars/members', (route) => {
      listed += 1;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'admin_only' }) });
    });
    await page.goto('/');
    await openPanel(page, 'Account: trent-admin');
    await expect.poll(() => listed).toBe(1);
    await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(page.getByText('Checking admin access…')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toHaveCount(0);
  });

  test('the check shows a spinner, then a failure and Retry, then the link', async ({ page, context, baseURL }) => {
    await serveFlags(page);
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route('**/bff/avatars/me', async (route) => {
      calls += 1;
      if (calls === 1) {
        await held;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canEdit: true }) });
    });
    await page.goto('/');
    await openPanel(page, 'Account: trent-admin');
    await expect(page.getByRole('status').filter({ hasText: 'Checking admin access…' })).toBeVisible();
    release();
    const failure = page.getByRole('alert').filter({ hasText: 'Couldn’t check admin access.' });
    await expect(failure).toBeVisible();
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toBeVisible();
    await expect(failure).toHaveCount(0);
  });

  test('the practice account is never asked', async ({ page }) => {
    let asked = 0;
    await serveFlags(page);
    await page.route('**/bff/avatars/me', (route) => {
      asked += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canEdit: true }) });
    });
    await page.goto('/signin?next=%2F');
    await demoSignIn(page);
    await openPanel(page, /^Account:/);
    await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(asked).toBe(0);
    await expect(page.getByRole('link', { name: 'Robot avatars' })).toHaveCount(0);
  });
});

test.describe('the avatars BFF, against a stand-in API', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('the list goes up as nobody signed out; everything else needs you, as you', async ({ context, baseURL }) => {
    const base = baseURL ?? '';
    await withStandIn(
      (request) =>
        request.path === '/api/avatars' || request.path === '/api/avatars/members'
          ? json(200, request.path === '/api/avatars' ? LIST : MEMBERS)
          : request.path === '/api/avatars/me'
            ? json(200, { canEdit: true })
            : undefined,
      async (seen) => {
        const list = await context.request.get('/bff/avatars');
        expect(list.status()).toBe(200);
        expect(await list.json()).toEqual(LIST);
        expect(seen[0]?.authorization).toBeNull();
        expect((await context.request.get('/bff/avatars/members')).status()).toBe(401);
        expect((await context.request.get('/bff/avatars/me')).status()).toBe(401);

        await signInAs(context, base, { sub: '4242', login: 'trent-admin' });
        const members = await context.request.get('/bff/avatars/members');
        expect(members.status()).toBe(200);
        expect(assertionClaims(seen.at(-1)?.authorization)).toMatchObject({ sub: '4242', login: 'trent-admin' });
        const me = await context.request.get('/bff/avatars/me');
        expect(await me.json()).toEqual({ canEdit: true });
        expect(seen.at(-1)?.path).toBe('/api/avatars/me');
        expect(assertionClaims(seen.at(-1)?.authorization)).toMatchObject({ sub: '4242' });
      },
    );
  });

  test('writes go up as you, to the path they name; anything not listed is a 404', async ({ context, baseURL }) => {
    const base = baseURL ?? '';
    await signInAs(context, base, { sub: '4242', login: 'trent-admin' });
    const writes: Array<['PUT' | 'DELETE', string, unknown]> = [
      ['PUT', '/members/gh:1001', { colors: LIST.avatars[0]?.colors }],
      ['DELETE', '/members/gh:1001', undefined],
      ['PUT', '/members/gh:1001/chest', { contentType: 'image/png', data: 'iVBORw0KGgo=' }],
      ['DELETE', '/members/gh:1001/chest', undefined],
      ['PUT', '/heads/phantom-mask', { name: 'Phantom', fit: 'accessory', data: 'Z2xURg==' }],
      ['DELETE', '/heads/phantom-mask', undefined],
    ];
    await withStandIn(
      (request) => (request.path.startsWith('/api/avatars/') ? json(200, { ok: true }) : undefined),
      async (seen) => {
        for (const [method, path, data] of writes) {
          const response = await context.request.fetch(`/bff/avatars${path}`, {
            method,
            ...(data === undefined ? {} : { data }),
            headers: { origin: base, 'content-type': 'application/json' },
          });
          expect(response.status(), `${method} ${path}`).toBe(200);
        }
        expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(writes.map(([m, p]) => `${m} /api/avatars${p}`));

        for (const [method, path] of [
          ['GET', '/members/gh:1001'],
          ['PUT', '/members/1001'],
          ['PUT', '/heads/Bad_Head'],
          ['POST', '/members/gh:1001'],
          ['PUT', '/members/gh:1001/chest/extra'],
          ['GET', '/assets/nope'],
        ] as const) {
          const response = await context.request.fetch(`/bff/avatars${path}`, {
            method,
            data: {},
            headers: { origin: base, 'content-type': 'application/json' },
          });
          expect(response.status(), `${method} ${path}`).toBe(path === '/assets/nope' ? 404 : method === 'POST' ? 405 : 404);
        }
      },
    );
  });

  test('a stored file comes back with its own type, cached for good; any other type does not', async ({ context }) => {
    const glb = 'b'.repeat(64);
    const html = 'c'.repeat(64);
    await withStandIn(
      (request) =>
        request.path === `/api/avatars/assets/${SHA}`
          ? { status: 200, headers: { 'content-type': 'image/png', 'set-cookie': 'x=1' }, body: 'PNGDATA' }
          : request.path === `/api/avatars/assets/${glb}`
            ? { status: 200, headers: { 'content-type': 'model/gltf-binary' }, body: 'glTF' }
            : request.path === `/api/avatars/assets/${html}`
              ? { status: 200, headers: { 'content-type': 'text/html' }, body: '<script>' }
              : json(404, { error: 'asset_not_found' }),
      async () => {
        const image = await context.request.get(`/bff/avatars/assets/${SHA}`);
        expect(image.status()).toBe(200);
        expect(image.headers()['content-type']).toBe('image/png');
        expect(image.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(image.headers()['set-cookie']).toBeUndefined();
        expect(await image.text()).toBe('PNGDATA');
        expect((await context.request.get(`/bff/avatars/assets/${glb}`)).headers()['content-type']).toBe('model/gltf-binary');
        expect((await context.request.get(`/bff/avatars/assets/${html}`)).status()).toBe(502);
        expect((await context.request.get(`/bff/avatars/assets/${'d'.repeat(64)}`)).status()).toBe(404);
      },
    );
  });
});
