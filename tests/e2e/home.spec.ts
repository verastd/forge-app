import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('shows the pitch and the three ways in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Nobody has to trust anybody.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your history' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The workshop' })).toBeVisible();

    await expect(page.getByRole('link', { name: /Your history/ })).toHaveAttribute(
      'href',
      '/history',
    );
    await expect(page.getByRole('link', { name: /Help build FORGE/ })).toHaveAttribute(
      'href',
      '/contribute',
    );
    await expect(page.getByRole('link', { name: /The workshop/ })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app',
    );

    await expect(page.getByText('beta · testnet')).toBeVisible();
  });

  test('navigates to the Bridge from the nav', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contribute' }).click();
    await expect(page).toHaveURL(/\/contribute$/);
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
  });
});
