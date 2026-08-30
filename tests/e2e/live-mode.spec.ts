import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * The app we deploy, with the service down (project `chromium-live`).
 *
 * The practice app in `contribute.spec.ts` is allowed to invent a lease, an
 * agent session and a status that marches to "shipped". This one is not: an
 * independent assessment found the data layer substituting fixtures on almost
 * every failure, writes included, so a claim that never left the browser was
 * drawn as a claim that had been granted. Every assertion below is about
 * something that must NOT be on screen.
 */

const FIXTURE_SUMMARY = 'Let people download their activity history as a spreadsheet file.';

/** A task card the server could really have sent — the contract's shape exactly. */
const SERVED_TASK = {
  id: 1,
  title: 'Polish the CSV export on the history page',
  civilianSummary: FIXTURE_SUMMARY,
  size: 'S',
  rewardClass: 'none',
  tierFloor: 'T0',
  status: 'open',
  url: 'https://github.com/verastd/forge-app/issues/1',
  labels: ['agent-ready', 'status:open', 'size:S'],
};

async function serviceDown(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/** Later routes win in Playwright, so these are registered after {@link serviceDown}. */
async function serve(page: Page, pattern: string, body: unknown, status = 200): Promise<void> {
  await page.route(pattern, (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

async function openBridge(page: Page): Promise<void> {
  await serve(page, '**/api/flags', { csv_export: true, contribute_bridge: true });
}

test.describe('the live app, with nothing behind it', () => {
  test('shows the task board as broken rather than inventing one', async ({ page }) => {
    await serviceDown(page);
    // Without this the flag service is down too, flags fail closed, and the
    // layout's kill switch answers instead — its "Contributing is closed just
    // now" card also carries role="alert", so every assertion below passed
    // against a screen where the board had never rendered at all.
    await openBridge(page);
    await page.goto('/contribute');

    // Pinned to the board's OWN error card, so no stand-in alert can satisfy it
    // (Next's route announcer and the layout kill switch are both role=alert).
    const brokenBoard = page.getByRole('alert').filter({ hasText: "We can't show the tasks just now" });
    await expect(brokenBoard).toBeVisible();
    await expect(brokenBoard.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText(FIXTURE_SUMMARY)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Tasks' })).toHaveCount(0);
    await expect(page.getByText('offline demo data')).toHaveCount(0);
    await expect(page.getByText(/practice data/)).toHaveCount(0);
  });

  test('with the flag service down, the Bridge reads as closed', async ({ page }) => {
    // The behaviour the test above used to land on by accident: flags fail
    // closed, so an unreachable flag service reads the same as a switch thrown
    // on purpose. Worth locking in on its own terms.
    await serviceDown(page);
    await page.goto('/contribute');

    await expect(page.getByRole('heading', { name: 'Contributing is closed just now' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tasks' })).toHaveCount(0);
    await expect(page.getByText(FIXTURE_SUMMARY)).toHaveCount(0);
  });

  test('shows history as broken, with no rows and no export', async ({ page }) => {
    await serviceDown(page);
    await page.goto('/history');

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
    await expect(page.getByText('offline demo data')).toHaveCount(0);
  });

  test('never opens a task screen out of local fixtures', async ({ page }) => {
    await serviceDown(page);
    await openBridge(page);
    await page.goto('/contribute/task/1');

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toHaveCount(0);
    await expect(page.getByText(/yours for \d+h/)).toHaveCount(0);
  });

  test('a claim that did not save leaves nothing claimed', async ({ page }) => {
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/api/bridge/tasks', { tasks: [SERVED_TASK] });
    await serve(page, '**/api/bridge/claim', { error: 'internal_error' }, 500);

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText('nothing was changed');
    // No lease, no countdown, no next step — and the button is still there to
    // try again, because trying again is the only thing that can help.
    await expect(page.getByText(/yours for \d+h/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Let my agent work on it' })).toHaveCount(0);
    await expect(page.getByText('Your agent is working')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
  });

  test('a handoff that did not save never says an agent started', async ({ page }) => {
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/api/bridge/tasks', { tasks: [SERVED_TASK] });
    await serve(page, '**/api/bridge/claim', {
      taskId: 1,
      claimedBy: 'you',
      leaseEndsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      leaseHours: 48,
    });
    await serve(page, '**/api/bridge/dispatch', { error: 'internal_error' }, 500);

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();
    await expect(page.getByRole('heading', { name: 'Let my agent work on it' })).toBeVisible();

    await page.getByRole('button').filter({ hasText: 'Claude Code' }).click();

    await expect(page.getByRole('status')).toContainText('nothing was changed');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(/^ref /)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Your agent has started/ })).toHaveCount(0);

    // The status poll is down too, so the stages must sit where they are
    // instead of walking themselves to "shipped".
    await expect(page.getByText('Your agent is working')).toHaveCount(0);
    await expect(page.getByText(/can't check on this one just now/)).toBeVisible();
  });
});
