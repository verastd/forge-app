import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { PROPOSAL_ERROR_CODES, describeProposalError, didNotGoThrough, notReadBack } from '../../apps/web/src/lib/proposals-format';
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
 * The Phase 6 sections are the house model's draft (contract §10), as an
 * admin sees it above the draft task: every status and reason in its own
 * words, the 5 s reads while it drafts (with the page's clock), "Use the
 * house draft", "Draft it again" and each of its refusals, the keyboard,
 * 390 px, and that members never see it. The F6b sections, and the probes
 * "turned around" in the Phase 6 ones, prove the fixes for the Phase 6 web
 * review (review-house-web.md, H1, M1–M4 and L1–L10).
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

/** What the API answers anyone (no identity): the same proposal, without `you`, the draft task or the house's draft. */
function publicOf(body: Json): Json {
  const { you: _you, draft: _draft, house: _house, ...rest } = body;
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
  async function onForm(page: Page, context: BrowserContext, baseURL: string | undefined, who = MEMBER): Promise<void> {
    await signInAs(context, baseURL ?? '', who);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await serve(page, '**/bff/proposals/me', { isAdmin: who === ADMIN, testTimers: false });
    await page.goto('/propose/new');
    await expect(page.getByRole('heading', { name: 'Bring a proposal', level: 1 })).toBeVisible();
  }

  test('a member’s pitch counts to 4,000, and one longer is caught before it goes', async ({ page, context, baseURL }) => {
    await onForm(page, context, baseURL);
    const created = await answer(page, '**/bff/proposals', () => ({ status: 500, body: {} }));
    await expect(page.getByText('0 / 4000')).toBeVisible();
    await expect(page.getByText(/As an admin/)).toHaveCount(0);
    await page.getByLabel('Title').fill('A map view');
    await page.getByLabel('Your pitch').fill('y'.repeat(4001));
    await expect(page.getByText('4001 / 4000')).toBeVisible();
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.getByText('Keep the pitch to 4000 characters (it has 4001).')).toBeVisible();
    await expect(page.getByLabel('Your pitch')).toBeFocused();
    expect(created).toEqual([]);
  });

  test('an admin’s pitch counts to 50,000, the form says so, and only past that is it caught', async ({ page, context, baseURL }) => {
    await onForm(page, context, baseURL, ADMIN);
    const created = await answer(page, '**/bff/proposals', () => ({
      status: 201,
      body: detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined, deadline: at(168) }, comments: [] }),
    }));
    await serve(page, '**/api/proposals/12', publicOf(detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined } })));
    await serve(page, '**/bff/proposals/12', detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined }, you: { isAdmin: true } }));
    await expect(page.getByText('0 / 50,000')).toBeVisible();
    await expect(page.getByText("As an admin, you can write up to 50,000 characters; everyone else's pitch stops at 4,000.")).toBeVisible();

    await page.getByLabel('Title').fill('A research pitch');
    await page.getByLabel('Your pitch').fill('🏛'.repeat(50001));
    await expect(page.getByText('50,001 / 50,000')).toBeVisible();
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.getByText('Keep the pitch to 50,000 characters (it has 50,001).')).toBeVisible();
    expect(created).toEqual([]);

    await page.getByLabel('Your pitch').fill('🏛'.repeat(50000));
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page).toHaveURL(/\/propose\/12$/);
    expect(created).toEqual([{ method: 'POST', path: '/bff/proposals', query: '', body: { title: 'A research pitch', pitch: '🏛'.repeat(50000) } }]);
  });

  test('an admin’s refusal naming the pitch gives the admin’s limit', async ({ page, context, baseURL }) => {
    await onForm(page, context, baseURL, ADMIN);
    await answer(page, '**/bff/proposals', () => ({ status: 400, body: { error: 'invalid_request', fields: ['pitch'] } }));
    await page.getByLabel('Title').fill('A research pitch');
    await page.getByLabel('Your pitch').fill('\u200b'.repeat(10));
    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Check the pitch (1 to 50,000 characters). Nothing was saved.');
    await expect(page.getByLabel('Your pitch')).toHaveAttribute('aria-invalid', 'true');
  });

  /** The form with `GET /bff/proposals/me` failing (502) until the test says the API is back, and then answering `me`. */
  async function onFormWithoutMe(page: Page, context: BrowserContext, baseURL: string | undefined, who: typeof MEMBER, me: Json) {
    const api = { up: false };
    await signInAs(context, baseURL ?? '', who);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    const reads = await answer(page, '**/bff/proposals/me', () =>
      api.up ? { body: me } : { status: 502, body: { error: 'service_unreachable' } },
    );
    await page.goto('/propose/new');
    await expect(page.getByRole('heading', { name: 'Bring a proposal', level: 1 })).toBeVisible();
    return { api, reads };
  }

  test('review: with `me` failing, an admin’s form says it counts to 4000, and "Try again" brings the admin’s limit back, the pitch kept', async ({
    page,
    context,
    baseURL,
  }) => {
    const pitch = 'Why this research matters to FORGE. '.repeat(1000).slice(0, 34990);
    const { api, reads } = await onFormWithoutMe(page, context, baseURL, ADMIN, { isAdmin: true, testTimers: false });
    const created = await answer(page, '**/bff/proposals', () => ({
      status: 201,
      body: detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined, deadline: at(168) }, comments: [] }),
    }));
    await serve(page, '**/api/proposals/12', publicOf(detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined } })));
    await serve(page, '**/bff/proposals/12', detail({ proposal: { id: 12, title: 'A research pitch', state: 'submitted', seconder: undefined }, you: { isAdmin: true } }));

    // The safe limit, and why: never a quiet 4000.
    const unchecked = page.locator('#proposal-unchecked');
    await expect(unchecked).toHaveText("FORGE couldn't check your account just now, so this form counts the pitch to 4000 characters.");
    await expect(unchecked).toHaveAttribute('role', 'status');
    await expect(page.getByText('0 / 4000')).toBeVisible();
    await expect(page.getByText(/As an admin/)).toHaveCount(0);
    await page.getByLabel('Title').fill('A research pitch');
    await page.getByLabel('Your pitch').fill(pitch);
    await expect(page.getByText('34990 / 4000')).toBeVisible();

    // Still down: it says so again.
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.click();
    await expect(unchecked).toHaveText("FORGE still couldn't check your account, so this form counts the pitch to 4000 characters.");
    expect(reads).toHaveLength(2);

    // Back: the admin's limit, the pitch as it was, and the pitch field next.
    api.up = true;
    await retry.click();
    await expect(unchecked).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByText('34,990 / 50,000')).toBeVisible();
    await expect(page.getByText("As an admin, you can write up to 50,000 characters; everyone else's pitch stops at 4,000.")).toBeVisible();
    await expect(page.getByLabel('Your pitch')).toHaveValue(pitch);
    await expect(page.getByLabel('Your pitch')).toBeFocused();
    expect(created).toEqual([]);

    await page.getByRole('button', { name: 'Put it on the floor' }).click();
    await expect(page).toHaveURL(/\/propose\/12$/);
    expect(created).toEqual([{ method: 'POST', path: '/bff/proposals', query: '', body: { title: 'A research pitch', pitch } }]);
  });

  test('review: "Try again" that finds your proposal already on the floor points at it and keeps what you typed', async ({ page, context, baseURL }) => {
    const { api } = await onFormWithoutMe(page, context, baseURL, MEMBER, { isAdmin: false, activeProposalId: 3, testTimers: false });
    await page.getByLabel('Title').fill('A second idea');
    await page.getByLabel('Your pitch').fill('Pins on a map.');
    api.up = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    const problem = page.locator('main').getByRole('alert');
    await expect(problem).toContainText(describeProposalError('one_active_proposal', 'create'));
    await expect(problem).toBeFocused();
    await expect(problem.getByRole('link', { name: 'See your proposal' })).toHaveAttribute('href', '/propose/3');
    await expect(page.locator('#proposal-unchecked')).toHaveCount(0);
    await expect(page.getByLabel('Title')).toHaveValue('A second idea');
    await expect(page.getByLabel('Your pitch')).toHaveValue('Pins on a map.');
    await expect(page.getByText('14 / 4000')).toBeVisible();
  });

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

  /** Proposal 7 waiting for a second, moved by `who`, who may edit it. */
  const waitingBy = (who: typeof MEMBER, pitch = 'A map with a pin for each property.') =>
    detail({
      proposal: { state: 'submitted', seconder: undefined, mover: who.login, deadline: at(160) },
      comments: [],
      you: { canEdit: true, canWithdraw: true, isAdmin: who === ADMIN },
      extra: { pitch, eligibleCount: undefined, consentCount: undefined },
    });

  test('a member editing counts the pitch to 4,000, and one longer is caught before it goes', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, waitingBy(MEMBER));
    const edits = await answer(page, '**/bff/proposals/7', () => ({ body: waitingBy(MEMBER) }));
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('35 / 4000')).toBeVisible();
    await expect(page.getByText(/As an admin/)).toHaveCount(0);
    await page.getByLabel('Your pitch').fill('y'.repeat(4001));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Keep the pitch to 4000 characters (it has 4001).')).toBeVisible();
    expect(edits.filter((entry) => entry.method === 'PATCH')).toEqual([]);
  });

  test('an admin editing counts the pitch to 50,000, and sends one that long', async ({ page, context, baseURL }) => {
    const pitch = '🏛'.repeat(50000);
    await onProposal(page, context, baseURL, waitingBy(ADMIN), ADMIN);
    const edits = await answer(page, '**/bff/proposals/7', (sent) =>
      sent.method === 'PATCH' ? { body: waitingBy(ADMIN, pitch) } : { body: waitingBy(ADMIN) },
    );
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('35 / 50,000')).toBeVisible();
    await expect(page.getByText("As an admin, you can write up to 50,000 characters; everyone else's pitch stops at 4,000.")).toBeVisible();
    await page.getByLabel('Your pitch').fill(`${pitch}🏛`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Keep the pitch to 50,000 characters (it has 50,001).')).toBeVisible();
    expect(edits.filter((entry) => entry.method === 'PATCH')).toEqual([]);

    await page.getByLabel('Your pitch').fill(pitch);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(outcome(page, 'part')).toContainText('Saved. The floor sees your changes.');
    expect(edits.filter((entry) => entry.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/bff/proposals/7', query: '', body: { title: 'Show my properties on a map', pitch } },
    ]);
  });

  test('an admin’s edit refused for its pitch gives the admin’s limit', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, waitingBy(ADMIN), ADMIN);
    await answer(page, '**/bff/proposals/7', (sent) =>
      sent.method === 'PATCH' ? { status: 400, body: { error: 'invalid_request', fields: ['pitch'] } } : { body: waitingBy(ADMIN) },
    );
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Your pitch').fill('A longer pitch.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(outcome(page, 'part')).toContainText('Check the pitch (1 to 50,000 characters). Nothing was saved.');
  });

  test('an admin’s long pitch opens with its first 4,000 characters, and the rest is a button away', async ({ page, context, baseURL }) => {
    const paragraph = 'Why this research matters to FORGE, said plainly. '.repeat(20).trim();
    const pitch = Array.from({ length: 40 }, () => paragraph).join('\n\n').slice(0, 34990);
    await onProposal(page, context, baseURL, detail({ extra: { pitch } }));
    const section = page.getByRole('region', { name: 'The pitch' });
    const text = section.locator('#pitch-text');
    const more = section.getByRole('button', { name: 'Read the whole pitch (34,990 characters)' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveAttribute('aria-controls', 'pitch-text');
    const opening = (await text.textContent()) ?? '';
    expect(opening.endsWith('…')).toBe(true);
    expect(pitch.startsWith(opening.slice(0, -1))).toBe(true);
    expect(Array.from(opening).length).toBeLessThanOrEqual(4001);
    // The rest of the page is still within reach: your part sits right below.
    await expect(yourPart(page)).toBeVisible();

    await more.click();
    const less = section.getByRole('button', { name: 'Show less of the pitch' });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(less).toBeFocused();
    expect(await text.textContent()).toBe(pitch);
    await less.click();
    await expect(more).toBeFocused();
    await expect(more).toBeInViewport();
    expect(await text.textContent()).toBe(opening);
  });

  test('a pitch a member may write shows whole, with no button', async ({ page, context, baseURL }) => {
    const pitch = `${'y'.repeat(1999)}\n\n${'z'.repeat(1999)}`;
    await onProposal(page, context, baseURL, detail({ extra: { pitch } }));
    const section = page.getByRole('region', { name: 'The pitch' });
    await expect(section.getByRole('button')).toHaveCount(0);
    expect(await section.locator('p').textContent()).toBe(pitch);
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
      house_busy: { status: 409 },
      house_off: { status: 503, body: { reason: 'switched_off' } },
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
        ...(code === 'house_off' ? { reason: 'switched_off' } : {}),
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

  /** The operator's research pitch: 34,990 characters in paragraphs. */
  const researchPitch = (): string => {
    const paragraph = 'Why this research matters to FORGE, said plainly. '.repeat(20).trim();
    return Array.from({ length: 60 }, () => paragraph).join('\n\n').slice(0, 34990);
  };

  test('review: an admin’s long pitch fits the screen folded and open, and its button’s whole label shows', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, detail({ extra: { pitch: researchPitch() } }));
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    const section = page.getByRole('region', { name: 'The pitch' });
    const more = section.getByRole('button', { name: 'Read the whole pitch (34,990 characters)' });
    await expect(more).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);
    const box = await more.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
    expect(await more.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);

    await more.click();
    await expect(section.getByRole('button', { name: 'Show less of the pitch' })).toBeFocused();
    expect(await width()).toBeLessThanOrEqual(390);
  });

  test('review: an open long pitch can be folded from anywhere in it, and folding it lands on its button, clear of the nav', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, detail({ extra: { pitch: researchPitch() } }));
    const section = page.getByRole('region', { name: 'The pitch' });
    const more = section.getByRole('button', { name: 'Read the whole pitch (34,990 characters)' });
    await more.click();
    const less = section.getByRole('button', { name: 'Show less of the pitch' });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(less).toHaveAttribute('aria-controls', 'pitch-text');

    // Near the top of the open pitch and halfway down it, the button is on screen, at its foot.
    for (const share of [0.05, 0.5]) {
      await section.evaluate((element, at) => {
        const box = element.getBoundingClientRect();
        window.scrollTo(0, window.scrollY + box.top + box.height * at);
      }, share);
      await expect(less).toBeInViewport();
      const stuck = await less.boundingBox();
      expect(stuck?.y ?? 0).toBeGreaterThan(844 / 2);
      expect((stuck?.y ?? 0) + (stuck?.height ?? Infinity)).toBeLessThanOrEqual(844);
    }

    await less.click();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeInViewport();
    const nav = await page.getByRole('banner').boundingBox();
    const back = await more.boundingBox();
    expect(back?.y ?? 0).toBeGreaterThanOrEqual((nav?.y ?? 0) + (nav?.height ?? Infinity));
    // Folded, the rest of the page is close again: your part starts within a screen of the button.
    const part = await yourPart(page).boundingBox();
    expect((part?.y ?? Infinity) - (back?.y ?? 0)).toBeLessThan(844);
  });

  test('review: the admin’s edit and draft-task views under a long pitch fit the screen', async ({ page, context, baseURL }) => {
    const pitch = researchPitch();
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    await onProposal(
      page,
      context,
      baseURL,
      detail({
        proposal: { state: 'submitted', seconder: undefined, mover: ADMIN.login, deadline: at(160) },
        comments: [],
        you: { canEdit: true, canWithdraw: true, isAdmin: true },
        extra: { pitch, eligibleCount: undefined, consentCount: undefined },
      }),
      ADMIN,
    );
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('34,990 / 50,000')).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);

    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith(undefined, { draft: { ...PLAIN_DRAFT, civilianSummary: pitch.replace(/\n+/g, ' ') }, extra: { pitch } }));
    await page.reload();
    await expect(adminPanel(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read the whole pitch (34,990 characters)' })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);
  });
});

/* --- Phase 6: the house model's draft (contract §10) ------------------------------------------ */

const HOUSE_SPEC = {
  title: 'Show my properties on a map in the Data app',
  civilianSummary: 'A map view in the Data app: a pin for each property, a tap on a pin to see its row, and the same filters as the table.',
  acceptanceCriteria: [
    'The Data app has a Map view with one pin for each property in the list.',
    "Tapping a pin shows that property's row.",
    "The table's filters apply to the map.",
  ],
  size: 'M',
  tierFloor: 'T1',
  scopeIn: ['apps/web/src/app/apps/data/**', 'tests/e2e/data-app.spec.ts'],
  scopeOut: ['apps/api/**'],
  risks: ['A map library would be a new dependency, which needs approval.'],
  questions: ['Should a pin show the address, or only open the row?'],
  verdict: 'ready',
  verdictReason: 'Clear, and small enough for one task.',
};

/** A second spec, as "Draft it again" might write it. */
const HOUSE_SPEC_B = {
  ...HOUSE_SPEC,
  title: 'Add a Map tab to the Data app',
  civilianSummary: 'A Map tab in the Data app, with a pin for each property.',
  acceptanceCriteria: ['The Data app has a Map tab.', "A pin opens its property's row."],
  size: 'S',
  verdictReason: 'Clear, and smaller as a tab.',
};

/** The draft a pass makes: the proposal's title, its pitch as the summary, no criteria. */
const PLAIN_DRAFT = {
  title: 'Show my properties on a map',
  civilianSummary: 'A map with a pin for each property.',
  acceptanceCriteria: [],
  size: 'S',
  tierFloor: 'T0',
  rewardClass: 'none',
};

/** The same draft once the house's spec filled it: its title, summary, criteria and size; T0 and the reward as they were. */
const HOUSE_FILLED_DRAFT = {
  title: HOUSE_SPEC.title,
  civilianSummary: HOUSE_SPEC.civilianSummary,
  acceptanceCriteria: HOUSE_SPEC.acceptanceCriteria,
  size: 'M',
  tierFloor: 'T0',
  rewardClass: 'none',
};

/** The same draft once the second spec filled it again (nobody had saved it). */
const HOUSE_B_FILLED_DRAFT = {
  ...HOUSE_FILLED_DRAFT,
  title: HOUSE_SPEC_B.title,
  civilianSummary: HOUSE_SPEC_B.civilianSummary,
  acceptanceCriteria: HOUSE_SPEC_B.acceptanceCriteria,
  size: 'S',
};

/** An admin's own saved draft, which the house leaves alone. */
const SAVED_DRAFT = {
  title: 'Map view for properties',
  civilianSummary: 'Pins on a map in the Data app.',
  acceptanceCriteria: ['A pin for every property'],
  size: 'S',
  tierFloor: 'T0',
  rewardClass: 'R1',
};

const HOUSE_LINE = "FORGE's house model drafted the task from this proposal. An admin checks it before it goes on the Contribute board.";
/** The block while `queued` (it may be waiting to try again) and while `running`. */
const QUEUED = 'The house model will draft this task shortly…';
const DRAFTING = 'The house model is drafting this task…';
const NOT_YET = "The house model hasn't drafted this task yet. Ask for a draft with Draft it again, or write it yourself.";
/** The admin's outcome line once "Draft it again" went through: "again" only when there was a draft before. */
const DRAFTING_AGAIN = "The house model is drafting it again. Its new draft shows below when it's ready.";
const DRAFTING_FIRST = "The house model is drafting this task. Its draft shows below when it's ready.";
/** Where the house's draft is, beside the form (F6b, review M1–M3). */
const IN_THE_FORM = 'Its draft is in the form below. Check every line before you publish.';
const USED = 'The house draft is in the form below. Nothing is saved until you save or publish.';
const HELD = 'Its draft is saved, but the form below still has the changes you were making.';
const EARLIER = 'Its draft is saved, but the form below still has the earlier draft.';
const CHANGED_SINCE = 'Its draft filled the draft task, but changes have been saved since.';
const NOT_REPLACED = "You had already saved the draft, so it wasn't replaced.";
/** A member's own view whose last read through the BFF failed (F6b, review H1). */
const STALE_VIEW = "Couldn't refresh your view just now. What you see may be out of date; it tries again shortly.";
/** The house block after 3 failed reads in a row while it drafts (review L1). */
const UNCHECKED = "Couldn't check on the house model's draft. Trying again every minute.";

/** What an admin is writing in the draft form, unsaved, when something goes wrong. */
const TYPED_SUMMARY = 'Half an hour of my own careful words about what the agent must do.';
const TYPED_CRITERIA = 'First criterion I wrote.\nSecond criterion I wrote.';

function doneHouse(overrides: Json = {}): Json {
  return { status: 'done', spec: HOUSE_SPEC, model: 'claude-opus-5-5', draftedAt: '2026-10-03T09:30:00Z', appliedToDraft: true, ...overrides };
}

/** A passed proposal as an admin reads it: the draft task, and the house model's draft when there is one. */
function passedWith(house: Json | undefined, options: { draft?: Json; proposal?: Json; you?: Json; extra?: Json } = {}): Json {
  return detail({
    proposal: { state: 'passed', deadline: undefined, ...options.proposal },
    you: { isAdmin: true, ...options.you },
    extra: { consentCount: 5, draft: options.draft ?? PLAIN_DRAFT, ...(house === undefined ? {} : { house }), ...options.extra },
  });
}

/** `body` with one more timeline line, "Read <n>.", so a test can see that read land on screen. */
function marked(body: Json, n: number): Json {
  return { ...body, events: [...(body.events as Json[]), { at: at(-0.5), kind: 'commented', message: `Read ${n}.` }] };
}

const adminPanel = (page: Page) => page.getByRole('region', { name: 'Admin' });
const houseBlock = (page: Page) => adminPanel(page).getByRole('group', { name: 'House draft' });
const timelineOf = (page: Page) => page.getByRole('region', { name: 'Timeline' });
/** The house block's status line beside the form: always there, filled once its draft is in the form, unsaved. */
const houseStatus = (page: Page) => houseBlock(page).locator('#house-status');
/** The page's "may be out of date" line: always there, filled while your own view couldn't be read again. */
const staleView = (page: Page) => page.locator('#view-stale');

/** Hide or show the tab, as the browser would say it. */
async function setVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** An answer held back until the test lets it go. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * An admin on proposal 7 whose BFF reads are answered by `reply(n)`, n counting from 1 (the page's first
 * read), each marked "Read n." on the timeline. Resolves once the first has landed; returns every read.
 */
async function onHouseProposal(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  reply: (n: number) => Json,
): Promise<Sent[]> {
  await signInAs(context, baseURL ?? '', ADMIN);
  await serviceDown(page);
  await openProposals(page);
  await serve(page, '**/api/proposals/7', publicOf(reply(1)));
  await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
  const reads = await answer(page, '**/bff/proposals/7', (_sent, n) => ({ body: marked(reply(n), n) }));
  await page.goto('/propose/7');
  await expect(timelineOf(page).getByText('Read 1.')).toBeVisible();
  return reads;
}

/**
 * An admin on proposal 7 whose public reads always work, and whose BFF reads answer `body` unless `failure()`
 * says otherwise. Resolves once the admin panel is up; returns the public reads and the BFF reads.
 */
async function onFlakyBff(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  body: Json,
  failure: () => Reply | null,
): Promise<{ publicReads: Sent[]; bffReads: Sent[] }> {
  await signInAs(context, baseURL ?? '', ADMIN);
  await serviceDown(page);
  await openProposals(page);
  const publicReads = await serve(page, '**/api/proposals/7', publicOf(body));
  await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
  const bffReads = await answer(page, '**/bff/proposals/7', () => failure() ?? { body });
  await page.goto('/propose/7');
  await expect(adminPanel(page).getByLabel('Task title')).toBeVisible();
  await expect(staleView(page)).toHaveText('');
  return { publicReads, bffReads };
}

/** The admin writes in the draft form, and saves nothing. */
async function typeOwnDraft(page: Page): Promise<void> {
  const admin = adminPanel(page);
  await admin.getByLabel('Plain summary').fill(TYPED_SUMMARY);
  await admin.getByLabel('What done means').fill(TYPED_CRITERIA);
}

/** What the admin wrote is still in the form, panel and all. */
async function expectOwnDraft(page: Page): Promise<void> {
  const admin = adminPanel(page);
  await expect(admin.getByLabel('Plain summary')).toHaveValue(TYPED_SUMMARY);
  await expect(admin.getByLabel('What done means')).toHaveValue(TYPED_CRITERIA);
  await expect(page.getByText("Your actions can't load right now. Try again.")).toHaveCount(0);
}

interface ReadTime {
  start: number;
  end: number;
}

/** Logs, in the page, when each read of proposal 7 through the BFF starts and ends, on the page's own clock. */
async function logReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const log: Array<{ start: number; end: number }> = [];
    (window as unknown as { __houseReads: typeof log }).__houseReads = log;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/bff\/proposals\/7$/.test(url) || (init?.method ?? 'GET') !== 'GET') return realFetch(input, init);
      const entry = { start: Date.now(), end: Number.NaN };
      log.push(entry);
      try {
        return await realFetch(input, init);
      } finally {
        entry.end = Date.now();
      }
    };
  });
}

async function readLog(page: Page): Promise<ReadTime[]> {
  return page.evaluate(() => (window as unknown as { __houseReads: ReadTime[] }).__houseReads);
}

test.describe('Phase 6 · the house model’s draft: every status and reason in its own words', () => {
  const SAID: Array<[string, Json, string]> = [
    ['off, no key on the server', { status: 'off', reason: 'not_configured' }, "The house model is off: FORGE's server has no key for it yet. Write the draft yourself."],
    ['off, switched off', { status: 'off', reason: 'switched_off' }, "The house model is off: it is switched off on FORGE's server. Write the draft yourself."],
    ['off, with no reason', { status: 'off' }, 'The house model is off. Write the draft yourself.'],
    ['failed, refused', { status: 'failed', reason: 'refused' }, 'The house model declined to draft this task. Write the draft yourself.'],
    ['failed, invalid_output', { status: 'failed', reason: 'invalid_output' }, "The house model's draft didn't hold together, twice in a row. Draft it again, or write it yourself."],
    ['failed, unavailable', { status: 'failed', reason: 'unavailable' }, "The house model couldn't be reached, even after four tries. Draft it again later, or write it yourself."],
    ['failed, too_large', { status: 'failed', reason: 'too_large' }, 'This proposal and its debate are too long for the house model. Write the draft yourself.'],
    ['failed, bad_request', { status: 'failed', reason: 'bad_request' }, "FORGE's request to the house model was refused, so its setup on the server needs checking. Write the draft yourself."],
    // Review L8(c): the limit counts a UTC day.
    ['failed, daily_limit', { status: 'failed', reason: 'daily_limit' }, 'The house model reached its daily limit before it got to this task. Draft it again after midnight UTC, or write it yourself.'],
    ['failed, with no reason', { status: 'failed' }, NOT_YET],
  ];
  for (const [name, house, sentence] of SAID) {
    // Review L8(e): while it is off, "Draft it again" could only be refused, so it isn't offered.
    const off = house.status === 'off';
    test(`${name}: its sentence, above the draft form, ${off ? 'with nothing to ask for' : 'with "Draft it again"'}`, async ({ page, context, baseURL }) => {
      await onProposal(page, context, baseURL, passedWith(house), ADMIN);
      const block = houseBlock(page);
      await expect(block.getByText(sentence, { exact: true })).toBeVisible();
      await expect(block.getByRole('button', { name: 'Draft it again' })).toHaveCount(off ? 0 : 1);
      // No draft of its own to show, so no verdict and nothing to use.
      await expect(block.getByRole('button', { name: 'Use the house draft' })).toHaveCount(0);
      await expect(block.getByRole('list')).toHaveCount(0);
      // Above the draft task's form, which an admin can fill in the meantime.
      await expect(adminPanel(page).getByLabel('Task title')).toHaveValue(PLAIN_DRAFT.title);
      const above = await block.evaluate((element) => {
        const form = document.getElementById('draft-title');
        return form !== null && (element.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(above).toBe(true);
    });
  }

  test('queued, then running: what it is doing, with no buttons; a draft from before stays out of the way', async ({
    page,
    context,
    baseURL,
  }) => {
    // Review L8(a): queued may be a wait to try again, so it isn't "drafting" yet.
    await onProposal(page, context, baseURL, passedWith({ status: 'queued' }), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText(QUEUED, { exact: true })).toBeVisible();
    await expect(block.getByText(DRAFTING, { exact: true })).toHaveCount(0);
    await expect(block.getByRole('button')).toHaveCount(0);

    // Drafting again: the last draft is in the answer, and waits until the new one lands.
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith(doneHouse({ status: 'running' })));
    await page.reload();
    await expect(block.getByText(DRAFTING, { exact: true })).toBeVisible();
    await expect(block.getByText(QUEUED, { exact: true })).toHaveCount(0);
    await expect(block.getByText('Ready', { exact: true })).toHaveCount(0);
    await expect(block.getByRole('button')).toHaveCount(0);
  });

  test('done: the verdict and its reason, the questions, risks and scope, who drafted it and when; its draft is in the form', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT }), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText('Ready', { exact: true })).toBeVisible();
    await expect(block.getByText('Clear, and small enough for one task.')).toBeVisible();
    await expect(block.getByRole('list', { name: 'Questions for the mover' }).getByRole('listitem')).toHaveText(HOUSE_SPEC.questions);
    await expect(block.getByRole('list', { name: 'Risks' }).getByRole('listitem')).toHaveText(HOUSE_SPEC.risks);
    await expect(block.getByRole('list', { name: 'Scope in' }).getByRole('listitem')).toHaveText(HOUSE_SPEC.scopeIn);
    await expect(block.getByRole('list', { name: 'Scope out' }).getByRole('listitem')).toHaveText(HOUSE_SPEC.scopeOut);
    await expect(block.getByText(/^Drafted by claude-opus-5-5 on .*2026\.$/)).toBeVisible();
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
    await expect(houseStatus(page)).toHaveText('');
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Draft it again' })).toBeVisible();

    // The form holds the house's draft; the tier stays T0 whatever the house suggested.
    const admin = adminPanel(page);
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(admin.getByLabel('Plain summary')).toHaveValue(HOUSE_SPEC.civilianSummary);
    await expect(admin.getByLabel('What done means')).toHaveValue(HOUSE_SPEC.acceptanceCriteria.join('\n'));
    await expect(admin.getByLabel('Size')).toHaveValue('M');
    await expect(admin.getByRole('group', { name: 'Tier floor' })).toContainText('T0');
  });

  test('every verdict has its chip; empty lists say so, and no questions means no questions heading', async ({ page, context, baseURL }) => {
    const empty = { ...HOUSE_SPEC, risks: [], scopeIn: [], scopeOut: [], questions: [] };
    await onProposal(page, context, baseURL, passedWith(doneHouse({ spec: { ...empty, verdict: 'needs_clarification' } })), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText('Needs answers from the mover', { exact: true })).toBeVisible();
    await expect(block.getByText('Questions for the mover')).toHaveCount(0);
    await expect(block.getByText('None noted.', { exact: true })).toBeVisible();
    await expect(block.getByText('No paths named.', { exact: true })).toHaveCount(2);

    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith(doneHouse({ spec: { ...HOUSE_SPEC, verdict: 'not_feasible' } })));
    await page.reload();
    await expect(block.getByText('Not feasible', { exact: true })).toBeVisible();
    await expect(block.getByText('Ready', { exact: true })).toHaveCount(0);
  });

  test('a failure after an earlier draft says why, and still shows the earlier draft', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse({ status: 'failed', reason: 'unavailable', appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText("The house model couldn't be reached, even after four tries. Draft it again later, or write it yourself.")).toBeVisible();
    await expect(block.getByText('Ready', { exact: true })).toBeVisible();
    await expect(block.getByText(NOT_REPLACED, { exact: true })).toBeVisible();
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toBeVisible();
    await expect(block.getByRole('button', { name: 'Draft it again' })).toBeVisible();
  });

  test('P10 turned around (review L5): `done` with no draft to show reads as a task it hasn’t drafted yet', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, passedWith({ status: 'done', model: 'claude-opus-5-5', appliedToDraft: true }), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText(NOT_YET, { exact: true })).toBeVisible();
    await expect(block.getByRole('button', { name: 'Draft it again' })).toBeVisible();
    await expect(block.getByText(/^Drafted by/)).toHaveCount(0);
  });
});

test.describe('Phase 6 · while the house model drafts, the page reads every 5 s, one read at a time', () => {
  // The page's clock is Playwright's: it runs in real time once installed, and `runFor` moves it on. Reads are
  // counted from the page's first one, and the page logs when each read starts and ends on that same clock.

  test('it starts while queued or running, waits 5 s after each read, and stops once the draft is done', async ({
    page,
    context,
    baseURL,
  }) => {
    await logReads(page);
    await page.clock.install();
    const reads = await onHouseProposal(page, context, baseURL, (n) =>
      n === 1 ? passedWith({ status: 'queued' }) : n < 4 ? passedWith({ status: 'running' }) : passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT }),
    );
    await expect(houseBlock(page).getByText(QUEUED, { exact: true })).toBeVisible();
    for (const n of [2, 3, 4]) {
      await page.clock.runFor(5_000);
      await expect(timelineOf(page).getByText(`Read ${n}.`)).toBeVisible();
    }
    const block = houseBlock(page);
    await expect(block.getByText('Ready', { exact: true })).toBeVisible();
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
    // The form was still the plain draft the pass made, untouched, so it took the draft the house filled.
    await expect(adminPanel(page).getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(adminPanel(page).getByLabel('What done means')).toHaveValue(HOUSE_SPEC.acceptanceCriteria.join('\n'));

    // Done: no more reads.
    await page.clock.runFor(15_000);
    await page.waitForTimeout(200);
    expect(reads).toHaveLength(4);
    // Each read began at least 5 s after the one before it had ended, on the page's own clock.
    const log = await readLog(page);
    expect(log).toHaveLength(4);
    for (let index = 1; index < log.length; index += 1) {
      const gap = (log[index]?.start ?? 0) - (log[index - 1]?.end ?? Infinity);
      expect(gap, `read ${index + 1}`).toBeGreaterThanOrEqual(5_000);
    }
  });

  test('a hidden tab stops it; coming back reads at once and goes on', async ({ page, context, baseURL }) => {
    await page.clock.install();
    const reads = await onHouseProposal(page, context, baseURL, () => passedWith({ status: 'queued' }));
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();

    await setVisibility(page, 'hidden');
    await page.clock.runFor(30_000);
    await page.waitForTimeout(200);
    expect(reads).toHaveLength(2);

    await setVisibility(page, 'visible');
    await expect(timelineOf(page).getByText('Read 3.')).toBeVisible();
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 4.')).toBeVisible();
  });

  test('leaving the page stops it', async ({ page, context, baseURL }) => {
    await page.clock.install();
    const reads = await onHouseProposal(page, context, baseURL, () => passedWith({ status: 'queued' }));
    await serve(page, '**/api/proposals', { proposals: [card({ state: 'passed', deadline: undefined })], testTimers: false });
    await serve(page, '**/bff/notifications', { notifications: [], unread: 0 });
    await page.getByRole('link', { name: '← All proposals' }).click();
    await expect(page.getByRole('heading', { name: 'Propose', level: 1 })).toBeVisible();
    await page.clock.runFor(30_000);
    await page.waitForTimeout(200);
    expect(reads).toHaveLength(1);
  });

  test('a slow answer is waited for: no read starts on top of one', async ({ page, context, baseURL }) => {
    await logReads(page);
    await page.clock.install();
    const slow = gate();
    let started = 0;
    await signInAs(context, baseURL ?? '', ADMIN);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals/7', publicOf(passedWith({ status: 'queued' })));
    await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
    await page.route('**/bff/proposals/7', async (route) => {
      started += 1;
      const n = started;
      // The page's second read (its first 5 s one) is slow.
      if (n === 2) await slow.wait;
      await route
        .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(marked(passedWith({ status: 'queued' }), n)) })
        .catch(() => undefined);
    });
    await page.goto('/propose/7');
    await expect(timelineOf(page).getByText('Read 1.')).toBeVisible();

    await page.clock.runFor(5_000);
    await expect.poll(() => started).toBe(2);
    // Six more seconds (inside the read's own 8 s limit) with that read still out: no other read starts.
    await page.clock.runFor(6_000);
    await page.waitForTimeout(200);
    expect(started).toBe(2);

    slow.open();
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 3.')).toBeVisible();
    const log = await readLog(page);
    expect(log).toHaveLength(3);
    expect((log[2]?.start ?? 0) - (log[1]?.end ?? Infinity)).toBeGreaterThanOrEqual(5_000);
  });

  test('a read that fails while it drafts keeps the page: the panel and what the admin is typing stay, and it says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    await signInAs(context, baseURL ?? '', ADMIN);
    await serviceDown(page);
    await openProposals(page);
    const publicReads = await serve(page, '**/api/proposals/7', publicOf(passedWith({ status: 'queued' })));
    await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
    let n = 0;
    await page.route('**/bff/proposals/7', async (route) => {
      n += 1;
      // The page's second read (its first 5 s one) gets no answer at all.
      if (n === 2) {
        await route.abort();
        return;
      }
      const body = n === 1 ? passedWith({ status: 'queued' }) : passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(marked(body, n)) });
    });
    await page.goto('/propose/7');
    await expect(timelineOf(page).getByText('Read 1.')).toBeVisible();
    const admin = adminPanel(page);
    await admin.getByLabel('Plain summary').fill('My own words.');
    const before = publicReads.length;

    await page.clock.runFor(5_000);
    await expect.poll(() => n).toBe(2);
    // Still the admin's page, waiting on the house, with what they typed; nothing read in public in its place.
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    await expect(houseBlock(page).getByText(QUEUED, { exact: true })).toBeVisible();
    await expect(admin.getByLabel('Plain summary')).toHaveValue('My own words.');
    await expect(page.getByText("Your actions can't load right now. Try again.")).toHaveCount(0);
    expect(publicReads).toHaveLength(before);

    // The next read lands the draft: the changes being made are kept, and the block says so.
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 3.')).toBeVisible();
    await expect(staleView(page)).toHaveText('');
    await expect(houseBlock(page).getByText(HELD, { exact: true })).toBeVisible();
    await expect(admin.getByLabel('Plain summary')).toHaveValue('My own words.');
  });

  test('changes being made when its draft lands are kept, and it says so; "Use the house draft" brings it in', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    await onHouseProposal(page, context, baseURL, (n) =>
      n === 1 ? passedWith({ status: 'running' }) : passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT }),
    );
    const admin = adminPanel(page);
    await expect(admin.getByLabel('Task title')).toHaveValue(PLAIN_DRAFT.title);

    // The admin starts on the summary while the house drafts.
    await admin.getByLabel('Plain summary').fill('My own words.');
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    const block = houseBlock(page);
    await expect(block.getByText(HELD, { exact: true })).toBeVisible();
    await expect(admin.getByLabel('Plain summary')).toHaveValue('My own words.');
    await expect(admin.getByLabel('Task title')).toHaveValue(PLAIN_DRAFT.title);

    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Plain summary')).toHaveValue(HOUSE_SPEC.civilianSummary);
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    // It is saved already (the house filled the draft), so it is in both.
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
    await expect(block.getByText(HELD, { exact: true })).toHaveCount(0);
  });
});

test.describe('Phase 6 · "Use the house draft" and "Draft it again"', () => {
  test('"Use the house draft" fills the title, summary, criteria and size without saving; the reward stays yours', async ({
    page,
    context,
    baseURL,
  }) => {
    const notApplied = (draft: Json) => passedWith(doneHouse({ appliedToDraft: false }), { draft });
    await onProposal(page, context, baseURL, notApplied(SAVED_DRAFT), ADMIN);
    const saves = await answer(page, '**/bff/proposals/7/admin/draft-task', (sent) => ({ body: notApplied(sent.body as Json) }));
    const admin = adminPanel(page);
    const block = houseBlock(page);
    await expect(block.getByText(NOT_REPLACED, { exact: true })).toBeVisible();
    await expect(admin.getByLabel('Task title')).toHaveValue(SAVED_DRAFT.title);

    await admin.getByLabel('Reward').selectOption('R3');
    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(admin.getByLabel('Plain summary')).toHaveValue(HOUSE_SPEC.civilianSummary);
    await expect(admin.getByLabel('What done means')).toHaveValue(HOUSE_SPEC.acceptanceCriteria.join('\n'));
    await expect(admin.getByLabel('Size')).toHaveValue('M');
    await expect(admin.getByLabel('Reward')).toHaveValue('R3');
    await expect(admin.getByRole('group', { name: 'Tier floor' })).toContainText('T0');
    // Review M4: focus goes to the line that says what happened, not into the form.
    await expect(houseStatus(page)).toHaveText(USED);
    await expect(houseStatus(page)).toBeFocused();
    await expect(block.getByText(NOT_REPLACED, { exact: true })).toHaveCount(0);
    expect(saves).toEqual([]);

    // Saving sends what the form now says; then the house's draft is in the form and saved.
    await admin.getByRole('button', { name: 'Save draft' }).click();
    await expect(outcome(page, 'admin')).toHaveText('Draft saved.');
    expect(saves).toEqual([
      {
        method: 'PUT',
        path: '/bff/proposals/7/admin/draft-task',
        query: '',
        body: { ...HOUSE_FILLED_DRAFT, rewardClass: 'R3' },
      },
    ]);
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
    await expect(houseStatus(page)).toHaveText('');
  });

  test('"Draft it again" asks first, then posts with no body; the house drafts, and its draft shows when it lands', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    const reads = await onHouseProposal(page, context, baseURL, (n) =>
      n === 1 ? passedWith({ status: 'failed', reason: 'unavailable' }) : passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT }),
    );
    const posts = await answer(page, '**/bff/proposals/7/admin/house-draft', () => ({ status: 202, body: { status: 'queued' } }));
    const block = houseBlock(page);

    await block.getByRole('button', { name: 'Draft it again' }).click();
    await expect(block.getByRole('group', { name: /^Draft it again\?/ })).toContainText(
      'Draft it again? The house model writes a new draft from the proposal and its debate. It replaces the draft task only if nobody has saved it yet.',
    );
    await block.getByRole('button', { name: 'Not yet' }).click();
    await expect(block.getByRole('button', { name: 'Draft it again' })).toBeFocused();
    expect(posts).toEqual([]);

    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    // Review L8(b): it had never drafted this task, so not "again".
    await expect(outcome(page, 'admin')).toHaveText(DRAFTING_FIRST);
    await expect(outcome(page, 'admin')).toBeFocused();
    await expect(block.getByText(QUEUED, { exact: true })).toBeVisible();
    await expect(block.getByRole('button')).toHaveCount(0);
    expect(posts).toEqual([{ method: 'POST', path: '/bff/proposals/7/admin/house-draft', query: '', body: undefined }]);
    // The answer was the house's new state: nothing had to be read again.
    expect(reads).toHaveLength(1);

    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await expect(block.getByText('Ready', { exact: true })).toBeVisible();
    await expect(adminPanel(page).getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await page.clock.runFor(15_000);
    await page.waitForTimeout(200);
    expect(reads).toHaveLength(2);
  });

  test('every refusal of "Draft it again" is said in its own words; the step stays open, and a stale page reads again', async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const reads = await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    const REFUSALS: Array<{ name: string; status: number; body: Json; headers?: Record<string, string>; sentence: string; readsAgain?: true }> = [
      {
        name: 'wrong_state',
        status: 409,
        body: { error: 'wrong_state', state: 'building' },
        sentence: "It can't be drafted again (it is being built): the house model drafts a task only after it passes and before it is published. Nothing changed.",
        readsAgain: true,
      },
      {
        name: 'house_busy',
        status: 409,
        body: { error: 'house_busy' },
        sentence: "The house model is already drafting this task, so nothing changed. Its new draft shows here when it's ready.",
        readsAgain: true,
      },
      {
        name: 'house_off, not_configured',
        status: 503,
        body: { error: 'house_off', reason: 'not_configured' },
        sentence: "The house model is off (FORGE's server has no key for it yet), so nothing changed. Write the draft yourself.",
        readsAgain: true,
      },
      {
        name: 'house_off, switched_off',
        status: 503,
        body: { error: 'house_off', reason: 'switched_off' },
        sentence: "The house model is off (it is switched off on FORGE's server), so nothing changed. Write the draft yourself.",
        readsAgain: true,
      },
      {
        name: 'rate_limited, five drafts of this proposal in a day',
        status: 429,
        body: { error: 'rate_limited', retryAfter: 7200, limit: 5 },
        headers: { 'retry-after': '7200' },
        sentence: 'The house model has drafted this proposal as often as FORGE allows in a day (5). Try again in about 2 hours.',
      },
      {
        name: 'rate_limited, the daily limit across the floor',
        status: 429,
        body: { error: 'rate_limited', retryAfter: 600, limit: 30 },
        headers: { 'retry-after': '600' },
        sentence: 'The house model has made as many drafts today as FORGE allows across the floor (30). Try again in about 10 minutes.',
      },
      // Review L8(d): the API names which limit it was, so a daily limit set to 5 reads as the daily one.
      {
        name: 'rate_limited, the daily limit set to 5, scope daily',
        status: 429,
        body: { error: 'rate_limited', retryAfter: 600, limit: 5, scope: 'daily' },
        headers: { 'retry-after': '600' },
        sentence: 'The house model has made as many drafts today as FORGE allows across the floor (5). Try again in about 10 minutes.',
      },
      {
        name: 'rate_limited, five drafts of this proposal, scope proposal',
        status: 429,
        body: { error: 'rate_limited', retryAfter: 3600, limit: 5, scope: 'proposal' },
        headers: { 'retry-after': '3600' },
        sentence: 'The house model has drafted this proposal as often as FORGE allows in a day (5). Try again in about 60 minutes.',
      },
      { name: 'admin_only', status: 403, body: { error: 'admin_only' }, sentence: "Only FORGE's admins can do that." },
      {
        name: 'not_configured (the BFF)',
        status: 503,
        body: { error: 'not_configured' },
        sentence: "FORGE couldn't reach its service just now, so nothing changed. Try again in a minute.",
      },
    ];
    let current = REFUSALS[0];
    const posts = await answer(page, '**/bff/proposals/7/admin/house-draft', () => ({
      status: current?.status ?? 500,
      body: { ...current?.body, message: 'The API’s own words.' },
      headers: current?.headers ?? {},
    }));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    for (const refusal of REFUSALS) {
      current = refusal;
      const before = reads.length;
      await block.getByRole('button', { name: 'Yes, draft it again' }).click();
      const alert = outcome(page, 'admin').getByRole('alert');
      await expect(alert, refusal.name).toHaveText(refusal.sentence);
      await expect(alert, refusal.name).not.toContainText('The API’s own words.');
      await expect(outcome(page, 'admin'), refusal.name).toBeFocused();
      if (refusal.readsAgain === true) await expect.poll(() => reads.length, refusal.name).toBeGreaterThan(before);
      // Nothing changed: the step is still open for another try, and the house's draft is as it was.
      await expect(block.getByRole('button', { name: 'Yes, draft it again' }), refusal.name).not.toHaveAttribute('aria-disabled', 'true');
      await expect(block.getByText('Ready', { exact: true }), refusal.name).toBeVisible();
    }
    expect(posts).toHaveLength(REFUSALS.length);
  });

  test('house_busy: the page reads again and shows the house at work', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse()), ADMIN);
    await answer(page, '**/bff/proposals/7/admin/house-draft', () => ({ status: 409, body: { error: 'house_busy' } }));
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith(doneHouse({ status: 'queued' })));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    await expect(outcome(page, 'admin').getByRole('alert')).toHaveText(
      "The house model is already drafting this task, so nothing changed. Its new draft shows here when it's ready.",
    );
    await expect(block.getByText(QUEUED, { exact: true })).toBeVisible();
  });

  test('no answer is not a "no": the proposal is read again, and the page says whether it went through', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse()), ADMIN);
    await page.route('**/bff/proposals/7/admin/house-draft', (route) => route.abort());
    await page.unroute('**/bff/proposals/7');
    const reads = await serve(page, '**/bff/proposals/7', passedWith(doneHouse()));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    // The read back is just as the house was: it didn't happen.
    await expect(outcome(page, 'admin').getByRole('alert')).toHaveText(didNotGoThrough('house_draft'));
    expect(reads.length).toBeGreaterThan(0);

    // This time the API took it before the connection dropped: the read back shows it queued. It had drafted
    // this task before, so "again".
    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith(doneHouse({ status: 'queued' })));
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    await expect(outcome(page, 'admin').getByRole('status')).toHaveText(DRAFTING_AGAIN);
    await expect(block.getByText(QUEUED, { exact: true })).toBeVisible();
  });

  test('P15 turned around (review L4): a lost answer, and the new job has already failed by the read back: it went through', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    await page.route('**/bff/proposals/7/admin/house-draft', (route) => route.abort());
    await page.unroute('**/bff/proposals/7');
    // The API took it, and the worker has already run it: refused, the draft from before still the latest.
    await serve(page, '**/bff/proposals/7', passedWith(doneHouse({ status: 'failed', reason: 'refused', appliedToDraft: false }), { draft: SAVED_DRAFT }));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    await expect(outcome(page, 'admin').getByRole('status')).toHaveText(
      'It went through, and the house model has already finished. The house draft below shows how it went.',
    );
    await expect(block.getByText('The house model declined to draft this task. Write the draft yourself.', { exact: true })).toBeVisible();
  });
});

test.describe('Phase 6 · once published, and who sees it', () => {
  test('building or shipped: the admin sees it read-only, with no buttons', async ({ page, context, baseURL }) => {
    const published = (state: string, house: Json) =>
      detail({
        proposal: { state, deadline: undefined },
        you: { isAdmin: true },
        extra: { consentCount: 5, taskId: 10001, draft: { ...SAVED_DRAFT, taskId: 10001 }, house },
      });
    await onProposal(page, context, baseURL, published('building', doneHouse({ appliedToDraft: false })), ADMIN);
    const block = houseBlock(page);
    await expect(block.getByText('Ready', { exact: true })).toBeVisible();
    await expect(block.getByRole('list', { name: 'Risks' })).toBeVisible();
    await expect(block.getByText("The draft had already been saved, so it wasn't replaced.", { exact: true })).toBeVisible();
    await expect(block.getByRole('button')).toHaveCount(0);
    await expect(adminPanel(page).getByLabel('Task title')).toHaveCount(0);
    await expect(adminPanel(page).getByRole('link', { name: 'See task #10001 on the Contribute board' })).toBeVisible();

    for (const [state, house, line] of [
      ['shipped', doneHouse(), 'Its draft filled the draft task.'],
      ['building', { status: 'failed', reason: 'refused' }, 'The house model declined to draft this task. Write the draft yourself.'],
      ['building', { status: 'off', reason: 'switched_off' }, "The house model is off: it is switched off on FORGE's server. Write the draft yourself."],
    ] as const) {
      await page.unroute('**/bff/proposals/7');
      await serve(page, '**/bff/proposals/7', published(state, house));
      await page.reload();
      await expect(block.getByText(line, { exact: true }), `${state}: ${line}`).toBeVisible();
      await expect(block.getByRole('button'), state).toHaveCount(0);
    }
  });

  test('members never see it, even if an answer carried it: the public timeline line is all they see, and it is a plain line', async ({
    page,
    context,
    baseURL,
  }) => {
    const body = passedWith(doneHouse(), { you: { isAdmin: false } });
    const withLine = { ...body, events: [...(body.events as Json[]), { at: at(-1), kind: 'house_drafted', message: HOUSE_LINE }] };
    await onProposal(page, context, baseURL, withLine, MEMBER);
    await expect(page.getByText('It has been decided, so there is nothing left to do here.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'House draft' })).toHaveCount(0);
    await expect(page.getByText('House draft', { exact: true })).toHaveCount(0);
    await expect(page.getByText(HOUSE_SPEC.verdictReason)).toHaveCount(0);
    const timeline = timelineOf(page);
    await expect(timeline.getByText(HOUSE_LINE)).toBeVisible();
    await expect(timeline.getByText('Admin', { exact: true })).toHaveCount(0);
  });

  test('P7 turned around (review L3): a member whose answer carries a working house never reads it every 5 s', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    const reads = await onProposal(page, context, baseURL, passedWith({ status: 'queued' }, { you: { isAdmin: false } }), MEMBER);
    await expect(page.getByRole('region', { name: 'Admin' })).toHaveCount(0);
    for (let round = 1; round <= 3; round += 1) {
      await page.clock.runFor(5_000);
      await page.waitForTimeout(200);
    }
    expect(reads).toHaveLength(1);
  });

  test('an admin’s timeline shows the same plain line', async ({ page, context, baseURL }) => {
    const body = passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT });
    const withLine = { ...body, events: [...(body.events as Json[]), { at: at(-1), kind: 'house_drafted', message: HOUSE_LINE }] };
    await onProposal(page, context, baseURL, withLine, ADMIN);
    const line = timelineOf(page).getByRole('listitem').filter({ hasText: HOUSE_LINE });
    await expect(line).toBeVisible();
    await expect(line.getByText('Admin', { exact: true })).toHaveCount(0);
  });

  test('a malformed house draft is dropped, and the page and the draft task still work', async ({ page, context, baseURL }) => {
    const MALFORMED: Array<[string, unknown]> = [
      ['a status this build doesn’t know', { status: 'thinking' }],
      ['null', null],
      ['a spec with more criteria than a task may have', doneHouse({ spec: { ...HOUSE_SPEC, acceptanceCriteria: Array.from({ length: 11 }, (_, index) => `Criterion ${index + 1}`) } })],
      ['a spec without criteria', doneHouse({ spec: { ...HOUSE_SPEC, acceptanceCriteria: [] } })],
      ['a reason that is not a code', { status: 'failed', reason: 'Boom: <b>bad</b>' }],
    ];
    const [first] = MALFORMED;
    await onProposal(page, context, baseURL, { ...passedWith(undefined), house: first?.[1] }, ADMIN);
    for (const [name, house] of MALFORMED) {
      await page.unroute('**/bff/proposals/7');
      await serve(page, '**/bff/proposals/7', { ...passedWith(undefined), house });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Show my properties on a map', level: 1 }), name).toBeVisible();
      await expect(adminPanel(page).getByLabel('Task title'), name).toHaveValue(PLAIN_DRAFT.title);
      await expect(page.getByRole('group', { name: 'House draft' }), name).toHaveCount(0);
      await expect(page.getByText("Your actions can't load right now. Try again."), name).toHaveCount(0);
    }
  });
});

test.describe('Phase 6 · the house block from the keyboard', () => {
  test('"Use the house draft" goes to its status line; "Draft it again" takes focus into its step and back; Yes keeps it while it is sent', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    await answer(page, '**/bff/proposals/7/admin/house-draft', () => ({ status: 202, body: doneHouse({ status: 'queued', appliedToDraft: false }), delayMs: 800 }));
    const block = houseBlock(page);
    const admin = adminPanel(page);

    await block.getByRole('button', { name: 'Use the house draft' }).focus();
    await page.keyboard.press('Enter');
    await expect(houseStatus(page)).toBeFocused();
    await expect(houseStatus(page)).toHaveText(USED);
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);

    await block.getByRole('button', { name: 'Draft it again' }).focus();
    await page.keyboard.press('Enter');
    await expect(block.getByRole('button', { name: 'Yes, draft it again' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(block.getByRole('button', { name: 'Not yet' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(block.getByRole('button', { name: 'Draft it again' })).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(block.getByRole('button', { name: 'Yes, draft it again' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(block.getByRole('button', { name: 'Asking the house model…' })).toBeFocused();
    await expect(outcome(page, 'admin')).toBeFocused();
    await expect(outcome(page, 'admin')).toHaveText(DRAFTING_AGAIN);
    // What "Use the house draft" put in the form is still there, unsaved.
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
  });

  // Review M4: focus used to go into "Task title", where the next Enter (a second press, or the key held down) saved.
  for (const how of ['pressed twice', 'held down'] as const) {
    test(`P4 turned around: Enter ${how} on "Use the house draft" saves nothing`, async ({ page, context, baseURL }) => {
      await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
      const saves = await answer(page, '**/bff/proposals/7/admin/draft-task', (sent) => ({
        body: passedWith(doneHouse({ appliedToDraft: false }), { draft: sent.body as Json }),
      }));
      await houseBlock(page).getByRole('button', { name: 'Use the house draft' }).focus();
      if (how === 'pressed twice') {
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.down('Enter');
        await page.keyboard.down('Enter'); // the repeats a held key sends
        await page.keyboard.down('Enter');
        await page.keyboard.up('Enter');
      }
      await expect(houseStatus(page)).toBeFocused();
      await expect(houseStatus(page)).toHaveText(USED);
      await expect(adminPanel(page).getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
      await page.waitForTimeout(1_000);
      expect(saves).toEqual([]);
      await expect(outcome(page, 'admin')).toHaveText('');
    });
  }
});

test.describe('Phase 6 · the house block at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('it fits the screen with long paths, a long model name and every list, and so does its step', async ({ page, context, baseURL }) => {
    const longPath = `apps/web/src/app/${'a'.repeat(170)}/page.tsx`;
    expect(longPath.length).toBeLessThanOrEqual(200);
    const spec = {
      ...HOUSE_SPEC,
      verdict: 'needs_clarification',
      scopeIn: [longPath, 'tests/e2e/data-app.spec.ts'],
      scopeOut: [longPath],
      questions: ['q'.repeat(300)],
      risks: Array.from({ length: 3 }, (_, index) => `Risk ${index + 1}: ${'r'.repeat(250)}`),
    };
    await onProposal(
      page,
      context,
      baseURL,
      passedWith(doneHouse({ spec, model: `claude-opus-5-5-${'x'.repeat(80)}`, appliedToDraft: false }), { draft: SAVED_DRAFT }),
      ADMIN,
    );
    const block = houseBlock(page);
    await expect(block.getByText('Needs answers from the mover', { exact: true })).toBeVisible();
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await width()).toBeLessThanOrEqual(390);
    const box = await block.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);

    await block.getByRole('button', { name: 'Draft it again' }).click();
    await expect(block.getByRole('button', { name: 'Yes, draft it again' })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);

    await page.unroute('**/bff/proposals/7');
    await serve(page, '**/bff/proposals/7', passedWith({ status: 'running' }, { draft: SAVED_DRAFT }));
    await page.reload();
    await expect(block.getByText(DRAFTING, { exact: true })).toBeVisible();
    expect(await width()).toBeLessThanOrEqual(390);
  });

  test('P8 and A3 turned around (review L9): a model name is cut short, a date that isn’t one is left out, and a path keeps its order', async ({
    page,
    context,
    baseURL,
  }) => {
    const rtl = 'apps/web/שלום/עולם/page.tsx';
    const spec = { ...HOUSE_SPEC, scopeIn: [rtl, 'apps/web/src/app/apps/data/**'] };
    await onProposal(
      page,
      context,
      baseURL,
      passedWith(doneHouse({ spec, model: `m${'x'.repeat(10_000)}`, draftedAt: `not-a-date-${'d'.repeat(500)}`, appliedToDraft: false }), {
        draft: SAVED_DRAFT,
      }),
      ADMIN,
    );
    const block = houseBlock(page);
    // At most 100 characters of the name, the ellipsis included, and no "on <date>" for a date that isn't one.
    const drafted = block.getByText(/^Drafted by /);
    await expect(drafted).toHaveText(`Drafted by m${'x'.repeat(98)}….`);
    expect((await drafted.boundingBox())?.height ?? Infinity).toBeLessThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // Each segment of the path is isolated, so the right-to-left ones stay in the order the path has them.
    const path = block.getByRole('list', { name: 'Scope in' }).getByRole('listitem').first().locator('code');
    await expect(path).toHaveText(rtl);
    const segments = path.locator('bdi');
    await expect(segments).toHaveText(rtl.split('/'));
    const boxes = await segments.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index] ?? 0, `segment ${index + 1} sits right of segment ${index}`).toBeGreaterThan(boxes[index - 1] ?? Infinity);
    }
  });
});

test.describe('F6b · your own view is never traded for the public one (review H1, D5)', () => {
  test('P3a turned around: the 60 s read fails through the BFF; the panel, and the draft being written, stay, said to be out of date', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    let down = false;
    const body = passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT });
    const { publicReads, bffReads } = await onFlakyBff(page, context, baseURL, body, () =>
      down ? { status: 502, body: { error: 'service_unreachable' } } : null,
    );
    await typeOwnDraft(page);
    const publicBefore = publicReads.length;

    down = true;
    const before = bffReads.length;
    await page.clock.runFor(60_000);
    await expect.poll(() => bffReads.length).toBe(before + 1);
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    // A polite live region, on the page all along, so a screen reader hears it fill.
    await expect(staleView(page)).toHaveAttribute('aria-live', 'polite');
    await expectOwnDraft(page);
    expect(publicReads).toHaveLength(publicBefore);

    // Once the BFF answers again, the line goes, and what was typed is still there.
    down = false;
    await page.clock.runFor(60_000);
    await expect.poll(() => bffReads.length).toBe(before + 2);
    await expect(staleView(page)).toHaveText('');
    await expectOwnDraft(page);
    expect(publicReads).toHaveLength(publicBefore);
  });

  test('P3c turned around: while the house drafts, neither its 5 s reads nor the 60 s one trade the panel for the public page', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    let down = false;
    const { publicReads, bffReads } = await onFlakyBff(page, context, baseURL, passedWith({ status: 'queued' }), () =>
      down ? { status: 504, body: { error: 'upstream_timeout' } } : null,
    );
    await expect(houseBlock(page).getByText(QUEUED, { exact: true })).toBeVisible();
    await typeOwnDraft(page);
    const publicBefore = publicReads.length;
    down = true;
    // Three 5 s reads fail; then the page's own 60 s read fails too. (A count goes up as a read leaves; the
    // page sets its next timer once the failure is in, so it gets a moment before the clock moves on.)
    for (const count of [2, 3, 4]) {
      await page.clock.runFor(5_000);
      await expect.poll(() => bffReads.length).toBe(count);
      await page.waitForTimeout(250);
    }
    await page.clock.runFor(45_000);
    await expect.poll(() => bffReads.length).toBe(5);
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    await expect(houseBlock(page).getByText(QUEUED, { exact: true })).toBeVisible();
    await expectOwnDraft(page);
    expect(publicReads).toHaveLength(publicBefore);
  });

  test('P3b turned around: back on the tab while the sign-in has ended, the panel and the text stay', async ({ page, context, baseURL }) => {
    let answer401 = false;
    let answerAsNobody = false;
    const body = passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT });
    const { publicReads, bffReads } = await onFlakyBff(page, context, baseURL, body, () => {
      if (answer401) return { status: 401, body: { error: 'unauthenticated' } };
      // The BFF reads a proposal as nobody once the session is gone: an answer with no `you` is no view to swap in.
      if (answerAsNobody) return { body: publicOf(body) };
      return null;
    });
    await typeOwnDraft(page);
    const publicBefore = publicReads.length;

    answer401 = true;
    let before = bffReads.length;
    await setVisibility(page, 'hidden');
    await setVisibility(page, 'visible');
    await expect.poll(() => bffReads.length).toBe(before + 1);
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    await expect(adminPanel(page)).toBeVisible();
    await expectOwnDraft(page);

    answer401 = false;
    answerAsNobody = true;
    before = bffReads.length;
    await setVisibility(page, 'hidden');
    await setVisibility(page, 'visible');
    await expect.poll(() => bffReads.length).toBe(before + 1);
    await page.waitForTimeout(200);
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    await expect(adminPanel(page)).toBeVisible();
    await expectOwnDraft(page);
    expect(publicReads).toHaveLength(publicBefore);
  });

  test('P3d turned around: "Draft it again" loses its answer and its read back fails: the outcome line, focus and the text stay', async ({
    page,
    context,
    baseURL,
  }) => {
    let down = false;
    const body = passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT });
    const { publicReads } = await onFlakyBff(page, context, baseURL, body, () => (down ? { status: 502, body: { error: 'service_unreachable' } } : null));
    await page.route('**/bff/proposals/7/admin/house-draft', (route) => {
      down = true;
      return route.abort();
    });
    await typeOwnDraft(page);
    const publicBefore = publicReads.length;
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    // It can't tell whether it went through, and says so rather than claiming the page is current.
    await expect(outcome(page, 'admin').getByRole('alert')).toHaveText(notReadBack());
    await expect(outcome(page, 'admin')).toBeFocused();
    await expect(staleView(page)).toHaveText(STALE_VIEW);
    await expectOwnDraft(page);
    expect(publicReads).toHaveLength(publicBefore);
  });
});

test.describe('F6b · what the block says of the form comes from the form itself (review M1–M3)', () => {
  test('P2a turned around: a draft that filled the task once, then saved over, says so, and can be brought back', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse(), { draft: SAVED_DRAFT }), ADMIN);
    const block = houseBlock(page);
    const admin = adminPanel(page);
    await expect(block.getByText(CHANGED_SINCE, { exact: true })).toBeVisible();
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toHaveCount(0);
    await expect(admin.getByLabel('Task title')).toHaveValue(SAVED_DRAFT.title);

    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(admin.getByLabel('What done means')).toHaveValue(HOUSE_SPEC.acceptanceCriteria.join('\n'));
    await expect(houseStatus(page)).toHaveText(USED);
    await expect(block.getByText(CHANGED_SINCE, { exact: true })).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toHaveCount(0);
  });

  test('P2b turned around: its draft lands on unsaved changes, and the admin saves theirs: it never claims to be in the form', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    await onHouseProposal(page, context, baseURL, (n) =>
      n === 1 ? passedWith({ status: 'running' }) : passedWith(doneHouse(), { draft: HOUSE_FILLED_DRAFT }),
    );
    // The API stores what the admin sent; the house's spec is still the latest, and it did fill the draft once.
    const saves = await answer(page, '**/bff/proposals/7/admin/draft-task', (sent) => ({ body: passedWith(doneHouse(), { draft: sent.body as Json }) }));
    const block = houseBlock(page);
    const admin = adminPanel(page);
    await typeOwnDraft(page);
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await expect(block.getByText(HELD, { exact: true })).toBeVisible();
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toBeVisible();

    await admin.getByRole('button', { name: 'Save draft' }).click();
    await expect(outcome(page, 'admin')).toHaveText('Draft saved.');
    expect((saves[0]?.body as Json).civilianSummary).toBe(TYPED_SUMMARY);
    await expect(block.getByText(CHANGED_SINCE, { exact: true })).toBeVisible();
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toBeVisible();
    await expect(admin.getByLabel('Task title')).toHaveValue(PLAIN_DRAFT.title);
  });

  test('P2c turned around: "Use the house draft", then Save: it is in the form and saved, with nothing left to use', async ({
    page,
    context,
    baseURL,
  }) => {
    const notApplied = (draft: Json) => passedWith(doneHouse({ appliedToDraft: false }), { draft });
    await onProposal(page, context, baseURL, notApplied(SAVED_DRAFT), ADMIN);
    await answer(page, '**/bff/proposals/7/admin/draft-task', (sent) => ({ body: notApplied(sent.body as Json) }));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(houseStatus(page)).toHaveText(USED);
    await adminPanel(page).getByRole('button', { name: 'Save draft' }).click();
    await expect(outcome(page, 'admin')).toHaveText('Draft saved.');
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
    await expect(block.getByText(NOT_REPLACED, { exact: true })).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toHaveCount(0);
    await expect(houseStatus(page)).toHaveText('');
  });

  test('P1 turned around: a new draft lands after "Use the house draft": the block no longer says the house draft is in the form', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    let drafted = false;
    const before = passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT });
    const after = passedWith(doneHouse({ spec: HOUSE_SPEC_B, draftedAt: '2026-10-04T10:00:00Z', appliedToDraft: false }), { draft: SAVED_DRAFT });
    await onHouseProposal(page, context, baseURL, () => (drafted ? after : before));
    await answer(page, '**/bff/proposals/7/admin/house-draft', () => {
      drafted = true;
      return { status: 202, body: doneHouse({ status: 'queued', appliedToDraft: false }) };
    });
    const block = houseBlock(page);
    const admin = adminPanel(page);

    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(houseStatus(page)).toHaveText(USED);

    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    await expect(outcome(page, 'admin')).toHaveText(DRAFTING_AGAIN);
    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await expect(block.getByText(HOUSE_SPEC_B.verdictReason, { exact: true })).toBeVisible();
    // The form still holds the first draft, and the block says nothing of the kind about the second.
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(block.getByText(USED, { exact: true })).toHaveCount(0);
    await expect(houseStatus(page)).toHaveText('');
    await expect(block.getByText(NOT_REPLACED, { exact: true })).toBeVisible();

    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC_B.title);
    await expect(houseStatus(page)).toHaveText(USED);
  });

  test('P16 turned around: a re-draft lands while the form shows the first draft: the form stays, and the block says so', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    // A re-draft is running; nobody has saved the house-filled draft, so the house fills it again.
    const running = passedWith(doneHouse({ status: 'running' }), { draft: HOUSE_FILLED_DRAFT });
    const landed = passedWith(doneHouse({ spec: HOUSE_SPEC_B, draftedAt: '2026-10-04T10:00:00Z' }), { draft: HOUSE_B_FILLED_DRAFT });
    await onHouseProposal(page, context, baseURL, (n) => (n === 1 ? running : landed));
    const admin = adminPanel(page);
    const block = houseBlock(page);
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);

    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await expect(block.getByText(HOUSE_SPEC_B.verdictReason, { exact: true })).toBeVisible();
    // No text changes under the admin: the form still has the first draft, and the block says the new one is saved.
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC.title);
    await expect(admin.getByLabel('What done means')).toHaveValue(HOUSE_SPEC.acceptanceCriteria.join('\n'));
    await expect(block.getByText(EARLIER, { exact: true })).toBeVisible();

    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Task title')).toHaveValue(HOUSE_SPEC_B.title);
    await expect(block.getByText(IN_THE_FORM, { exact: true })).toBeVisible();
  });

  test('L10: "Use the house draft" over unsaved changes can be undone; over the saved draft there is nothing to undo', async ({
    page,
    context,
    baseURL,
  }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    const block = houseBlock(page);
    const admin = adminPanel(page);
    const undo = block.getByRole('button', { name: 'Undo' });

    // Over the saved draft: nothing of the admin's goes, so there is nothing to undo.
    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(houseStatus(page)).toHaveText(USED);
    await expect(undo).toHaveCount(0);

    // Over changes nobody saved: they can be put back.
    await admin.getByLabel('Task title').fill('My own title');
    await admin.getByLabel('Plain summary').fill(TYPED_SUMMARY);
    await expect(houseStatus(page)).toHaveText('');
    await block.getByRole('button', { name: 'Use the house draft' }).click();
    await expect(admin.getByLabel('Plain summary')).toHaveValue(HOUSE_SPEC.civilianSummary);
    await expect(houseStatus(page)).toHaveText(USED);
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(admin.getByLabel('Task title')).toHaveValue('My own title');
    await expect(admin.getByLabel('Plain summary')).toHaveValue(TYPED_SUMMARY);
    await expect(houseStatus(page)).toHaveText('');
    await expect(undo).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Use the house draft' })).toBeFocused();
  });
});

test.describe('F6b · reads that fail, and reads that overlap (review L1, L2)', () => {
  test('P6 turned around: after 3 failed reads in a row it reads once a minute, and says so, until a read works', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    let down = false;
    await signInAs(context, baseURL ?? '', ADMIN);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals/7', publicOf(passedWith({ status: 'running' })));
    await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
    const reads = await answer(page, '**/bff/proposals/7', (_sent, n) =>
      down ? { status: 502, body: { error: 'service_unreachable' } } : { body: marked(passedWith({ status: 'running' }), n) },
    );
    await page.goto('/propose/7');
    await expect(timelineOf(page).getByText('Read 1.')).toBeVisible();
    const block = houseBlock(page);

    down = true;
    // A count goes up as a read leaves; the page sets its next timer once the failure is in.
    for (const count of [2, 3]) {
      await page.clock.runFor(5_000);
      await expect.poll(() => reads.length).toBe(count);
      await page.waitForTimeout(250);
      await expect(block.getByText(UNCHECKED, { exact: true })).toHaveCount(0);
    }
    await page.clock.runFor(5_000);
    await expect.poll(() => reads.length).toBe(4);
    await expect(block.getByText(UNCHECKED, { exact: true })).toBeVisible();
    await expect(block.getByText(DRAFTING, { exact: true })).toBeVisible();

    // Once a minute now: nothing for the next 20 s, then the page's own 60 s read (which fails too).
    await page.clock.runFor(20_000);
    await page.waitForTimeout(200);
    expect(reads).toHaveLength(4);
    await page.clock.runFor(25_000);
    await expect.poll(() => reads.length).toBe(5);
    await page.waitForTimeout(250);

    // The house's own read, a minute after its last, works: the line goes, and it is back to every 5 s.
    down = false;
    await page.clock.runFor(15_000);
    await expect.poll(() => reads.length).toBe(6);
    await expect(block.getByText(UNCHECKED, { exact: true })).toHaveCount(0);
    await expect(staleView(page)).toHaveText('');
    await page.clock.runFor(5_000);
    await expect.poll(() => reads.length).toBe(7);
  });

  test('P5 turned around: the 60 s read never starts while one of the 5 s ones is still out', async ({ page, context, baseURL }) => {
    await logReads(page);
    await page.clock.install();
    await signInAs(context, baseURL ?? '', ADMIN);
    await serviceDown(page);
    await openProposals(page);
    await serve(page, '**/api/proposals/7', publicOf(passedWith({ status: 'queued' })));
    await serve(page, '**/bff/proposals/me', { isAdmin: true, testTimers: false });
    let n = 0;
    let holdNext = false;
    const held = gate();
    await page.route('**/bff/proposals/7', async (route) => {
      n += 1;
      const mine = n;
      if (holdNext) {
        holdNext = false;
        await held.wait;
      }
      await route
        .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(marked(passedWith({ status: 'queued' }), mine)) })
        .catch(() => undefined);
    });
    await page.goto('/propose/7');
    await expect(timelineOf(page).getByText('Read 1.')).toBeVisible();
    for (let round = 2; round <= 11; round += 1) {
      await page.clock.runFor(5_000);
      await expect(timelineOf(page).getByText(`Read ${round}.`)).toBeVisible();
    }
    // Read 12 (a 5 s one, at 55 s) is held while the page's clock crosses the 60 s mark.
    holdNext = true;
    await page.clock.runFor(5_000);
    await expect.poll(() => n).toBe(12);
    await page.clock.runFor(6_000);
    await page.waitForTimeout(300);
    expect(n).toBe(12);
    held.open();
    await expect(timelineOf(page).getByText('Read 12.')).toBeVisible();
    // Never two at once.
    const log = await readLog(page);
    for (let index = 1; index < log.length; index += 1) {
      expect(log[index]?.start ?? 0, `read ${index + 1} starts after read ${index} ends`).toBeGreaterThanOrEqual(log[index - 1]?.end ?? Infinity);
    }
  });
});

test.describe('F6b · the house block’s live regions and motion (review L6, L7)', () => {
  test('A1 turned around: under reduced motion (the suite asks for it), its spinner holds still', async ({ page, context, baseURL }) => {
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await onProposal(page, context, baseURL, passedWith({ status: 'running' }, { draft: SAVED_DRAFT }), ADMIN);
    const spinner = houseBlock(page).locator('.spinner');
    await expect(spinner).toHaveCount(1);
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  });

  test('A2 turned around: the status line is on the page before "Use the house draft" fills it', async ({ page, context, baseURL }) => {
    await onProposal(page, context, baseURL, passedWith(doneHouse({ appliedToDraft: false }), { draft: SAVED_DRAFT }), ADMIN);
    const status = houseStatus(page);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('tabindex', '-1');
    await expect(status).toHaveText('');
    // Watch for live regions inserted into the block: a screen reader may not read one inserted already filled.
    await houseBlock(page).evaluate((block) => {
      const inserted: string[] = [];
      (window as unknown as { __inserted: string[] }).__inserted = inserted;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof HTMLElement && (node.matches('[role="status"]') || node.querySelector('[role="status"]') !== null)) {
              inserted.push(node.textContent ?? '');
            }
          }
        }
      }).observe(block, { subtree: true, childList: true });
    });
    await houseBlock(page).getByRole('button', { name: 'Use the house draft' }).click();
    await expect(status).toHaveText(USED);
    expect(await page.evaluate(() => (window as unknown as { __inserted: string[] }).__inserted)).toEqual([]);
  });

  test('P11 turned around: "Draft it again" is said once, by the outcome line; the block speaks only when drafting stops', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.clock.install();
    await onHouseProposal(page, context, baseURL, (n) =>
      n === 1 ? passedWith({ status: 'failed' }) : passedWith({ status: 'failed', reason: 'refused' }),
    );
    await answer(page, '**/bff/proposals/7/admin/house-draft', () => ({ status: 202, body: { status: 'queued' } }));
    const block = houseBlock(page);
    await block.getByRole('button', { name: 'Draft it again' }).click();
    await block.getByRole('button', { name: 'Yes, draft it again' }).click();
    await expect(outcome(page, 'admin')).toHaveText(DRAFTING_FIRST);
    await expect(block.getByText(QUEUED, { exact: true })).toBeVisible();
    // In the admin panel, the outcome line is the only live region with anything to say.
    const spoken = () =>
      adminPanel(page).locator('[role="status"], [role="alert"], [aria-live]').evaluateAll((elements) =>
        elements.map((element) => element.textContent?.trim() ?? '').filter((text) => text !== ''),
      );
    expect(await spoken()).toEqual([DRAFTING_FIRST]);

    await page.clock.runFor(5_000);
    await expect(timelineOf(page).getByText('Read 2.')).toBeVisible();
    await expect(block.getByText('The house model declined to draft this task. Write the draft yourself.', { exact: true })).toBeVisible();
    expect(await block.getByRole('status').allTextContents()).toContain('The house model stopped drafting: the reason is below.');
  });
});
