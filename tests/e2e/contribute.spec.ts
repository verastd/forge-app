import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import apiTasks from '../../apps/api/src/forge_api/fixtures/tasks.json';
import { TASK_FIXTURES } from '../../apps/web/src/lib/fixtures';
import { COPY_STEP, compileBrief } from '../../packages/shared/dist/index.js';
import { demoSignIn } from './helpers/session';

/**
 * The Contribute flow on the practice app (project `chromium-demo`, API
 * deliberately down): browse, claim, then the three steps ("Your copy",
 * "Your agent" with both of its parts, "Send for review"), the closed copy
 * fallback, a practice start, release, and the two agent sections on /me.
 * The practice run of the three steps themselves is repo-practice.spec.ts.
 *
 * Signed in, it's the practice account, which is nobody on GitHub: every
 * identity call is simulated in the tab (lib/offline.ts), never sent to the
 * BFF. The "Open my agent" links are real links all the same, so their hrefs
 * are checked against the brief byte for byte — the practice account has no
 * fork, so it's the compiler's brief with no login and no copy.
 */

/** Force the offline path so every assertion holds with or without the API up. */
async function goOffline(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/** The practice app has to say so, on every screen that can invent data. */
const DEMO_BANNER = 'Demo mode — this is practice data. Nothing here is real or saved.';

/** The task the practice account claims: the one open to T0. */
const PRACTICE_TASK = TASK_FIXTURES.find((task) => task.tierFloor === 'T0');
if (PRACTICE_TASK === undefined) throw new Error('no T0 task in the fixtures for the practice account to claim');
const PRACTICE_PATH = `/contribute/task/${PRACTICE_TASK.id}`;
/** The first card on the board, whatever its tier: what browsing checks. */
const FIRST_TASK = TASK_FIXTURES[0];
if (FIRST_TASK === undefined) throw new Error('no task fixtures');
/** The brief the practice page hands to every open rail: the compiler's own output, with no login and no copy (the practice account has neither). */
const BRIEF_WITHOUT_LOGIN = compileBrief(PRACTICE_TASK, PRACTICE_TASK.acceptanceCriteria, null);

const START_RAILS = ['GitHub Copilot', 'Google Jules', 'Cursor cloud agent', 'Devin', 'OpenHands Cloud', 'Claude Code routine'];
const OPEN_LINKS = [
  'Claude Code on the web',
  'Claude Code on your computer',
  'Codex app',
  'VS Code agents',
  'Cursor app',
];

/** Signs in with the practice account and lands on the T0 task, claimed. */
async function claimTaskOne(page: Page): Promise<void> {
  await goOffline(page);
  await page.goto(`/signin?next=${encodeURIComponent(PRACTICE_PATH)}`);
  await demoSignIn(page);
  await expect(page).toHaveURL(new RegExp(`${PRACTICE_PATH}$`));
  await page.getByRole('button', { name: 'Claim this' }).click();
  await expect(page.getByText(/yours for 48h/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
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
  test('lists the posted Task Specs in plain language', async ({ page }) => {
    await page.goto('/contribute');

    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Help build FORGE' })).toBeVisible();
    await expect(page.getByText('Point the coding agent you already pay for at a task.')).toBeVisible();

    const cards = page.getByRole('region', { name: 'Tasks' }).getByRole('link');
    await expect(cards).toHaveCount(5);
    await expect(
      page.getByText('Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.'),
    ).toBeVisible();
    // A task is priced in the contributor's agent time, never in dollars.
    await expect(page.getByText('Agent runs ~1 hour').first()).toBeVisible();
    await expect(page.getByText(/\$\s?\d/)).toHaveCount(0);
  });

  test("the run-time chip keeps the token estimate behind a hover or a focus, and Escape puts it away", async ({
    page,
  }) => {
    await page.goto('/contribute');
    const summary = 'Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.';
    const card = page.getByRole('region', { name: 'Tasks' }).getByRole('article').filter({ has: page.getByRole('link', { name: summary, exact: true }) });
    const chip = card.getByText('Agent runs ~1 hour');
    const tip = card.getByRole('tooltip', { includeHidden: true });
    await expect(tip).toBeHidden();
    await expect(chip).toHaveAttribute('aria-describedby', (await tip.getAttribute('id')) ?? 'missing');

    // Hovering the chip shows the estimate; moving away hides it.
    await chip.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(
      'Roughly 2M to 4M tokens of model use, counting the context the agent re-reads as it works. It varies a lot by agent.',
    );
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();

    // A click or a tap focuses it, which shows the estimate too, and never opens the card.
    await chip.click();
    await expect(page).toHaveURL(/\/contribute$/);
    await expect(tip).toBeVisible();
    // Escape hides it without moving focus; leaving the chip resets it.
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(chip).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await chip.focus();
    await expect(tip).toBeVisible();
  });

  test('Escape hides the estimate while the chip is only hovered, with focus somewhere else (WCAG 1.4.13)', async ({
    page,
  }) => {
    await page.goto('/contribute');
    const summary = 'Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.';
    const card = page.getByRole('region', { name: 'Tasks' }).getByRole('article').filter({ has: page.getByRole('link', { name: summary, exact: true }) });
    const chip = card.getByText('Agent runs ~1 hour');
    const tip = card.getByRole('tooltip', { includeHidden: true });

    await chip.hover();
    await expect(tip).toBeVisible();
    await expect(chip).not.toBeFocused();
    // The pointer stays put; Escape reaches the page, not the chip, and still hides it.
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await page.waitForTimeout(300);
    await expect(tip).toBeHidden();
    // Leaving and coming back shows it again.
    await page.mouse.move(0, 0);
    await chip.hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();
  });

  test('each card is a link named by its summary, and opens from anywhere on the card (review-pages, Phase 4 carry-over)', async ({
    page,
  }) => {
    await page.goto('/contribute');
    const summary = 'Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.';
    const link = page.getByRole('region', { name: 'Tasks' }).getByRole('link', { name: summary, exact: true });
    await expect(link).toHaveAttribute('href', '/contribute/task/48');
    // Every card's link has a name of its own: its summary, never nothing.
    const names = await page.getByRole('region', { name: 'Tasks' }).getByRole('link').evaluateAll((links) =>
      links.map((element) => element.textContent?.trim() ?? ''),
    );
    expect(names).toHaveLength(TASK_FIXTURES.length);
    expect(names.every((name) => name.length > 10)).toBe(true);
    // The card's corner, far from the summary, still opens it.
    const card = page.getByRole('region', { name: 'Tasks' }).getByRole('article').filter({ has: page.getByRole('link', { name: summary, exact: true }) });
    const box = await card.boundingBox();
    if (box === null) throw new Error('no card');
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
    await expect(page).toHaveURL(new RegExp(`/contribute/task/${FIRST_TASK.id}$`));
  });

  test('filters down to the tasks that carry a reward', async ({ page }) => {
    await page.goto('/contribute');

    const cards = page.getByRole('region', { name: 'Tasks' }).getByRole('link');
    await expect(cards).toHaveCount(TASK_FIXTURES.length);

    const rewarded = TASK_FIXTURES.filter((task) => task.rewardClass !== 'none').length;
    await page.getByRole('button', { name: 'Has a reward' }).click();
    await expect(cards).toHaveCount(rewarded);
    // It says a reward is attached, never what it is worth in dollars.
    await expect(page.getByText('reward attached')).toHaveCount(rewarded);
    await expect(page.getByText(/\$\s?\d/)).toHaveCount(0);
  });

  test('opens a task and shows what done looks like; signed out, the claim is "Sign in to claim"', async ({
    page,
  }) => {
    await goOffline(page);
    await page.goto('/contribute');

    await page.getByText('Give the lobby one list of everything a robot can do, so each new trick comes with its own speed limit and its own on-screen feedback.').click();

    await expect(page).toHaveURL(new RegExp(`/contribute/task/${FIRST_TASK.id}$`));
    await expect(page.getByRole('heading', { name: 'What done looks like' })).toBeVisible();
    await expect(page.getByRole('list').filter({ hasText: 'Every action kind the lobby sends' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to claim' })).toHaveAttribute(
      'href',
      `/signin?next=${encodeURIComponent(`/contribute/task/${FIRST_TASK.id}`)}`,
    );
    await expect(page.getByRole('button', { name: 'Claim this' })).toHaveCount(0);
    // Nothing to hand to an agent before the task is yours.
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
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
    await expect(start.getByText('FORGE starts your agent for you. It works in your copy and opens a pull request.')).toBeVisible();
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
    // A copy needs FORGE's connector settings (step 1 sets one up with them), and the connector wants a sign-in (review-web M6).
    await expect(open.getByText("Press Get started on this page first, so your copy has FORGE's connector settings.")).toBeVisible();
    await expect(open.getByText('Open your copy in Antigravity. The FORGE connector is already set up in it.')).toBeVisible();
    await expect(open.getByText(/Settings → Customizations, press Authenticate next to forge, then paste the code/)).toBeVisible();
    await expect(open.getByText(`Ask it: Start FORGE task #${PRACTICE_TASK.id}`)).toBeVisible();
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
    // The one-time setup links to real places: the copy step to step 1 on this page, where Get started is.
    await expect(panel.getByRole('link', { name: COPY_STEP })).toHaveAttribute('href', '#copy-title');
    await expect(panel.getByRole('link', { name: 'Create an API key in Jules settings.' })).toHaveAttribute(
      'href',
      'https://jules.google.com/settings',
    );

    const key = panel.getByLabel('Your Jules API key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('autocomplete', 'off');
    // A name of its own per vendor, and password managers told to keep out (review-creds CR-10).
    await expect(key).toHaveAttribute('name', 'jules-key');
    await expect(key).toHaveAttribute('data-1p-ignore', '');
    await expect(key).toHaveAttribute('data-lpignore', 'true');
    // Saving a key is opt-in (review-web M2).
    await expect(panel.getByLabel('Remember it, encrypted, so next time is one click')).not.toBeChecked();
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
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Release this task' }).click();
    await page.getByRole('button', { name: 'Yes, release it' }).click();

    await expect(page.getByRole('status')).toContainText('Practice: released.');
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
    await expect(page.getByText(/yours for 48h/)).toHaveCount(0);
  });

  test('after Claim, keyboard focus is on what it opened (review-web L4)', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Your copy', exact: true })).toBeFocused();
  });

  test('"Opened a pull request FORGE can\'t see?" is there, closed, and says practice can\'t hand one in (review-web M5)', async ({
    page,
  }) => {
    const handIn = page.locator('details', { has: page.getByText("Opened a pull request FORGE can't see?") });
    await expect(handIn).not.toHaveAttribute('open');
    await handIn.getByText("Opened a pull request FORGE can't see?").click();
    await handIn.getByLabel("Your pull request's link").fill('https://github.com/verastd/forge-app/pull/77');
    await handIn.getByRole('button', { name: 'Hand it in' }).click();
    await expect(handIn.getByRole('alert')).toHaveText(
      "Practice accounts can't do that. Sign in with GitHub to do it for real.",
    );
  });
});

test.describe('a task above the practice account’s tier', () => {
  test('says so, as the API does, and nothing is claimed (tier_too_low)', async ({ page }) => {
    await goOffline(page);
    const above = TASK_FIXTURES.find((task) => task.tierFloor !== 'T0');
    if (above === undefined) throw new Error('no task above T0 in the fixtures');
    await page.goto(`/signin?next=${encodeURIComponent(`/contribute/task/${above.id}`)}`);
    await demoSignIn(page);
    await page.getByRole('button', { name: 'Claim this' }).click();
    await expect(page.getByText('This task needs a contributor tier above T0; it opens up as you ship work.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
  });
});

test.describe('with the FORGE connector switched off', () => {
  test('Antigravity and "Connect your agent to FORGE once" are not offered (review-web M6)', async ({ page }) => {
    await goOffline(page);
    await page.route('**/api/flags', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ contribute_bridge: true, agent_start: true, mcp_connector: false }),
      }),
    );
    await page.goto(`/signin?next=${encodeURIComponent(PRACTICE_PATH)}`);
    await demoSignIn(page);
    await page.getByRole('button', { name: 'Claim this' }).click();

    const open = openPart(page);
    await expect(open.getByRole('link', { name: 'Open Claude Code on the web' })).toBeVisible();
    await expect(open.getByRole('button', { name: /Google Antigravity/ })).toHaveCount(0);
    await expect(open.getByText(/Antigravity/)).toHaveCount(0);
    await expect(open.getByRole('link', { name: 'Connect your agent to FORGE once' })).toHaveCount(0);
    // Nor as a first-time step that would lead to a switched-off page.
    await open.getByText('First time with Claude Code on the web?').click();
    await expect(open.getByText(/Connect your agent to FORGE once/)).toHaveCount(0);
  });
});

test.describe('the practice account is nobody on GitHub', () => {
  test('a task a GitHub user called "you" holds is not the practice account’s (review-bridge B-L7)', async ({
    page,
  }) => {
    // A practice build pointed at a live API sees real holders' logins.
    const [taskOne, ...rest] = TASK_FIXTURES;
    if (taskOne === undefined) throw new Error('no task fixtures');
    const { acceptanceCriteria: criteria, ...cardOne } = taskOne;
    const card = {
      ...cardOne,
      status: 'claimed',
      claimedBy: 'you',
      leaseEndsAt: new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString(),
    };
    const others = rest.map(({ acceptanceCriteria: _criteria, ...task }) => task);
    await goOffline(page);
    await page.route('**/api/bridge/tasks', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [card, ...others] }) }),
    );
    await page.route('**/api/bridge/tasks/48', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task: card, acceptanceCriteria: criteria, branch: 'task/48-x', brief: BRIEF_WITHOUT_LOGIN }),
      }),
    );
    await page.goto(`/signin?next=${encodeURIComponent('/contribute')}`);
    await demoSignIn(page);

    const first = page.getByRole('region', { name: 'Tasks' }).getByRole('article').first();
    await expect(first).toContainText('someone is on it');
    await expect(first).not.toContainText('yours right now');

    await page.goto('/contribute/task/48');
    await expect(page.getByText('you is on this one right now.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
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
    await page.goto(`/signin?next=${encodeURIComponent(PRACTICE_PATH)}`);
    await demoSignIn(page);
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
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
  // compared as the API serves a task: it adds `status` from its lease store.
  // Neither side carries a dollar amount. (Moved here from the retired
  // handoff-golden.spec.ts.)
  test('match the API fixtures field for field', () => {
    const served = apiTasks.map((task) => ({ ...task, status: 'open' }));
    expect(apiTasks.some((task) => 'rewardUsd' in task)).toBe(false);
    expect(TASK_FIXTURES.map((task) => task.id)).toEqual([48, 49, 50, 51, 52]);
    expect(TASK_FIXTURES).toStrictEqual(served);
  });
});
