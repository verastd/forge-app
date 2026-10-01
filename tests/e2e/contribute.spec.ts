import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import apiTasks from '../../apps/api/src/forge_api/fixtures/tasks.json';
import { TASK_FIXTURES } from '../../apps/web/src/lib/fixtures';
import golden from '../fixtures/brief-golden.json';
import { demoSignIn } from './helpers/session';

/**
 * The Contribute flow on the practice app (project `chromium-demo`, API
 * deliberately down): browse, claim, then "Get your agent on it" with both of
 * its parts, the closed copy fallback, a practice start, release, and the
 * two agent sections on /me.
 *
 * Signed in, it's the practice account, which is nobody on GitHub: every
 * identity call is simulated in the tab (lib/offline.ts), never sent to the
 * BFF. The "Open my agent" links are real links all the same, so their hrefs
 * are checked against the brief byte for byte — the practice account has no
 * fork, so it's the golden brief without a login.
 */

/** Force the offline path so every assertion holds with or without the API up. */
async function goOffline(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/** The practice app has to say so, on every screen that can invent data. */
const DEMO_BANNER = 'Demo mode — this is practice data. Nothing here is real or saved.';

const BRIEF_WITHOUT_LOGIN = (() => {
  const found = golden.cases.find((entry) => entry.name === 'without login');
  if (found === undefined) {
    throw new Error('brief-golden.json lost its "without login" case');
  }
  return found.brief;
})();

const START_RAILS = ['GitHub Copilot', 'Google Jules', 'Cursor cloud agent', 'Devin', 'OpenHands Cloud', 'Claude Code routine'];
const OPEN_LINKS = [
  'Claude Code on the web',
  'Claude Code on your computer',
  'Codex app',
  'VS Code agents',
  'Cursor app',
];

/** Signs in with the practice account and lands on task 1, claimed. */
async function claimTaskOne(page: Page): Promise<void> {
  await goOffline(page);
  await page.goto(`/signin?next=${encodeURIComponent('/contribute/task/1')}`);
  await demoSignIn(page);
  await expect(page).toHaveURL(/\/contribute\/task\/1$/);
  await page.getByRole('button', { name: 'Claim this' }).click();
  await expect(page.getByText(/yours for 48h/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toBeVisible();
}

function startPart(page: Page): Locator {
  return page.getByRole('group', { name: 'Start it for me' });
}

function openPart(page: Page): Locator {
  return page.getByRole('group', { name: 'Open my agent' });
}

/** The decoded query of a link's href, whatever its scheme. */
async function hrefQuery(link: Locator): Promise<URLSearchParams> {
  const href = await link.getAttribute('href');
  expect(href).not.toBeNull();
  return new URL(href ?? '').searchParams;
}

test.describe('browsing the Bridge', () => {
  test('lists the eight starter tasks in plain language', async ({ page }) => {
    await page.goto('/contribute');

    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
    await expect(page.getByText('Point the coding agent you already pay for at a task.')).toBeVisible();

    const cards = page.getByRole('region', { name: 'Tasks' }).getByRole('link');
    await expect(cards).toHaveCount(8);
    await expect(
      page.getByText('Let people download the Upland data they are looking at as a spreadsheet file.'),
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

  test('opens a task and shows what done looks like; signed out, the claim is "Sign in to claim"', async ({
    page,
  }) => {
    await goOffline(page);
    await page.goto('/contribute');

    await page.getByText('Let people download the Upland data they are looking at as a spreadsheet file.').click();

    await expect(page).toHaveURL(/\/contribute\/task\/1$/);
    await expect(page.getByRole('heading', { name: 'What done looks like' })).toBeVisible();
    await expect(page.getByRole('list').filter({ hasText: 'GET /api/upland/export' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to claim' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fcontribute%2Ftask%2F1',
    );
    await expect(page.getByRole('button', { name: 'Claim this' })).toHaveCount(0);
    // Nothing to hand to an agent before the task is yours.
    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toHaveCount(0);
  });
});

test.describe('claiming with the practice account', () => {
  test.beforeEach(async ({ page }) => {
    await claimTaskOne(page);
  });

  test('shows both ways in: a start button per start rail, a link per open rail', async ({ page }) => {
    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    await expect(page.getByText(/Practice account: a start here is pretend/)).toBeVisible();

    const start = startPart(page);
    await expect(start.getByText('FORGE starts your agent for you. It works in your fork and opens a pull request.')).toBeVisible();
    const startButtons = start.getByRole('button');
    await expect(startButtons).toHaveCount(START_RAILS.length);
    for (const [index, label] of START_RAILS.entries()) {
      await expect(startButtons.nth(index)).toContainText(label);
    }

    const open = openPart(page);
    await expect(open.getByText('Opens your agent with the task already typed in. You press send.')).toBeVisible();
    for (const label of OPEN_LINKS) {
      await expect(open.getByRole('link', { name: `Open ${label}` })).toBeVisible();
    }
    await expect(open.getByRole('button', { name: /Google Antigravity/ })).toBeVisible();
    await expect(open.getByRole('link', { name: 'Connect your agent to FORGE once' })).toHaveAttribute('href', '/connect');
  });

  test('every open-rail link carries the brief, byte for byte', async ({ page }) => {
    const open = openPart(page);

    const web = open.getByRole('link', { name: 'Open Claude Code on the web' });
    await expect(web).toHaveAttribute('href', /^https:\/\/claude\.ai\/code\?prompt=/);
    await expect(web).toHaveAttribute('target', '_blank');
    expect((await hrefQuery(web)).get('prompt')).toBe(BRIEF_WITHOUT_LOGIN);
    // The practice account has no fork to preselect.
    expect((await hrefQuery(web)).has('repositories')).toBe(false);

    const cli = open.getByRole('link', { name: 'Open Claude Code on your computer' });
    await expect(cli).toHaveAttribute('href', /^claude-cli:\/\/open\?q=/);
    expect((await hrefQuery(cli)).get('q')).toBe(BRIEF_WITHOUT_LOGIN);

    const codex = open.getByRole('link', { name: 'Open Codex app' });
    await expect(codex).toHaveAttribute('href', /^codex:\/\/new\?prompt=/);
    expect((await hrefQuery(codex)).get('prompt')).toBe(BRIEF_WITHOUT_LOGIN);
    expect((await hrefQuery(codex)).has('originUrl')).toBe(false);

    const vscode = open.getByRole('link', { name: 'Open VS Code agents' });
    await expect(vscode).toHaveAttribute('href', /^vscode:\/\/agents\/new\?prompt=/);
    expect((await hrefQuery(vscode)).get('prompt')).toBe(BRIEF_WITHOUT_LOGIN);

    const cursor = open.getByRole('link', { name: 'Open Cursor app' });
    await expect(cursor).toHaveAttribute('href', /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/);
    expect((await hrefQuery(cursor)).get('text')).toBe(BRIEF_WITHOUT_LOGIN);

    // Antigravity has no link: its button shows the steps.
    const antigravity = open.getByRole('button', { name: /Google Antigravity/ });
    await expect(antigravity).toHaveAttribute('aria-expanded', 'false');
    await antigravity.click();
    await expect(antigravity).toHaveAttribute('aria-expanded', 'true');
    await expect(open.getByText('Ask it: Start FORGE task #1')).toBeVisible();
  });

  test('copying the brief is a closed fallback, and it holds the same brief', async ({ page }) => {
    const fallback = page.locator('details', { has: page.getByText('Using another agent? Copy the brief') });
    await expect(fallback).toHaveCount(1);
    await expect(fallback).not.toHaveAttribute('open');
    await expect(fallback.locator('pre')).toBeHidden();

    await fallback.getByText('Using another agent? Copy the brief').click();
    await expect(fallback).toHaveAttribute('open');
    expect(await fallback.locator('pre').textContent()).toBe(BRIEF_WITHOUT_LOGIN);
    await expect(fallback.getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  test('a practice start says it is practice, sends nothing and keeps no key', async ({ page }) => {
    const start = startPart(page);
    await start.getByRole('button', { name: /^Google Jules/ }).click();

    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await expect(panel).toBeVisible();
    // The one-time setup links to real places.
    await expect(panel.getByRole('link', { name: 'Fork forge-app on GitHub.' })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app/fork',
    );
    await expect(panel.getByRole('link', { name: 'Create an API key in Jules settings.' })).toHaveAttribute(
      'href',
      'https://jules.google.com/settings',
    );

    const key = panel.getByLabel('Your Jules API key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('autocomplete', 'off');
    await expect(panel.getByLabel('Remember it, encrypted, so next time is one click')).toBeChecked();
    await expect(panel.getByText('You can remove saved keys on your profile.')).toBeVisible();

    await key.fill('test-only-practice-key');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    await expect(panel.getByText('Google Jules is working on it.')).toBeVisible();
    await expect(panel.getByText('Practice: nothing was sent.')).toBeVisible();
    // No session link to watch: nothing was started anywhere.
    await expect(panel.getByRole('link', { name: /Watch it work/ })).toHaveCount(0);
    // The key is gone from the page.
    await expect(key).toHaveValue('');
    await expect(page.getByText('test-only-practice-key')).toHaveCount(0);

    // The progress view picks the hand-off up.
    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(progress.getByText('Practice: Google Jules would start now. Nothing was sent.')).toBeVisible();
  });

  test('GitHub Copilot needs nothing pasted', async ({ page }) => {
    await startPart(page).getByRole('button', { name: /^GitHub Copilot/ }).click();
    const panel = page.getByRole('region', { name: 'Start GitHub Copilot' });
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await expect(panel.locator('input[type="password"]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Start GitHub Copilot' })).toBeVisible();
  });

  test('releasing asks first, then hands the task back', async ({ page }) => {
    await page.getByRole('button', { name: 'Release this task' }).click();
    await expect(page.getByText(/Release this task\? It goes back on the board/)).toBeVisible();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toBeVisible();

    await page.getByRole('button', { name: 'Release this task' }).click();
    await page.getByRole('button', { name: 'Yes, release it' }).click();

    await expect(page.getByRole('status')).toContainText('Practice: released.');
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toHaveCount(0);
    await expect(page.getByText(/yours for 48h/)).toHaveCount(0);
  });
});

test.describe('with agent_start switched off', () => {
  test('"Start it for me" is not offered; "Open my agent" still is', async ({ page }) => {
    await goOffline(page);
    // Registered after the catch-all, so this answer wins for the flags call.
    await page.route('**/api/flags', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ contribute_bridge: true, agent_start: false }),
      }),
    );
    await page.goto(`/signin?next=${encodeURIComponent('/contribute/task/1')}`);
    await demoSignIn(page);
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toBeVisible();
    await expect(openPart(page).getByRole('link', { name: 'Open Claude Code on the web' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start it for me' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Google Jules/ })).toHaveCount(0);
  });
});

test.describe('/me for the practice account', () => {
  test.beforeEach(async ({ page }) => {
    await goOffline(page);
    await page.goto('/signin?next=%2Fme');
    await demoSignIn(page);
    await expect(page).toHaveURL(/\/me$/);
  });

  test('agent keys and connected agents are not available with a practice account', async ({ page }) => {
    const keys = page.getByRole('region', { name: 'Your agent keys' });
    const agents = page.getByRole('region', { name: 'Connected agents' });
    await expect(keys.getByText('Not available with a practice account.')).toBeVisible();
    await expect(agents.getByText('Not available with a practice account.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Remove|Disconnect/ })).toHaveCount(0);
  });

  test('shows the ledger and the ladder (/contribute/profile now redirects here)', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Your contributions' })).toBeVisible();
    await expect(page.getByText('contributions shipped')).toBeVisible();
    await expect(page.getByRole('list', { name: 'The ladder' }).getByText('Steward')).toBeVisible();
    await expect(page.getByText(/unlocks in \d+ days/)).toBeVisible();
    await expect(page.getByText('Contribution accepted')).toBeVisible();
  });
});

test.describe('the offline task fixtures', () => {
  // No browser: `lib/fixtures.ts` against the API's `tasks.json`, every field,
  // compared as the API serves a task: it adds `status` from its lease store
  // and leaves an unpaid task's null `rewardUsd` out. (Moved here from the
  // retired handoff-golden.spec.ts.)
  test('match the API fixtures field for field', () => {
    const served = apiTasks.map(({ rewardUsd, ...task }) => ({
      ...task,
      ...(rewardUsd === null ? {} : { rewardUsd }),
      status: 'open',
    }));
    expect(TASK_FIXTURES.map((task) => task.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TASK_FIXTURES).toStrictEqual(served);
  });
});
