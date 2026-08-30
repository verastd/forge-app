import { expect, test } from '@playwright/test';

test.describe('history page', () => {
  test('renders the activity table from fixture data', async ({ page }) => {
    await page.goto('/history');

    // Fixture rows only exist in the practice app, and it says so.
    await expect(
      page.getByText('Demo mode — this is practice data. Nothing here is real or saved.'),
    ).toBeVisible();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(10);

    await expect(page.getByRole('columnheader', { name: 'When' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'What' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Amount' })).toBeVisible();

    // Type chips are colour-coded by kind; at least one of each should be present.
    await expect(page.getByText('earned').first()).toBeVisible();
    await expect(page.getByText('spent').first()).toBeVisible();
  });

  test('offers the CSV export with default flags', async ({ page }) => {
    await page.goto('/history');

    const exportLink = page.getByRole('link', { name: 'Export CSV' });
    await expect(exportLink).toBeVisible();
    await expect(exportLink).toHaveAttribute('href', /\/api\/export$/);
  });

  test('hides the CSV export when the flag is off', async ({ page }) => {
    await page.route('**/api/flags', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ csv_export: false, contribute_bridge: true }),
      }),
    );

    await page.goto('/history');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  });

  test('surfaces the offline demo pill when the service is unreachable', async ({ page }) => {
    // Forced, so the assertion means the same thing whether or not the API is up.
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/history');
    await expect(page.getByText('offline demo data')).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
  });
});
