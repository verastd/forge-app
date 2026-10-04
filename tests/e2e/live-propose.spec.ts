import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { PROPOSAL_ERROR_CODES, describeProposalError, didNotGoThrough } from '../../apps/web/src/lib/proposals-format';
import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * The Propose screens on the build we deploy (project `chromium-live`), with
 * the API deliberately down and the browser's calls answered by `page.route`:
 * the API itself for the public reads, and the BFF (`/bff/proposals*`,
 * `/bff/notifications*`) for what needs to know who is asking. Each action
 * must send exactly the body the contract names, each refusal must come back
 * as its own plain sentence, the admin panel must follow `you.isAdmin` and
 * nothing else, the draft task must be checked before it goes, and the bell
 * must count, link only within the site, and mark read.
 *
 * The F5b sections prove the fixes for the Phase 5 pages review
 * (review-pages.md, M1–M6 and L1–L6) and the web side of the rules review's
 * API changes (F5-decisions.md): each turns a reviewer's probe around.
 *
 * What the BFF itself forwards (the assertion, no cookies, the practice
 * account refused) is in proposals-bff.spec.ts, on the demo server, whose
 * API port a stand-in can hold; this server's API URL points at a port
 * nothing may listen on.
 */

const MEMBER = { sub: '5200001', login: 'octo-member' };
const ADMIN = { sub: '5200002', login: 'octo-admin' };

const at = (hours: number): string => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const inSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

type Json = Record<string, unknown>;

const YOU = {
  canEdit: false,
  canWithdraw: false,
  canSecond: false,
  canConsent: false,
  canComment: false,
  canVote: false,
  isAdmin: false,
};

function card(overrides: Json = {}): Json {
  return {
    id: 7,
    title: 'Show my properties on a map',
    state: 'debate',
    mover: 'maya',
    movedAt: at(-30),
    seconder: 'jo',
    deadline: at(50),
    commentCount: 1,
    objectionCount: 0,
    ...overrides,
  };
}

/** GET /api/proposals/7 as the API would answer it, with `you` for an identified caller unless `you` is null. */
function detail(
  options: { proposal?: Json; you?: Json | null; comments?: Json[]; extra?: Json } = {},
): Json {
  return {
    proposal: card(options.proposal),
    pitch: 'A map with a pin for each property.\n\nPins, a tap to see the row, and the same filters.',
    eligibleCount: 5,
    consentCount: 2,
    comments: options.comments ?? [{ id: 1, author: 'jo', text: 'Seconded so we can talk it through.', at: at(-20) }],
    events: [
      { at: at(-30), kind: 'moved', actor: 'maya', message: 'maya brought this proposal. It needs a second from another member.' },
      { at: at(-22), kind: 'seconded', actor: 'jo', message: 'jo seconded it, so debate is open.' },
    ],
    revision: 1,
    ...(options.you === null ? {} : { you: { ...YOU, ...options.you } }),
    ...options.extra,
  };
}

/** What the API answers anyone (no identity): the same proposal, without `you` or the draft task. */
function publicOf(body: Json): Json {
  const { you: _you, draft: _draft, ...rest } = body;
  return rest;
}

interface Sent {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

/** Everything the browser would send to the API or the BFF fails, unless a test answers it below. */
async function serviceDown(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort());
  await page.route('**/bff/**', (route) => route.abort());
}

/** Later routes win, so these go after {@link serviceDown}. Records what was sent. */
async function answer(
  page: Page,
  pattern: string | ((url: URL) => boolean),
  reply: (sent: Sent, count: number) => Reply,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route(pattern, async (route: Route) => {
    const request = route.request();
    const raw = request.postData();
    const url = new URL(request.url());
    const entry = { method: request.method(), path: url.pathname, query: url.search, body: raw === null ? undefined : (JSON.parse(raw) as unknown) };
    sent.push(entry);
    const { status = 200, body = {}, headers = {}, delayMs = 0 } = reply(entry, sent.length);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) }).catch(() => undefined);
  });
  return sent;
}

function serve(page: Page, pattern: string | ((url: URL) => boolean), body: unknown, status = 200): Promise<Sent[]> {
  return answer(page, pattern, () => ({ status, body }));
}

async function openProposals(page: Page, flags: Json = {}): Promise<void> {
  await serve(page, '**/api/flags', { proposals: true, github_signin: true, contribute_bridge: true, ...flags });
}

/**
 * Signed in as `who`, on proposal 7's page: read in public first (the API),
 * then through the BFF for `you`, which `body` answers. Returns the BFF reads.
 */
async function onProposal(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  body: Json,
  who = MEMBER,
  options: { testTimers?: boolean } = {},
): Promise<Sent[]> {
  await signInAs(context, baseURL ?? '', who);
  await serviceDown(page);
  await openProposals(page);
  await serve(page, '**/api/proposals/7', publicOf(body));
  await serve(page, '**/bff/proposals/me', { isAdmin: who === ADMIN, testTimers: options.testTimers ?? true });
  const reads = await serve(page, '**/bff/proposals/7', body);
  await page.goto('/propose/7');
  await expect(page.getByRole('heading', { name: String((body.proposal as Json).title), level: 1 })).toBeVisible();
  await expect(page.getByText('Loading what you can do here…')).toHaveCount(0);
  return reads;
}

const yourPart = (page: Page) => page.getByRole('region', { name: 'Your part' });
const outcome = (page: Page, part: 'part' | 'admin' | 'debate') => page.locator(`#${part}-outcome`);

/** Count the one-second intervals running at once, as the page sets and clears them. */
async function countIntervals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const realSet = window.setInterval.bind(window);
    const realClear = window.clearInterval.bind(window);
    const running = new Set<number>();
    const counter = window as unknown as { __running: () => number };
    counter.__running = () => running.size;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
      const id = realSet(handler, timeout, ...rest);
      if (timeout === 1000) running.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) running.delete(id);
      realClear(id);
    }) as typeof window.clearInterval;
  });
}

test.describe('the floor, on the live build', () => {
  test('signed out, it reads the list from the API: sections, countdowns, the test-timers banner', async ({ page }) => {
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', {
      proposals: [
        card({ id: 9, title: 'Weekly digest', state: 'submitted', seconder: undefined, deadline: at(0.1) }),
        card({ id: 8, title: 'Dark mode', state: 'voting', deadline: at(26) }),
        card(),
        card({ id: 3, title: 'CSV export', state: 'building', deadline: undefined }),
        card({ id: 2, title: 'Old idea', state: 'lapsed', seconder: undefined, deadline: undefined }),
      ],
      testTimers: true,
    });
    await page.goto('/propose');

    await expect(page.getByRole('note')).toHaveText('Test timers are on: deadlines are minutes, not days.');
    await expect(page.getByRole('region', { name: 'Needs a second' }).getByText(/Needs a second within [0-9]m [0-9]{2}s/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Voting' }).getByText(/Voting closes in 1d 0[12]h/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'In debate' }).getByRole('link')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Decided' }).getByRole('link')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Decided' }).getByText('Being built')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to bring a proposal' })).toHaveAttribute('href', '/signin?next=%2Fpropose%2Fnew');
    await expect(page.getByRole('switch', { name: 'Test timers' })).toHaveCount(0);
    // Nothing practice-flavoured on the build we ship.
    await expect(page.getByText(/practice/i)).toHaveCount(0);
  });

  test('a list it can’t read is said, not invented, and "Try again" reads it again', async ({ page }) => {
    await serviceDown(page);
    await openProposals(page);
    let calls = 0;
    await page.route('**/api/proposals', async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.abort();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposals: [card()], testTimers: false }) });
    });
    await page.goto('/propose');
    await expect(page.locator('main').getByRole('alert')).toContainText("We can't show the proposals just now");
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('region', { name: 'In debate' }).getByRole('link', { name: /Show my properties on a map/ })).toBeVisible();
  });

  test('a member with a proposal on the floor is pointed at it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', { proposals: [card()], testTimers: false });
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, activeProposalId: 7, testTimers: false });
    await page.goto('/propose');

    await expect(page.getByText('You have a proposal on the floor.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See your proposal' })).toHaveAttribute('href', '/propose/7');
    await expect(page.getByRole('link', { name: 'Bring a proposal' })).toHaveCount(0);
  });

  test('a member without one is offered "Bring a proposal"; only an admin gets the Test timers switch', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', ADMIN);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', { proposals: [card()], testTimers: false });
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
    const settings = await answer(page, '**/bff/proposals/settings', (sent) => ({ body: sent.body }));
    await page.goto('/propose');

    await expect(page.getByRole('link', { name: 'Bring a proposal' })).toHaveAttribute('href', '/propose/new');
    const timers = page.getByRole('switch', { name: 'Test timers' });
    await expect(timers).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('note')).toHaveCount(0);

    await timers.click();
    await expect(timers).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('note')).toHaveText('Test timers are on: deadlines are minutes, not days.');
    await expect(page.getByRole('status')).toContainText('Test timers are on.');
    // The switch stays where it was, focus included (it is never disabled under the pointer).
    await expect(timers).toBeFocused();
    expect(settings).toEqual([{ method: 'PUT', path: '/bff/proposals/settings', query: '', body: { testTimers: true } }]);
  });

  test('a member who is not an admin never sees the switch', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', { proposals: [], testTimers: false });
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, testTimers: false });
    await page.goto('/propose');
    await expect(page.getByRole('link', { name: 'Bring a proposal' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Decided' }).getByText('Nothing has been decided yet.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Test timers' })).toHaveCount(0);
  });

  test('with the flag off: switched off, and no bell', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await serve(page, '**/api/flags', { proposals: false, github_signin: true, contribute_bridge: true });
    await page.goto('/propose');
    await expect(page.locator('main').getByRole('alert')).toContainText('Proposals are switched off right now.');
    await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
  });

  test('a practice session is nobody on the build we ship: read-only, and no bell', async ({ page, context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', { proposals: [card()], testTimers: false });
    await serve(page, '**/api/proposals/7', detail({ you: null }));
    await page.goto('/propose');
    await expect(page.getByRole('link', { name: 'Sign in to bring a proposal' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);

    await page.goto('/propose/7');
    await expect(page.getByRole('link', { name: 'Sign in with GitHub to take part' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fpropose%2F7',
    );
    await expect(page.getByRole('button', { name: 'Consent' })).toHaveCount(0);
  });
});

test.describe('F5b · the floor stays current (review-pages M3)', () => {
  test('P2 turned around: right after a card’s deadline the list is read again, then every 30 s', async ({ page }) => {
    await page.clock.install();
    await serviceDown(page);
    await openProposals(page);
    const lists = await answer(page, '**/api/proposals', (_sent, count) => ({
      body: {
        proposals: [
          count === 1
            ? card({ state: 'debate', deadline: inSeconds(4), objectionCount: 1 })
            : card({ state: 'voting', deadline: at(48), objectionCount: 1 }),
        ],
        testTimers: true,
      },
    }));
    await page.goto('/propose');
    const debate = page.getByRole('region', { name: 'In debate' });
    await expect(debate.getByRole('link', { name: 'Show my properties on a map' })).toBeVisible();
    expect(lists).toHaveLength(1);

    // The deadline passes: the API moves it on at its next read, and the floor reads right after.
    await page.clock.runFor(6_000);
    await expect(page.getByRole('region', { name: 'Voting' }).getByRole('link', { name: 'Show my properties on a map' })).toBeVisible();
    await expect(debate.getByText('Nothing is in debate right now.')).toBeVisible();
    expect(lists).toHaveLength(2);

    // And every 30 s while the tab is visible.
    await page.clock.runFor(30_000);
    await expect.poll(() => lists.length).toBe(3);
  });

  test('a re-read that fails keeps the last list on screen, and says it may be out of date', async ({ page }) => {
    await page.clock.install();
    await serviceDown(page);
    await openProposals(page);
    let reads = 0;
    await page.route('**/api/proposals', async (route) => {
      reads += 1;
      if (reads > 1) {
        await route.abort();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposals: [card()], testTimers: false }) });
    });
    await page.goto('/propose');
    await expect(page.getByRole('link', { name: 'Show my properties on a map' })).toBeVisible();
    await page.clock.runFor(31_000);
    await expect(page.getByText('This list may be out of date: the last update failed.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Show my properties on a map' })).toBeVisible();
  });
});

test.describe('F5b · the floor pages decided proposals (rules L8)', () => {
  test('"Show earlier decided proposals" reads the next page below the lowest one shown, and adds it', async ({ page }) => {
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', {
      proposals: [card({ id: 12, title: 'Active one' }), card({ id: 11, title: 'Decided eleven', state: 'passed', deadline: undefined }), card({ id: 9, title: 'Decided nine', state: 'failed', deadline: undefined })],
      testTimers: false,
      moreDecided: true,
    });
    const pages = await answer(
      page,
      (url) => url.pathname === '/api/proposals' && url.searchParams.has('decidedBefore'),
      (sent) => ({
        body:
          sent.query === '?decidedBefore=9'
            ? { proposals: [card({ id: 8, title: 'Decided eight', state: 'lapsed', deadline: undefined, seconder: undefined })], testTimers: false, moreDecided: true }
            : { proposals: [card({ id: 3, title: 'Decided three', state: 'shipped', deadline: undefined })], testTimers: false },
      }),
    );
    await page.goto('/propose');
    const decided = page.getByRole('region', { name: 'Decided' });
    await expect(decided.getByRole('link')).toHaveCount(2);

    await decided.getByRole('button', { name: 'Show earlier decided proposals' }).click();
    await expect(decided.getByRole('link', { name: 'Decided eight' })).toBeVisible();
    // The first card the page added takes focus, so a keyboard user is where the new ones are.
    await expect(decided.getByRole('link', { name: 'Decided eight' })).toBeFocused();
    await decided.getByRole('button', { name: 'Show earlier decided proposals' }).click();
    await expect(decided.getByRole('link', { name: 'Decided three' })).toBeVisible();
    await expect(decided.getByRole('button', { name: 'Show earlier decided proposals' })).toHaveCount(0);
    expect(pages.map((sent) => sent.query)).toEqual(['?decidedBefore=9', '?decidedBefore=8']);
    await expect(decided.getByRole('link')).toHaveText(['Decided eleven', 'Decided nine', 'Decided eight', 'Decided three']);
    // Active proposals are never in the earlier pages: the first page lists them all.
    await expect(page.getByRole('region', { name: 'In debate' }).getByRole('link')).toHaveText(['Active one']);
  });
});

test.describe('F5b · the floor is paused (rules M1)', () => {
  test('the floor and a proposal say so, and no deadline counts down or triggers a read', async ({ page }) => {
    await page.clock.install();
    await serviceDown(page);
    await openProposals(page);
    const lists = await serve(page, '**/api/proposals', {
      proposals: [card({ deadline: inSeconds(3) }), card({ id: 6, title: 'Waiting', state: 'submitted', seconder: undefined, deadline: at(5) })],
      testTimers: false,
      floorPaused: true,
    });
    await page.goto('/propose');
    await expect(page.getByRole('note', { name: 'The floor is paused' })).toContainText(
      'every running deadline moves later by the time it was paused',
    );
    await expect(page.getByRole('region', { name: 'In debate' }).getByText('Debate time is paused')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs a second' }).getByText('The time to second it is paused')).toBeVisible();
    await expect(page.getByRole('timer')).toHaveCount(0);
    await page.clock.runFor(10_000);
    expect(lists).toHaveLength(1);

    const reads = await serve(page, '**/api/proposals/7', detail({ proposal: { deadline: inSeconds(3) }, you: null, extra: { floorPaused: true } }));
    await page.goto('/propose/7');
    await expect(page.getByRole('note', { name: 'The floor is paused' })).toBeVisible();
    await expect(page.locator('main').getByText('Debate time is paused')).toBeVisible();
    await page.clock.runFor(10_000);
    expect(reads).toHaveLength(1);
  });
});

test.describe('bringing a proposal', () => {
  async function onForm(page: Page, context: BrowserContext, baseURL: string | undefined): Promise<void> {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, testTimers: false });
    await page.goto('/propose/new');
    await expect(page.getByRole('heading', { name: 'Bring a proposal', level: 1 })).toBeVisible();
  }

  test('sends the title and pitch, trimmed, and opens the new proposal', async ({ page, context, baseURL }) => {
    await onForm(page, context, baseURL);
    const created = await answer(page, '**/bff/proposals', () => ({
      status: 201,
      body: detail({ proposal: { id: 12, title: 'A map view', state: 'submitted', seconder: undefined, deadline: at(168) }, comments: [] }),
    }));
    const opened = detail({ proposal: { id: 12, title: 'A map view', state: 'submitted', seconder: undefined }, comments: [], you: { canEdit: true, canWithdraw: true } });
    await serve(page, '**/api/proposals/12', publicOf(opened));
    await serve(page, '**/bff/proposals/12', opened);

    await page.getByLabel('Title').fill('  A map view ');
    await page.getByLabel('Your pitch').fill('Pins on a map.\n\nThat is all.\n');
    await page.getByRole('button', { name: 'Put it on the floor' }).click();

    await expect(page).toHaveURL(/\/propose\/12$/);
    await expect(page.getByRole('status')).toContainText('Your proposal is on the floor.');
    expect(created).toEqual([
      { method: 'POST', path: '/bff/proposals', query: '', body: { title: 'A map view', pitch: 'Pins on a map.\n\nThat is all.' } },
    ]);
  });

  test('a member with a proposal on the floor gets a link to it instead of the form', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, activeProposalId: 7, testTimers: false });
    await page.goto('/propose/new');
    await expect(page.getByRole('link', { name: 'See your proposal' })).toHaveAttribute('href', '/propose/7');
    await expect(page.getByLabel('Your pitch')).toHaveCount(0);
  });

  for (const refusal of [
    {
      name: 'one_active_proposal links to yours',
      status: 409,
      body: { error: 'one_active_proposal', proposalId: 7 },
      sentence: describeProposalError('one_active_proposal', 'create'),
      link: '/propose/7',
    },
    {
      name: 'rate_limited says how long to wait',
      status: 429,
      body: { error: 'rate_limited', retryAfter: 7200, limit: 3 },
      headers: { 'retry-after': '7200' },
      sentence: "You've brought as many proposals as FORGE allows in a day (3). Try again in about 2 hours.",
    },
    {
      name: 'invalid_request names the field',
      status: 400,
      body: { error: 'invalid_request', fields: ['title'] },
      sentence: 'Check the title (1 to 100 characters). Nothing was saved.',
      field: 'Title',
    },
  ]) {
    test(`a refusal changes nothing and says why: ${refusal.name}`, async ({ page, context, baseURL }) => {
      await onForm(page, context, baseURL);
      await answer(page, '**/bff/proposals', () => ({ status: refusal.status, body: refusal.body, headers: refusal.headers ?? {} }));
      await page.getByLabel('Title').fill('A map view');
      await page.getByLabel('Your pitch').fill('Pins on a map.');
      await page.getByRole('button', { name: 'Put it on the floor' }).click();

      await expect(page.locator('main').getByRole('alert')).toContainText(refusal.sentence);
      // The refusal takes focus, so it is heard and the form is next.
      await expect(page.locator('main').getByRole('alert')).toBeFocused();
      await expect(page).toHaveURL(/\/propose\/new$/);
      if (refusal.link !== undefined) {
        await expect(page.locator('main').getByRole('alert').getByRole('link', { name: 'See your proposal' })).toHaveAttribute('href', refusal.link);
      }
      if (refusal.field !== undefined) {
        await expect(page.getByLabel(refusal.field)).toHaveAttribute('aria-invalid', 'true');
      }
    });
  }
});

test.describe('a proposal, as a member', () => {
  test('signed in, it is read in public first, then through the BFF for your part, with its countdown spoken coarsely', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    const order: string[] = [];
    await answer(page, '**/api/proposals/7', (sent) => {
      order.push(sent.path);
      return { body: detail({ you: null }) };
    });
    await answer(page, '**/bff/proposals/7', (sent) => {
      order.push(sent.path);
      return { body: detail({ you: { canComment: true } }) };
    });
    await page.goto('/propose/7');
    await expect(page.getByLabel('Add to the debate')).toBeVisible();
    expect(order).toEqual(['/api/proposals/7', '/bff/proposals/7']);
    await expect(page.getByText(/^Debate ends in 2d 0[12]h$/)).toBeVisible();
    await expect(page.locator('main [aria-live="polite"]', { hasText: /^Debate ends in 2 days$/ })).toHaveCount(1);
    await expect(page.getByText('2 of 5 have consented.')).toBeVisible();
    await expect(page.getByText('jo seconded it, so debate is open.')).toBeVisible();
  });

  test('Second sends the revision on screen, and the page shows the debate it opened', async ({ page, context, baseURL }) => {
    await onProposal(
      page,
      context,
      baseURL,
      detail({
        proposal: { state: 'submitted', seconder: undefined, deadline: at(160) },
        comments: [],
        you: { canSecond: true },
        extra: { eligibleCount: undefined, consentCount: undefined, revision: 3 },
      }),
    );
    const seconds = await answer(page, '**/bff/proposals/7/second', () => ({
      body: detail({ proposal: { seconder: MEMBER.login }, you: { canConsent: true, canComment: true }, extra: { consentCount: 1, revision: 3 } }),
    }));
    await page.getByRole('button', { name: 'Second this proposal' }).click();

    await expect(yourPart(page).getByRole('status')).toHaveText('You seconded it. Debate is open.');
    await expect(page.getByText('1 of 5 has consented.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeVisible();
    expect(seconds).toEqual([{ method: 'POST', path: '/bff/proposals/7/second', query: '', body: { revision: 3 } }]);
  });

  test('rules L3: a proposal edited since you opened it says so, shows the new text, and seconds that one next', async ({
    page,
    context,
    baseURL,
  }) => {
    const waiting = (title: string, revision: number) =>
      detail({
        proposal: { state: 'submitted', seconder: undefined, deadline: at(160), title },
        comments: [],
        you: { canSecond: true },
        extra: { eligibleCount: undefined, consentCount: undefined, revision },
      });
    const reads = await onProposal(page, context, baseURL, waiting('Show my properties on a map', 1));
    const seconds = await answer(page, '**/bff/proposals/7/second', (sent) =>
      (sent.body as { revision: number }).revision === 2
        ? { body: detail({ proposal: { seconder: MEMBER.login, title: 'Show my properties on a map, and sales' }, you: { canConsent: true }, extra: { revision: 2 } }) }
        : { status: 409, body: { error: 'proposal_changed', message: 'The API’s own words.', revision: 2 } },
    );
    // The mover edited it a moment ago: the next read has the new text.
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', waiting('Show my properties on a map, and sales', 2));

    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(yourPart(page).getByRole('alert')).toHaveText('The proposal changed since you opened it. Read it again, then second it.');
    await expect(page.getByRole('heading', { name: 'Show my properties on a map, and sales', level: 1 })).toBeVisible();
    expect(reads.length).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(yourPart(page).getByRole('status')).toHaveText('You seconded it. Debate is open.');
    expect(seconds.map((sent) => sent.body)).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  test('pages M1: Consent asks first, saying it is final, then posts {consent: true}', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    const consents = await answer(page, '**/bff/proposals/7/consent', () => ({
      body: detail({ you: { consent: 'consented', canComment: true }, extra: { consentCount: 3 } }),
    }));
    await expect(yourPart(page)).toContainText('Consenting is final, and so is objecting.');
    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    await expect(page.getByRole('group', { name: /Consent to this proposal\?/ })).toContainText(
      "Consenting is final: you can't object afterwards.",
    );
    expect(consents).toEqual([]);
    // Cancel changes nothing.
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(consents).toEqual([]);
    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await expect(yourPart(page).getByText('You consented.', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('3 of 5 have consented.')).toBeVisible();
    expect(consents).toEqual([{ method: 'POST', path: '/bff/proposals/7/consent', query: '', body: { consent: true } }]);
  });

  test('Object posts {consent: false}, then the reason as a comment', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    const objected = detail({ proposal: { objectionCount: 1 }, you: { consent: 'objected', canComment: true } });
    const consents = await answer(page, '**/bff/proposals/7/consent', () => ({ body: objected }));
    const comments = await answer(page, '**/bff/proposals/7/comments', () => ({
      body: {
        ...objected,
        comments: [
          { id: 1, author: 'jo', text: 'Seconded so we can talk it through.', at: at(-20) },
          { id: 2, author: MEMBER.login, text: 'Phones first, please.', at: at(0) },
        ],
      },
    }));
    await page.getByRole('button', { name: 'Object', exact: true }).click();
    await page.getByLabel('Why do you object? One line, posted in the debate.').fill('Phones first, please.');
    await page.getByRole('button', { name: 'Send my objection' }).click();

    await expect(page.getByText('Objected: this goes to a vote after debate.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Phones first, please.');
    expect(consents).toEqual([{ method: 'POST', path: '/bff/proposals/7/consent', query: '', body: { consent: false } }]);
    expect(comments).toEqual([{ method: 'POST', path: '/bff/proposals/7/comments', query: '', body: { text: 'Phones first, please.' } }]);
  });

  test('an objection whose reason didn’t post still counts, and says so', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    await serve(page, '**/bff/proposals/7/consent', detail({ proposal: { objectionCount: 1 }, you: { consent: 'objected', canComment: true } }));
    await answer(page, '**/bff/proposals/7/comments', () => ({ status: 429, body: { error: 'rate_limited', limit: 10 }, headers: { 'retry-after': '900' } }));
    await page.getByRole('button', { name: 'Object', exact: true }).click();
    await page.getByLabel('Why do you object? One line, posted in the debate.').fill('Phones first, please.');
    await page.getByRole('button', { name: 'Send my objection' }).click();
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      "Your objection counts, but your reason wasn't posted. You've commented on this proposal as often as FORGE allows in an hour (10). Try again in about 15 minutes.",
    );
    await expect(page.getByText('You objected, so it goes to a vote after debate.')).toBeVisible();
  });

  test('a comment posts {text}', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true } }));
    const comments = await answer(page, '**/bff/proposals/7/comments', () => ({
      body: detail({
        you: { canComment: true },
        comments: [
          { id: 1, author: 'jo', text: 'Seconded so we can talk it through.', at: at(-20) },
          { id: 2, author: MEMBER.login, text: 'Count me in.\nOn phones too.', at: at(0) },
        ],
      }),
    }));
    await page.getByLabel('Add to the debate').fill('Count me in.\nOn phones too.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(2);
    await expect(outcome(page, 'debate').getByRole('status')).toHaveText('Your comment is posted.');
    await expect(page.getByLabel('Add to the debate')).toHaveValue('');
    expect(comments).toEqual([
      { method: 'POST', path: '/bff/proposals/7/comments', query: '', body: { text: 'Count me in.\nOn phones too.' } },
    ]);
  });

  test('a vote posts {choice}, shows turnout only, says who quorum counts, and can be changed until the close', async ({
    page,
    context,
    baseURL,
  }) => {
    const voting = (vote?: string, turnout = 2) =>
      detail({
        proposal: { state: 'voting', objectionCount: 1, deadline: at(30) },
        you: { canVote: true, canComment: true, ...(vote === undefined ? {} : { vote }) },
        extra: { consentCount: undefined, turnout },
      });
    await onProposal(page, context, baseURL, voting());
    await expect(page.getByText('2 of 5 have voted.')).toBeVisible();
    await expect(page.getByText('Votes are public: your name shows next to your vote after the close.')).toBeVisible();
    // Rules M3: quorum is a majority of the members active in the last 30 days when it was seconded.
    const ballot = page.getByRole('group', { name: 'Your vote' });
    await expect(ballot).toHaveAccessibleDescription(
      'Quorum counts the members active in the last 30 days when it was seconded, with its mover and seconder: 5 of them, so it needs 3 ballots (Abstain counts).',
    );
    const votes = await answer(page, '**/bff/proposals/7/vote', (sent) => ({
      body: voting((sent.body as { choice: string }).choice, 3),
    }));

    await ballot.getByRole('button', { name: 'Yes' }).click();
    await expect(ballot.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('3 of 5 have voted.')).toBeVisible();
    await ballot.getByRole('button', { name: 'Abstain' }).click();
    await expect(ballot.getByRole('button', { name: 'Abstain' })).toHaveAttribute('aria-pressed', 'true');
    await expect(ballot.getByText('Your vote: Abstain. You can change it until the vote closes.')).toBeVisible();
    expect(votes.map((entry) => entry.body)).toEqual([{ choice: 'yes' }, { choice: 'abstain' }]);
    expect(votes.every((entry) => entry.method === 'POST' && entry.path === '/bff/proposals/7/vote')).toBe(true);
  });

  test('after the close: the tally, and the task once it is published', async ({ page, context, baseURL }) => {
    await onProposal(
      page,
      context,
      baseURL,
      detail({
        proposal: { state: 'building', objectionCount: 1, deadline: undefined },
        you: {},
        extra: { consentCount: undefined, tally: { yes: 3, no: 1, abstain: 1, eligible: 5, quorumMet: true }, taskId: 10001 },
      }),
    );
    await expect(page.getByText('Yes 3 · No 1 · Abstain 1')).toBeVisible();
    await expect(page.getByText('Quorum met: 5 of 5 voted.')).toBeVisible();
    await expect(page.getByText('More Yes than No, so it passed.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See the task on the Contribute board' })).toHaveAttribute('href', '/contribute/task/10001');
    await expect(page.getByText('It has been decided, so there is nothing left to do here.')).toBeVisible();
  });

  test('the mover edits with PATCH {title, pitch}, and withdraws after a confirm step', async ({ page, context, baseURL }) => {
    const waiting = (title = 'Show my properties on a map') =>
      detail({
        proposal: { state: 'submitted', seconder: undefined, mover: MEMBER.login, title, deadline: at(160) },
        comments: [],
        you: { canEdit: true, canWithdraw: true },
        extra: { eligibleCount: undefined, consentCount: undefined },
      });
    await onProposal(page, context, baseURL, waiting());
    const edits = await answer(page, '**/bff/proposals/7', (sent) =>
      sent.method === 'PATCH' ? { body: waiting('Show my properties on a map, please') } : { body: waiting() },
    );
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Title').fill('Show my properties on a map, please');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: 'Show my properties on a map, please', level: 1 })).toBeVisible();
    expect(edits.filter((entry) => entry.method === 'PATCH')).toEqual([
      {
        method: 'PATCH',
        path: '/bff/proposals/7',
        query: '',
        body: {
          title: 'Show my properties on a map, please',
          pitch: 'A map with a pin for each property.\n\nPins, a tap to see the row, and the same filters.',
        },
      },
    ]);

    const withdrawals = await answer(page, '**/bff/proposals/7/withdraw', () => ({
      body: detail({ proposal: { state: 'withdrawn', seconder: undefined, mover: MEMBER.login, deadline: undefined }, comments: [], you: {} }),
    }));
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText(/Withdraw this proposal\? It leaves the floor for good/)).toBeVisible();
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(withdrawals).toEqual([]);
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await page.getByRole('button', { name: 'Yes, withdraw it' }).click();
    await expect(page.getByText('Withdrawn', { exact: true })).toBeVisible();
    expect(withdrawals).toEqual([{ method: 'POST', path: '/bff/proposals/7/withdraw', query: '', body: {} }]);
  });

  test('every refusal code comes back as its own sentence, and the page reads the proposal again when it may be behind', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const reads = await onProposal(
      page,
      context,
      baseURL,
      detail({ proposal: { state: 'submitted', seconder: undefined, deadline: at(160) }, comments: [], you: { canSecond: true } }),
    );
    const EXTRA: Record<string, { status: number; body?: Json; headers?: Record<string, string> }> = {
      proposal_not_found: { status: 404 },
      wrong_state: { status: 409, body: { state: 'debate' } },
      one_active_proposal: { status: 409, body: { proposalId: 3 } },
      already_seconded: { status: 409 },
      already_decided_consent: { status: 409 },
      not_eligible: { status: 409 },
      not_mover: { status: 403 },
      own_proposal: { status: 403 },
      rate_limited: { status: 429, body: { limit: 60 }, headers: { 'retry-after': '120' } },
      invalid_request: { status: 400, body: { fields: ['title'] } },
      'proposals-disabled': { status: 404 },
      admin_only: { status: 403 },
      unauthenticated: { status: 401 },
      practice_session: { status: 403 },
      bad_origin: { status: 403 },
      too_large: { status: 413 },
      service_unreachable: { status: 502 },
      not_configured: { status: 503 },
      upstream_timeout: { status: 504 },
      proposal_changed: { status: 409, body: { revision: 2 } },
      test_mode_off: { status: 409 },
      edit_limit: { status: 409, body: { limit: 20 } },
      tier_not_open: { status: 400 },
      task_title_needs_letters: { status: 400 },
    };
    expect(Object.keys(EXTRA).sort()).toEqual([...PROPOSAL_ERROR_CODES].sort());

    let current = '';
    await answer(page, '**/bff/proposals/7/second', () => {
      const spec = EXTRA[current] ?? { status: 500 };
      return { status: spec.status, body: { error: current, message: 'The API’s own words.', ...spec.body }, headers: spec.headers ?? {} };
    });
    const second = page.getByRole('button', { name: 'Second this proposal' });
    for (const code of PROPOSAL_ERROR_CODES) {
      current = code;
      const before = reads.length;
      await second.click();
      const failure = {
        code,
        ...(code === 'wrong_state' ? { state: 'debate' } : {}),
        ...(code === 'rate_limited' ? { retryAfterSeconds: 120, limit: 60 } : {}),
        ...(code === 'invalid_request' ? { fields: ['title'] } : {}),
        ...(code === 'proposal_changed' ? { revision: 2 } : {}),
        ...(code === 'edit_limit' ? { limit: 20 } : {}),
      };
      const alert = yourPart(page).getByRole('alert');
      // No answer is read again first: it shows the second didn't happen, so the page says so.
      const sentence = code === 'upstream_timeout' ? didNotGoThrough('second') : describeProposalError(failure, 'second');
      await expect(alert, code).toContainText(sentence);
      // The API's own message is never shown: the page says it in its own words.
      await expect(alert, code).not.toContainText('The API’s own words.');
      // And focus is on what it says, so it is heard and the next press is right there.
      await expect(outcome(page, 'part'), code).toBeFocused();
      if (code === 'one_active_proposal') {
        await expect(alert.getByRole('link', { name: 'See your proposal' })).toHaveAttribute('href', '/propose/3');
      }
      if (['wrong_state', 'already_seconded', 'not_eligible', 'own_proposal', 'upstream_timeout', 'proposal_changed'].includes(code)) {
        await expect.poll(() => reads.length, code).toBeGreaterThan(before);
      }
      await expect(second).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  test('no answer at all is not a "no": the proposal is read again, and the page says whether it went through', async ({
    page,
    context,
    baseURL,
  }) => {
    const reads = await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    await page.route('**/bff/proposals/7/consent', (route) => route.abort());
    const before = reads.length;
    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await expect.poll(() => reads.length).toBeGreaterThan(before);
    // The proposal read back has no consent from you: it didn't happen.
    await expect(yourPart(page).getByRole('alert')).toHaveText(didNotGoThrough('consent'));

    // This time the API took it before the connection dropped: the read back shows it, and the page says so.
    // (The step is still open after a failure, so trying again is one press.)
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', detail({ you: { consent: 'consented', canComment: true }, extra: { consentCount: 3 } }));
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await expect(yourPart(page).getByRole('status')).toHaveText('You consented.');
    await expect(page.getByText('3 of 5 have consented.')).toBeVisible();
  });
});

test.describe('F5b · reading a proposal when the BFF can’t answer (review-pages M6)', () => {
  for (const [name, status, error] of [
    ['P8: the BFF can’t reach the API (503)', 503, 'not_configured'],
    ['P8b: the API refuses the assertion (401, sign-in switched off)', 401, 'unauthenticated'],
  ] as const) {
    test(`${name}: the proposal still shows, read-only, with "Try again" for your part`, async ({ page, context, baseURL }) => {
      await signInAs(context, baseURL ?? '', MEMBER);
      await serviceDown(page);
      await openProposals(page);
      await serve(page, '**/api/proposals/7', detail({ you: null }));
      const bff = await serve(page, '**/bff/proposals/7', { error }, status);
      await page.goto('/propose/7');
      await expect(page.getByRole('heading', { name: 'Show my properties on a map', level: 1 })).toBeVisible();
      await expect(yourPart(page)).toContainText("Your actions can't load right now. Try again.");
      await expect(page.getByRole('list', { name: 'Comments' })).toContainText('Seconded so we can talk it through.');
      await expect(page.getByRole('button', { name: 'Consent', exact: true })).toHaveCount(0);

      // Try again asks the BFF again, and stays readable while it still can't answer.
      const tries = bff.length;
      await yourPart(page).getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => bff.length).toBeGreaterThan(tries);
      await expect(yourPart(page)).toContainText("Your actions can't load right now. Try again.");

      // Once it can, your part is back.
      await page.unroute('**/bff/proposals/7');
      await serve(page, '**/bff/proposals/7', detail({ you: { canConsent: true, canComment: true } }));
      await yourPart(page).getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeVisible();
    });
  }

  test('the pause banner shows to signed-in members too, when sign-in is what paused it', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await serve(page, '**/api/flags', { proposals: true, github_signin: false, contribute_bridge: true });
    await serve(page, '**/api/proposals/7', detail({ you: null, extra: { floorPaused: true } }));
    await serve(page, '**/bff/proposals/7', { error: 'unauthenticated' }, 401);
    await page.goto('/propose/7');
    await expect(page.getByRole('note', { name: 'The floor is paused' })).toBeVisible();
    await expect(yourPart(page)).toContainText("Your actions can't load right now. Try again.");
  });

  test('if the API can’t be read from the browser, the BFF’s answer is used', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/proposals/7', detail({ you: { canConsent: true, canComment: true } }));
    await page.goto('/propose/7');
    await expect(page.getByRole('heading', { name: 'Show my properties on a map', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeVisible();
  });
});

test.describe('F5b · comments (review-pages M2, rules M2)', () => {
  test('P4 turned around: a comment refused because the vote closed is explained above where the box was, with what you wrote', async ({
    page,
    context,
    baseURL,
  }) => {
    const open = detail({ proposal: { state: 'voting', deadline: at(1), objectionCount: 1 }, you: { canComment: true, canVote: true }, extra: { turnout: 3 } });
    await onProposal(page, context, baseURL, open);
    const closed = detail({
      proposal: { state: 'passed', deadline: undefined, objectionCount: 1 },
      you: { canComment: false },
      extra: { tally: { yes: 3, no: 1, abstain: 0, eligible: 5, quorumMet: true } },
    });
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', closed);
    const posts = await answer(page, '**/bff/proposals/7/comments', () => ({
      status: 409,
      body: { error: 'wrong_state', state: 'passed', message: 'That can’t be done now: this proposal has passed.' },
    }));
    await page.getByLabel('Add to the debate').fill('Before you count: the map should work offline too.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible();

    const said = outcome(page, 'debate').getByRole('alert');
    await expect(said).toContainText('Comments are closed (it has passed): they run from the second until the vote closes.');
    await expect(said).toContainText("What you wrote, which wasn't posted:");
    await expect(said.locator('blockquote')).toHaveText('Before you count: the map should work offline too.');
    await expect(page.getByLabel('Add to the debate')).toHaveCount(0);
    await expect(outcome(page, 'debate')).toBeFocused();
    expect(posts).toHaveLength(1);
  });

  test('a comment that fails keeps its text in the box, with the reason said above the box', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true } }));
    await answer(page, '**/bff/proposals/7/comments', () => ({ status: 429, body: { error: 'rate_limited', limit: 10 }, headers: { 'retry-after': '600' } }));
    const box = page.getByLabel('Add to the debate');
    await box.fill('Pins should cluster when zoomed out.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    const said = outcome(page, 'debate').getByRole('alert');
    await expect(said).toHaveText("You've commented on this proposal as often as FORGE allows in an hour (10). Try again in about 10 minutes.");
    await expect(box).toHaveValue('Pins should cluster when zoomed out.');
    // Above the box: the reason comes first in reading order.
    const above = await said.evaluate((element) => {
      const field = document.getElementById('comment-text');
      return field !== null && (element.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(above).toBe(true);
  });

  test('"Show earlier comments" reads the page before the oldest shown, and a re-read keeps them', async ({ page, context, baseURL }) => {
    const comment = (id: number) => ({ id, author: id % 2 === 0 ? 'jo' : 'maya', text: `Comment number ${id}.`, at: at(-10 + id / 100) });
    const newest = Array.from({ length: 100 }, (_, index) => comment(201 + index));
    await onProposal(page, context, baseURL, detail({ you: { canComment: true }, comments: newest, extra: { moreComments: true } }));
    const pages = await answer(
      page,
      (url) => url.pathname === '/api/proposals/7/comments',
      (sent) => ({
        body:
          sent.query === '?before=201'
            ? { comments: Array.from({ length: 100 }, (_, index) => comment(101 + index)), moreComments: true }
            : { comments: [comment(1), comment(2)], moreComments: false },
      }),
    );
    const thread = page.getByRole('list', { name: 'Comments' });
    await expect(thread.getByRole('listitem')).toHaveCount(100);
    await page.getByRole('button', { name: 'Show earlier comments' }).click();
    await expect(thread.getByRole('listitem')).toHaveCount(200);
    await expect(thread.getByRole('listitem').first()).toContainText('Comment number 101.');
    await expect(thread.getByRole('listitem').first()).toBeFocused();
    await page.getByRole('button', { name: 'Show earlier comments' }).click();
    await expect(thread.getByRole('listitem')).toHaveCount(202);
    await expect(page.getByRole('button', { name: 'Show earlier comments' })).toHaveCount(0);
    expect(pages.map((sent) => sent.query)).toEqual(['?before=201', '?before=101']);

    // A new comment arrives and the page reads again (here: back to the tab): the earlier ones stay.
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', detail({ you: { canComment: true }, comments: [...newest.slice(1), comment(301)], extra: { moreComments: true } }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(thread.getByRole('listitem')).toHaveCount(203);
    await expect(thread.getByRole('listitem').last()).toContainText('Comment number 301.');
    await expect(thread.getByRole('listitem').first()).toContainText('Comment number 1.');
  });
});

test.describe('F5b · a write whose answer was lost (review-pages L1)', () => {
  const HOST_TIMEOUT = 'An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT\n';

  test('P14a turned around: a host timeout on a comment the API stored is read back, said as posted, and not posted twice', async ({
    page,
    context,
    baseURL,
  }) => {
    const text = 'The pins should cluster when zoomed out.';
    const stored: Json[] = [{ id: 1, author: 'jo', text: 'Seconded so we can talk it through.', at: at(-20) }];
    await onProposal(page, context, baseURL, detail({ you: { canComment: true } }));
    await page.unroute('**/bff/proposals/7');
    let reads = 0;
    await page.route('**/bff/proposals/7', async (route) => {
      reads += 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(detail({ you: { canComment: true }, comments: stored })) });
    });
    let posts = 0;
    await page.route('**/bff/proposals/7/comments', async (route) => {
      posts += 1;
      // The API stores it; its answer is lost to the host's timeout.
      stored.push({ id: stored.length + 1, author: MEMBER.login, text, at: at(0) });
      await route.fulfill({ status: 504, contentType: 'text/plain', body: HOST_TIMEOUT });
    });
    await page.getByLabel('Add to the debate').fill(text);
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(outcome(page, 'debate').getByRole('status')).toHaveText('Your comment is posted.');
    expect(reads).toBeGreaterThan(0);
    await expect(page.getByRole('list', { name: 'Comments' }).getByText(text)).toHaveCount(1);
    await expect(page.getByLabel('Add to the debate')).toHaveValue('');
    expect(posts).toBe(1);
  });

  test('a host error page on a comment the API never got says so, and keeps the text', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true } }));
    await page.route('**/bff/proposals/7/comments', (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<h1>Internal Server Error</h1>' }));
    await page.getByLabel('Add to the debate').fill('Cluster the pins.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(outcome(page, 'debate').getByRole('alert')).toHaveText(didNotGoThrough('comment'));
    await expect(page.getByLabel('Add to the debate')).toHaveValue('Cluster the pins.');
  });

  test('P14b turned around: a 502 page on Second the API took is read back and said as done; a retry is "already seconded", by you', async ({
    page,
    context,
    baseURL,
  }) => {
    let seconded = false;
    await onProposal(
      page,
      context,
      baseURL,
      detail({ proposal: { state: 'submitted', seconder: undefined, deadline: at(160) }, comments: [], you: { canSecond: true } }),
    );
    await page.unroute('**/bff/proposals/7');
    await page.route('**/bff/proposals/7', async (route) => {
      const body = seconded
        ? detail({ proposal: { state: 'debate', seconder: MEMBER.login, deadline: at(72) }, you: { canConsent: true, canComment: true } })
        : detail({ proposal: { state: 'submitted', seconder: undefined, deadline: at(160) }, comments: [], you: { canSecond: true } });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/bff/proposals/7/second', async (route) => {
      seconded = true; // the API took it
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
    });
    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(yourPart(page).getByRole('status')).toHaveText('You seconded it. Debate is open.');
    await expect(page.locator('main').getByText(/^Seconded by/)).toHaveText(`Seconded by ${MEMBER.login}`);
    await expect(page.getByRole('button', { name: 'Second this proposal' })).toHaveCount(0);
  });

  test('a retry refused as already seconded, by you, says you have seconded it', async ({ page, context, baseURL }) => {
    await onProposal(
      page,
      context,
      baseURL,
      detail({ proposal: { state: 'submitted', seconder: undefined, deadline: at(160) }, comments: [], you: { canSecond: true } }),
    );
    await page.route('**/bff/proposals/7/second', async (route) => {
      await page.unroute('**/bff/proposals/7');
      await serve(page, '**/bff/proposals/7', detail({ proposal: { seconder: MEMBER.login }, you: { canConsent: true } }));
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'already_seconded' }) });
    });
    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(yourPart(page).getByRole('status')).toHaveText("You've seconded it already, so debate is open.");
  });
});

test.describe('F5b · answers in order (review-pages L2)', () => {
  test('P5 turned around: a slow read that left before Second can’t put the old state back', async ({ page, context, baseURL }) => {
    const submitted = detail({ proposal: { state: 'submitted', seconder: undefined, deadline: at(160), commentCount: 0 }, comments: [], you: { canSecond: true } });
    const debate = detail({ proposal: { state: 'debate', seconder: MEMBER.login, deadline: at(72), commentCount: 0 }, comments: [], you: { canConsent: true, canComment: true } });
    await onProposal(page, context, baseURL, submitted);
    await page.unroute('**/bff/proposals/7');
    // The next read is the refresh when the tab comes back: the API answered it before the second, slowly.
    const reads = await answer(page, '**/bff/proposals/7', () => ({ body: submitted, delayMs: 3000 }));
    const seconds = await answer(page, '**/bff/proposals/7/second', () => ({ body: debate }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => reads.length).toBe(1);
    await page.getByRole('button', { name: 'Second this proposal' }).click();
    await expect(page.getByRole('button', { name: 'Consent', exact: true })).toBeVisible();
    await page.waitForTimeout(4000);
    await expect(page.locator('main').getByText(/^(In debate|Needs a second)$/).first()).toHaveText('In debate');
    await expect(page.getByRole('button', { name: 'Second this proposal' })).toHaveCount(0);
    await expect(page.locator('main p.visually-hidden[aria-live="polite"]').last()).not.toHaveText('This proposal is now: Needs a second.');
    expect(seconds).toHaveLength(1);
  });
});

test.describe('one proposal’s answers stay on its own page', () => {
  // The App Router mounts a new page for each proposal, so nothing of one (its reads, its writes, the
  // order they are shown in) reaches the next. This holds that in place.
  test('a write still out when the bell opens another proposal never shows on that one', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    const five = detail({ proposal: { id: 5, title: 'Dark mode', state: 'voting', deadline: at(20), objectionCount: 1 }, you: { canVote: true }, extra: { turnout: 1 } });
    await serve(page, '**/api/proposals/5', publicOf(five));
    await serve(page, '**/bff/proposals/5', five);
    await serve(page, '**/bff/notifications', {
      notifications: [{ id: 3, kind: 'vote_opened', message: 'Voting is open on “Dark mode”.', href: '/propose/5', at: at(-1), read: false }],
      unread: 1,
    });
    await serve(page, '**/bff/notifications/read', { notifications: [], unread: 0 });
    const consents = await answer(page, '**/bff/proposals/7/consent', () => ({
      body: detail({ you: { consent: 'consented', canComment: true }, extra: { consentCount: 3 } }),
      delayMs: 2500,
    }));
    // Consent on 7, then, while it is out, open the bell (it reads when opened) and leave for 5.
    const bell = page.getByRole('button', { name: /^Notifications/ });
    await page.getByRole('button', { name: 'Consent', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, consent' }).click();
    await bell.click();
    await page.getByRole('link', { name: /Voting is open on “Dark mode”/ }).click();
    await expect(page).toHaveURL(/\/propose\/5$/);
    await expect(page.getByRole('heading', { name: 'Dark mode', level: 1 })).toBeVisible();
    await expect.poll(() => consents.length).toBe(1);
    await page.waitForTimeout(3500);
    // 7's answer landed: 5's page still shows 5, and nothing about 7's consent.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dark mode');
    await expect(page.getByRole('group', { name: 'Your vote' })).toBeVisible();
    await expect(page.locator('#part-outcome')).toHaveText('');
  });
});

test.describe('F5b · kinds this build doesn’t know yet (review-pages L3)', () => {
  test('P7a turned around: a timeline line of a new kind shows as its message, and the page works', async ({ page }) => {
    await serviceDown(page);
    await openProposals(page);
    const base = detail({ you: null }) as { events: unknown[] };
    await serve(page, '**/api/proposals/7', {
      ...base,
      events: [
        ...base.events,
        { at: at(-2), kind: 'floor_paused', message: 'The floor closed: members can’t take part right now.' },
        { at: at(-1), kind: 'proposal_archived', message: 'It was archived for the season.' },
      ],
    });
    await page.goto('/propose/7');
    await expect(page.getByRole('heading', { name: 'Show my properties on a map', level: 1 })).toBeVisible();
    const timeline = page.getByRole('region', { name: 'Timeline' });
    await expect(timeline.getByText('It was archived for the season.')).toBeVisible();
    await expect(timeline.getByText('The floor closed: members can’t take part right now.')).toBeVisible();
    await expect(timeline.getByText('Admin')).toHaveCount(0);
  });

  test('P7b turned around: a bell item of a new kind is listed with the rest', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/notifications', {
      notifications: [
        { id: 9, kind: 'proposal_withdrawn', message: '“Show my properties on a map” was withdrawn.', href: '/propose/7', at: at(-1), read: false },
        { id: 8, kind: 'vote_opened', message: 'Voting is open on “Show my properties on a map”.', href: '/propose/7', at: at(-2), read: false },
      ],
      unread: 2,
    });
    await serve(page, '**/api/proposals', { proposals: [card()], testTimers: false });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, testTimers: false });
    await page.goto('/propose');
    const bell = page.getByRole('button', { name: 'Notifications: 2 unread' });
    await bell.click();
    await expect(page.getByRole('link', { name: /was withdrawn/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Voting is open/ })).toBeVisible();
    await expect(page.getByText("FORGE couldn't load your notifications just now.")).toHaveCount(0);
  });
});

test.describe('F5b · one clock, the server’s (review-pages L4, L5)', () => {
  test('P15 turned around: a 500-card floor runs one one-second interval, and decided cards none', async ({ page }) => {
    await countIntervals(page);
    await serviceDown(page);
    await openProposals(page);
    const proposals = Array.from({ length: 500 }, (_, index) =>
      index < 10
        ? card({ id: 500 - index, title: `Active proposal ${index}`, state: 'debate', deadline: at(30 + index) })
        : card({ id: 500 - index, title: `Decided proposal ${index}`, state: index % 2 ? 'passed' : 'failed', deadline: undefined }),
    );
    await serve(page, '**/api/proposals', { proposals, testTimers: false });
    await page.goto('/propose');
    await expect(page.locator('article')).toHaveCount(500);
    await expect(page.getByRole('region', { name: 'In debate' }).getByRole('timer')).toHaveCount(10);
    await expect(page.getByRole('region', { name: 'Decided' }).getByRole('timer')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __running: () => number }).__running())).toBe(1);
  });

  /** The visitor's clock, 2 minutes slow. */
  async function slowClock(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const skew = -120_000;
      const RealDate = Date;
      class SkewedDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(RealDate.now() + skew);
          else super(...(args as [string]));
        }
        static now(): number {
          return RealDate.now() + skew;
        }
      }
      (globalThis as unknown as { Date: DateConstructor }).Date = SkewedDate as unknown as DateConstructor;
    });
  }

  test('P10 turned around (signed in): with the visitor’s clock 2 minutes slow, the countdown and the read after the deadline keep the server’s time', async ({
    page,
    context,
    baseURL,
  }) => {
    await slowClock(page);
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    // Debate ends 6 s after the page first asks (server time), however long the page took to load.
    let deadline: string | undefined;
    const debateEnds = (): string => (deadline ??= inSeconds(6));
    await answer(page, '**/api/proposals/7', () => ({ body: detail({ proposal: { state: 'debate', deadline: debateEnds(), objectionCount: 1 }, you: null }) }));
    // The BFF is this origin: its answers carry the server's Date, as Next's do.
    const reads = await answer(page, '**/bff/proposals/7', (_sent, count) => ({
      body:
        count === 1
          ? detail({ proposal: { state: 'debate', deadline: debateEnds(), objectionCount: 1 }, you: { canComment: true } })
          : detail({ proposal: { state: 'voting', deadline: at(48), objectionCount: 1 }, you: { canComment: true, canVote: true }, extra: { turnout: 0 } }),
      headers: { date: new Date().toUTCString() },
    }));
    await page.goto('/propose/7');
    // Seconds left on the server's clock, not 2 minutes more on the visitor's.
    await expect(page.getByText(/^Debate ends in 0m 0[0-6]s$/)).toBeVisible();
    // Past the deadline on the server's clock, the page reads again and shows the vote.
    await expect(page.getByRole('group', { name: 'Your vote' })).toBeVisible({ timeout: 9000 });
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test('P10 turned around (signed out): an API answer whose Date header is exposed sets the clock too', async ({ page }) => {
    await slowClock(page);
    await serviceDown(page);
    await openProposals(page);
    const deadline = (): string => inSeconds(6);
    const reads = await answer(page, '**/api/proposals/7', (_sent, count) => ({
      body:
        count === 1
          ? detail({ proposal: { state: 'debate', deadline: deadline(), objectionCount: 1 }, you: null })
          : detail({ proposal: { state: 'voting', deadline: at(48), objectionCount: 1 }, you: null, extra: { turnout: 0 } }),
      headers: { date: new Date().toUTCString(), 'access-control-expose-headers': 'Date' },
    }));
    await page.goto('/propose/7');
    await expect(page.getByText(/^Debate ends in 0m 0[0-6]s$/)).toBeVisible();
    await expect(page.locator('main').getByText(/^Voting closes in \dd \d{2}h$/)).toBeVisible({ timeout: 9000 });
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });
});

test.describe('F5b · a flag service that never answers (review-pages L6)', () => {
  test('P9 turned around: after 8 s the floor fails closed instead of loading for ever', async ({ page }) => {
    await page.clock.install();
    await serviceDown(page);
    await page.route('**/api/flags', () => {
      /* never answered */
    });
    await page.goto('/propose');
    await expect(page.getByText('Opening the floor…')).toBeVisible();
    await page.clock.runFor(8_100);
    await expect(page.locator('main').getByRole('alert')).toContainText('Proposals are switched off right now.');
    await expect(page.getByText('Opening the floor…')).toHaveCount(0);
  });
});

test.describe('F5b · keyboard focus never drops to the page (review-pages M4)', () => {
  test('P12 turned around: Consent from the keyboard keeps focus on its button while it is sent, then on what happened', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    await answer(page, '**/bff/proposals/7/consent', () => ({
      body: detail({ you: { consent: 'consented', canComment: true }, extra: { consentCount: 3 } }),
      delayMs: 800,
    }));
    await page.getByRole('button', { name: 'Consent', exact: true }).focus();
    await page.keyboard.press('Enter');
    const yes = page.getByRole('button', { name: 'Yes, consent' });
    await expect(yes).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Consenting…' })).toBeFocused();
    await expect(outcome(page, 'part')).toBeFocused();
    await expect(outcome(page, 'part')).toHaveText('You consented.');
  });

  test('P12b turned around: Withdraw, Keep it, Edit and Cancel each put focus where the next step is', async ({ page, context, baseURL }) => {
    await onProposal(
      page,
      context,
      baseURL,
      detail({ proposal: { state: 'submitted', seconder: undefined, mover: MEMBER.login, deadline: at(100) }, you: { canEdit: true, canWithdraw: true } }),
    );
    await page.getByRole('button', { name: 'Withdraw', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Yes, withdraw it' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Withdraw', exact: true })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Title')).toBeFocused();
    // Title, pitch, Save changes, Cancel.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  });

  test('Object opens its reason with focus in it, and Cancel returns to Object', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canConsent: true, canComment: true } }));
    await page.getByRole('button', { name: 'Object', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Why do you object? One line, posted in the debate.')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Object', exact: true })).toBeFocused();
  });

  test('an admin’s confirm steps take focus, and "Not yet" gives it back', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true, isAdmin: true } }), ADMIN);
    const admin = page.getByRole('region', { name: 'Admin' });
    await admin.getByRole('button', { name: 'End debate now' }).focus();
    await page.keyboard.press('Enter');
    await expect(admin.getByRole('button', { name: 'Yes, end debate now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(admin.getByRole('button', { name: 'End debate now' })).toBeFocused();
  });
});

test.describe('the admin panel', () => {
  test('is there only when the API says you are an admin', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true, isAdmin: false } }));
    await expect(page.getByRole('region', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'End debate now' })).toHaveCount(0);
  });

  test('"End debate now" confirms, then posts; "Close the vote now" likewise', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true, isAdmin: true } }), ADMIN);
    const admin = page.getByRole('region', { name: 'Admin' });
    await expect(admin).toBeVisible();
    const ended = await answer(page, '**/bff/proposals/7/admin/end-debate', () => ({
      body: detail({
        proposal: { state: 'voting', objectionCount: 1, deadline: at(48) },
        you: { canVote: true, canComment: true, isAdmin: true },
        extra: { consentCount: undefined, turnout: 0 },
      }),
    }));
    await admin.getByRole('button', { name: 'End debate now' }).click();
    await admin.getByRole('button', { name: 'Not yet' }).click();
    expect(ended).toEqual([]);
    await admin.getByRole('button', { name: 'End debate now' }).click();
    await admin.getByRole('button', { name: 'Yes, end debate now' }).click();
    await expect(admin.getByRole('status')).toHaveText('Debate ended. Voting is open.');
    expect(ended).toEqual([{ method: 'POST', path: '/bff/proposals/7/admin/end-debate', query: '', body: {} }]);

    const closed = await answer(page, '**/bff/proposals/7/admin/close-vote', () => ({
      body: detail({
        proposal: { state: 'failed', objectionCount: 1, deadline: undefined },
        you: { isAdmin: true },
        extra: { consentCount: undefined, tally: { yes: 1, no: 1, abstain: 0, eligible: 5, quorumMet: false } },
      }),
    }));
    await admin.getByRole('button', { name: 'Close the vote now' }).click();
    await admin.getByRole('button', { name: 'Yes, close the vote now' }).click();
    await expect(page.getByText('Without quorum, it failed.')).toBeVisible();
    expect(closed).toEqual([{ method: 'POST', path: '/bff/proposals/7/admin/close-vote', query: '', body: {} }]);
  });

  test('rules L2: the test tools show only while Test timers are on, and a refusal hides them', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ you: { canComment: true, isAdmin: true } }), ADMIN, { testTimers: false });
    const admin = page.getByRole('region', { name: 'Admin' });
    await expect(admin).toContainText('“End debate now” and “Close the vote now” are test tools: they show only while Test timers are on.');
    await expect(admin.getByRole('button', { name: 'End debate now' })).toHaveCount(0);

    // Test timers were on when the page asked, and someone switched them off since.
    await page.unroute('**/bff/proposals/me');
    const me = await answer(page, '**/bff/proposals/me', (_sent, count) => ({ body: { isAdmin: true, testTimers: count === 1 } }));
    await page.reload();
    await admin.getByRole('button', { name: 'End debate now' }).click();
    await answer(page, '**/bff/proposals/7/admin/end-debate', () => ({ status: 409, body: { error: 'test_mode_off' } }));
    await admin.getByRole('button', { name: 'Yes, end debate now' }).click();
    await expect(admin.getByRole('alert')).toHaveText(
      "End debate now and Close the vote now work only while Test timers are on, and they're off. Nothing changed.",
    );
    await expect(admin.getByRole('button', { name: 'End debate now' })).toHaveCount(0);
    expect(me.length).toBeGreaterThanOrEqual(2);
  });

  test('the draft task is checked before it goes; its tier is T0; Publish saves it, then publishes it', async ({ page, context, baseURL }) => {
    const draft = {
      title: 'Show my properties on a map',
      civilianSummary: 'p'.repeat(600),
      acceptanceCriteria: [],
      size: 'S',
      tierFloor: 'T1',
      rewardClass: 'none',
    };
    const passed = (extra: Json = {}) =>
      detail({
        proposal: { state: 'passed', deadline: undefined },
        you: { isAdmin: true },
        extra: { consentCount: 5, draft, ...extra },
      });
    await onProposal(page, context, baseURL, passed(), ADMIN);
    const saves = await answer(page, '**/bff/proposals/7/admin/draft-task', (sent) => ({
      body: passed({ draft: { ...(sent.body as Json) } }),
    }));
    const publishes = await answer(page, '**/bff/proposals/7/admin/publish-task', () => ({
      body: detail({
        proposal: { state: 'building', deadline: undefined },
        you: { isAdmin: true },
        extra: { consentCount: 5, taskId: 10001, draft: { ...draft, tierFloor: 'T0', taskId: 10001 } },
      }),
    }));

    const admin = page.getByRole('region', { name: 'Admin' });
    // Rules M4 and L1: the tier is T0 until higher ones open, and the summary is what agents read.
    await expect(admin.getByRole('group', { name: 'Tier floor' })).toContainText('T0');
    await expect(admin.getByRole('group', { name: 'Tier floor' })).toContainText('Higher tiers open later.');
    await expect(admin.getByRole('combobox')).toHaveCount(2);
    await expect(admin.getByLabel('Plain summary')).toHaveAccessibleDescription(/^Agents read this as the task\./);

    await admin.getByRole('button', { name: 'Publish to the board' }).click();
    await expect(admin.getByText('Keep the summary to 500 characters (it has 600).')).toBeVisible();
    await expect(admin.getByText('Write at least one line saying what done means.')).toBeVisible();
    await expect(admin.getByLabel('Plain summary')).toBeFocused();
    expect(saves).toEqual([]);
    expect(publishes).toEqual([]);

    await admin.getByLabel('Plain summary').fill('Show each property as a pin on a map in the Data app.');
    await admin.getByLabel('What done means').fill(
      Array.from({ length: 11 }, (_, index) => `Line ${index + 1}`).join('\n'),
    );
    await expect(admin.getByText('11 / 10 lines')).toBeVisible();
    await admin.getByRole('button', { name: 'Save draft' }).click();
    await expect(admin.getByText('Keep it to 10 lines (it has 11).')).toBeVisible();
    expect(saves).toEqual([]);

    await admin.getByLabel('What done means').fill('A pin for every property\n\nThe filters work on the map');
    await admin.getByLabel('Size').selectOption('M');
    await admin.getByLabel('Reward').selectOption('R2');
    await admin.getByRole('button', { name: 'Save draft' }).click();
    await expect(admin.getByRole('status')).toHaveText('Draft saved.');
    const sentDraft = {
      title: 'Show my properties on a map',
      civilianSummary: 'Show each property as a pin on a map in the Data app.',
      acceptanceCriteria: ['A pin for every property', 'The filters work on the map'],
      size: 'M',
      tierFloor: 'T0',
      rewardClass: 'R2',
    };
    expect(saves).toEqual([{ method: 'PUT', path: '/bff/proposals/7/admin/draft-task', query: '', body: sentDraft }]);

    // Rules L10: a title that can't name a branch is caught before it goes.
    await admin.getByLabel('Task title').fill('ダークモード');
    await admin.getByRole('button', { name: 'Publish to the board' }).click();
    await expect(admin.getByText('Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch on GitHub is named after it.', { exact: true })).toBeVisible();
    await expect(admin.getByLabel('Task title')).toBeFocused();
    expect(publishes).toEqual([]);
    await admin.getByLabel('Task title').fill('Show my properties on a map');

    await admin.getByRole('button', { name: 'Publish to the board' }).click();
    await expect(admin.getByRole('status')).toHaveText("Published: it's task #10001 on the Contribute board.");
    await expect(admin.getByRole('link', { name: 'See task #10001 on the Contribute board' })).toHaveAttribute('href', '/contribute/task/10001');
    expect(saves.at(-1)).toEqual({ method: 'PUT', path: '/bff/proposals/7/admin/draft-task', query: '', body: sentDraft });
    expect(publishes).toEqual([{ method: 'POST', path: '/bff/proposals/7/admin/publish-task', query: '', body: {} }]);
  });
});

test.describe('the bell', () => {
  const NOTIFICATIONS = {
    notifications: [
      { id: 31, kind: 'proposal_seconded', message: 'jo seconded “Show my properties on a map”. Debate is open.', href: '/propose/7', at: at(-1), read: false },
      { id: 30, kind: 'proposal_moved', message: 'A link that leaves the site.', href: '//evil.example/propose/7', at: at(-2), read: false },
      { id: 29, kind: 'proposal_passed', message: 'Dark mode passed.', href: '/propose/5', at: at(-30), read: true },
    ],
    unread: 2,
  };

  async function withBell(page: Page, context: BrowserContext, baseURL: string | undefined) {
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    const reads = await serve(page, '**/bff/notifications', NOTIFICATIONS);
    const marks = await answer(page, '**/bff/notifications/read', (sent) => {
      const ids = (sent.body as { ids?: number[] }).ids;
      return {
        body: {
          notifications: NOTIFICATIONS.notifications.map((item) => ({ ...item, read: item.read || ids === undefined || ids.includes(item.id) })),
          unread: ids === undefined ? 0 : NOTIFICATIONS.unread - ids.length,
        },
      };
    });
    await serve(page, '**/api/proposals', { proposals: [], testTimers: false });
    await serve(page, '**/bff/proposals/me', { isAdmin: false, testTimers: false });
    await page.goto('/propose');
    return { reads, marks };
  }

  test('shows the unread count, links only within the site, and marks all read', async ({ page, context, baseURL }) => {
    const { marks } = await withBell(page, context, baseURL);
    const bell = page.getByRole('button', { name: 'Notifications: 2 unread' });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('aria-expanded', 'false');

    await bell.click();
    await expect(bell).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`[id="${await bell.getAttribute('aria-controls')}"]`);
    await expect(panel.getByRole('link', { name: /jo seconded/ })).toHaveAttribute('href', '/propose/7');
    // An href that leaves the site is shown as text, never as a link.
    await expect(panel.getByText('A link that leaves the site.')).toBeVisible();
    await expect(panel.getByRole('link', { name: /A link that leaves the site/ })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: /Dark mode passed/ })).toHaveAttribute('href', '/propose/5');

    await panel.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
    expect(marks).toEqual([{ method: 'POST', path: '/bff/notifications/read', query: '', body: {} }]);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeFocused();
  });

  test('opening one marks just that one read, and goes where it points', async ({ page, context, baseURL }) => {
    const { marks } = await withBell(page, context, baseURL);
    await serve(page, '**/api/proposals/7', detail({ you: null }));
    await serve(page, '**/bff/proposals/7', detail({ you: { canComment: true } }));
    await page.getByRole('button', { name: 'Notifications: 2 unread' }).click();
    await page.getByRole('link', { name: /jo seconded/ }).click();
    await expect(page).toHaveURL(/\/propose\/7$/);
    await expect(page.getByRole('button', { name: 'Notifications: 1 unread' })).toBeVisible();
    await expect.poll(() => marks).toEqual([{ method: 'POST', path: '/bff/notifications/read', query: '', body: { ids: [31] } }]);
  });

  test('is in the bar of an app, too', async ({ page, context, baseURL }) => {
    await withBell(page, context, baseURL);
    await serve(page, '**/api/flags', { proposals: true, github_signin: true, upland_data: true });
    await page.goto('/apps/data');
    await expect(page.getByRole('button', { name: 'Notifications: 2 unread' })).toBeVisible();
  });
});

test.describe('at 390 px, signed in', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the nav, the bell’s list and an admin’s proposal page fit the screen', async ({ page, context, baseURL }) => {
    await onProposal(
      page,
      context,
      baseURL,
      detail({ proposal: { state: 'voting', objectionCount: 1 }, you: { canVote: true, canComment: true, isAdmin: true }, extra: { turnout: 2 } }),
      ADMIN,
    );
    await serve(page, '**/bff/notifications', { notifications: [{ id: 1, kind: 'vote_opened', message: 'Voting is open on “Show my properties on a map”.', href: '/propose/7', at: at(-1), read: false }], unread: 1 });
    await page.reload();
    await expect(page.getByRole('group', { name: 'Your vote' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close the vote now' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByRole('button', { name: 'Notifications: 1 unread' }).click();
    const panel = page.locator(`[id="${await page.getByRole('button', { name: /^Notifications/ }).getAttribute('aria-controls')}"]`);
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('pages M5: a 100-character title with no spaces fits on the floor, its page and the bell', async ({ page, context, baseURL }) => {
    const title = 'Add_a_dark_mode_switch_to_the_Data_app_so_night_owls_can_read_their_property_lists_in_comfort_now';
    expect([...title].length).toBeLessThanOrEqual(100);
    expect(title).not.toMatch(/[\s-]/);
    await signInAs(context, baseURL ?? '', MEMBER);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals', { proposals: [card({ title })], testTimers: false });
    await serve(page, '**/api/proposals/7', detail({ proposal: { title }, you: null }));
    await serve(page, '**/bff/proposals/7', detail({ proposal: { title }, you: { canComment: true } }));
    await serve(page, '**/bff/proposals/me', { isAdmin: false, testTimers: false });
    await serve(page, '**/bff/notifications', {
      notifications: [{ id: 1, kind: 'vote_opened', message: `Voting is open on “${title}”.`, href: '/propose/7', at: at(-1), read: false }],
      unread: 1,
    });
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);

    await page.goto('/propose');
    await expect(page.getByRole('link', { name: title })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);

    await page.goto('/propose/7');
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);
    const heading = await page.getByRole('heading', { level: 1 }).evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(heading).toBe(true);

    await page.getByRole('button', { name: 'Notifications: 1 unread' }).click();
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);
  });
});
