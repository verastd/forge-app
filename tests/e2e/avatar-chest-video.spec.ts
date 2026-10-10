import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * A chestplate that's a short clip (MP4 or WebM) instead of an image: read in
 * the browser first (Checking the clip…), refused with the reason when it's
 * too long, too big or not a clip at all, else uploaded with its progress and
 * shown as a clip that loops.
 *
 * The fixtures are real WebMs (Chromium plays WebM; it has no H.264): a 1.5 s
 * loop and a 20 s one. The editor's BFF is answered in the browser.
 */

const LOOP = readFileSync(join(__dirname, 'fixtures', 'chest-loop.webm'));
const TOO_LONG = readFileSync(join(__dirname, 'fixtures', 'chest-too-long.webm'));
const SHA = 'f'.repeat(64);
const MEMBERS = { members: [{ memberId: 'gh:1001', login: 'octo-alice' }] };
const COLORS = { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' };
const ROBOT = { memberId: 'gh:1001', colors: COLORS, updatedAt: '2026-10-05T08:00:00+00:00' };
const CHEST = '**/bff/avatars/members/gh%3A1001/chest';

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

async function openEditor(page: Page, robot: unknown = ROBOT): Promise<void> {
  await page.route('**/bff/avatars/members', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) }),
  );
  await page.route('**/bff/avatars', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avatars: [robot], heads: [] }) }),
  );
  await page.route(`**/bff/avatars/assets/${SHA}`, (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: LOOP }));
  await page.goto('/me/avatars');
  await expect(page.getByRole('heading', { name: '@octo-alice', exact: true })).toBeVisible({ timeout: 60_000 });
}

const chestInput = (page: Page) => page.locator('input[type=file][accept*="video/webm"]');

test.describe('a chestplate that plays', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a short clip is checked, uploaded with its progress, and shown as a clip', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await expect(page.getByRole('button', { name: 'Upload image or clip' })).toBeEnabled();
    const upload = held();
    let body: { contentType?: string; data?: string } | null = null;
    await page.route(CHEST, async (route) => {
      body = route.request().postDataJSON() as typeof body;
      await upload.handler(route);
    });
    await chestInput(page).setInputFiles({ name: 'loop.webm', mimeType: 'video/webm', buffer: LOOP });
    await expect(page.getByRole('progressbar', { name: 'the chestplate upload' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    await expect.poll(() => body?.contentType).toBe('video/webm');
    expect(Buffer.from(body!.data!, 'base64').equals(LOOP)).toBe(true);
    upload.release(200, { ...ROBOT, chest: SHA, chestType: 'video/webm' });
    await expect(page.getByText('An uploaded clip (it loops, silently)')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Replace clip' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Remove clip' })).toBeEnabled();
  });

  test('a clip that is too long, too big or not a clip is refused before it is sent', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    let sent = 0;
    await page.route(CHEST, (route) => {
      sent += 1;
      return route.fulfill({ status: 500, body: '' });
    });
    await chestInput(page).setInputFiles({ name: 'long.webm', mimeType: 'video/webm', buffer: TOO_LONG });
    await expect(page.getByRole('alert').filter({ hasText: /That clip is 20 s\. The most is 15 s/ })).toBeVisible();
    await chestInput(page).setInputFiles({ name: 'huge.webm', mimeType: 'video/webm', buffer: Buffer.alloc(3 * 1024 * 1024 + 1) });
    await expect(page.getByRole('alert').filter({ hasText: /That clip is 3\.0 MB\. The most is 3\.0 MB/ })).toBeVisible();
    await chestInput(page).setInputFiles({ name: 'broken.webm', mimeType: 'video/webm', buffer: Buffer.from('not a video at all') });
    await expect(page.getByRole('alert').filter({ hasText: 'This browser couldn’t play that clip' })).toBeVisible();
    await chestInput(page).setInputFiles({ name: 'clip.mov', mimeType: 'video/quicktime', buffer: Buffer.from('moov') });
    await expect(page.getByRole('alert').filter({ hasText: 'Use a PNG, JPEG or WebP image. (Or a short MP4 or WebM clip.)' })).toBeVisible();
    expect(sent).toBe(0);
  });

  test('a clip the API refuses says why; a saved clip can be removed', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { ...ROBOT, chest: SHA, chestType: 'video/webm' });
    await expect(page.getByText('An uploaded clip (it loops, silently)')).toBeVisible();
    await page.route(CHEST, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_request', fields: ['data'], reason: 'not_webm' }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROBOT) });
    });
    await chestInput(page).setInputFiles({ name: 'loop.webm', mimeType: 'video/webm', buffer: LOOP });
    await expect(page.getByRole('alert').filter({ hasText: 'That file isn’t really a WebM.' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove clip' }).click();
    await expect(page.getByText('Their initials (no image yet)')).toBeVisible();
  });
});
