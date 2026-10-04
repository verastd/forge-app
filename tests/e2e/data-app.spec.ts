import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { DATA_LINK, DATA_SLOT, lobbyRoot, openLobby, slotOnScreen, tapThrough } from './helpers/lobby';
import { demoSignIn, signInAs } from './helpers/session';

/**
 * The Data app (project `chromium-demo`, API deliberately down), moved from
 * `/upland` to `/apps/data` under its own `AppBar` in the Phase 2 restructure
 * (see notes-phase2.md, unit 2D). It has no demo fixtures on purpose: the
 * data set is the product, so a page that cannot reach it says so instead of
 * inventing one. The happy path is exercised by serving contract-exact
 * payloads through page.route — the same wire shapes `@forge/shared`
 * validates, requested same-origin through `/bff/upland/*` rather than the
 * API's own origin.
 *
 * The way in is the Apps lobby at /apps: its directory link, or a tap on
 * the Data app's lit screen in the 3D view (lobby.spec.ts covers the lobby
 * itself, and helpers/lobby.ts how a test aims a tap).
 *
 * `/apps` and everything under it is behind sign-in, so every test signs in
 * first, mostly with the practice account. The practice account
 * still can't reach the API — the BFF 401s a demo session before it ever
 * forwards — but that's invisible once a test mocks the BFF's own routes
 * itself; where a test deliberately leaves them unmocked, that real 401 is
 * exactly what's under test (the sign-in card, not a fixture).
 *
 * The sign-in card has three states. Two are reachable here: the practice
 * account's, and a real GitHub session's (sealed with `signInAs`, BFF mocked
 * to 401). The signed-out one is not: the middleware sends a signed-out
 * visitor to /signin before any Data page renders, which the entry flow
 * below covers.
 */

async function serve(page: Page, pattern: string, body: unknown): Promise<void> {
  await page.route(pattern, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

/** A full, schema-valid flags payload, so `FlagConfigSchema.safeParse` succeeds outright. */
async function serveFlags(
  page: Page,
  overrides: Partial<{ csv_export: boolean; contribute_bridge: boolean; upland_data: boolean; github_signin: boolean }>,
): Promise<void> {
  await serve(page, '**/api/flags', {
    csv_export: true,
    contribute_bridge: true,
    upland_data: true,
    github_signin: true,
    ...overrides,
  });
}

const OVERVIEW = {
  totalActions: 1400000,
  dateRange: { min: '2026-06-21T00:00:00.000', max: '2026-09-18T12:34:56.000' },
  byCategory: { trade: 800000, mint: 100000 },
  byType: [
    { actionName: 'n5', actionMeaning: 'buy_property_secondary', category: 'trade', count: 500000 },
  ],
  totalProperties: 250000,
};

const SALE_ACTION = {
  globalSequence: 123456789,
  ts: '2026-09-18T12:34:56.000',
  blockNum: 400000123,
  trxId: 'abc123',
  contract: 'playuplandme',
  actionName: 'n5',
  actionMeaning: 'buy_property_secondary',
  category: 'trade',
  actor: 'upland-alice',
  propertyId: '1234567890123',
  priceUpx: 15000,
  fromAccount: 'seller-bob',
  toAccount: 'upland-alice',
};

test.describe('reaching the Data app', () => {
  test('signed out, from the lobby: a sign-in with the practice account, then its directory link, lands on /apps/data', async ({
    page,
  }) => {
    await page.goto('/apps');
    await expect(page).toHaveURL(/\/signin\?next=%2Fapps$/);
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/apps$/);

    // The directory is the way in by keyboard while the 3D wall is the page.
    await page
      .getByRole('navigation', { name: 'Apps', exact: true })
      .getByRole('link', { name: DATA_LINK, exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/apps\/data$/, { timeout: 30_000 });
  });

  test('from a tap on its lit screen in the 3D lobby, lands on /apps/data', async ({ page }) => {
    // The 3D view has to be up first, and SwiftShader builds it slowly.
    test.setTimeout(90_000);
    await openLobby(page);
    await expect(lobbyRoot(page)).toHaveAttribute('data-focus', 'data');

    await tapThrough(page, await slotOnScreen(page, DATA_SLOT), /\/apps\/data$/);
    await expect(page.getByRole('link', { name: 'Back to the lobby' })).toHaveAttribute('href', '/apps?from=data');
  });
});

test.describe('the Data app, signed in with the practice account', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signin');
    await demoSignIn(page);
  });

  test('the AppBar links back to the lobby, and the app has no site nav or footer', async ({
    page,
  }) => {
    await page.goto('/apps/data');

    const back = page.getByRole('link', { name: 'Back to the lobby' });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', '/apps?from=data');

    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByText('beta · testnet')).toHaveCount(0);
  });

  test('the tab nav is aria-label="Data sections"', async ({ page }) => {
    await page.goto('/apps/data');

    const tabs = page.getByRole('navigation', { name: 'Data sections' });
    await expect(tabs.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Actions' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Sales' })).toBeVisible();
  });

  test('unmocked, the practice account gets an honest card with nothing to click — no sign-in loop', async ({
    page,
  }) => {
    await page.goto('/apps/data');

    const gate = page.getByRole('alert').filter({ hasText: 'Sign in with GitHub to open the Data app' });
    await expect(gate.getByRole('heading', { name: 'Sign in with GitHub to open the Data app' })).toBeVisible();
    await expect(
      gate.getByText(
        "The Data app is for signed-in FORGE members. It shows Upland's public blockchain data, the same for everyone. The practice account can't open it, because it isn't tied to a real GitHub account.",
      ),
    ).toBeVisible();
    // /signin sends anyone already signed in straight back here, so a "Sign
    // in" link, or any button, could only loop.
    await expect(gate.getByRole('link')).toHaveCount(0);
    await expect(gate.getByRole('button')).toHaveCount(0);
    // No made-up data behind the gate, and no export offer for data we can't show.
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  });

  test('shows the summary as broken rather than inventing one', async ({ page }) => {
    // Mocked BFF, deliberately broken: even inside sign-in, a failed read must
    // say so rather than substitute a fixture.
    await page.route('**/bff/upland/**', (route) => route.abort());
    await page.goto('/apps/data');

    const broken = page
      .getByRole('alert')
      .filter({ hasText: "We can't show the data summary just now" });
    await expect(broken).toBeVisible();
    await expect(broken.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Nothing loaded, so there is nothing to export.
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  });

  test('renders a served summary on the overview, with the export CSV link', async ({ page }) => {
    await serve(page, '**/bff/upland/stats/overview', OVERVIEW);
    await page.goto('/apps/data');

    await expect(page.getByText('1,400,000')).toBeVisible();
    await expect(page.getByText('250,000')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'trade' })).toBeVisible();

    // Same-origin BFF, never the API's own origin.
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute(
      'href',
      '/bff/upland/export?type=actions',
    );
  });

  test('the actions explorer renders served rows and their filters', async ({ page }) => {
    await serve(page, '**/bff/upland/stats/overview', OVERVIEW);
    await serve(page, '**/bff/upland/actions**', {
      items: [SALE_ACTION],
      total: 1,
      hasMore: false,
    });
    await page.goto('/apps/data/actions');

    await expect(page.getByRole('cell', { name: 'buy_property_secondary' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'upland-alice' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '15,000 UPX' })).toBeVisible();

    // Category chips come from the served overview, plus the fixed "All".
    const filters = page.getByRole('group', { name: 'Filter by category' });
    await expect(filters.getByRole('button', { name: 'All' })).toBeVisible();
    await expect(filters.getByRole('button', { name: 'trade' })).toBeVisible();
    await expect(filters.getByRole('button', { name: 'mint' })).toBeVisible();
  });

  test('pages a long result under a "Pages" landmark', async ({ page }) => {
    await serve(page, '**/bff/upland/stats/overview', OVERVIEW);
    await serve(page, '**/bff/upland/actions**', { items: [SALE_ACTION], total: 120, hasMore: true });
    await page.goto('/apps/data/actions');

    const pages = page.getByRole('navigation', { name: 'Pages' });
    await expect(pages).toContainText('page 1 of 3');
    await expect(pages.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  test('the sales tab renders served sales and daily volume, with the export sales CSV link', async ({
    page,
  }) => {
    await serve(page, '**/bff/upland/actions/sales**', [SALE_ACTION]);
    await serve(page, '**/bff/upland/stats/sales_volume**', [
      {
        date: '2026-09-18',
        count: 120,
        volumeUpx: 1500000,
        avgPrice: 12500,
        minPrice: 900,
        maxPrice: 250000,
      },
    ]);
    await page.goto('/apps/data/sales');

    await expect(page.getByRole('cell', { name: 'seller-bob' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2026-09-18' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1,500,000 UPX' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export sales CSV' })).toHaveAttribute(
      'href',
      '/bff/upland/export?type=sales',
    );
  });

  test('offers the sales export only beside sales that loaded', async ({ page }) => {
    await page.route('**/bff/upland/actions/sales**', (route) => route.abort());
    await serve(page, '**/bff/upland/stats/sales_volume**', []);
    await page.goto('/apps/data/sales');

    await expect(
      page.getByRole('alert').filter({ hasText: "We can't show the latest sales just now" }),
    ).toBeVisible();
    await expect(page.getByText('No sales volume in the data set yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export sales CSV' })).toHaveCount(0);
  });

  test.describe('acceptance criterion 2: the Export CSV button follows the csv_export flag', () => {
    test.beforeEach(async ({ page }) => {
      await serve(page, '**/bff/upland/stats/overview', OVERVIEW);
    });

    test('visible when csv_export is on', async ({ page }) => {
      await serveFlags(page, { csv_export: true });
      await page.goto('/apps/data');

      await expect(page.getByText('1,400,000')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Export CSV' })).toBeVisible();
    });

    test('absent when csv_export is off', async ({ page }) => {
      await serveFlags(page, { csv_export: false });
      await page.goto('/apps/data');

      // The rest of the summary still loads — only the export offer is gated.
      await expect(page.getByText('1,400,000')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
    });
  });
});

test.describe('the Data app, signed in with a real GitHub session', () => {
  // This build accepts a real session sealed under its (non-public) test
  // keys. Every BFF call is mocked below, so nothing forwards upstream and the
  // demo server's API port stays closed (see helpers/env.ts). For a real
  // session, a 401 is the data service refusing a sign-in the BFF vouched for.
  test.beforeEach(async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '5002001', login: 'octocat' });
  });

  test('a refused sign-in offers "Try again", which re-runs the fetch — no sign-in loop', async ({
    page,
  }) => {
    let refused = true;
    await page.route('**/bff/upland/**', (route: Route) =>
      refused
        ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OVERVIEW) }),
    );
    await page.goto('/apps/data');

    const gate = page.getByRole('alert').filter({ hasText: "FORGE couldn't confirm your sign-in" });
    await expect(gate.getByRole('heading', { name: "FORGE couldn't confirm your sign-in" })).toBeVisible();
    await expect(
      gate.getByText(
        "You're signed in with GitHub, but FORGE couldn't confirm the sign-in with the data service, so the Data app can't open just now.",
      ),
    ).toBeVisible();
    // Signing in again would only come straight back here.
    await expect(gate.getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);

    refused = false;
    await gate.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('1,400,000')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  });
});
