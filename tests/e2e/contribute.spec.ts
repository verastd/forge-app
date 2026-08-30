import { expect, test } from '@playwright/test';

/** Force the offline path so every assertion holds with or without the API up. */
async function goOffline(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/** The practice app has to say so, on every screen that can invent data. */
const DEMO_BANNER = 'Demo mode — this is practice data. Nothing here is real or saved.';

test.describe('the Bridge', () => {
  test('lists the eight starter tasks in plain language', async ({ page }) => {
    await page.goto('/contribute');

    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
    await expect(
      page.getByText("Point the coding agent you already pay for at a task."),
    ).toBeVisible();

    const cards = page.getByRole('region', { name: 'Tasks' }).getByRole('link');
    await expect(cards).toHaveCount(8);
    await expect(
      page.getByText('Let people download their activity history as a spreadsheet file.'),
    ).toBeVisible();
    // Size is priced in the contributor's agent time, never in story points.
    await expect(page.getByText("~an evening of your agent's time").first()).toBeVisible();
  });

  test('filters down to the tasks that carry a reward', async ({ page }) => {
    await page.goto('/contribute');

    const cards = page.getByRole('region', { name: 'Tasks' }).getByRole('link');
    await expect(cards).toHaveCount(8);

    await page.getByRole('button', { name: 'Has a reward' }).click();
    await expect(cards).toHaveCount(6);
    await expect(page.getByText('$200-equiv').first()).toBeVisible();
  });

  test('opens a task and shows what done looks like', async ({ page }) => {
    await page.goto('/contribute');

    await page
      .getByText('Let people download their activity history as a spreadsheet file.')
      .click();

    await expect(page).toHaveURL(/\/contribute\/task\/1$/);
    await expect(page.getByRole('heading', { name: 'What done looks like' })).toBeVisible();
    await expect(page.getByRole('list').filter({ hasText: 'GET /api/export' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeVisible();
  });

  test('claiming offline still opens the rail picker and the handoff preview', async ({ page }) => {
    await goOffline(page);
    await page.goto('/contribute/task/1');

    // The lease below is simulated, so the label saying so is part of the test.
    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeVisible();
    await page.getByRole('button', { name: 'Claim this' }).click();

    // Claim → lease countdown, then the rail picker with all seven rails (PRD I.3).
    await expect(page.getByText(/yours for 48h/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Let my agent work on it' })).toBeVisible();

    const rails = page.getByRole('button').filter({ hasText: /★/ });
    await expect(rails).toHaveCount(7);
    for (const name of [
      'GitHub Copilot',
      'Google Jules',
      'Cursor',
      'Devin',
      'OpenHands Cloud',
      'Claude Code',
      'OpenAI Codex',
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }

    // The status stepper starts as soon as it is yours.
    await expect(page.getByText('Your agent is working')).toBeVisible();

    // Handoff rail → modal with the locally-composed prompt in a copy box.
    await page.getByRole('button').filter({ hasText: 'Claude Code' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/Preview: we put this together on your device/)).toBeVisible();
    await expect(modal.getByText('Task #1: Polish the CSV export on the history page')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Open Claude Code' })).toHaveAttribute(
      'href',
      'https://claude.ai/code',
    );
  });

  test('says so kindly when someone else got there first', async ({ page }) => {
    await goOffline(page);
    // Registered after the catch-all, so this handler wins for the claim call.
    await page.route('**/api/bridge/claim', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'already_claimed', claimedBy: 'maya' }),
      }),
    );

    await page.goto('/contribute/task/2');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText('Someone claimed this one first');
    await expect(page.getByText('maya is on this one right now.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Find another' })).toBeVisible();
  });

  test('shows the ledger and the ladder on the profile', async ({ page }) => {
    await page.goto('/contribute/profile');

    await expect(page.getByRole('heading', { name: 'Your contributions' })).toBeVisible();
    await expect(page.getByText('contributions shipped')).toBeVisible();
    await expect(page.getByRole('list', { name: 'The ladder' }).getByText('Steward')).toBeVisible();
    await expect(page.getByText(/unlocks in \d+ days/)).toBeVisible();
    await expect(page.getByText('Contribution accepted')).toBeVisible();
  });
});
