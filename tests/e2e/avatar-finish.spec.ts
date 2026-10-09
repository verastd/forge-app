import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * Two-tone eyes and finishes (paint, chrome, ice) in the avatar editor.
 *
 * The editor's BFF is answered in the browser (page.route), as lobby-avatars
 * does, so each answer can be held to show the state the page is in. A right
 * eye and a finish go up only when set: a robot without them saves exactly as
 * it always did.
 */

const MEMBERS = { members: [{ memberId: 'gh:1001', login: 'octo-alice' }] };
const COLORS = { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' };
const LIST = { avatars: [{ memberId: 'gh:1001', colors: COLORS, updatedAt: '2026-10-05T08:00:00+00:00' }], heads: [] };
const SAVE = '**/bff/avatars/members/gh%3A1001';

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

async function openEditor(page: Page, list: unknown = LIST): Promise<void> {
  await page.route('**/bff/avatars/members', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) }),
  );
  await page.route('**/bff/avatars', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));
  await page.goto('/me/avatars');
  await expect(page.getByRole('heading', { name: '@octo-alice', exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Sets a colour input as the picker would. */
async function pick(page: Page, label: string, value: string): Promise<void> {
  await page
    .locator('label', { hasText: label })
    .locator('input[type=color]')
    .evaluate((el, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

test.describe('two-tone eyes and finishes', () => {
  test.describe.configure({ timeout: 90_000 });

  test('a different right eye and a chrome finish go up with the save, which says Saving…, then Saved', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    const finish = page.getByRole('group', { name: 'Finish' });
    await expect(finish.getByRole('button', { name: /^Paint/ })).toHaveAttribute('aria-pressed', 'true');

    await page.getByLabel('Different right eye').check();
    await expect(page.getByText('Left eye', { exact: true })).toBeVisible();
    await pick(page, 'Right eye', '#ff2d55');
    await finish.getByRole('button', { name: /^Chrome/ }).click();
    await expect(finish.getByRole('button', { name: /^Chrome/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    const save = held();
    let body: unknown = null;
    await page.route(SAVE, async (route) => {
      body = route.request().postDataJSON();
      await save.handler(route);
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saving = page.getByRole('button', { name: 'Saving…' });
    await expect(saving).toBeDisabled();
    await expect(saving).toHaveAttribute('aria-busy', 'true');
    save.release(200, { memberId: 'gh:1001', colors: { ...COLORS, eyeRight: '#ff2d55' }, finish: 'chrome', updatedAt: '2026-10-05T09:00:00+00:00' });
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    expect(body).toEqual({ colors: { ...COLORS, eyeRight: '#ff2d55' }, finish: 'chrome' });
    // The member list says so too.
    await expect(page.getByRole('button', { name: /@octo-alice/ }).getByText('Chrome')).toBeVisible();
  });

  test('switched back to one eye and paint, the save is just the colours, and Undo puts the draft back', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    const dressed = { ...LIST, avatars: [{ ...LIST.avatars[0], colors: { ...COLORS, eyeRight: '#ff2d55' }, finish: 'ice' }] };
    await openEditor(page, dressed);
    const finish = page.getByRole('group', { name: 'Finish' });
    await expect(finish.getByRole('button', { name: /^Ice/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Different right eye')).toBeChecked();

    // A change, then Undo: nothing to save.
    await finish.getByRole('button', { name: /^Paint/ }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: /Undo changes/ }).click();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await expect(finish.getByRole('button', { name: /^Ice/ })).toHaveAttribute('aria-pressed', 'true');

    await page.getByLabel('Different right eye').uncheck();
    await expect(page.locator('label', { hasText: 'Right eye' }).locator('input[type=color]')).toHaveCount(0);
    await finish.getByRole('button', { name: /^Paint/ }).click();
    let body: unknown = null;
    await page.route(SAVE, async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...LIST.avatars[0] }) });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    expect(body).toEqual({ colors: COLORS });
  });

  test('a save that fails says why, keeps the draft, and tries again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await page.getByRole('group', { name: 'Finish' }).getByRole('button', { name: /^Ice/ }).click();
    await page.route(SAVE, (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) }));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t reach the server' });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('group', { name: 'Finish' }).getByRole('button', { name: /^Ice/ })).toHaveAttribute('aria-pressed', 'true');

    await page.unroute(SAVE);
    let body: unknown = null;
    await page.route(SAVE, async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...LIST.avatars[0], finish: 'ice' }) });
    });
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    expect(body).toEqual({ colors: COLORS, finish: 'ice' });
  });
});
