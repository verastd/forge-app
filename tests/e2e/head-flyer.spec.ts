import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * A helicopter over a head: switched on in the fitting tool, saved with the
 * head's fit (Saving…, then Saved, or the error and Try again), shown as a
 * chip in the library, and left alone by Reset to auto-fit.
 *
 * The editor's BFF is answered in the browser (page.route), as lobby-avatars
 * does, so each answer can be held to show the state the page is in.
 */

const SHA = 'b'.repeat(64);
const MEMBERS = { members: [{ memberId: 'gh:1001', login: 'octo-alice' }] };
const HEAD = {
  id: 'city',
  name: 'City head',
  sha256: SHA,
  bytes: 64_000,
  fit: 'replace',
  eyes: false,
  owner: 'gh:1001',
  placement: { scale: 0.45, offset: [0, 0.02, 0] },
  updatedAt: '2026-10-05T08:00:00+00:00',
};
const LIST = { avatars: [], heads: [HEAD] };
const REFIT = '**/bff/avatars/heads/city/placement';

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

/** A tiny real .glb: one box, `min` to `max` in metres (a head with a flat top to fly over). */
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
    nodes: [{ name: 'Head', mesh: 0 }],
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

const CITY_HEAD = boxGlb([-0.4, 0, -0.3], [0.4, 0.6, 0.3]);

async function openFitter(page: Page, list: unknown = LIST): Promise<void> {
  await page.route(`**/bff/avatars/assets/${SHA}`, (route) =>
    route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: CITY_HEAD }),
  );
  await page.route('**/bff/avatars/members', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) }),
  );
  await page.route('**/bff/avatars', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }));
  await page.goto('/me/avatars');
  await expect(page.getByRole('heading', { name: '@octo-alice', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('listitem').filter({ hasText: 'City head' }).getByRole('button', { name: 'Adjust fit' }).click();
  await expect(page.getByRole('heading', { name: 'Fitting “City head”' })).toBeVisible();
  await expect(page.getByRole('slider', { name: /^Size/ })).toBeEnabled({ timeout: 90_000 });
}

test.describe('a helicopter over a head', () => {
  test.describe.configure({ timeout: 150_000 });

  test('switched on, it is saved with the fit, Saving… then Saved, and the library says so', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openFitter(page);
    const heli = page.getByRole('checkbox', { name: /Helicopter over the top/ });
    await expect(heli).not.toBeChecked();
    await expect(page.getByText('Off: nothing flies over this head.')).toBeVisible();
    await heli.check();
    await expect(page.getByText(/Flies figure-8s just above the model’s top/)).toBeVisible();

    // Reset to auto-fit puts the fit back, and leaves the helicopter.
    await page.getByRole('button', { name: 'Reset to auto-fit' }).click();
    await expect(heli).toBeChecked();

    const save = held();
    let body: { placement?: Record<string, unknown> } | null = null;
    await page.route(REFIT, async (route) => {
      body = route.request().postDataJSON() as { placement?: Record<string, unknown> };
      await save.handler(route);
    });
    await page.getByRole('button', { name: 'Save fit' }).click();
    const saving = page.getByRole('button', { name: 'Saving…' });
    await expect(saving).toBeDisabled();
    await expect(saving).toHaveAttribute('aria-busy', 'true');
    await expect(heli).toBeDisabled();
    await expect.poll(() => body?.placement?.flyer).toBe('helicopter');
    save.release(200, { ...HEAD, placement: { ...HEAD.placement, flyer: 'helicopter' } });
    await expect(page.getByRole('status').filter({ hasText: 'Saved ✓' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'City head' }).getByText('Helicopter', { exact: true })).toBeVisible();
  });

  test('a save that fails says why, keeps it on, and tries again', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openFitter(page);
    await page.getByRole('checkbox', { name: /Helicopter over the top/ }).check();
    let attempts = 0;
    let body: { placement?: Record<string, unknown> } | null = null;
    await page.route(REFIT, async (route) => {
      attempts += 1;
      body = route.request().postDataJSON() as { placement?: Record<string, unknown> };
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unreachable' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...HEAD, placement: body!.placement }) });
    });
    await page.getByRole('button', { name: 'Save fit' }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Couldn’t reach the server.' });
    await expect(failure).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Helicopter over the top/ })).toBeChecked();
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved ✓' })).toBeVisible();
    expect(attempts).toBe(2);
    expect(body!.placement!.flyer).toBe('helicopter');
  });

  test('a head that has one opens with it on; switched off, the fit goes up without it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    const flown = { ...HEAD, placement: { ...HEAD.placement, flyer: 'helicopter' } };
    await openFitter(page, { ...LIST, heads: [flown] });
    await expect(page.getByRole('listitem').filter({ hasText: 'City head' }).getByText('Helicopter', { exact: true })).toBeVisible();
    const heli = page.getByRole('checkbox', { name: /Helicopter over the top/ });
    await expect(heli).toBeChecked();
    await heli.uncheck();
    let body: { placement?: Record<string, unknown> } | null = null;
    await page.route(REFIT, async (route) => {
      body = route.request().postDataJSON() as { placement?: Record<string, unknown> };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEAD) });
    });
    await page.getByRole('button', { name: 'Save fit' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved ✓' })).toBeVisible();
    expect(body!.placement).not.toHaveProperty('flyer');
    await expect(page.getByRole('listitem').filter({ hasText: 'City head' }).getByText('Helicopter', { exact: true })).toHaveCount(0);
  });
});
