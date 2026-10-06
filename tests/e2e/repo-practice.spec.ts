import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { demoSignIn } from './helpers/session';

/**
 * The task page's three steps on the practice app (project `chromium-demo`,
 * API deliberately down, Phase 7): "Get started" and "Refresh your copy" set
 * up a pretend copy, the pretend agent pushes to it and waits, and "Send for
 * review" sends the pretend work on to its checks. Each says it is practice,
 * and nothing reaches GitHub, the BFF or the API: the practice account is
 * nobody on GitHub (lib/offline.ts simulates it all in the tab).
 */

const BRANCH = 'task/1-polish-the-csv-export-in-the-data-app';

async function goOffline(page: Page): Promise<string[]> {
  const reached: string[] = [];
  await page.route('**/api/**', (route) => route.abort());
  // Nothing a practice step does may go anywhere but this tab.
  await page.route('**/auth/github/**', (route) => {
    reached.push(route.request().url());
    return route.abort();
  });
  await page.route('**/bff/**', (route) => {
    reached.push(route.request().url());
    return route.abort();
  });
  return reached;
}

/** Signs in with the practice account and claims task 1. */
async function claimTaskOne(page: Page): Promise<void> {
  await page.goto(`/signin?next=${encodeURIComponent('/contribute/task/1')}`);
  await demoSignIn(page);
  await expect(page).toHaveURL(/\/contribute\/task\/1$/);
  await page.getByRole('button', { name: 'Claim this' }).click();
  await expect(page.getByText(/yours for 48h/)).toBeVisible();
}

const step = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

test.describe('the three steps, practised', () => {
  test('after the claim, step 1 has the focus and says what FORGE will do', async ({ page }) => {
    await goOffline(page);
    await claimTaskOne(page);
    await expect(page.getByRole('heading', { name: 'Your copy', exact: true })).toBeFocused();
    await expect(
      step(page, 'Your copy').getByText(
        "FORGE makes your own copy of FORGE's code on GitHub for your agent to work in. GitHub asks you once to allow it.",
      ),
    ).toBeVisible();
    await expect(step(page, 'Your agent').getByText('Your agent needs your copy first: press Get started above.')).toBeVisible();
    await expect(
      step(page, 'Send for review').getByText('Once your copy is set up and your agent has pushed its work, you send it for review from here.'),
    ).toBeVisible();
  });

  test('Get started makes a pretend copy, says so, and sends nothing', async ({ page }) => {
    const reached = await goOffline(page);
    await claimTaskOne(page);
    const copy = step(page, 'Your copy');
    const button = copy.getByRole('button', { name: 'Get started' });
    await button.click();

    await expect(copy.getByText(/^Your copy is ready:/)).toHaveText('Your copy is ready: you/forge-app, up to date just now.');
    await expect(copy.getByRole('status')).toHaveText('Practice: nothing was sent.');
    // The same button, now quiet, keeps the focus.
    const refresh = copy.getByRole('button', { name: 'Refresh your copy' });
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveClass(/btn-ghost/);
    // The pretend copy is never a link, and never named to an agent.
    await expect(copy.getByRole('link')).toHaveCount(0);
    const web = step(page, 'Your agent').getByRole('link', { name: 'Open Claude Code on the web' });
    expect(new URL((await web.getAttribute('href')) ?? '').searchParams.has('repositories')).toBe(false);
    await expect(step(page, 'Your agent').getByText(/needs your copy first/)).toHaveCount(0);

    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(
      progress.getByText(`FORGE: Practice: FORGE would set up your copy, you/forge-app, and the branch ${BRANCH}. Nothing was sent.`),
    ).toBeVisible();

    await refresh.click();
    await expect(progress.getByText('FORGE: Practice: FORGE would bring your copy, you/forge-app, up to date. Nothing was sent.')).toBeVisible();
    expect(reached).toEqual([]);
  });

  test('the pretend agent pushes to the copy and waits; Send for review sends it on to its checks', async ({ page }) => {
    const reached = await goOffline(page);
    await page.clock.install();
    await claimTaskOne(page);
    await step(page, 'Your copy').getByRole('button', { name: 'Get started' }).click();
    await page.clock.runFor(1000);
    await expect(step(page, 'Your copy').getByText(/^Your copy is ready:/)).toBeVisible();

    // Hand it to an agent: a practice start.
    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-practice-key');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();
    await page.clock.runFor(1000);
    await expect(panel.getByText('Google Jules is working on it.')).toBeVisible();

    const review = step(page, 'Send for review');
    await expect(
      review.getByText('When your agent has pushed its work, send it for review from here: FORGE opens the pull request in your name.'),
    ).toBeVisible();
    await expect(review.getByRole('button')).toHaveCount(0);

    // 45 seconds on, the pretend agent has pushed; the next status read shows it.
    await page.clock.runFor(61_000);
    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(progress.getByText('Your agent: Practice: pushed the first changes to the task branch.')).toBeVisible();
    const send = review.getByRole('button', { name: 'Send for review' });
    await expect(send).toBeVisible();
    await expect(send).toHaveAccessibleDescription(/^FORGE opens the pull request in your name\. It says, for you,/);

    // A run in the copy waits for the person, however long it takes.
    await page.clock.runFor(120_000);
    await expect(send).toBeVisible();
    await expect(progress.getByText(/opened the pull request/)).toHaveCount(0);

    await send.click();
    await page.clock.runFor(1000);
    await expect(review.getByText('Sent for review. Its checks and the review show up in “Where it is” below.')).toBeVisible();
    await expect(review.getByRole('status')).toHaveText('Practice: nothing was sent.');
    await expect(
      progress.getByText('FORGE: Practice: sent for review. FORGE would open the pull request now. Nothing was sent.'),
    ).toBeVisible();
    // And on to the checks.
    await page.clock.runFor(16_000);
    await expect(progress.getByText('3 of 5 checks passed. Two need another look.')).toBeVisible();
    expect(reached).toEqual([]);
  });

  test('on a phone, the practised steps fit the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goOffline(page);
    await claimTaskOne(page);
    await step(page, 'Your copy').getByRole('button', { name: 'Get started' }).click();
    await expect(step(page, 'Your copy').getByRole('button', { name: 'Refresh your copy' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
