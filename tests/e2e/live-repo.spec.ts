import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';

import { openTransaction } from '../../packages/auth/dist/index.js';
import { RAIL_REGISTRY } from '../../packages/shared/dist/index.js';
import { describeRepoError } from '../../apps/web/src/lib/handoff';
import golden from '../fixtures/brief-golden.json';
import { SESSION_SECRET } from './helpers/env';
import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * "Your copy" and "Send for review" on the build we deploy (project
 * `chromium-live`, Phase 7), with the API deliberately down. This server has
 * a fake OAuth App (GITHUB_REPO_CLIENT_ID in playwright.config.ts), so the
 * task page offers the three steps. Two halves:
 *
 * - the task page, with the browser's calls answered by `page.route` (as in
 *   live-contribute.spec.ts): 1. Your copy, before and after; 2. Your agent,
 *   whose links open the agent in the copy; 3. Send for review, offered when
 *   the API says there is work to send or the agent said it pushed, and the
 *   pull request once there is one; and the one sentence for each outcome
 *   GitHub sends the browser back with. None of it says "fork", except the
 *   "What's this?" line;
 * - `POST /auth/github/repo` and `GET /auth/github/repo/callback` over HTTP,
 *   up to the point where GitHub itself would have to answer. The rest of the
 *   callback (the token exchanged, checked, used once and revoked) runs with
 *   stand-ins in repo-flow.spec.ts.
 */

const LOGIN = 'octo-contributor';
const IDENTITY = { sub: '5104001', login: LOGIN };
const COPY_NAME = 'octo-contributor/forge-app-1';
const REPO_CLIENT_ID = 'Ov23e2e0000000000000';

function goldenCase(name: string): (typeof golden.cases)[number] {
  const found = golden.cases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`brief-golden.json lost its "${name}" case`);
  }
  return found;
}

const WITH_LOGIN = goldenCase('with login');
const WITH_COPY = goldenCase('with a copy');

const inHours = (hours: number): string => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

const MINE = {
  ...WITH_LOGIN.task,
  size: 'S',
  rewardClass: 'none',
  tierFloor: 'T0',
  status: 'claimed',
  claimedBy: LOGIN,
  leaseEndsAt: inHours(47),
  labels: ['agent-ready', 'status:open', 'size:S'],
};

/** GET /api/bridge/tasks/1 for the holder, before FORGE has set up a copy. */
function detail(extra: Record<string, unknown> = {}) {
  return { task: MINE, acceptanceCriteria: WITH_LOGIN.criteria, branch: WITH_LOGIN.branch, brief: WITH_LOGIN.brief, ...extra };
}

/** ...and once it has: the copy (brought up to date five minutes ago) and the brief that names it. */
function withCopy(extra: Record<string, unknown> = {}) {
  return detail({ brief: WITH_COPY.brief, copy: { fullName: COPY_NAME, syncedAt: inHours(-5 / 60) }, ...extra });
}

function rails() {
  return {
    rails: RAIL_REGISTRY.map((meta) => ({
      ...meta,
      setup: [...meta.setup],
      enabled: meta.mode === 'open' || meta.id === 'jules',
      ...(meta.mode === 'start' ? { savedCredential: false } : {}),
    })),
    vault: true,
  };
}

const CLAIMED = { at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' };

function status(extra: Record<string, unknown> = {}) {
  return {
    taskId: 1,
    stage: 'claimed',
    detail: 'This task is yours for the next 47 hours.',
    events: [CLAIMED],
    holder: LOGIN,
    leaseEndsAt: MINE.leaseEndsAt,
    ...extra,
  };
}

/** The status once the agent said it pushed, and FORGE sees no pull request yet. */
const PUSHED = status({
  stage: 'ready_to_submit',
  events: [
    CLAIMED,
    { at: inHours(-0.5), kind: 'progress', source: 'agent', stage: 'pushed', message: 'Pushed the changes.' },
  ],
});

async function serviceDown(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
  await page.route('**/bff/**', (route) => route.abort());
}

async function serve(page: Page, pattern: string, body: unknown, statusCode = 200): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

/** Signed in as octo-contributor, holding task 1, on its page (or `path`). */
async function holdingTaskOne(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  options: { detail?: unknown; status?: unknown; path?: string } = {},
): Promise<void> {
  await signInAs(context, baseURL ?? '', IDENTITY);
  await serviceDown(page);
  await serve(page, '**/api/flags', { contribute_bridge: true, agent_start: true, github_signin: true, mcp_connector: true });
  await serve(page, '**/bff/bridge/tasks/1', options.detail ?? detail());
  await serve(page, '**/bff/bridge/rails', rails());
  await serve(page, '**/bff/bridge/status/1', options.status ?? status());
  await page.goto(options.path ?? '/contribute/task/1');
  await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
}

const step = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

/** The steps' visible words, without the "What's this?" line, which alone may say what GitHub calls it. */
async function stepsText(page: Page): Promise<string> {
  const texts: string[] = [];
  for (const name of ['Your copy', 'Your agent', 'Send for review']) {
    texts.push(
      await step(page, name).evaluate((section) => {
        const clone = section.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('details').forEach((details) => {
          if (!(details as HTMLDetailsElement).open || details.querySelector('summary')?.textContent === "What's this?") {
            details.remove();
          }
        });
        return clone.textContent ?? '';
      }),
    );
  }
  return texts.join('\n');
}

test.describe('the three steps on the live build', () => {
  test('before the copy: Get started, a word on what it is, and the agent needs the copy first', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    const copy = step(page, 'Your copy');
    await expect(
      copy.getByText(
        "FORGE makes your own copy of FORGE's code on GitHub for your agent to work in. GitHub asks you once to allow it.",
      ),
    ).toBeVisible();
    const getStarted = copy.getByRole('button', { name: 'Get started' });
    await expect(getStarted).toBeVisible();
    // A plain form post to FORGE: GitHub's approval page has to be a top-level navigation.
    const form = copy.locator('form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(form).toHaveAttribute('action', '/auth/github/repo');
    await expect(form.locator('input[name="taskId"]')).toHaveValue('1');
    await expect(form.locator('input[name="action"]')).toHaveValue('copy');

    // "What's this?" is closed, and the one place that says what GitHub calls it.
    const whatsThis = copy.locator('details', { has: page.getByText("What's this?") });
    await expect(whatsThis).not.toHaveAttribute('open');
    await whatsThis.getByText("What's this?").click();
    await expect(whatsThis.getByText(/^GitHub calls it a fork: a copy of FORGE's code under your own GitHub account/)).toBeVisible();

    await expect(step(page, 'Your agent').getByText('Your agent needs your copy first: press Get started above.')).toBeVisible();
    // Still usable before the copy: the links are there.
    await expect(step(page, 'Your agent').getByRole('link', { name: 'Open Claude Code on the web' })).toBeVisible();
    const review = step(page, 'Send for review');
    await expect(
      review.getByText('Once your copy is set up and your agent has pushed its work, you send it for review from here.'),
    ).toBeVisible();
    await expect(review.getByRole('button')).toHaveCount(0);

    expect(await stepsText(page)).not.toMatch(/fork/i);
    // Keyboard: from step 1's heading, the next stop is Get started.
    await page.getByRole('heading', { name: 'Your copy', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(getStarted).toBeFocused();
  });

  test('Get started goes to FORGE, then to GitHub for public_repo only, holding a repo attempt for this task', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    // Route handlers only see the first URL of a redirect chain, so the post is
    // caught here and sent on without following GitHub's redirect.
    let posted = '';
    let sentTo = '';
    await page.route('**/auth/github/repo', async (route) => {
      posted = route.request().postData() ?? '';
      const response = await route.fetch({ maxRedirects: 0 });
      sentTo = response.headers().location ?? `status ${response.status()}`;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>On the way to GitHub</title>' });
    });
    await step(page, 'Your copy').getByRole('button', { name: 'Get started' }).click();
    await expect(page).toHaveTitle('On the way to GitHub');

    expect(posted).toBe('taskId=1&action=copy');
    const authorize = new URL(sentTo);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe(REPO_CLIENT_ID);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/github/repo/callback`);
    expect(authorize.searchParams.getAll('scope')).toEqual(['public_repo']);
    expect(authorize.searchParams.get('allow_signup')).toBe('false');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const attempt = await openTransaction((await transactionCookie(context))?.value, [SESSION_SECRET]);
    expect(attempt).toMatchObject({ purpose: 'repo', action: 'copy', taskId: 1, state: authorize.searchParams.get('state') });
  });

  test('with a copy: ready and up to date, a quiet Refresh, and the agent opens in the copy', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy() });
    const copy = step(page, 'Your copy');
    await expect(copy.getByText(/^Your copy is ready:/)).toContainText(', up to date 5 minutes ago.');
    await expect(copy.getByRole('link', { name: `${COPY_NAME} (opens on GitHub in a new tab)` })).toHaveAttribute(
      'href',
      `https://github.com/${COPY_NAME}`,
    );
    const refresh = copy.getByRole('button', { name: 'Refresh your copy' });
    await expect(refresh).toHaveClass(/btn-ghost/);
    await expect(copy.locator('input[name="action"]')).toHaveValue('copy');
    await expect(copy.getByRole('button', { name: 'Get started' })).toHaveCount(0);

    const agent = step(page, 'Your agent');
    await expect(agent.getByText(/needs your copy first/)).toHaveCount(0);
    const web = agent.getByRole('link', { name: 'Open Claude Code on the web' });
    const query = new URL((await web.getAttribute('href')) ?? '').searchParams;
    expect(query.get('repositories')).toBe(COPY_NAME);
    // The links carry the API's own brief, which names the copy.
    expect(query.get('prompt')).toBe(WITH_COPY.brief);
    const codex = new URL((await agent.getByRole('link', { name: 'Open Codex app' }).getAttribute('href')) ?? '');
    expect(codex.searchParams.get('originUrl')).toBe(`https://github.com/${COPY_NAME}.git`);

    // Nothing to send yet: step 3 waits, and can be asked to look again.
    const review = step(page, 'Send for review');
    await expect(
      review.getByText('When your agent has pushed its work, send it for review from here: FORGE opens the pull request in your name.'),
    ).toBeVisible();
    await expect(review.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Send for review' })).toHaveCount(0);
    expect(await stepsText(page)).not.toMatch(/fork/i);
  });

  test('with a copy, Antigravity\'s steps point at Refresh your copy and name the copy; releasing says it stays in the copy', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy() });
    const agent = step(page, 'Your agent');
    await agent.getByRole('button', { name: /Google Antigravity/ }).click();
    const steps = agent.locator('#open-antigravity-steps');
    await expect(steps.getByText("If your copy is older than October 2026, press Refresh your copy on this page first so it has FORGE's connector settings.")).toBeVisible();
    await expect(steps.getByText(`Open your copy, ${COPY_NAME}, in Antigravity. The FORGE connector is already set up in it.`)).toBeVisible();
    expect(await steps.textContent()).not.toMatch(/fork/i);

    await page.getByRole('button', { name: 'Release this task' }).click();
    await expect(
      page.getByText('Release this task? It goes back on the board for someone else. Anything your agent already pushed stays in your copy.'),
    ).toBeVisible();
  });

  test('Send for review is offered when the API says the copy has work to send, and posts "review"', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy({ canSendForReview: true }) });
    const review = step(page, 'Send for review');
    await expect(review.getByText('Your agent has pushed its work. Send it for review, and the checks start.')).toBeVisible();
    // What the pull request will say in the person's name, up front, and as the button's own description.
    const says =
      "FORGE opens the pull request in your name. It says, for you, that your agent didn't change or delete any existing tests (FORGE checks that first) and that an AI agent did the work.";
    await expect(review.getByText(says)).toBeVisible();
    await expect(review.getByRole('button', { name: 'Send for review' })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Send for review' })).toHaveAccessibleDescription(says);
    const form = review.locator('form');
    await expect(form).toHaveAttribute('action', '/auth/github/repo');
    await expect(form.locator('input[name="action"]')).toHaveValue('review');
    await expect(form.locator('input[name="taskId"]')).toHaveValue('1');
  });

  test('...and when the agent said it pushed, before the API knows', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy(), status: PUSHED });
    await expect(step(page, 'Send for review').getByRole('button', { name: 'Send for review' })).toBeVisible();
  });

  test('once the pull request is open: its link, a tick, and no second Send for review', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, {
      detail: withCopy({ canSendForReview: true }),
      status: status({
        stage: 'in_checks',
        prUrl: 'https://github.com/verastd/forge-app/pull/12',
        events: [CLAIMED, { at: inHours(-0.1), kind: 'review_sent', source: 'forge', message: 'Sent for review: pull request #12.' }],
      }),
    });
    const review = step(page, 'Send for review');
    await expect(review.getByRole('link', { name: 'pull request #12 (opens on GitHub in a new tab)' })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app/pull/12',
    );
    await expect(review.getByText(/^Sent for review: /)).toContainText('Its checks and the review show up in “Where it is” below.');
    await expect(review.getByRole('button')).toHaveCount(0);
    await expect(step(page, 'Where it is').getByText('FORGE: Sent for review: pull request #12.')).toBeVisible();
  });

  test('with the copy, "Where it is" points at Send for review rather than at GitHub', async ({ page, context, baseURL }) => {
    // The API's own words for "ready to submit", which send the person to GitHub.
    const apiDetail =
      "Your agent says the work is ready, but there's no pull request for it yet. Use “When your agent has pushed its branch: open the pull request”, or ask your agent to open it.";
    const ready = {
      ...PUSHED,
      detail: apiDetail,
      compareUrl: `https://github.com/verastd/forge-app/compare/main...${LOGIN}:${WITH_LOGIN.branch}`,
    };
    await holdingTaskOne(page, context, baseURL, { detail: withCopy(), status: ready });
    const progress = step(page, 'Where it is');
    await expect(
      progress.getByText('Your agent says the work is ready. Send it for review above: FORGE opens the pull request in your name.'),
    ).toBeVisible();
    await expect(progress.getByRole('link', { name: /open the pull request/ })).toHaveCount(0);
    await expect(step(page, 'Send for review').getByRole('button', { name: 'Send for review' })).toBeVisible();

    // No copy yet: as before, GitHub's compare page and the API's own words.
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await page.reload();
    await expect(progress.getByRole('link', { name: 'When your agent has pushed its branch: open the pull request' })).toBeVisible();
    await expect(progress.getByText(apiDetail)).toBeVisible();
  });

  test('Check again reads the task again, and offers Send for review once there is work to send', async ({
    page,
    context,
    baseURL,
  }) => {
    let canSend = false;
    await holdingTaskOne(page, context, baseURL, { detail: withCopy() });
    await page.route('**/bff/bridge/tasks/1', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(withCopy(canSend ? { canSendForReview: true } : {})) }),
    );
    const review = step(page, 'Send for review');
    await expect(review.getByRole('button', { name: 'Check again' })).toBeVisible();
    canSend = true;
    await review.getByRole('button', { name: 'Check again' }).click();
    await expect(review.getByRole('button', { name: 'Send for review' })).toBeVisible();
    // The page never went back to its loading screen.
    await expect(page.getByText('Opening the task…')).toHaveCount(0);
  });

  test('on a phone, the steps fit the screen', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await holdingTaskOne(page, context, baseURL, { detail: withCopy({ canSendForReview: true }) });
    await expect(step(page, 'Send for review').getByRole('button', { name: 'Send for review' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe('what GitHub sending you back says', () => {
  test('?copy=ready is said once the task shows the copy, and the address bar drops it', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy(), path: '/contribute/task/1?copy=ready' });
    await expect(page.getByRole('status').filter({ hasText: 'Your copy is ready. Your agent can work in it now.' })).toBeVisible();
    await expect(page).toHaveURL(/\/contribute\/task\/1$/);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
    await expect(page.getByText('Your copy is ready. Your agent can work in it now.')).toHaveCount(0);
  });

  test('?copy=ready&synced=0&latest=0 adds a sentence for each', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { detail: withCopy(), path: '/contribute/task/1?copy=ready&synced=0&latest=0' });
    const note = page.getByRole('status').filter({ hasText: 'Your copy is ready. Your agent can work in it now.' });
    await expect(note).toContainText(
      "FORGE couldn't bring your copy fully up to date, because it has changes of its own. That doesn't stop your agent: it works on this task's own branch.",
    );
    await expect(note).toContainText(
      "Your agent's branch starts from your copy's main, which may be behind FORGE's latest code. Ask your agent to bring the branch up to date with FORGE's code first.",
    );
    await expect(page).toHaveURL(/\/contribute\/task\/1$/);
  });

  test('a ?copy=ready the task doesn’t back up is not said', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?copy=ready' });
    await expect(step(page, 'Your copy').getByRole('button', { name: 'Get started' })).toBeVisible();
    await expect(page.getByText('Your copy is ready. Your agent can work in it now.')).toHaveCount(0);
  });

  test('?review=sent&pr=12 is said when the status shows pull request #12, and not for another', async ({
    page,
    context,
    baseURL,
  }) => {
    const sent = status({ stage: 'in_checks', prUrl: 'https://github.com/verastd/forge-app/pull/12' });
    await holdingTaskOne(page, context, baseURL, { detail: withCopy(), status: sent, path: '/contribute/task/1?review=sent&pr=12' });
    await expect(
      page.getByRole('status').filter({ hasText: 'Sent for review: pull request #12. Its checks show up below as they run.' }),
    ).toBeVisible();

    await page.goto('/contribute/task/1?review=sent&pr=13');
    await expect(step(page, 'Send for review').getByRole('link', { name: /pull request #12/ })).toBeVisible();
    await expect(page.getByText(/Sent for review: pull request #13/)).toHaveCount(0);
  });

  test('each ?repo_error= reads as its own sentence, and nothing from the query string is shown', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?repo_error=wrong_account' });
    await expect(page.getByRole('alert').filter({ hasText: describeRepoError('wrong_account') })).toBeVisible();
    await expect(page).toHaveURL(/\/contribute\/task\/1$/);

    for (const [query, sentence] of [
      ['repo_error=github_denied', "You didn't allow it on GitHub, so FORGE did nothing."],
      [
        'repo_error=github_failed&status=502',
        "GitHub turned down one of FORGE's requests (error 502). Try again in a minute: FORGE picks up where it stopped.",
      ],
      ['repo_error=no_changes', "Your agent hasn't pushed any work for this task to your copy yet, so there's nothing to send."],
      ['repo_error=not_configured', "FORGE can't do that on this server yet, so nothing changed."],
      ['repo_error=rate_limited', "You've asked FORGE to do that too many times in the last hour. Try again later."],
      ['repo_error=copy_not_ready', 'GitHub is still making your copy. Wait a minute, then press Get started again.'],
      [
        'repo_error=head_taken&pr=77',
        "Someone else opened pull request #77 from your copy's branch. FORGE can't send yours while it's open. Ask a maintainer to close it.",
      ],
      [
        'repo_error=tests_modified&files=2',
        "Your agent changed 2 test files that were already there, so FORGE didn't send it. Ask your agent to undo that and put any new tests in new files, then send it for review again.",
      ],
      ['repo_error=%3Cb%3Eyour+account+is+locked%3C%2Fb%3E', "That didn't work. Reload the page to see where things stand, then try again."],
    ] as const) {
      await page.goto(`/contribute/task/1?${query}`);
      await expect(page.getByRole('alert').filter({ hasText: sentence }), query).toBeVisible();
    }
    await expect(page.getByText(/account is locked/)).toHaveCount(0);
  });

  test('a ?repo_error= on a task that isn’t yours any more is said where you can take it on', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await serve(page, '**/api/flags', { contribute_bridge: true, agent_start: true });
    await serve(page, '**/bff/bridge/tasks/1', detail({ task: { ...MINE, status: 'open', claimedBy: undefined, leaseEndsAt: undefined } }));
    await page.goto('/contribute/task/1?repo_error=not_holder');
    const take = page.getByRole('region', { name: 'Take it on' });
    await expect(take.getByRole('alert')).toHaveText("This task isn't yours any more, so nothing changed. Claim it again first.");
    await expect(page.getByRole('heading', { name: 'Your copy', exact: true })).toHaveCount(0);
  });

  test('the board says when there was no attempt to go back to, once', async ({ page }) => {
    await serviceDown(page);
    await serve(page, '**/api/flags', { contribute_bridge: true });
    await serve(page, '**/api/bridge/tasks', { tasks: [] });
    await page.goto('/contribute?repo_error=expired');
    await expect(page.getByRole('alert').filter({ hasText: describeRepoError('expired') })).toBeVisible();
    await expect(page).toHaveURL(/\/contribute$/);
  });
});

/* --- the routes, over HTTP --------------------------------------------------------------------------- */

/** POST /auth/github/repo as the task page's form does, from this origin unless told otherwise. */
function startRepo(
  request: APIRequestContext,
  baseURL: string,
  fields: Record<string, string> = { taskId: '1', action: 'copy' },
  origin: string | null = baseURL,
) {
  return request.post('/auth/github/repo', {
    form: fields,
    headers: origin === null ? {} : { origin },
    maxRedirects: 0,
  });
}

async function transactionCookie(context: BrowserContext): Promise<{ value: string } | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === 'forge_oauth');
}

/** Starts a repo attempt for task 1 and hands back the state GitHub would echo. */
async function startedRepo(context: BrowserContext, baseURL: string, action = 'copy'): Promise<string> {
  const start = await startRepo(context.request, baseURL, { taskId: '1', action });
  expect(start.status()).toBe(303);
  return new URL(start.headers().location ?? '').searchParams.get('state') ?? '';
}

test.describe('POST /auth/github/repo on the live build', () => {
  test('refuses a post from another site, and one without an Origin, and keeps nothing', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const foreign = await startRepo(context.request, baseURL ?? '', undefined, 'https://evil.example');
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'bad_origin' });
    expect((await startRepo(context.request, baseURL ?? '', undefined, null)).status()).toBe(403);
    expect(await transactionCookie(context)).toBeUndefined();
  });

  test('a same-origin fetch without Origin passes on Sec-Fetch-Site alone', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const response = await context.request.post('/auth/github/repo', {
      form: { taskId: '1', action: 'review' },
      headers: { 'sec-fetch-site': 'same-origin' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
  });

  test('signed out, it goes to sign-in and back to the task, and keeps nothing', async ({ request, baseURL }) => {
    const response = await startRepo(request, baseURL ?? '');
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?next=%2Fcontribute%2Ftask%2F1');
    const { cookies } = await request.storageState();
    expect(cookies.find((cookie) => cookie.name === 'forge_oauth')).toBeUndefined();
  });

  test('a practice cookie is nobody on this build, so it goes to sign-in too', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await startRepo(context.request, baseURL ?? '');
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?next=%2Fcontribute%2Ftask%2F1');
  });

  test('a task that isn’t a task number, or an action other than copy and review, is a 400', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const forms: Record<string, string>[] = [
      { taskId: '0', action: 'copy' },
      { taskId: 'one', action: 'copy' },
      { taskId: '12345678901', action: 'review' },
      { taskId: '1', action: 'fork' },
      { taskId: '1', action: 'merge' },
      { taskId: '1' },
    ];
    for (const fields of forms) {
      expect((await startRepo(context.request, baseURL ?? '', fields)).status(), JSON.stringify(fields)).toBe(400);
    }
    const big = await startRepo(context.request, baseURL ?? '', { taskId: '1', action: 'copy', pad: 'x'.repeat(2000) });
    expect(big.status()).toBe(413);
  });

  test('signed in: off to GitHub for public_repo only, with PKCE, holding a repo attempt', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const response = await startRepo(context.request, baseURL ?? '', { taskId: '1', action: 'review' });
    expect(response.status()).toBe(303);
    expect(response.headers()['cache-control']).toBe('no-store');
    const location = new URL(response.headers().location ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: REPO_CLIENT_ID,
      redirect_uri: `${baseURL}/auth/github/repo/callback`,
      scope: 'public_repo',
      code_challenge_method: 'S256',
      allow_signup: 'false',
    });
    expect(location.searchParams.get('code_challenge') ?? '').toHaveLength(43);
    // Never the sign-in App's id, and never a secret.
    expect(location.href).not.toContain('Iv1.e2e0000000000000');
    expect(location.href).not.toContain('e2e-fake-repo-client-secret');

    const attempt = await openTransaction((await transactionCookie(context))?.value, [SESSION_SECRET]);
    expect(attempt).toMatchObject({
      purpose: 'repo',
      action: 'review',
      taskId: 1,
      next: '/contribute/task/1',
      state: location.searchParams.get('state'),
    });
  });
});

test.describe('GET /auth/github/repo/callback on the live build', () => {
  /** The attempt is spent: one attempt, one use. */
  async function expectSpent(context: BrowserContext): Promise<void> {
    const left = await transactionCookie(context);
    expect(left === undefined || left.value === '').toBe(true);
  }

  test('GitHub said no: back to the task, github_denied', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const state = await startedRepo(context, baseURL ?? '');
    const denied = await context.request.get(`/auth/github/repo/callback?state=${state}&error=access_denied`, { maxRedirects: 0 });
    expect(denied.status()).toBe(303);
    expect(denied.headers().location).toBe('/contribute/task/1?repo_error=github_denied');
    await expectSpent(context);
  });

  test('a state that doesn’t match: back to the task, github_failed, and the attempt is spent', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await startedRepo(context, baseURL ?? '');
    const response = await context.request.get('/auth/github/repo/callback?state=definitely-not-it&code=x', { maxRedirects: 0 });
    expect(response.headers().location).toBe('/contribute/task/1?repo_error=github_failed');
    await expectSpent(context);
    // Spent means spent: the right state no longer works either.
    const again = await context.request.get('/auth/github/repo/callback?state=x&code=x', { maxRedirects: 0 });
    expect(again.headers().location).toBe('/contribute?repo_error=expired');
  });

  test('no code: github_failed, before anything reaches GitHub', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const state = await startedRepo(context, baseURL ?? '');
    const response = await context.request.get(`/auth/github/repo/callback?state=${state}`, { maxRedirects: 0 });
    expect(response.headers().location).toBe('/contribute/task/1?repo_error=github_failed');
  });

  test('signed out by the time GitHub sends you back: signed_out, before anything reaches GitHub', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const state = await startedRepo(context, baseURL ?? '');
    await context.clearCookies({ name: 'forge_session' });
    const response = await context.request.get(`/auth/github/repo/callback?state=${state}&code=x`, { maxRedirects: 0 });
    expect(response.headers().location).toBe('/contribute/task/1?repo_error=signed_out');
  });

  test('no attempt at all: to the board, which says so', async ({ request }) => {
    const response = await request.get('/auth/github/repo/callback?state=x&code=y', { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/contribute?repo_error=expired');
  });

  test('a Copilot attempt is no repo attempt: to the board, and nothing is done', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const start = await context.request.post('/auth/github/agent', {
      form: { taskId: '1' },
      headers: { origin: baseURL ?? '' },
      maxRedirects: 0,
    });
    const state = new URL(start.headers().location ?? '').searchParams.get('state') ?? '';
    const response = await context.request.get(`/auth/github/repo/callback?state=${state}&code=x`, { maxRedirects: 0 });
    expect(response.headers().location).toBe('/contribute?repo_error=expired');
    await expectSpent(context);
  });

  test('a repo attempt is no sign-in: the sign-in callback refuses it', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const state = await startedRepo(context, baseURL ?? '');
    const response = await context.request.get(`/auth/callback?state=${state}&code=x`, { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?error=state');
    await expectSpent(context);
  });
});
