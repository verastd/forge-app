import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * The Upland data app (project `chromium-demo`, API deliberately down).
 *
 * Upland pages have no demo fixtures on purpose: the data set is the product,
 * so a page that cannot reach it says so instead of inventing one. The happy
 * path is exercised by serving contract-exact payloads through page.route —
 * the same wire shapes `@forge/shared` validates.
 */

async function serve(page: Page, pattern: string, body: unknown): Promise<void> {
  await page.route(pattern, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
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

test.describe('the Upland data app', () => {
  test('is reachable from the nav and carries its section tabs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Upland' }).click();
    await expect(page).toHaveURL(/\/upland$/);

    const tabs = page.getByRole('navigation', { name: 'Upland sections' });
    await expect(tabs.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Actions' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Sales' })).toBeVisible();
  });

  test('shows the summary as broken rather than inventing one', async ({ page }) => {
    // No fixtures behind /api/upland/* even in the demo app: the summary must
    // fail honestly when the service is down.
    await page.route('**/api/upland/**', (route) => route.abort());
    await page.goto('/upland');

    const broken = page
      .getByRole('alert')
      .filter({ hasText: "We can't show the data summary just now" });
    await expect(broken).toBeVisible();
    await expect(broken.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('renders a served summary on the overview', async ({ page }) => {
    await serve(page, '**/api/upland/stats/overview', OVERVIEW);
    await page.goto('/upland');

    await expect(page.getByText('1,400,000')).toBeVisible();
    await expect(page.getByText('250,000')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'trade' })).toBeVisible();
  });

  test('the actions explorer renders served rows and their filters', async ({ page }) => {
    await serve(page, '**/api/upland/stats/overview', OVERVIEW);
    await serve(page, '**/api/upland/actions**', {
      items: [SALE_ACTION],
      total: 1,
      hasMore: false,
    });
    await page.goto('/upland/actions');

    await expect(page.getByRole('cell', { name: 'buy_property_secondary' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'upland-alice' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '15,000 UPX' })).toBeVisible();

    // Category chips come from the served overview, plus the fixed "All".
    const filters = page.getByRole('group', { name: 'Filter by category' });
    await expect(filters.getByRole('button', { name: 'All' })).toBeVisible();
    await expect(filters.getByRole('button', { name: 'trade' })).toBeVisible();
    await expect(filters.getByRole('button', { name: 'mint' })).toBeVisible();
  });

  test('the sales tab renders served sales and daily volume', async ({ page }) => {
    await serve(page, '**/api/upland/actions/sales**', [SALE_ACTION]);
    await serve(page, '**/api/upland/stats/sales_volume**', [
      {
        date: '2026-09-18',
        count: 120,
        volumeUpx: 1500000,
        avgPrice: 12500,
        minPrice: 900,
        maxPrice: 250000,
      },
    ]);
    await page.goto('/upland/sales');

    await expect(page.getByRole('cell', { name: 'seller-bob' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2026-09-18' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1,500,000 UPX' })).toBeVisible();
  });
});
