import { expect, test } from '@playwright/test';

/**
 * Old links must not 404 (Phase 2 restructure): `next.config.mjs`'s
 * `redirects()` sends every retired or moved path to its new home with a
 * permanent redirect. `maxRedirects: 0` means the request fixture stops at
 * the first hop, so this checks the redirect itself — status and
 * `location` — rather than wherever it eventually leads (the middleware
 * gate on `/apps/data`, covered separately in auth.spec.ts).
 */

const CASES: ReadonlyArray<{ from: string; to: string }> = [
  { from: '/history', to: '/apps/data' },
  { from: '/upland', to: '/apps/data' },
  { from: '/upland/actions', to: '/apps/data/actions' },
  { from: '/contribute/profile', to: '/me' },
];

for (const { from, to } of CASES) {
  test(`${from} redirects permanently to ${to}`, async ({ request }) => {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(to);
  });
}
