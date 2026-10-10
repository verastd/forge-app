import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { signInAs } from './helpers/session';

/**
 * A replacing head with a talking mouth: switched on in the fitter, the mouth
 * marked with a click in its opening (found and sized from the model), its
 * plate's size and colour adjusted, its talking previewed (shut, then open and
 * pouring blocks), sent up with the fit, and named in the library.
 *
 * The editor's BFF is answered in the browser (page.route), as avatar-back does.
 */

const MEMBERS = { members: [{ memberId: 'gh:1001', login: 'octo-alice' }] };
const COLORS = { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' };
const ROBOT = { memberId: 'gh:1001', colors: COLORS, updatedAt: '2026-10-05T08:00:00+00:00' };

type Box = [[number, number, number], [number, number, number]];

/** A tiny real .glb: boxes (`min` to `max`, metres) in one mesh. */
function boxesGlb(boxes: Box[]): Buffer {
  const corners: number[] = [];
  const faces: number[] = [];
  const quad = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  let lo: [number, number, number] = [Infinity, Infinity, Infinity];
  let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  boxes.forEach(([min, max], b) => {
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(x, y, z);
    faces.push(...quad.map((i) => i + b * 8));
    lo = [Math.min(lo[0], min[0]), Math.min(lo[1], min[1]), Math.min(lo[2], min[2])];
    hi = [Math.max(hi[0], max[0]), Math.max(hi[1], max[1]), Math.max(hi[2], max[2])];
  });
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
      { bufferView: 0, componentType: 5126, count: corners.length / 3, type: 'VEC3', min: lo, max: hi },
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

/**
 * A blocky head a metre across with a wide mouth hole, 0.2 m deep, across the
 * middle of its face: a back block, and the face built round the hole.
 */
const HEAD = boxesGlb([
  [[-0.5, 0, -0.24], [0.5, 1, 0.04]],
  [[-0.5, 0, 0.04], [0.5, 0.3, 0.24]],
  [[-0.5, 0.65, 0.04], [0.5, 1, 0.24]],
  [[-0.5, 0.3, 0.04], [-0.35, 0.65, 0.24]],
  [[0.35, 0.3, 0.04], [0.5, 0.65, 0.24]],
]);

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avatars: [ROBOT], heads: [] }) }),
  );
  await page.goto('/me/avatars');
  await expect(page.getByRole('heading', { name: '@octo-alice', exact: true })).toBeVisible({ timeout: 60_000 });
}

/**
 * Clicks down the middle of the fitter's preview until the mouth is marked:
 * the camera's framing is the page's to choose, and it eases in on the head
 * (slowly, with a headless browser's frames), so it keeps trying a while.
 */
async function markMouth(page: Page): Promise<void> {
  const stage = page.locator('[data-fitter] canvas');
  await stage.scrollIntoViewIfNeeded();
  const marked = page.locator('[data-mouth-marked]');
  for (let round = 0; round < 12; round += 1) {
    const box = (await stage.boundingBox())!;
    for (const fy of [0.5, 0.42, 0.58, 0.35, 0.65]) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height * fy);
      await page.waitForTimeout(150);
      if (await marked.isVisible()) return;
    }
    await page.waitForTimeout(1000);
  }
}

test.describe('a head with a talking mouth', () => {
  test.describe.configure({ timeout: 150_000 });

  test('the mouth is marked with a click, sized and coloured, previewed talking, and goes up with the fit', async ({ page, context, baseURL }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    const upload = held();
    let sent: { fit?: string; placement?: { mouth?: { center: number[]; size: number[]; color: string } } } | null = null;
    await page.route('**/bff/avatars/heads/mouthy', async (route) => {
      sent = route.request().postDataJSON() as typeof sent;
      await upload.handler(route);
    });
    await page.getByLabel('Name').fill('Mouthy');
    await page.getByRole('radio', { name: /Replaces the head/ }).check();
    await page.getByLabel(/File \(\.glb/).setInputFiles({ name: 'mouthy.glb', mimeType: 'model/gltf-binary', buffer: HEAD });

    const talks = page.getByRole('checkbox', { name: /Talking mouth/ });
    await expect(talks).toBeEnabled({ timeout: 90_000 });
    await expect(talks).not.toBeChecked();
    await expect(page.getByText('Off: the mouth stays as the model has it.')).toBeVisible();
    await expect(page.locator('[data-fitter] [data-preview]')).toHaveAttribute('data-preview', 'ready', { timeout: 30_000 });

    // On: straight into marking it.
    await talks.check();
    await expect(page.getByRole('status').filter({ hasText: 'Click in the middle of the mouth opening (the dark recess).' })).toBeVisible();
    await markMouth(page);
    await expect(page.locator('[data-mouth-marked]')).toBeVisible();
    await expect(page.getByText(/^Mouth marked/)).toBeVisible();
    await expect(talks).toBeChecked();
    await expect(page.getByRole('button', { name: 'Mark the mouth again' })).toHaveAttribute('aria-pressed', 'false');

    // Found from the model: the hole is 70% of its width and 35% of its height.
    const width = page.getByRole('slider', { name: 'Mouth width' });
    const height = page.getByRole('slider', { name: 'Mouth height' });
    expect(Number(await width.inputValue())).toBeGreaterThanOrEqual(65);
    expect(Number(await width.inputValue())).toBeLessThanOrEqual(75);
    expect(Number(await height.inputValue())).toBeGreaterThanOrEqual(30);
    expect(Number(await height.inputValue())).toBeLessThanOrEqual(40);
    await width.fill('60');
    await expect(width).toHaveAttribute('aria-valuetext', '60 percent of the model');

    // Talking, previewed: the plate drops open and blocks pour; stopped, it shuts.
    const canvas = page.locator('[data-fitter] canvas');
    await expect(canvas).toHaveAttribute('data-mouth', 'shut');
    await expect(page.getByText('Quiet: mouth shut (idle)')).toBeVisible();
    const talk = page.getByRole('button', { name: 'Preview talking' });
    await talk.click();
    await expect(page.getByRole('button', { name: 'Stop talking' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Talking: mouth open, pouring green blocks')).toBeVisible();
    await expect(canvas).toHaveAttribute('data-mouth', 'spewing');
    await page.getByRole('button', { name: 'Stop talking' }).click();
    await expect(canvas).toHaveAttribute('data-mouth', 'shut');

    await page.getByRole('button', { name: 'Add to library' }).click();
    await expect(page.getByRole('button', { name: 'Uploading…' })).toBeVisible();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent!.fit).toBe('replace');
    const mouth = sent!.placement!.mouth!;
    expect(mouth.size[0]).toBeCloseTo(0.6, 2);
    expect(mouth.color).toMatch(/^#[0-9a-f]{6}$/);
    for (const fraction of mouth.center) expect(fraction).toBeGreaterThanOrEqual(0), expect(fraction).toBeLessThanOrEqual(1);
    upload.release(200, {
      id: 'mouthy',
      name: 'Mouthy',
      sha256: 'e'.repeat(64),
      bytes: HEAD.length,
      fit: 'replace',
      eyes: false,
      owner: 'gh:1001',
      placement: sent!.placement,
      updatedAt: '2026-10-05T08:00:00+00:00',
    });
    await expect(page.locator('li', { hasText: 'Mouthy' }).getByText('Talks with its mouth', { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('switched off again, the mouth is gone from the fit', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4242', login: 'trent-admin' });
    await openEditor(page);
    await page.getByLabel('Name').fill('Mouthy');
    await page.getByRole('radio', { name: /Replaces the head/ }).check();
    await page.getByLabel(/File \(\.glb/).setInputFiles({ name: 'mouthy.glb', mimeType: 'model/gltf-binary', buffer: HEAD });
    const talks = page.getByRole('checkbox', { name: /Talking mouth/ });
    await expect(talks).toBeEnabled({ timeout: 90_000 });
    await expect(page.locator('[data-fitter] [data-preview]')).toHaveAttribute('data-preview', 'ready');
    await talks.check();
    // A click off the hole says so and waits for another.
    await page.locator('[data-fitter] canvas').scrollIntoViewIfNeeded();
    const box = (await page.locator('[data-fitter] canvas').boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + 4);
    await expect(page.getByText(/That missed the model|That isn’t in an opening/)).toBeVisible();
    await markMouth(page);
    await expect(page.locator('[data-mouth-marked]')).toBeVisible();
    await talks.uncheck();
    await expect(page.locator('[data-mouth-marked]')).toHaveCount(0);
    await expect(page.getByText('Off: the mouth stays as the model has it.')).toBeVisible();
  });
});
