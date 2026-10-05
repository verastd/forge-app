import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Locator, Page, Request, Route } from '@playwright/test';

import { openTransaction } from '../../packages/auth/dist/index.js';
import { COPY_STEP, RAIL_REGISTRY } from '../../packages/shared/dist/index.js';
import golden from '../fixtures/brief-golden.json';
import { SESSION_SECRET } from './helpers/env';
import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * The Contribute hand-off on the build we deploy (project `chromium-live`),
 * with the API deliberately down. Two halves:
 *
 * - the screens, with the browser's calls answered by `page.route`: the BFF
 *   (`/bff/bridge/*`, `/bff/oauth/grants*`) once signed in, the API itself for
 *   the public reads while signed out. Nothing on these screens may claim
 *   more than the answers say: a failed claim or start changes nothing, the
 *   links carry the signed-in contributor's own brief, and an agent's words
 *   are only ever text;
 * - the server routes that need this build's fake GitHub App config: the
 *   one-time GitHub authorization behind "Start GitHub Copilot"
 *   (`POST /auth/github/agent`) and the callback's `agent` branch, up to the
 *   point where GitHub itself would have to answer.
 *
 * The BFF's forwarding (assertion, header allowlists, a stand-in API) is in
 * bridge-bff.spec.ts, on the demo server: this one's API URL points at a port
 * nothing may listen on. live-mode.spec.ts keeps the failure cases it always
 * had, rewritten for v2: a claim or a start that did not save, repositories=
 * on the Claude Code link, and the prompt_url fallback for a long brief.
 */

const LOGIN = 'octo-contributor';
const IDENTITY = { sub: '5104001', login: LOGIN };

const WITH_LOGIN = (() => {
  const found = golden.cases.find((entry) => entry.name === 'with login');
  if (found === undefined) {
    throw new Error('brief-golden.json lost its "with login" case');
  }
  return found;
})();

const TASK = {
  ...WITH_LOGIN.task,
  size: 'S',
  rewardClass: 'none',
  tierFloor: 'T0',
  status: 'open',
  labels: ['agent-ready', 'status:open', 'size:S'],
};

const inHours = (hours: number): string => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

function detail(task: Record<string, unknown> = TASK, criteria: string[] = WITH_LOGIN.criteria) {
  return { task, acceptanceCriteria: criteria, branch: WITH_LOGIN.branch, brief: WITH_LOGIN.brief };
}

const MINE = { ...TASK, status: 'claimed', claimedBy: LOGIN, leaseEndsAt: inHours(47) };
const CLAIM = { taskId: 1, claimedBy: LOGIN, leaseEndsAt: inHours(48), leaseHours: 48 };

/** GET /api/bridge/rails as the API would answer it: these start rails on, Cursor's key saved. */
function rails(enabled: readonly string[] = ['copilot', 'jules', 'devin', 'claude-routine'], saved: readonly string[] = []) {
  return {
    rails: RAIL_REGISTRY.map((meta) => ({
      ...meta,
      setup: [...meta.setup],
      enabled: meta.mode === 'open' || enabled.includes(meta.id),
      ...(meta.mode === 'start' ? { savedCredential: saved.includes(meta.id) } : {}),
    })),
    vault: true,
  };
}

function status(extra: Record<string, unknown> = {}) {
  return {
    taskId: 1,
    stage: 'claimed',
    detail: 'This task is yours for the next 47 hours.',
    events: [{ at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' }],
    holder: LOGIN,
    leaseEndsAt: MINE.leaseEndsAt,
    ...extra,
  };
}

/** Everything the browser would send to the API or the BFF fails, unless a test answers it below. */
async function serviceDown(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
  await page.route('**/bff/**', (route) => route.abort());
}

/** Later routes win in Playwright, so these are registered after {@link serviceDown}. */
async function serve(page: Page, pattern: string, body: unknown, statusCode = 200): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

async function openBridge(page: Page, flags: Record<string, boolean> = {}): Promise<void> {
  await serve(page, '**/api/flags', { contribute_bridge: true, agent_start: true, github_signin: true, ...flags });
}

/** Signed in as octo-contributor, holding task 1, on its page. */
async function holdingTaskOne(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  options: { rails?: unknown; status?: unknown; path?: string } = {},
): Promise<void> {
  await signInAs(context, baseURL ?? '', IDENTITY);
  await serviceDown(page);
  await openBridge(page);
  await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
  await serve(page, '**/bff/bridge/rails', options.rails ?? rails());
  await serve(page, '**/bff/bridge/status/1', options.status ?? status());
  await page.goto(options.path ?? '/contribute/task/1');
  await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
}

function href(page: Page, name: string): Promise<string | null> {
  return page.getByRole('link', { name }).getAttribute('href');
}

test.describe('claiming, on the live build', () => {
  test('signed out, the task reads from the API and the claim is "Sign in to claim"', async ({ page }) => {
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/api/bridge/tasks/1', detail());
    await page.goto('/contribute/task/1');

    await expect(page.getByRole('heading', { name: WITH_LOGIN.task.civilianSummary })).toBeVisible();
    await expect(page.getByText(WITH_LOGIN.criteria[0] ?? '')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to claim' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fcontribute%2Ftask%2F1',
    );
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
    // Nothing practice-flavoured on the build we ship.
    await expect(page.getByText(/practice/i)).toHaveCount(0);
  });

  test('says so kindly when someone else got there first', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await serve(page, '**/bff/bridge/claim', { error: 'already_claimed', claimedBy: 'maya' }, 409);
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText('Someone claimed this one first');
    await expect(page.getByText('maya is on this one right now.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Find another' })).toBeVisible();
  });

  test('a claim past your limit says what to do, and leaves the button for later', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await serve(page, '**/bff/bridge/claim', { error: 'claim_limit' }, 409);
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText('Finish or release one, then claim this.');
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
  });

  test('a claim that lands opens the three steps and the progress view', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await serve(page, '**/bff/bridge/claim', CLAIM);
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByRole('status')).toContainText("It's yours for the next 48 hours.");
    await expect(page.getByText(/yours for 48h/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start it for me' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open my agent' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Where it is' }).getByText('FORGE: You claimed this task.')).toBeVisible();
    // The 45-second march and its beta note are gone from the build we ship.
    await expect(page.getByText(/Beta note|simulated/)).toHaveCount(0);
    // Keyboard and screen-reader users land on what the claim opened (review-web L4).
    await expect(page.getByRole('heading', { name: 'Your copy', exact: true })).toBeFocused();
  });

  test('a claim FORGE’s rules turn down says which rule, in plain words', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    const answers: Array<[number, unknown, Record<string, string>, string]> = [
      [403, { error: 'tier_too_low', tierFloor: 'T2' }, {}, 'This task needs a contributor tier above T0; it opens up as you ship work.'],
      [
        409,
        { error: 'claim_cooldown', retryAfter: 82_800 },
        { 'retry-after': '82800' },
        "This task was yours less than a day ago, so you can't claim it again just yet; someone else can take it meanwhile. Try again in about 23 hours.",
      ],
      [
        429,
        { error: 'claim_rate_limit' },
        { 'retry-after': '3600' },
        "You've claimed as many tasks as FORGE allows in a day. Try again in about 60 minutes.",
      ],
    ];
    let next = 0;
    await page.route('**/bff/bridge/claim', async (route) => {
      const [code, body, headers] = answers[next] ?? [500, {}, {}];
      next += 1;
      await route.fulfill({ status: code, contentType: 'application/json', headers, body: JSON.stringify(body) });
    });
    await page.goto('/contribute/task/1');
    for (const [, , , sentence] of answers) {
      await page.getByRole('button', { name: 'Claim this' }).click();
      await expect(page.getByText(sentence)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
    }
  });

  test('a task the API doesn’t have says so, with no "Try again" that can’t work (review-web L1)', async ({
    page,
    context,
    baseURL,
  }) => {
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/api/bridge/tasks/999', { error: 'task_not_found', taskId: 999 }, 404);
    await page.goto('/contribute/task/999');
    await expect(page.getByRole('heading', { name: "This task doesn't exist (any more)" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to the task list' })).toBeVisible();

    // Signed in, through the BFF, the same.
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serve(page, '**/bff/bridge/tasks/999', { error: 'task_not_found', taskId: 999 }, 404);
    await page.reload();
    await expect(page.getByRole('heading', { name: "This task doesn't exist (any more)" })).toBeVisible();

    // Anything else that fails is still the "try again" kind.
    await serve(page, '**/bff/bridge/tasks/999', { error: 'bridge-disabled' }, 404);
    await page.reload();
    await expect(page.getByRole('heading', { name: "We can't open that task just now" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('"Open my agent", signed in', () => {
  test('the links and the fallback carry the API’s own brief, not one compiled here (review-web L5)', async ({
    page,
    context,
    baseURL,
  }) => {
    // What the API would send after a brief change the web build hasn't caught up with.
    const fromApi = `${WITH_LOGIN.brief}\n\n(The API's brief, newer than this web build.)`;
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', { ...detail(MINE), brief: fromApi });
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    await page.goto('/contribute/task/1');
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();

    expect(new URL((await href(page, 'Open Claude Code on the web')) ?? '').searchParams.get('prompt')).toBe(fromApi);
    expect(new URL((await href(page, 'Open Codex app')) ?? '').searchParams.get('prompt')).toBe(fromApi);
    const fallback = page.locator('details', { has: page.getByText('Using another agent? Copy the brief') });
    await fallback.getByText('Using another agent? Copy the brief').click();
    expect(await fallback.locator('pre').textContent()).toBe(fromApi);
  });

  test('every link carries your own brief, and the fork wherever the agent takes one', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    const brief = encodeURIComponent(WITH_LOGIN.brief);

    expect(await href(page, 'Open Claude Code on the web')).toBe(
      `https://claude.ai/code?prompt=${brief}&repositories=${LOGIN}/forge-app`,
    );
    expect(await href(page, 'Open Claude Code on your computer')).toBe(
      `claude-cli://open?repo=${LOGIN}/forge-app&q=${brief}`,
    );
    expect(await href(page, 'Open Codex app')).toBe(
      `codex://new?prompt=${brief}&originUrl=${encodeURIComponent(`https://github.com/${LOGIN}/forge-app.git`)}`,
    );
    expect(await href(page, 'Open VS Code agents')).toBe(`vscode://agents/new?prompt=${brief}`);
    expect(await href(page, 'Open Cursor app')).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${brief}`);

    const fallback = page.locator('details', { has: page.getByText('Using another agent? Copy the brief') });
    await expect(fallback).not.toHaveAttribute('open');
    await fallback.getByText('Using another agent? Copy the brief').click();
    expect(await fallback.locator('pre').textContent()).toBe(WITH_LOGIN.brief);
  });

  test('opening an agent notes the hand-off on the side, without holding the link up', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    await context.route('https://claude.ai/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Claude Code stand-in</title>' }),
    );
    const noted = page.waitForRequest((request: Request) => request.url().endsWith('/bff/bridge/dispatch'));
    await serve(page, '**/bff/bridge/dispatch', {
      mode: 'open',
      rail: 'claude-code',
      brief: WITH_LOGIN.brief,
      startedAt: new Date().toISOString(),
    });

    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open Claude Code on the web' }).click();
    const agent = await popup;
    expect(agent.url()).toContain('https://claude.ai/code?prompt=');

    const request = await noted;
    expect(request.method()).toBe('POST');
    expect(request.postDataJSON()).toEqual({ taskId: 1, rail: 'claude-code' });
  });
});

test.describe('"Start it for me", signed in', () => {
  test('only the start rails the API switched on are offered, and none when agent_start is off', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { rails: rails(['jules']) });
    const start = page.getByRole('group', { name: 'Start it for me' });
    await expect(start.getByRole('button')).toHaveCount(1);
    await expect(start.getByRole('button', { name: /^Google Jules/ })).toBeVisible();

    const off = await context.newPage();
    await serviceDown(off);
    await openBridge(off, { agent_start: false });
    await serve(off, '**/bff/bridge/tasks/1', detail(MINE));
    await serve(off, '**/bff/bridge/rails', rails());
    await serve(off, '**/bff/bridge/status/1', status());
    await off.goto('/contribute/task/1');
    await expect(off.getByRole('heading', { name: 'Open my agent' })).toBeVisible();
    await expect(off.getByRole('heading', { name: 'Start it for me' })).toHaveCount(0);
  });

  test('a key the vendor refused gets a plain sentence, nothing starts, and the key is gone', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    let sent: unknown = null;
    await page.route('**/bff/bridge/dispatch', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'credential_rejected' }) });
    });

    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    await expect(panel.getByRole('alert')).toHaveText("Google didn't accept that key. Check it and try again.");
    await expect(page.getByText('Google Jules is working on it.')).toHaveCount(0);
    await expect(panel.getByLabel('Your Jules API key')).toHaveValue('');
    await expect(page.getByText('test-only-jules-credential')).toHaveCount(0);
    // "Remember it" was left as it came, unticked, so FORGE is not asked to keep the key (review-web M2).
    expect(sent).toEqual({
      taskId: 1,
      rail: 'jules',
      credential: { key: 'test-only-jules-credential' },
    });
  });

  test('every refusal reads as a sentence, with the vendor’s status when it failed', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    const answers: Array<[number, Record<string, unknown>, string]> = [
      [502, { error: 'rail_failed', status: 503, rail: 'devin' }, "Cognition didn't answer properly (error 503). Try again in a minute."],
      [400, { error: 'rail_setup_needed', message: 'Connect GitHub in Devin first.' }, 'Connect GitHub in Devin first.'],
      [
        429,
        { error: 'dispatch_limit', limit: 10 },
        "You've started agents 10 times in the last hour, the most FORGE allows. Try again in about 10 minutes.",
      ],
      [
        400,
        { error: 'credential_invalid', field: 'orgId' },
        "That doesn't look like your Devin organization ID. Check you copied all of it and try again.",
      ],
      [403, { error: 'not_holder' }, "This task isn't yours any more, so nothing changed. Claim it again first."],
    ];
    let next = 0;
    await page.route('**/bff/bridge/dispatch', async (route) => {
      const [code, body] = answers[next] ?? answers[0] ?? [500, {}, ''];
      next += 1;
      await route.fulfill({
        status: code,
        contentType: 'application/json',
        headers: code === 429 ? { 'retry-after': '600' } : {},
        body: JSON.stringify(body),
      });
    });

    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Devin/ }).click();
    const panel = page.getByRole('region', { name: 'Start Devin' });
    for (const [, , sentence] of answers) {
      await panel.getByLabel('Your Devin API key').fill('test-only-devin-credential');
      await panel.getByLabel('Your Devin organization ID').fill('test-only-org');
      await panel.getByRole('button', { name: 'Start Devin' }).click();
      await expect(panel.getByRole('alert')).toHaveText(sentence);
    }
  });

  test('a start that worked: where to watch it, and the key saved for next time', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    let sent: unknown = null;
    await page.route('**/bff/bridge/dispatch', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'start',
          rail: 'jules',
          brief: WITH_LOGIN.brief,
          startedAt: new Date().toISOString(),
          sessionUrl: 'https://jules.google.com/session/42',
          sessionRef: 'sessions/42',
          credentialSaved: true,
        }),
      });
    });

    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByLabel('Remember it, encrypted, so next time is one click').check();
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    await expect(panel.getByText('Google Jules is working on it.')).toBeVisible();
    expect(sent).toMatchObject({ rail: 'jules', saveCredential: true });
    await expect(panel.getByRole('link', { name: /Watch it work/ })).toHaveAttribute('href', 'https://jules.google.com/session/42');
    await expect(panel.getByText('Your key is saved, encrypted, for next time.')).toBeVisible();
    await expect(panel.getByText(/Practice/)).toHaveCount(0);
    // Next time is one click.
    await expect(panel.getByRole('button', { name: 'Use a different key' })).toBeVisible();
    await expect(panel.getByLabel('Your Jules API key')).toHaveCount(0);
  });

  test('a saved key starts with one click and sends no key', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { rails: rails(['jules'], ['jules']) });
    const noted = page.waitForRequest((request: Request) => request.url().endsWith('/bff/bridge/dispatch'));
    await serve(page, '**/bff/bridge/dispatch', { error: 'credential_rejected' }, 400);

    const start = page.getByRole('group', { name: 'Start it for me' });
    await expect(start.getByRole('button', { name: /^Google Jules/ })).toContainText('key saved');
    await start.getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    expect((await noted).postDataJSON()).toEqual({ taskId: 1, rail: 'jules' });
    // A refused saved key is gone (the API deletes it), so the key field comes back.
    await expect(panel.getByRole('alert')).toHaveText(
      "Google didn't accept your saved key, so FORGE removed it. Add it again and try once more.",
    );
    await expect(panel.getByLabel('Your Jules API key')).toBeVisible();
  });

  test('pressing Start again after a start went through shows that start, and starts nothing twice', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    await serve(
      page,
      '**/bff/bridge/dispatch',
      { error: 'already_started', rail: 'jules', sessionUrl: 'https://jules.google.com/session/42' },
      409,
    );
    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();

    await expect(
      panel.getByText("Google Jules already started on this task a moment ago, so FORGE didn't start it twice."),
    ).toBeVisible();
    await expect(panel.getByRole('link', { name: /Watch it work/ })).toHaveAttribute(
      'href',
      'https://jules.google.com/session/42',
    );
    await expect(panel.getByRole('alert')).toBeEmpty();
  });

  test('a start the BFF stopped waiting on is checked before anything is said (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    let pressed = false;
    let letStatusAnswer = (): void => undefined;
    const statusMayAnswer = new Promise<void>((resolve) => {
      letStatusAnswer = () => resolve();
    });
    await holdingTaskOne(page, context, baseURL);
    await page.route('**/bff/bridge/dispatch', async (route) => {
      pressed = true;
      // The BFF's own 45 s ran out with the API still at the vendor.
      await route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_timeout' }) });
    });
    await page.unroute('**/bff/bridge/status/1');
    await page.route('**/bff/bridge/status/1', async (route) => {
      if (!pressed) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status()) });
        return;
      }
      await statusMayAnswer;
      // The API finished the start after all.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          status({
            stage: 'agent_working',
            rail: 'jules',
            sessionUrl: 'https://jules.google.com/session/9',
            events: [
              { at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' },
              { at: new Date().toISOString(), kind: 'dispatched', source: 'forge', message: 'FORGE started Google Jules.', rail: 'jules' },
            ],
          }),
        ),
      });
    });

    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();
    try {
      await expect(panel.getByText('It may have started. Checking…')).toBeVisible();
    } finally {
      letStatusAnswer();
    }
    await expect(panel.getByText('Google Jules is working on it.')).toBeVisible();
    await expect(panel.getByRole('link', { name: /Watch it work/ })).toHaveAttribute('href', 'https://jules.google.com/session/9');
    await expect(page.getByText(/nothing changed/)).toHaveCount(0);
  });

  test('the page waits longer than the BFF, and no answer at all is checked too (review-creds CR-3, review-web L7)', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    // The start never answers: neither the API nor the BFF.
    await page.route('**/bff/bridge/dispatch', () => undefined);
    await page.clock.install();
    await page.goto('/contribute/task/1');
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();

    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();
    await expect(panel.getByRole('button', { name: 'Starting…' })).toBeDisabled();

    // Past the BFF's 45 s the page is still listening, for the BFF's own answer.
    await page.clock.runFor(46_000);
    await expect(panel.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await expect(panel.getByRole('alert')).toBeEmpty();

    // Past its own limit, it checks the status rather than say nothing changed.
    await page.clock.runFor(15_000);
    await expect(panel.getByRole('alert')).toHaveText(
      "FORGE didn't hear back, and this task shows no start yet. Check “Where it is” below in a minute before you start Google Jules again.",
    );
    await expect(page.getByText(/nothing changed/)).toHaveCount(0);
  });

  test('the routine panel offers FORGE’s routine prompt once, closed', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL);
    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Claude Code routine/ }).click();
    const panel = page.getByRole('region', { name: 'Start Claude Code routine' });
    const prompt = panel.locator('details', { has: page.getByText("FORGE's routine prompt") });
    await expect(prompt).not.toHaveAttribute('open');
    await expect(panel.getByLabel("Your routine's URL")).toHaveAttribute('type', 'password');
    await expect(panel.getByLabel("Your routine's token")).toHaveAttribute('type', 'password');
    await expect(panel.getByRole('link', { name: /create a routine for your copy/ })).toHaveAttribute(
      'href',
      'https://claude.ai/code/routines',
    );
  });

  test('GitHub Copilot: a form post to FORGE, then off to GitHub to approve it once', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    // Route handlers only see the first URL of a redirect chain, so the post
    // itself is caught here and sent on without following GitHub's redirect.
    let sentTo = '';
    let form = '';
    await page.route('**/auth/github/agent', async (route) => {
      form = route.request().postData() ?? '';
      const response = await route.fetch({ maxRedirects: 0 });
      sentTo = response.headers().location ?? `status ${response.status()}`;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>On the way to GitHub</title>' });
    });
    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^GitHub Copilot/ }).click();
    const panel = page.getByRole('region', { name: 'Start GitHub Copilot' });
    await expect(panel.locator('input[type="password"]')).toHaveCount(0);
    // No GITHUB_APP_SLUG on this server: the install step is words, not a link to nowhere.
    await expect(panel.getByText("Install FORGE's GitHub app on your copy.")).toBeVisible();
    await expect(panel.getByRole('link', { name: "Install FORGE's GitHub app on your copy." })).toHaveCount(0);

    await panel.getByRole('button', { name: 'Start GitHub Copilot' }).click();
    await expect(page).toHaveTitle('On the way to GitHub');
    expect(form).toBe('taskId=1');
    const authorize = new URL(sentTo);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.e2e0000000000000');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/callback`);
    const attempt = await openTransaction((await agentTransaction(context))?.value, [SESSION_SECRET]);
    expect(attempt).toMatchObject({ purpose: 'agent', taskId: 1, rail: 'copilot' });
  });
});

test.describe('the outcome the Copilot callback sends back', () => {
  /** The status after a real Copilot start: FORGE's own `dispatched` line, `minutesAgo` old. */
  const copilotStarted = (minutesAgo: number) =>
    status({
      stage: 'agent_working',
      rail: 'copilot',
      events: [
        { at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' },
        {
          at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          kind: 'dispatched',
          source: 'forge',
          message: 'FORGE started GitHub Copilot.',
          rail: 'copilot',
        },
      ],
    });

  test('?started=copilot is said once, and the address bar drops it', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?started=copilot', status: copilotStarted(1) });
    await expect(page.getByText('GitHub Copilot is working on it.')).toBeVisible();
    await expect(page).toHaveURL(/\/contribute\/task\/1$/);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
    await expect(page.getByText('GitHub Copilot is working on it.')).toHaveCount(0);
  });

  test('a ?started=copilot the status doesn’t back up is ignored (review-web L2)', async ({ page, context, baseURL }) => {
    // Anyone can link here with ?started=copilot; this task has no Copilot start at all...
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?started=copilot' });
    await expect(page.getByRole('region', { name: 'Where it is' }).getByText('FORGE: You claimed this task.')).toBeVisible();
    await expect(page.getByText('GitHub Copilot is working on it.')).toHaveCount(0);

    // ...and one from half an hour ago is not this one either.
    const stale = await context.newPage();
    await serviceDown(stale);
    await openBridge(stale);
    await serve(stale, '**/bff/bridge/tasks/1', detail(MINE));
    await serve(stale, '**/bff/bridge/rails', rails());
    await serve(stale, '**/bff/bridge/status/1', copilotStarted(30));
    await stale.goto('/contribute/task/1?started=copilot');
    await expect(stale.getByRole('region', { name: 'Where it is' }).getByText('FORGE: FORGE started GitHub Copilot.')).toBeVisible();
    await expect(stale.getByText('GitHub Copilot is working on it.')).toHaveCount(0);
  });

  test('a Copilot setup failure brings the Copilot setup steps with it (review-web L2)', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?start_error=rail_setup_needed' });
    const outcome = page.getByRole('alert').filter({ hasText: 'GitHub Copilot' });
    await expect(outcome.getByText("GitHub Copilot isn't connected to your copy yet. Finish the setup steps below, then try again.")).toBeVisible();
    await expect(outcome.getByRole('link', { name: COPY_STEP })).toHaveAttribute('href', '#copy-title');
    await expect(outcome.getByText("Install FORGE's GitHub app on your copy.")).toBeVisible();
  });

  test('?start_error= reads as a sentence, and nothing in the query string is shown as text', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL, { path: '/contribute/task/1?start_error=rail_failed&status=503' });
    await expect(page.getByRole('alert').filter({ hasText: 'GitHub' })).toHaveText(
      "GitHub didn't answer properly (error 503). Try again in a minute.",
    );

    await page.goto('/contribute/task/1?start_error=%3Cb%3Eyour+account+is+locked%3C%2Fb%3E');
    await expect(page.getByText("That didn't work, and nothing was started. Please try again.")).toBeVisible();
    await expect(page.getByText(/account is locked/)).toHaveCount(0);
  });
});

test.describe('after the hand-off', () => {
  test('the progress view: stage, links, and an agent’s words as plain text only', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, {
      status: status({
        stage: 'agent_working',
        detail: 'Your agent is working on it.',
        rail: 'jules',
        sessionUrl: 'https://jules.google.com/session/42',
        compareUrl: 'https://github.com/verastd/forge-app/compare/main...octo-contributor:task/1-polish',
        events: [
          { at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' },
          { at: inHours(-0.5), kind: 'dispatched', source: 'forge', message: 'FORGE started Google Jules.', rail: 'jules' },
          {
            at: inHours(-0.1),
            kind: 'progress',
            source: 'agent',
            stage: 'pushed',
            message: 'Pushed the fix <img src=x onerror="window.__forgeInjected=1"> \u202Eevil\u0007',
          },
        ],
      }),
    });
    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(progress.getByText('Your agent is working on it.')).toBeVisible();
    await expect(progress.getByRole('link', { name: 'Watch it work' })).toHaveAttribute(
      'href',
      'https://jules.google.com/session/42',
    );
    await expect(
      progress.getByRole('link', { name: 'When your agent has pushed its branch: open the pull request' }),
    ).toHaveAttribute('href', 'https://github.com/verastd/forge-app/compare/main...octo-contributor:task/1-polish');
    const agentLine = progress.getByRole('listitem').filter({ hasText: 'Pushed the fix' });
    await expect(agentLine).toContainText('Your agent: Pushed the fix <img src=x onerror="window.__forgeInjected=1"> evil');
    expect(await agentLine.textContent()).not.toMatch(/[\u202E\u0007]/);
    await expect(progress.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __forgeInjected?: number }).__forgeInjected)).toBeUndefined();
  });

  test('links that are not plain https are not links', async ({ page, context, baseURL }) => {
    for (const sessionUrl of [
      'javascript:alert(1)',
      // httpx reads the host as jules.google.com; a browser goes to evil.example (review-creds CR-2).
      'https://evil.example\\@jules.google.com/session/1',
      // Another vendor's site is not where this rail's session lives.
      'https://cursor.com/agents/bc-1',
    ]) {
      const view = await context.newPage();
      await holdingTaskOne(view, context, baseURL, {
        status: status({
          stage: 'agent_working',
          detail: 'Google Jules is working on it.',
          rail: 'jules',
          sessionUrl,
          compareUrl: 'https://evil.example/verastd/forge-app/compare',
          events: [
            { at: inHours(-1), kind: 'claimed', source: 'forge', message: 'You claimed this task.' },
            { at: inHours(-0.5), kind: 'dispatched', source: 'forge', message: 'FORGE started Google Jules.', rail: 'jules' },
          ],
        }),
      });
      const progress = view.getByRole('region', { name: 'Where it is' });
      await expect(progress.getByText('Google Jules is working on it.')).toBeVisible();
      await expect(progress.getByRole('link'), sessionUrl).toHaveCount(0);
      await view.close();
    }
  });

  test('the compare link waits until the task has gone to an agent (review-web L3)', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL, {
      status: status({
        compareUrl: 'https://github.com/verastd/forge-app/compare/main...octo-contributor:task/1-polish',
      }),
    });
    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(progress.getByText('FORGE: You claimed this task.')).toBeVisible();
    // Right after the claim there is no branch to compare yet.
    await expect(progress.getByRole('link', { name: /open the pull request/i })).toHaveCount(0);
  });

  test('a session link from the API passes the same check after a start (review-creds CR-2)', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    await serve(page, '**/bff/bridge/dispatch', {
      mode: 'start',
      rail: 'jules',
      brief: WITH_LOGIN.brief,
      startedAt: new Date().toISOString(),
      sessionUrl: 'https://evil.example\\@jules.google.com/session/42',
    });
    await page.getByRole('group', { name: 'Start it for me' }).getByRole('button', { name: /^Google Jules/ }).click();
    const panel = page.getByRole('region', { name: 'Start Google Jules' });
    await panel.getByLabel('Your Jules API key').fill('test-only-jules-credential');
    await panel.getByRole('button', { name: 'Start Google Jules' }).click();
    await expect(panel.getByText('Google Jules is working on it.')).toBeVisible();
    await expect(panel.getByRole('link', { name: /Watch it work/ })).toHaveCount(0);
  });

  test('failing checks after a start rail: send the notes to it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/checks/1', {
      taskId: 1,
      state: 'failed',
      checks: [
        { name: 'Lint', status: 'completed', conclusion: 'success' },
        {
          name: 'Acceptance tests',
          status: 'completed',
          conclusion: 'failure',
          summary: 'test_csv_export failed',
          url: 'https://github.com/verastd/forge-app/runs/1',
        },
      ],
      notes: 'Acceptance tests failed: test_csv_export. Fix it in task/1-polish and push again.',
      prUrl: 'https://github.com/verastd/forge-app/pull/31',
    });
    let notesSent = 0;
    await page.route('**/bff/bridge/feedback/1', async (route) => {
      notesSent += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ relayed: true, notes: 'Acceptance tests failed.', relayedTo: 'jules' }),
      });
    });
    await holdingTaskOneAfterSetup(page, status({
      stage: 'in_checks',
      detail: '1 of 2 checks passed.',
      rail: 'jules',
      prUrl: 'https://github.com/verastd/forge-app/pull/31',
      checksPassed: 1,
      checksTotal: 2,
      // The API says a relay would really happen: the saved key that started Jules is still there.
      canRelay: true,
    }));

    const progress = page.getByRole('region', { name: 'Where it is' });
    await expect(progress.getByText('1 of 2 checks failed.')).toBeVisible();
    await expect(progress.getByRole('link', { name: 'Your pull request on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app/pull/31',
    );
    // A pull request exists, so no compare link any more, and nothing to hand in.
    await expect(progress.getByRole('link', { name: /open the pull request/i })).toHaveCount(0);
    await expect(progress.getByText("Opened a pull request FORGE can't see?")).toHaveCount(0);
    await progress.getByRole('button', { name: 'Send the notes to Google Jules' }).click();
    await expect(progress.getByText('Sent to Google Jules. It takes another pass from here.')).toBeVisible();
    expect(notesSent).toBe(1);
    const copy = progress.locator('details', { has: page.getByText('Using another agent? Copy the notes') });
    await expect(copy).not.toHaveAttribute('open');
  });

  for (const rail of ['claude-code', 'copilot']) {
    test(`failing checks after ${rail}: no relay to offer, the connector reads them`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signInAs(context, baseURL ?? '', IDENTITY);
      await serviceDown(page);
      await openBridge(page);
      await serve(page, '**/bff/bridge/checks/1', {
        taskId: 1,
        state: 'failed',
        checks: [{ name: 'Acceptance tests', status: 'completed', conclusion: 'failure' }],
        notes: 'Acceptance tests failed.',
      });
      await holdingTaskOneAfterSetup(page, status({ stage: 'in_checks', rail, prUrl: 'https://github.com/verastd/forge-app/pull/32' }));

      const progress = page.getByRole('region', { name: 'Where it is' });
      await expect(progress.getByText('If your agent has the FORGE connector, it can read these itself.')).toBeVisible();
      await expect(progress.getByRole('button', { name: /Send the notes/ })).toHaveCount(0);
      const copy = progress.locator('details', { has: page.getByText('Using another agent? Copy the notes') });
      await expect(copy).not.toHaveAttribute('open');
    });
  }

  /** Signed in, holding task 1 after a Jules start, with its checks failing; `feedback` answers the relay. */
  async function failedAfterJules(
    page: Page,
    context: BrowserContext,
    baseURL: string | undefined,
    statusExtra: Record<string, unknown>,
    feedback?: (route: Route) => Promise<void>,
  ): Promise<Locator> {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/checks/1', {
      taskId: 1,
      state: 'failed',
      checks: [{ name: 'Acceptance tests', status: 'completed', conclusion: 'failure' }],
      notes: 'Acceptance tests failed.',
      prUrl: 'https://github.com/verastd/forge-app/pull/33',
    });
    if (feedback !== undefined) await page.route('**/bff/bridge/feedback/1', feedback);
    await holdingTaskOneAfterSetup(
      page,
      status({ stage: 'in_checks', rail: 'jules', prUrl: 'https://github.com/verastd/forge-app/pull/33', ...statusExtra }),
    );
    return page.getByRole('region', { name: 'Where it is' });
  }

  test('no "Send the notes" unless the API says the relay would happen (review-web M8)', async ({
    page,
    context,
    baseURL,
  }) => {
    // After Jules, but the saved key is gone, or a different one started it: no canRelay.
    const progress = await failedAfterJules(page, context, baseURL, {});
    await expect(progress.getByText('1 of 1 checks failed.')).toBeVisible();
    await expect(progress.getByText('If your agent has the FORGE connector, it can read these itself.')).toBeVisible();
    await expect(progress.getByRole('button', { name: /Send the notes/ })).toHaveCount(0);
  });

  test('a relay that didn’t happen says why, never "only with a key you saved" (review-web M8)', async ({
    page,
    context,
    baseURL,
  }) => {
    const answers: Array<[number, unknown, Record<string, string>]> = [
      [200, { relayed: false, notes: 'Acceptance tests failed.' }, {}],
      [429, { error: 'dispatch_limit', limit: 10 }, { 'retry-after': '1200' }],
      [502, { error: 'rail_failed', status: 503 }, {}],
    ];
    let next = 0;
    const progress = await failedAfterJules(page, context, baseURL, { canRelay: true }, async (route) => {
      const [code, body, headers] = answers[next] ?? [500, {}, {}];
      next += 1;
      await route.fulfill({ status: code, contentType: 'application/json', headers, body: JSON.stringify(body) });
    });
    const send = progress.getByRole('button', { name: 'Send the notes to Google Jules' });

    await send.click();
    await expect(
      progress.getByText(
        "Nothing was sent: Google Jules didn't take the notes just now. Try again in a few minutes. If your agent has the FORGE connector, it can read these itself.",
      ),
    ).toBeVisible();
    await send.click();
    await expect(progress.getByRole('alert')).toHaveText(
      'FORGE has called agents for you 10 times in the last hour, the most it allows, so nothing was sent. Try again in about 20 minutes.',
    );
    await send.click();
    await expect(progress.getByRole('alert')).toHaveText(
      "Google didn't take the notes (error 503), so nothing was sent. Try again in a minute.",
    );
    await expect(progress.getByText(/only with a key you saved/)).toHaveCount(0);
    expect(next).toBe(3);
  });

  test('a relay with no answer checks before it says anything (review-creds CR-3)', async ({ page, context, baseURL }) => {
    let relayed = false;
    const progress = await failedAfterJules(page, context, baseURL, { canRelay: true }, async (route) => {
      relayed = true;
      // The BFF waited its 45 s and the API never answered: it may have sent them.
      await route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_timeout' }) });
    });
    // The status the page reads next shows the relay went through after all.
    await page.unroute('**/bff/bridge/status/1');
    await page.route('**/bff/bridge/status/1', async (route) => {
      const events = relayed
        ? [{ at: new Date().toISOString(), kind: 'relayed', source: 'forge', message: 'Sent the check notes to Google Jules.', rail: 'jules' }]
        : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          status({ stage: 'in_checks', rail: 'jules', prUrl: 'https://github.com/verastd/forge-app/pull/33', canRelay: true, events }),
        ),
      });
    });
    await progress.getByRole('button', { name: 'Send the notes to Google Jules' }).click();
    await expect(progress.getByText('Sent to Google Jules. It takes another pass from here.')).toBeVisible();
    await expect(progress.getByText(/nothing changed|nothing was sent/)).toHaveCount(0);
  });

  test('a pull request FORGE can’t see can be handed in by its link (review-web M5)', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    const answers: Array<[number, unknown, Record<string, string>, string]> = [
      [400, { error: 'pr_not_for_task' }, {}, "That pull request isn't for this task."],
      [400, { error: 'invalid_pr_url' }, {}, "That isn't a link to a pull request on verastd/forge-app."],
      [404, { error: 'pr_not_found', prNumber: 78 }, {}, 'GitHub has no pull request at that link.'],
      [403, { error: 'not_your_pr', prNumber: 78 }, {}, "That pull request comes from someone else's copy, not yours."],
      [429, { error: 'submit_limit' }, { 'retry-after': '30' }, "You've handed in links too often just now. Try again in about 1 minute."],
    ];
    const sent: unknown[] = [];
    await page.route('**/bff/bridge/submit/1', async (route) => {
      sent.push(route.request().postDataJSON());
      const answer = answers[sent.length - 1];
      if (answer !== undefined) {
        const [code, body, headers] = answer;
        await route.fulfill({ status: code, contentType: 'application/json', headers, body: JSON.stringify(body) });
        return;
      }
      await page.unroute('**/bff/bridge/status/1');
      await serve(page, '**/bff/bridge/status/1', status({ stage: 'in_checks', prUrl: 'https://github.com/verastd/forge-app/pull/78' }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status({ stage: 'in_checks', prUrl: 'https://github.com/verastd/forge-app/pull/78' })),
      });
    });

    const progress = page.getByRole('region', { name: 'Where it is' });
    const handIn = progress.locator('details', { has: page.getByText("Opened a pull request FORGE can't see?") });
    await expect(handIn).not.toHaveAttribute('open');
    await handIn.getByText("Opened a pull request FORGE can't see?").click();
    const link = handIn.getByLabel("Your pull request's link");
    for (const [, , , sentence] of answers) {
      await link.fill('https://github.com/verastd/forge-app/pull/78');
      await handIn.getByRole('button', { name: 'Hand it in' }).click();
      await expect(handIn.getByRole('alert')).toContainText(sentence);
    }
    await link.fill('https://github.com/verastd/forge-app/pull/78');
    await handIn.getByRole('button', { name: 'Hand it in' }).click();
    await expect(progress.getByRole('link', { name: 'Your pull request on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app/pull/78',
    );
    expect(sent.at(-1)).toEqual({ prUrl: 'https://github.com/verastd/forge-app/pull/78' });
    expect(sent).toHaveLength(answers.length + 1);
  });

  test('a status with no holder means it is not yours any more', async ({ page, context, baseURL }) => {
    // The page asks for the status as soon as it shows the task as yours, so
    // an answer that comes back at once can take the lease away before that
    // view has painted. Hold the answer until the view is up.
    let answerStatus = (): void => undefined;
    const statusMayAnswer = new Promise<void>((resolve) => {
      answerStatus = () => resolve();
    });
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
    await serve(page, '**/bff/bridge/rails', rails());
    await page.route('**/bff/bridge/status/1', async (route) => {
      await statusMayAnswer;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status({ holder: undefined, leaseEndsAt: undefined, detail: 'This task was let go.' })),
      });
    });
    try {
      await page.goto('/contribute/task/1');
      await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
    } finally {
      answerStatus();
    }

    await expect(page.getByText("This task isn't yours any more: it was released, or its time ran out.", { exact: false })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Where it is' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
  });

  test('releasing asks first, then the task is back on the board', async ({ page, context, baseURL }) => {
    await holdingTaskOne(page, context, baseURL);
    let released = 0;
    await page.route('**/bff/bridge/release/1', async (route) => {
      released += 1;
      await page.unroute('**/bff/bridge/tasks/1');
      await serve(page, '**/bff/bridge/tasks/1', detail());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status({ events: [], holder: undefined, leaseEndsAt: undefined, detail: 'Nobody holds it.' })),
      });
    });

    await page.getByRole('button', { name: 'Release this task' }).click();
    await page.getByRole('button', { name: 'Yes, release it' }).click();
    await expect(page.getByRole('status')).toContainText('Released. The task is back on the board.');
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
    expect(released).toBe(1);
  });
});

test.describe('no answer to a claim, a release or a pull request handed in', () => {
  const MAY_HAVE = "FORGE didn't hear back in time, so it may have gone through. Reload the page to see where things stand.";

  test('a claim the BFF stopped waiting on reads the task again, and finds it yours (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    await page.route('**/bff/bridge/claim', async (route) => {
      // The API made the claim; the BFF's own 25 s ran out before it said so.
      await page.unroute('**/bff/bridge/tasks/1');
      await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
      await route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_timeout' }) });
    });
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByText(MAY_HAVE)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
    await expect(page.getByText(/yours for \d+h/)).toBeVisible();
  });

  test('a claim answered by the host’s own 502 page reads the task again, and finds it yours (review-pages L1)', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail());
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    await page.route('**/bff/bridge/claim', async (route) => {
      // The API made the claim; the host answered for the BFF with its own error page.
      await page.unroute('**/bff/bridge/tasks/1');
      await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
    });
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();

    await expect(page.getByText(MAY_HAVE)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
    await expect(page.getByText(/nothing (was )?changed/)).toHaveCount(0);
  });

  test('a claim with no answer at all: the page waits past the BFF, then reads the task again (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    let taskReads = 0;
    await page.route('**/bff/bridge/tasks/1', async (route) => {
      taskReads += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail()) });
    });
    // The claim never answers: neither the API nor the BFF.
    await page.route('**/bff/bridge/claim', () => undefined);
    await page.clock.install();
    await page.goto('/contribute/task/1');
    await page.getByRole('button', { name: 'Claim this' }).click();
    await expect(page.getByRole('button', { name: 'Claiming…' })).toBeDisabled();
    const readsBefore = taskReads;

    // Past the browser's usual 8 s, and short of the BFF's 25 s: still listening.
    await page.clock.runFor(9_000);
    await expect(page.getByRole('button', { name: 'Claiming…' })).toBeDisabled();
    // Past its own 30 s: the claim may have gone through, so the task is read again.
    await page.clock.runFor(22_000);
    await expect(page.getByText(MAY_HAVE)).toBeVisible();
    await expect.poll(() => taskReads).toBeGreaterThan(readsBefore);
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
    await expect(page.getByText(/nothing (was )?changed/)).toHaveCount(0);
  });

  test('a release with no answer reads the status again, and finds it released (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    await holdingTaskOne(page, context, baseURL);
    let released = false;
    await page.unroute('**/bff/bridge/status/1');
    await page.route('**/bff/bridge/status/1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          released ? status({ events: [], holder: undefined, leaseEndsAt: undefined, detail: 'Nobody holds it.' }) : status(),
        ),
      }),
    );
    await page.route('**/bff/bridge/release/1', async (route) => {
      // The API let it go; the answer was lost on the way back.
      released = true;
      await route.abort();
    });

    await page.getByRole('button', { name: 'Release this task' }).click();
    await page.getByRole('button', { name: 'Yes, release it' }).click();
    await expect(page.getByText(MAY_HAVE)).toBeVisible();
    await expect(
      page.getByText("This task isn't yours any more: it was released, or its time ran out.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim this' })).toBeEnabled();
  });

  test('a pull request handed in with no answer reads the status again, and shows it if FORGE has it (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    let submitted = false;
    let letStatusAnswer = (): void => undefined;
    const statusMayAnswer = new Promise<void>((resolve) => {
      letStatusAnswer = () => resolve();
    });
    await holdingTaskOne(page, context, baseURL);
    await page.unroute('**/bff/bridge/status/1');
    await page.route('**/bff/bridge/status/1', async (route) => {
      if (submitted) {
        // Held until the page has said what it knows, so that can be read first.
        await statusMayAnswer;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          submitted ? status({ stage: 'in_checks', prUrl: 'https://github.com/verastd/forge-app/pull/78' }) : status(),
        ),
      });
    });
    await page.route('**/bff/bridge/submit/1', async (route) => {
      // FORGE took the pull request; the answer was lost on the way back.
      submitted = true;
      await route.abort();
    });

    const progress = page.getByRole('region', { name: 'Where it is' });
    const handIn = progress.locator('details', { has: page.getByText("Opened a pull request FORGE can't see?") });
    await handIn.getByText("Opened a pull request FORGE can't see?").click();
    await handIn.getByLabel("Your pull request's link").fill('https://github.com/verastd/forge-app/pull/78');
    await handIn.getByRole('button', { name: 'Hand it in' }).click();
    try {
      await expect(handIn.getByRole('alert')).toHaveText(MAY_HAVE);
    } finally {
      letStatusAnswer();
    }
    await expect(progress.getByRole('link', { name: 'Your pull request on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/verastd/forge-app/pull/78',
    );
  });

  test('releasing and handing in wait past the BFF too, then say it may have gone through (review-creds CR-3)', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await openBridge(page);
    await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
    await serve(page, '**/bff/bridge/rails', rails());
    await serve(page, '**/bff/bridge/status/1', status());
    // Neither answers: not the API, not the BFF.
    await page.route('**/bff/bridge/release/1', () => undefined);
    await page.route('**/bff/bridge/submit/1', () => undefined);
    await page.clock.install();
    await page.goto('/contribute/task/1');
    await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Release this task' }).click();
    await page.getByRole('button', { name: 'Yes, release it' }).click();
    await page.clock.runFor(9_000);
    await expect(page.getByRole('button', { name: 'Releasing…' })).toBeDisabled();
    await page.clock.runFor(22_000);
    await expect(page.getByText(MAY_HAVE)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes, release it' })).toBeEnabled();

    const progress = page.getByRole('region', { name: 'Where it is' });
    const handIn = progress.locator('details', { has: page.getByText("Opened a pull request FORGE can't see?") });
    await handIn.getByText("Opened a pull request FORGE can't see?").click();
    await handIn.getByLabel("Your pull request's link").fill('https://github.com/verastd/forge-app/pull/78');
    await handIn.getByRole('button', { name: 'Hand it in' }).click();
    await page.clock.runFor(9_000);
    await expect(handIn.getByRole('button', { name: 'Handing it in…' })).toBeDisabled();
    await page.clock.runFor(22_000);
    await expect(handIn.getByRole('alert')).toHaveText(MAY_HAVE);
    await expect(page.getByText(/nothing (was )?changed/)).toHaveCount(0);
  });
});

/** The rest of {@link holdingTaskOne}, for tests that registered their own routes first. */
async function holdingTaskOneAfterSetup(page: Page, statusBody: unknown): Promise<void> {
  await serve(page, '**/bff/bridge/tasks/1', detail(MINE));
  await serve(page, '**/bff/bridge/rails', rails());
  await serve(page, '**/bff/bridge/status/1', statusBody);
  await page.goto('/contribute/task/1');
  await expect(page.getByRole('heading', { name: 'Your agent', exact: true })).toBeVisible();
}

test.describe('/me: your agent keys and connected agents', () => {
  test('lists them with only a hint of each key, and removes and disconnects', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await serve(page, '**/bff/bridge/profile', {
      login: LOGIN,
      tier: 'T0',
      merged: 0,
      survivalRate: 1,
      pendingRewards: [],
      ledger: [],
    });
    await page.route('**/bff/bridge/me/keys', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          credentials: [{ rail: 'jules', hint: '…a1b2', savedAt: '2026-09-30T10:00:00Z', lastUsedAt: '2026-10-01T09:00:00Z' }],
          vault: true,
        }),
      }),
    );
    await page.route('**/bff/bridge/me/keys/jules', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ credentials: [], vault: true }) }),
    );
    await page.route('**/bff/oauth/grants', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            {
              id: 'grant_1',
              clientName: 'Claude \u202Eevil',
              redirectHost: 'claude.ai',
              connectedAt: '2026-09-29T10:00:00Z',
            },
          ],
        }),
      }),
    );
    await page.route('**/bff/oauth/grants/grant_1', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) }),
    );
    await page.goto('/me');

    const keys = page.getByRole('region', { name: 'Your agent keys' });
    await expect(keys.getByText('Google Jules')).toBeVisible();
    await expect(keys.getByText(/Key ending …a1b2 · saved/)).toBeVisible();
    await expect(keys.getByText(/can't use saved keys/)).toHaveCount(0);
    await keys.getByRole('button', { name: 'Remove your Google Jules key' }).click();
    await expect(keys.getByText('Removed your Google Jules key. FORGE no longer has it.')).toBeVisible();
    await expect(keys.getByText(/No saved keys/)).toBeVisible();

    const agents = page.getByRole('region', { name: 'Connected agents' });
    await expect(agents.getByText('Claude evil')).toBeVisible();
    await expect(agents.getByText(/Sends you back to claude\.ai · connected/)).toBeVisible();
    await agents.getByRole('button', { name: 'Disconnect Claude evil' }).click();
    await expect(agents.getByText('Disconnected Claude evil. It can no longer reach FORGE as you.')).toBeVisible();
    await expect(agents.getByRole('link', { name: 'Connect your agent to FORGE' })).toHaveAttribute('href', '/connect');
  });

  test('with the vault off, saved keys are still listed, with a word that FORGE can’t use them', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await serviceDown(page);
    await serve(page, '**/bff/bridge/me/keys', {
      credentials: [{ rail: 'jules', hint: '…a1b2', savedAt: '2026-09-30T10:00:00Z' }],
      vault: false,
    });
    await serve(page, '**/bff/bridge/me/keys/jules', { credentials: [], vault: false });
    await serve(page, '**/bff/oauth/grants', { agents: [] });
    await page.goto('/me');

    const keys = page.getByRole('region', { name: 'Your agent keys' });
    await expect(keys.getByText("FORGE can't use saved keys right now; you can still remove them.")).toBeVisible();
    await expect(keys.getByText(/Key ending …a1b2 · saved .* · not used yet/)).toBeVisible();
    await keys.getByRole('button', { name: 'Remove your Google Jules key' }).click();
    await expect(keys.getByText('Removed your Google Jules key. FORGE no longer has it.')).toBeVisible();
    await expect(keys.getByText(/This FORGE server doesn't save keys/)).toBeVisible();
    await expect(keys.getByText(/can't use saved keys/)).toHaveCount(0);
  });

  for (const [code, httpStatus] of [
    ['connector-disabled', 404],
    ['connector_unavailable', 503],
  ] as const) {
    test(`"Connected agents" is not shown while the connector is off (${code})`, async ({ page, context, baseURL }) => {
      await signInAs(context, baseURL ?? '', IDENTITY);
      await serviceDown(page);
      await serve(page, '**/bff/bridge/me/keys', { credentials: [], vault: false });
      await serve(page, '**/bff/oauth/grants', { error: code }, httpStatus);
      await page.goto('/me');

      const keys = page.getByRole('region', { name: 'Your agent keys' });
      await expect(keys.getByText(/This FORGE server doesn't save keys/)).toBeVisible();
      await expect(page.getByRole('region', { name: 'Connected agents' })).toHaveCount(0);
      await expect(page.getByText(/can't show your connected agents/)).toHaveCount(0);
    });
  }

  test('with the API down, both sections say so and offer to try again', async ({ page, context, baseURL }) => {
    // Unmocked BFF: it really forwards, to a closed port, and answers 502.
    await signInAs(context, baseURL ?? '', IDENTITY);
    await page.goto('/me');
    await expect(page.getByRole('region', { name: 'Your agent keys' }).getByText(/can't show your agent keys/)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Connected agents' }).getByText(/can't show your connected agents/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  });
});

/** POST /auth/github/agent as the task page's form does, from this origin unless told otherwise. */
function startCopilot(request: APIRequestContext, baseURL: string, taskId = '1', origin: string | null = baseURL) {
  return request.post('/auth/github/agent', {
    form: { taskId },
    headers: origin === null ? {} : { origin },
    maxRedirects: 0,
  });
}

async function agentTransaction(context: BrowserContext): Promise<{ value: string } | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === 'forge_oauth');
}

test.describe('POST /auth/github/agent: GitHub’s one-time approval to start Copilot', () => {
  test('refuses a post from another site, and one without an Origin', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const foreign = await startCopilot(context.request, baseURL ?? '', '1', 'https://evil.example');
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'bad_origin' });
    expect((await startCopilot(context.request, baseURL ?? '', '1', null)).status()).toBe(403);
    expect(await agentTransaction(context)).toBeUndefined();
  });

  test('a same-origin fetch without Origin passes on Sec-Fetch-Site alone', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const response = await context.request.post('/auth/github/agent', {
      form: { taskId: '1' },
      headers: { 'sec-fetch-site': 'same-origin' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
  });

  test('signed out, it goes to sign-in and back to the task, and starts nothing', async ({ request, baseURL }) => {
    const response = await startCopilot(request, baseURL ?? '');
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?next=%2Fcontribute%2Ftask%2F1');
    const { cookies } = await request.storageState();
    expect(cookies.find((cookie) => cookie.name === 'forge_oauth')).toBeUndefined();
  });

  test('a practice cookie is nobody on this build, so it goes to sign-in too', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await startCopilot(context.request, baseURL ?? '');
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/signin?next=%2Fcontribute%2Ftask%2F1');
  });

  test('a task id that is not a task number is a 400', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    for (const taskId of ['0', 'one', '1/../2', '12345678901']) {
      expect((await startCopilot(context.request, baseURL ?? '', taskId)).status(), taskId).toBe(400);
    }
  });

  test('signed in: off to GitHub with PKCE, holding an agent attempt for this task', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const response = await startCopilot(context.request, baseURL ?? '');
    expect(response.status()).toBe(303);
    const location = new URL(response.headers().location ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.e2e0000000000000');
    expect(location.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/callback`);
    expect(location.searchParams.get('code_challenge') ?? '').toHaveLength(43);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.has('scope')).toBe(false);

    const sealed = await agentTransaction(context);
    expect(sealed).toBeDefined();
    const attempt = await openTransaction(sealed?.value, [SESSION_SECRET]);
    expect(attempt).toMatchObject({
      purpose: 'agent',
      taskId: 1,
      rail: 'copilot',
      next: '/contribute/task/1',
      state: location.searchParams.get('state'),
    });
  });

  test('the callback sends an agent attempt back to its task: GitHub said no', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const start = await startCopilot(context.request, baseURL ?? '');
    const state = new URL(start.headers().location ?? '').searchParams.get('state') ?? '';

    const denied = await context.request.get(`/auth/callback?state=${state}&error=access_denied`, { maxRedirects: 0 });
    expect(denied.status()).toBe(303);
    expect(denied.headers().location).toBe('/contribute/task/1?start_error=github_denied');
    // One attempt, one use.
    const left = await agentTransaction(context);
    expect(left === undefined || left.value === '').toBe(true);
  });

  test('the callback sends an agent attempt back to its task: the state did not match', async ({
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    await startCopilot(context.request, baseURL ?? '');
    const response = await context.request.get('/auth/callback?state=definitely-not-it&code=x', { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/contribute/task/1?start_error=github_failed');
  });
});

test.describe('the Bridge BFF on the live build', () => {
  test('a practice cookie is nobody here: 401, not a forwarded request', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await context.request.post('/bff/bridge/claim', {
      data: { taskId: 1 },
      headers: { origin: baseURL ?? '' },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a real session gets forwarded, to an API that is not there: 502', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', IDENTITY);
    const response = await context.request.post('/bff/bridge/claim', {
      data: { taskId: 1 },
      headers: { origin: baseURL ?? '' },
    });
    expect(response.status()).toBe(502);
    expect(await response.json()).toEqual({ error: 'service_unreachable' });
  });
});
