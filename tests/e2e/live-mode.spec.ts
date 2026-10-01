import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { RAIL_REGISTRY, branchName, compileBrief } from '../../packages/shared/dist/index.js';
import { signInAs } from './helpers/session';

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

const FIXTURE_SUMMARY = 'Let people download the Upland data they are looking at as a spreadsheet file.';

/** A task card the server could really have sent — the contract's shape exactly. */
const SERVED_TASK = {
  id: 1,
  title: 'Polish the CSV export in the Data app',
  civilianSummary: FIXTURE_SUMMARY,
  size: 'S',
  rewardClass: 'none',
  tierFloor: 'T0',
  status: 'open',
  url: 'https://github.com/verastd/forge-app/issues/1',
  labels: ['agent-ready', 'status:open', 'size:S'],
};

/** Its acceptance criteria, which GET /api/bridge/tasks/1 serves with the card. */
const SERVED_CRITERIA = [
  'GET /api/upland/export returns text/csv whose first line is the 13-column action header',
  'Export CSV button visible on /apps/data for signed-in users (flag: csv_export)',
  '10k-row export completes < 3s in CI fixture data',
];

/**
 * Claiming and handing off need a GitHub identity since Phase 4, so these go
 * through the BFF (`/bff/bridge/*`) as this signed-in contributor.
 */
const IDENTITY = { sub: '5002001', login: 'octocat' };

/** GET /api/bridge/tasks/1, as the API answers the signed-in contributor (the brief names their fork). */
function servedDetail(criteria: string[] = SERVED_CRITERIA) {
  return {
    task: SERVED_TASK,
    acceptanceCriteria: criteria,
    branch: branchName(SERVED_TASK.id, SERVED_TASK.title),
    brief: compileBrief(SERVED_TASK, criteria, IDENTITY.login),
  };
}

const SERVED_CLAIM = () => ({
  taskId: 1,
  claimedBy: IDENTITY.login,
  leaseEndsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  leaseHours: 48,
});

async function serviceDown(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
}

/** Later routes win in Playwright, so these are registered after {@link serviceDown}. */
async function serve(page: Page, pattern: string, body: unknown, status = 200): Promise<void> {
  await page.route(pattern, (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

async function openBridge(page: Page, flags: Record<string, boolean> = {}): Promise<void> {
  await serve(page, '**/api/flags', { csv_export: true, contribute_bridge: true, ...flags });
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

  test('never opens a task screen out of local fixtures', async ({ page }) => {
    await serviceDown(page);
    await openBridge(page);
    await page.goto('/contribute/task/1');

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toHaveCount(0);
    await expect(page.getByText(/yours for \d+h/)).toHaveCount(0);
  });

  test('a claim that did not save leaves nothing claimed', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', servedDetail());
    await serve(page, '**/bff/bridge/claim', { error: 'internal_error' }, 500);

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText('nothing was changed');
    // No lease, no countdown, no next step — and the button is still there to
    // try again, because trying again is the only thing that can help.
    await expect(page.getByText(/yours for \d+h/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toHaveCount(0);
    await expect(page.getByText('Your agent is working')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
  });

  test('a hand-off that did not save never says an agent started', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page, { agent_start: true });
    await serve(page, '**/bff/bridge/tasks/1', servedDetail());
    await serve(page, '**/bff/bridge/claim', SERVED_CLAIM());
    await serve(page, '**/bff/bridge/rails', {
      rails: RAIL_REGISTRY.map((meta) => ({ ...meta, enabled: meta.mode === 'open' || meta.id === 'jules' })),
      vault: false,
    });
    await serve(page, '**/bff/bridge/dispatch', { error: 'internal_error' }, 500);
    // The status is left to the real BFF, which finds the API down (502).

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();
    await expect(page.getByRole('heading', { name: 'Get your agent on it' })).toBeVisible();

    await page.getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    await expect(panel.getByRole('alert')).toContainText('nothing was started');
    await expect(page.getByText('Google Jules is working on it.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Watch it work/ })).toHaveCount(0);

    // The status poll is down too, so the stages must sit where they are
    // instead of walking themselves to "shipped".
    await expect(page.getByText('Your agent is working')).toHaveCount(0);
    await expect(page.getByText(/can't check on this one just now/)).toBeVisible();
  });

  test('a signed-in identity adds repositories= to the Claude Code link', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', servedDetail());
    await serve(page, '**/bff/bridge/claim', SERVED_CLAIM());

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    // The brief itself is compileBrief's, held to tests/fixtures/brief-golden.json.
    const brief = compileBrief(SERVED_TASK, SERVED_CRITERIA, IDENTITY.login);
    await expect(page.getByRole('link', { name: 'Open Claude Code on the web' })).toHaveAttribute(
      'href',
      `https://claude.ai/code?prompt=${encodeURIComponent(brief)}&repositories=octocat/forge-app`,
    );
  });

  test('a brief too long for a link falls back to prompt_url, and the steps say what to ask', async ({
    page,
    context,
    baseURL,
  }) => {
    // Past the 7,000-character Claude Code link (and the 5,000-character
    // `q` of a claude-cli:// link) once encoded: lib/launch.ts.
    const criteria = Array.from({ length: 90 }, (_, index) => `Criterion ${index + 1}: ${'Context. '.repeat(12)}`);
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', servedDetail(criteria));
    await serve(page, '**/bff/bridge/claim', SERVED_CLAIM());

    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    // Nothing is cut short: Claude Code fetches the whole brief from the API.
    const web = new URL((await page.getByRole('link', { name: 'Open Claude Code on the web' }).getAttribute('href')) ?? '');
    expect(web.searchParams.has('prompt')).toBe(false);
    expect(web.searchParams.get('prompt_url')).toBe('http://localhost:8000/api/bridge/tasks/1/brief?login=octocat');
    expect(web.searchParams.get('repositories')).toBe('octocat/forge-app');

    // Claude Code on your computer opens without it, so the steps say what to ask.
    await expect(page.getByRole('link', { name: 'Open Claude Code on your computer' })).toHaveAttribute(
      'href',
      'claude-cli://open?repo=octocat/forge-app',
    );
    await expect(page.getByText('Once Claude Code opens, ask it: Start FORGE task #1')).toBeVisible();
    // Cursor's whole link is capped too: it opens with the short ask instead.
    const cursor = new URL((await page.getByRole('link', { name: 'Open Cursor app' }).getAttribute('href')) ?? '');
    expect(cursor.searchParams.get('text')).toBe('Start FORGE task #1');
  });

  test('a real session with the API down gets the Data app failure card, not a sign-in loop', async ({
    page,
    context,
    baseURL,
  }) => {
    // Unmocked BFF: it really forwards, to a closed port, and answers 502. That
    // is the data service failing, which "Try again" can fix; a sign-in can't.
    await signInAs(context, baseURL ?? '', { sub: '5002001', login: 'octocat' });
    await serviceDown(page);
    await serve(page, '**/api/flags', {
      csv_export: true,
      contribute_bridge: true,
      upland_data: true,
      github_signin: true,
    });
    await page.goto('/apps/data');

    const broken = page.getByRole('alert').filter({ hasText: "We can't show the data summary just now" });
    await expect(broken.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('Sign in with GitHub to open the Data app')).toHaveCount(0);
    await expect(page.getByText("FORGE couldn't confirm your sign-in")).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  });
});
