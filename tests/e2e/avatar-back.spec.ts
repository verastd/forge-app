import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * What a robot wears on its back: the built-in cape (its outside and lining)
 * or a library model worn on the back. Chosen in the editor, saved with the
 * robot (Saving…, then Saved, or the error and Try again), undone, and a
 * model uploaded with the "Worn on the back" fit, fitted from behind.
 *
 * The editor's BFF is answered in the browser (page.route), as lobby-avatars
 * does, so each answer can be held to show the state the page is in.
 */

const SHA = 'd'.repeat(64);
const MEMBERS = { members: [{ memberId: 'gh:1001', login: 'octo-alice' }] };
const COLORS = { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' };
const PACK = {
  id: 'pack',
  name: 'Jetpack',
  sha256: SHA,
  bytes: 48_000,
  fit: 'back',
  eyes: false,
  owner: 'gh:1001',
  placement: { scale: 1, offset: [0, 0.14, -0.002] },
  updatedAt: '2026-10-05T08:00:00+00:00',
};
const ROBOT = { memberId: 'gh:1001', colors: COLORS, updatedAt: '2026-10-05T08:00:00+00:00' };
const LIST = { avatars: [ROBOT], heads: [PACK] };
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

/** A tiny real .glb: one box, `min` to `max` in metres. */
function boxGlb(min: [number, number, number], max: [number, number, number]): Buffer {
  const corners: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(x, y, z);
  const faces = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const positions = Buffer.from(new Float32Array(corners).buffer);
  const indices = Buffer.from(new Uint16Array(faces).buffer);
  const bin = Buffer.concat([positions, indices, Buffer.alloc((4 - ((positions.length + indices.length) % 4)) % 4)]);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Wings', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: faces.length, type: 'SCALAR' },
    ],
  };
  let text = Buffer.from(JSON.stringify(doc));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (length: number, type: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, chunk(text.length, 0x4e4f534a), text, chunk(bin.length, 0x004e4942), bin]);
}

/** Wings as a modeller exports them: 2 m across, a metre tall. */
const WINGS = boxGlb([-1, 0, -0.2], [1, 1, 0]);

async function openEditor(page: Page, list: unknown = LIST): Promise<void> {
  await page.route(`**/bff/avatars/assets/${SHA}`, (route) =>
    route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: WINGS }),
  );
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

const back = (page: Page) => page.getByRole('group', { name: 'Back' });

test.describe('what a robot wears on its back', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a cape, opera black and crimson to start, is saved with the robot, Saving… then Saved', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await expect(back(page).getByRole('button', { name: /^None/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(back(page).getByRole('button', { name: /^Jetpack/ })).toContainText('Worn on the back');

    await back(page).getByRole('button', { name: /^Cape/ }).click();
    await expect(back(page).getByRole('button', { name: /^Cape/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('label', { hasText: 'Cape outside' }).locator('code')).toHaveText('#111114');
    await expect(page.locator('label', { hasText: 'Cape lining' }).locator('code')).toHaveText('#9b1020');
    const classic = page.getByRole('button', { name: /^Opera classic/ });
    await expect(classic).toBeDisabled();
    await pick(page, 'Cape lining', '#ff0000');
    await expect(classic).toBeEnabled();
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
    await expect.poll(() => body).toEqual({ colors: COLORS, cape: { outer: '#111114', lining: '#ff0000' } });
    save.release(200, { ...ROBOT, cape: { outer: '#111114', lining: '#ff0000' } });
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /@octo-alice/ }).getByText('Cape', { exact: true })).toBeVisible();
  });

  test('a model on the back is saved instead of the cape; a failed save says why and tries again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { ...LIST, avatars: [{ ...ROBOT, cape: { outer: '#111114', lining: '#9b1020' } }] });
    await expect(back(page).getByRole('button', { name: /^Cape/ })).toHaveAttribute('aria-pressed', 'true');
    await back(page).getByRole('button', { name: /^Jetpack/ }).click();
    await expect(back(page).getByRole('button', { name: /^Jetpack/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('label', { hasText: 'Cape outside' })).toHaveCount(0);

    let attempts = 0;
    let body: unknown = null;
    await page.route(SAVE, async (route) => {
      attempts += 1;
      body = route.request().postDataJSON();
      if (attempts === 1) {
        await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...ROBOT, back: 'pack' }) });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Couldn’t reach the server' });
    await expect(failure).toBeVisible();
    await expect(back(page).getByRole('button', { name: /^Jetpack/ })).toHaveAttribute('aria-pressed', 'true');
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(/Saved\. Everyone in the lobby sees it/)).toBeVisible();
    expect(attempts).toBe(2);
    expect(body).toEqual({ colors: COLORS, back: 'pack' });
  });

  test('nothing on its back, then Undo puts the cape back', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { ...LIST, avatars: [{ ...ROBOT, cape: { outer: '#222222', lining: '#9b1020' } }] });
    await back(page).getByRole('button', { name: /^None/ }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: /Undo changes/ }).click();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await expect(back(page).getByRole('button', { name: /^Cape/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('label', { hasText: 'Cape outside' }).locator('code')).toHaveText('#222222');
  });

  test('a model uploaded to be worn on the back is fitted to the back, and added with its fit', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { avatars: [ROBOT], heads: [] });
    const upload = held();
    let sent: { fit?: string; placement?: { scale: number; offset: number[]; flyer?: string } } | null = null;
    await page.route('**/bff/avatars/heads/wings', async (route) => {
      sent = route.request().postDataJSON() as typeof sent;
      await upload.handler(route);
    });
    await page.getByLabel('Name').fill('Wings');
    await page.getByRole('radio', { name: /Worn on the back/ }).check();
    await page.getByLabel(/File \(\.glb/).setInputFiles({ name: 'wings.glb', mimeType: 'model/gltf-binary', buffer: WINGS });
    const size = page.getByRole('slider', { name: /^Size/ });
    await expect(size).toBeEnabled({ timeout: 90_000 });
    // Nothing for a face here: no eyes, no screen, no helicopter.
    await expect(page.getByRole('checkbox', { name: /Helicopter over the top/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Line up an eye hole' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Place left eye' })).toHaveCount(0);

    const add = page.getByRole('button', { name: 'Add to library' });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeVisible();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent!.fit).toBe('back');
    // 2 m of wings fitted to the back's 0.46 m, their front on the back plate.
    expect(sent!.placement!.scale).toBeCloseTo(0.46 / 2, 2);
    expect(sent!.placement!.offset[2]).toBeCloseTo(-0.002, 3);
    upload.release(200, { ...PACK, id: 'wings', name: 'Wings', fit: 'back', placement: sent!.placement });
    await expect(back(page).getByRole('button', { name: /^Wings/ })).toBeVisible();
  });

  test('a back model can move like an arm: the switch says what it does, it goes up with the fit, and the library says so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { avatars: [ROBOT], heads: [] });
    const upload = held();
    let sent: { fit?: string; placement?: { motion?: string } } | null = null;
    await page.route('**/bff/avatars/heads/arm', async (route) => {
      sent = route.request().postDataJSON() as typeof sent;
      await upload.handler(route);
    });
    await page.getByLabel('Name').fill('Arm');
    await page.getByRole('radio', { name: /Worn on the back/ }).check();
    await page.getByLabel(/File \(\.glb/).setInputFiles({ name: 'arm.glb', mimeType: 'model/gltf-binary', buffer: WINGS });
    const moves = page.getByRole('checkbox', { name: /Moves like an arm/ });
    await expect(moves).toBeEnabled({ timeout: 90_000 });
    await expect(moves).not.toBeChecked();
    await expect(page.getByText('Off: it holds still.')).toBeVisible();
    await moves.check();
    await expect(page.getByText(/bounces around and turns its far end \(its camera\) to look at whoever’s near/)).toBeVisible();
    // The preview keeps going with it on (it's rigged as it's worn there too).
    await expect(page.locator('[data-fitter] [data-preview]')).toHaveAttribute('data-preview', 'ready');

    await page.getByRole('button', { name: 'Add to library' }).click();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeVisible();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent!.fit).toBe('back');
    expect(sent!.placement!.motion).toBe('arm');
    upload.release(200, { ...PACK, id: 'arm', name: 'Arm', fit: 'back', placement: sent!.placement });
    await expect(page.locator('li', { hasText: 'Arm' }).getByText('Moves like an arm', { exact: true })).toBeVisible();
  });

  test('a back model can make bricks: the Lego bot’s backpack is added with it, and the library says so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page, { avatars: [ROBOT], heads: [] });
    const upload = held();
    let sent: { fit?: string; placement?: { emitter?: string } } | null = null;
    await page.route('**/bff/avatars/heads/backpack', async (route) => {
      sent = route.request().postDataJSON() as typeof sent;
      await upload.handler(route);
    });
    await page.getByLabel('Name').fill('Backpack');
    await page.getByRole('radio', { name: /Worn on the back/ }).check();
    await page.getByLabel(/File \(\.glb/).setInputFiles({ name: 'backpack.glb', mimeType: 'model/gltf-binary', buffer: WINGS });
    const makes = page.getByRole('checkbox', { name: /Makes bricks/ });
    await expect(makes).toBeEnabled({ timeout: 90_000 });
    await expect(makes).not.toBeChecked();
    await expect(page.getByText('Off: an ordinary back model.')).toBeVisible();
    await makes.check();
    await expect(page.getByText(/is the Lego bot: they make building bricks/)).toBeVisible();

    // Where new bricks come out: guessed (low on the middle of its back) until the ramp is marked with a click.
    const ramp = page.locator('[data-ramp]');
    await expect(ramp).toHaveAttribute('data-ramp', 'guessed');
    await expect(ramp.getByText('Not marked: new bricks drop from low on the middle of its back.')).toBeVisible();
    const mark = page.getByRole('button', { name: 'Mark the ramp' });
    await mark.click();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Click the ramp (or chute) new bricks drop out of.' })).toBeVisible();
    await expect(page.locator('[data-fitter] [data-preview]')).toHaveAttribute('data-preview', 'ready');
    const stage = page.locator('[data-fitter] canvas');
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
    await expect(ramp).toHaveAttribute('data-ramp', 'marked');
    await expect(page.getByText('Ramp marked: new bricks drop out there.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark the ramp again' })).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Add to library' }).click();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeVisible();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent!.fit).toBe('back');
    expect(sent!.placement!.emitter).toBe('bricks');
    const spout = (sent!.placement as { spout?: number[] }).spout!;
    expect(spout).toHaveLength(3);
    for (const fraction of spout) expect(fraction).toBeGreaterThanOrEqual(0), expect(fraction).toBeLessThanOrEqual(1);
    upload.release(200, { ...PACK, id: 'backpack', name: 'Backpack', fit: 'back', placement: sent!.placement });
    await expect(page.locator('li', { hasText: 'Backpack' }).getByText('Makes bricks', { exact: true })).toBeVisible();
  });
});
