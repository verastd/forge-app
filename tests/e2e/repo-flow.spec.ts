import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  AuthError,
  constantTimeEqual,
  createPkcePair,
  isRepoAction,
  openTransaction,
  pkceChallenge,
  publicRepoAuthorizeUrl,
  randomToken,
  sealTransaction,
} from '../../packages/auth/dist/index.js';
import type { TransactionClaims, TransactionInput } from '../../packages/auth/dist/index.js';
import { REPO_ACTION_ERRORS, compileBrief } from '../../packages/shared/dist/index.js';
import {
  actionTimeoutMs,
  CALLBACK_MAX_SECONDS,
  copiedState,
  finishRepoAuthorization,
  MAX_FORM_BYTES,
  REPO_ACTION_TIMEOUT_MS,
  REPO_CALLBACK_PATH,
  REVOKE_RESERVE_MS,
  reviewedPullRequest,
  startRepoAuthorization,
} from '../../apps/web/src/app/auth/github/repo/flow';
import type { CallbackSteps, RepoActOutcome, StartSteps, Visitor } from '../../apps/web/src/app/auth/github/repo/flow';
import { revokeNow, withOneTimeToken } from '../../apps/web/src/app/auth/one-time-token';
import { repoAppSettings } from '../../apps/web/src/lib/auth/repo-app';
import { timeAgo } from '../../apps/web/src/lib/format';
import {
  COPY_NOT_LATEST_SENTENCE,
  COPY_NOT_SYNCED_SENTENCE,
  COPY_READY_SENTENCE,
  REPO_ERROR_CODES,
  REVIEW_SAYS_SENTENCE,
  copiedSentences,
  REVIEW_CHECK_ERRORS,
  WEB_REPO_ERRORS,
  describeRepoError,
  readRepoOutcome,
  reviewSentBy,
  reviewState,
  sentForReviewSentence,
  upstreamPullRequest,
} from '../../apps/web/src/lib/handoff';
import { launchLinks } from '../../apps/web/src/lib/launch';
import { TASK_FIXTURES } from '../../apps/web/src/lib/fixtures';
import { PRACTICE_COPY, localClaim, localCopy, localDispatch, localReview, localStatus, localTaskDetail, stageFor } from '../../apps/web/src/lib/offline';
import { plantPracticeSession, signInAs } from './helpers/session';

/**
 * "Your copy" and "Send for review" (Phase 7), outside any one screen: unit
 * tests with no browser, as hardening.spec.ts does for the Copilot token, and
 * the two routes on the practice build's server. Project `chromium-demo`.
 *
 * - `POST /auth/github/repo` (`startRepoAuthorization`) and its callback
 *   (`finishRepoAuthorization`) run here with stand-ins for the session, the
 *   cookie, GitHub and the API, so every way through is tried without
 *   reaching any of them: the Origin check, the practice account, signed out,
 *   not configured, a bad state, GitHub saying no, someone else's token, the
 *   token kept out of every log line, URL and body, the token revoked on every
 *   path that got one, and the browser sent only to the sealed task's page.
 * - The pure helpers behind the task page's three steps: the outcome in the
 *   query string and its sentences (none says "fork"), when "Send for review"
 *   is offered, the copy's name in the Open my agent links, and the practice
 *   app's pretend copy and review.
 *
 * live-repo.spec.ts drives the same routes on the build we deploy, and the
 * task page's steps; repo-practice.spec.ts the practice app's.
 */

const SECRET = 'repo-flow-spec-session-secret-0123456789';
/** The `@forge/auth` calls the flow makes, from the package's build, as the routes pass the package's own. */
const AUTH = { AuthError, constantTimeEqual, createPkcePair, isRepoAction, publicRepoAuthorizeUrl, randomToken, sealTransaction };
const APP = { clientId: 'Ov23liRepoFlowSpec01', clientSecret: 'repo-flow-spec-client-secret-0003', origin: 'https://forge.example' };
const TOKEN = 'gho_one-time-token-must-never-leak-0004';
const CODE = 'oauth-code-must-never-leak-0005';
const MAYA: Visitor = { sub: '5104001', login: 'maya', demo: false };
const PRACTICE: Visitor = { sub: 'demo', login: 'you', demo: true };

/* --- POST /auth/github/repo ---------------------------------------------------------------------- */

function form(fields: Record<string, string>): Request {
  return new Request('https://forge.example/auth/github/repo', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Stand-ins for the start, recording the cookie it kept and whether it read the session. */
function starting(overrides: Partial<StartSteps> = {}) {
  const kept: string[] = [];
  const read: string[] = [];
  const steps: StartSteps = {
    auth: AUTH,
    sameOrigin: () => true,
    session: async () => {
      read.push('session');
      return MAYA;
    },
    setup: async () => ({ app: APP, seal: SECRET }),
    keep: async (sealed) => {
      kept.push(sealed);
    },
    ...overrides,
  };
  return { steps, kept, read };
}

test.describe('POST /auth/github/repo (startRepoAuthorization)', () => {
  test('refuses a form from another page before it reads anything (403 bad_origin)', async () => {
    const { steps, kept, read } = starting({ sameOrigin: () => false });
    const response = await startRepoAuthorization(form({ taskId: '7', action: 'copy' }), steps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad_origin' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(kept).toEqual([]);
    expect(read).toEqual([]);
  });

  test('a body over 1 KiB is 413, and nothing is kept', async () => {
    const { steps, kept } = starting();
    const response = await startRepoAuthorization(
      form({ taskId: '7', action: 'copy', pad: 'x'.repeat(MAX_FORM_BYTES) }),
      steps,
    );
    expect(response.status).toBe(413);
    expect(kept).toEqual([]);
  });

  test('only a task number and copy or review get through (400)', async () => {
    const { steps, kept } = starting();
    for (const fields of [
      { taskId: '0', action: 'copy' },
      { taskId: 'one', action: 'copy' },
      { taskId: '1/../2', action: 'copy' },
      { taskId: '12345678901', action: 'copy' },
      { taskId: '-7', action: 'copy' },
      { taskId: '7', action: 'fork' },
      { taskId: '7', action: 'merge' },
      { taskId: '7', action: 'COPY' },
      { taskId: '7', action: '' },
      { taskId: '7' },
    ]) {
      const response = await startRepoAuthorization(form(fields as Record<string, string>), steps);
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(await response.json()).toEqual({ error: 'bad_request' });
    }
    expect(kept).toEqual([]);
  });

  test('signed out goes to sign-in and back to the task page, and keeps nothing', async () => {
    const { steps, kept } = starting({ session: async () => null });
    const response = await startRepoAuthorization(form({ taskId: '7', action: 'review' }), steps);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?next=%2Fcontribute%2Ftask%2F7');
    expect(kept).toEqual([]);
  });

  test('the practice account is refused (403 practice_session), and keeps nothing', async () => {
    const { steps, kept } = starting({ session: async () => PRACTICE });
    const response = await startRepoAuthorization(form({ taskId: '7', action: 'copy' }), steps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'practice_session' });
    expect(kept).toEqual([]);
  });

  test('with the OAuth App not set up, back to the task page: not_configured', async () => {
    const { steps, kept } = starting({ setup: async () => null });
    const response = await startRepoAuthorization(form({ taskId: '7', action: 'copy' }), steps);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/contribute/task/7?repo_error=not_configured');
    expect(kept).toEqual([]);
  });

  for (const action of ['copy', 'review'] as const) {
    test(`${action}: off to GitHub for public_repo only, with PKCE, holding a repo attempt for this task`, async () => {
      const { steps, kept } = starting();
      const response = await startRepoAuthorization(form({ taskId: '7', action }), steps);
      expect(response.status).toBe(303);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const location = new URL(response.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
      const query = Object.fromEntries(location.searchParams);
      expect(Object.keys(query).sort()).toEqual([
        'allow_signup',
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'redirect_uri',
        'scope',
        'state',
      ]);
      expect(query).toMatchObject({
        client_id: APP.clientId,
        redirect_uri: `https://forge.example${REPO_CALLBACK_PATH}`,
        scope: 'public_repo',
        code_challenge_method: 'S256',
        allow_signup: 'false',
      });
      // Nothing secret rides in the URL.
      expect(location.href).not.toContain(APP.clientSecret);

      expect(kept).toHaveLength(1);
      const attempt = await openTransaction(kept[0], [SECRET]);
      expect(attempt).toMatchObject({ purpose: 'repo', action, taskId: 7, next: '/contribute/task/7', state: query.state });
      // The challenge GitHub holds is the S256 of the verifier only the cookie holds.
      expect(await pkceChallenge(attempt?.verifier ?? '')).toBe(query.code_challenge);
      expect(location.href).not.toContain(attempt?.verifier ?? 'missing');
    });
  }

  test('every attempt is fresh: a new state and verifier each time', async () => {
    const { steps, kept } = starting();
    await startRepoAuthorization(form({ taskId: '7', action: 'copy' }), steps);
    await startRepoAuthorization(form({ taskId: '7', action: 'copy' }), steps);
    const [first, second] = await Promise.all(kept.map((sealed) => openTransaction(sealed, [SECRET])));
    expect(first?.state).not.toBe(second?.state);
    expect(first?.verifier).not.toBe(second?.verifier);
  });
});

/* --- GET /auth/github/repo/callback -------------------------------------------------------------- */

const NOW_TX = async (overrides: Partial<TransactionInput> = {}): Promise<TransactionClaims> => {
  const input = {
    state: 'Xq3vG0b1k9Zr8dT2yWc4nHs6uJm5pLf7aEo-_iRkQzA',
    verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    next: '/contribute/task/7',
    purpose: 'repo',
    taskId: 7,
    action: 'copy',
    ...overrides,
  } as TransactionInput;
  const opened = await openTransaction(await sealTransaction(input, SECRET), [SECRET]);
  if (opened === null) throw new Error('the test attempt did not seal');
  return opened;
};

interface Run {
  response: Response;
  /** Everything the steps saw happen, in order. */
  ran: string[];
  /** How much of `ran` had happened when the response was ready. */
  respondedAt: number;
  logs: string[];
  /** Each log line's level, in the same order. */
  levels: string[];
  revokedWith: { clientId: string; clientSecret: string }[];
  acted: { action: string; taskId: number; token: string; who: unknown }[];
}

/**
 * A stand-in for Next's `after()`, as the web review's probe (phase7/probes-web) found Next 15.5
 * behaves: a callback waits for the response's connection to close, so once the browser has left it
 * never runs; a promise is already running, and is only kept alive until it settles.
 */
function nextAfter(browserGone: () => boolean) {
  const queued: (() => Promise<void>)[] = [];
  const kept: Promise<void>[] = [];
  return {
    after(task: Promise<void> | (() => Promise<void>)): void {
      if (typeof task !== 'function') {
        kept.push(task);
      } else if (!browserGone()) {
        queued.push(task);
      }
      // A callback for a connection that has already closed: Node doesn't replay 'close', so it never runs.
    },
    /** The response's connection closes (if the browser is still there to close it), and the function ends. */
    async settle(): Promise<void> {
      if (!browserGone()) {
        for (const task of queued.splice(0)) await task();
      }
      await Promise.all(kept);
    },
  };
}

/** The callback with stand-ins, `keepAlive` as Next's `after()` behaves (`nextAfter`). */
async function callback(
  query: Record<string, string>,
  attempt: TransactionClaims | null,
  overrides: Partial<CallbackSteps> = {},
  browser: { gone: boolean } = { gone: false },
): Promise<Run> {
  const ran: string[] = [];
  const logs: string[] = [];
  const levels: string[] = [];
  const revokedWith: Run['revokedWith'] = [];
  const acted: Run['acted'] = [];
  const next = nextAfter(() => browser.gone);
  const steps: CallbackSteps = {
    auth: AUTH,
    attempt: async () => {
      ran.push('attempt spent');
      return attempt;
    },
    session: async () => MAYA,
    app: async () => APP,
    exchange: async (params) => {
      ran.push(`exchange ${params.redirectUri}`);
      expect(params).toMatchObject({ clientId: APP.clientId, clientSecret: APP.clientSecret, code: CODE });
      expect(params.codeVerifier).toBe(attempt?.verifier);
      return { accessToken: TOKEN };
    },
    userIdOf: async (token) => {
      ran.push('user');
      expect(token).toBe(TOKEN);
      return MAYA.sub;
    },
    act: async (action, taskId, token, who) => {
      ran.push(`act ${action}`);
      acted.push({ action, taskId, token, who });
      return action === 'copy' ? { ok: true } : { ok: true, pr: 42 };
    },
    revoke: async (app, token) => {
      ran.push('revoke');
      expect(token).toBe(TOKEN);
      revokedWith.push({ clientId: app.clientId, clientSecret: app.clientSecret });
      return true;
    },
    keepAlive: (running) => {
      ran.push('kept alive');
      next.after(running);
    },
    log: (line, level) => {
      logs.push(line);
      levels.push(level);
    },
    ...overrides,
  };
  const url = new URL(`https://forge.example${REPO_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`);
  const response = await finishRepoAuthorization(url, steps);
  const respondedAt = ran.length;
  await next.settle();
  return { response, ran, respondedAt, logs, levels, revokedWith, acted };
}

const REVOKED = 'repo authorization: one-time GitHub token revoked';
const NOT_CONFIRMED = 'repo authorization: GitHub did not confirm the one-time token was revoked';

/** The revocation had already started when the response was ready, and the function stayed alive for it. */
function expectRevokedFirst(run: Run): void {
  expect(run.ran).toContain('revoke');
  expect(run.ran.indexOf('revoke')).toBeLessThan(run.respondedAt);
  expect(run.ran.indexOf('kept alive')).toBeGreaterThan(run.ran.indexOf('revoke'));
}

/** The log lines, whatever order the revocation's line landed in. */
function expectLogs(run: Run, lines: string[]): void {
  expect([...run.logs].sort()).toEqual([...lines].sort());
}

/** The token, the code, the verifier and the client secret appear nowhere the run can show. */
async function expectNothingLeaked(run: Run, attempt: TransactionClaims | null): Promise<void> {
  const shown = [
    run.response.headers.get('location') ?? '',
    JSON.stringify([...run.response.headers]),
    await run.response.clone().text(),
    ...run.logs,
  ].join('\n');
  for (const secret of [TOKEN, CODE, APP.clientSecret, attempt?.verifier ?? 'no-verifier', attempt?.state ?? 'no-state']) {
    expect(shown, 'a secret got out').not.toContain(secret);
  }
}

/** Every way out goes to the sealed task's page, or to the board when there was no attempt. */
function expectOnlyTaskPage(run: Run, taskId: number | null): void {
  expect(run.response.status).toBe(303);
  const location = run.response.headers.get('location') ?? '';
  if (taskId === null) {
    expect(location).toBe('/contribute?repo_error=expired');
  } else {
    expect(location.startsWith(`/contribute/task/${taskId}?`)).toBe(true);
    expect(new URL(location, 'https://forge.example').origin).toBe('https://forge.example');
  }
}

const GOOD = { state: 'Xq3vG0b1k9Zr8dT2yWc4nHs6uJm5pLf7aEo-_iRkQzA', code: CODE };

test.describe('GET /auth/github/repo/callback (finishRepoAuthorization)', () => {
  test('copy: the token is the signed-in account\'s, the API makes the copy, and the token\'s revocation starts before the response', async () => {
    const attempt = await NOW_TX();
    const run = await callback(GOOD, attempt);
    expectOnlyTaskPage(run, 7);
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?copy=ready');
    expect(run.ran).toEqual([
      'attempt spent',
      `exchange https://forge.example${REPO_CALLBACK_PATH}`,
      'user',
      'act copy',
      'revoke',
      'kept alive',
    ]);
    expect(run.respondedAt).toBe(run.ran.length);
    expect(run.acted).toEqual([{ action: 'copy', taskId: 7, token: TOKEN, who: { sub: MAYA.sub, login: MAYA.login } }]);
    // Revoked with the OAuth App's own credentials, and said so in the log, at info, without the token.
    expect(run.revokedWith).toEqual([{ clientId: APP.clientId, clientSecret: APP.clientSecret }]);
    expect(run.logs).toEqual([REVOKED]);
    expect(run.levels).toEqual(['info']);
    await expectNothingLeaked(run, attempt);
  });

  test('a browser that leaves while the API works can\'t stop the revocation (review-web W-M1)', async () => {
    const attempt = await NOW_TX();
    const browser = { gone: false };
    const run = await callback(
      GOOD,
      attempt,
      {
        act: async () => {
          // The tab closed while GitHub made the copy: the connection is gone before the API answers.
          browser.gone = true;
          return { ok: true };
        },
      },
      browser,
    );
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?copy=ready');
    expectRevokedFirst(run);
    expect(run.revokedWith).toHaveLength(1);
    expect(run.logs).toEqual([REVOKED]);
  });

  test('the stand-in for after() is the one that catches the old code: a callback never runs once the browser has left', async () => {
    const browser = { gone: true };
    const next = nextAfter(() => browser.gone);
    let late = false;
    next.after(async () => {
      late = true;
    });
    let started = false;
    next.after(
      (async () => {
        started = true;
      })(),
    );
    await next.settle();
    // `after(task)`, as the callback had it: never. `after(task())`, as it has it now: already done.
    expect(late).toBe(false);
    expect(started).toBe(true);
  });

  test('copy: a copy that couldn\'t be brought up to date, or a branch from the copy\'s own main, says so in the redirect', async () => {
    const attempt = await NOW_TX();
    for (const [outcome, query] of [
      [{ ok: true, synced: false }, 'copy=ready&synced=0'],
      [{ ok: true, latest: false }, 'copy=ready&latest=0'],
      [{ ok: true, synced: false, latest: false }, 'copy=ready&synced=0&latest=0'],
    ] as [RepoActOutcome, string][]) {
      const run = await callback(GOOD, attempt, { act: async () => outcome });
      expect(run.response.headers.get('location')).toBe(`/contribute/task/7?${query}`);
      expectRevokedFirst(run);
    }
  });

  test('review: sent, with the pull request number the API gave', async () => {
    const attempt = await NOW_TX({ action: 'review' });
    const run = await callback(GOOD, attempt);
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?review=sent&pr=42');
    expect(run.acted.map((entry) => entry.action)).toEqual(['review']);
    expectRevokedFirst(run);
    await expectNothingLeaked(run, attempt);
  });

  test('review: sent without a number when the API gave none', async () => {
    const attempt = await NOW_TX({ action: 'review' });
    const run = await callback(GOOD, attempt, { act: async () => ({ ok: true }) });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?review=sent');
    expectRevokedFirst(run);
  });

  test('someone else\'s token: wrong_account, nothing done with it, and still revoked', async () => {
    const attempt = await NOW_TX();
    const run = await callback(GOOD, attempt, { userIdOf: async () => '999' });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=wrong_account');
    expect(run.acted).toEqual([]);
    expectRevokedFirst(run);
    expectLogs(run, ['repo copy: wrong_account', REVOKED]);
    await expectNothingLeaked(run, attempt);
  });

  test('the API\'s refusal comes back as its code (and GitHub\'s status), and the token is revoked', async () => {
    const attempt = await NOW_TX({ action: 'review' });
    const refusals: [RepoActOutcome, string, string][] = [
      [{ ok: false, code: 'github_failed', status: 502 }, 'repo_error=github_failed&status=502', 'repo review: github_failed 502'],
      [{ ok: false, code: 'no_changes' }, 'repo_error=no_changes', 'repo review: no_changes'],
      [{ ok: false, code: 'rate_limited' }, 'repo_error=rate_limited', 'repo review: rate_limited'],
      [{ ok: false, code: 'not_holder' }, 'repo_error=not_holder', 'repo review: not_holder'],
      [{ ok: false, code: 'upstream_timeout' }, 'repo_error=upstream_timeout', 'repo review: upstream_timeout'],
      // The files a review was refused for travel as a count, never as paths.
      [{ ok: false, code: 'tests_modified', files: 2 }, 'repo_error=tests_modified&files=2', 'repo review: tests_modified'],
      [{ ok: false, code: 'protected_paths', files: 1 }, 'repo_error=protected_paths&files=1', 'repo review: protected_paths'],
      // The pull request in the way travels as its number.
      [{ ok: false, code: 'head_taken', pr: 77 }, 'repo_error=head_taken&pr=77', 'repo review: head_taken'],
    ];
    for (const [outcome, query, logged] of refusals) {
      const run = await callback(GOOD, attempt, { act: async () => outcome });
      expect(run.response.headers.get('location')).toBe(`/contribute/task/7?${query}`);
      expectRevokedFirst(run);
      // Logged by its code (and status) only.
      expectLogs(run, [logged, REVOKED]);
      await expectNothingLeaked(run, attempt);
    }
  });

  test('GitHub won\'t say whose the token is: github_failed, logged by code, and still revoked', async () => {
    const attempt = await NOW_TX();
    const run = await callback(GOOD, attempt, {
      userIdOf: async () => {
        throw new AuthError('github_user_failed', `could not read the user for ${TOKEN}`);
      },
    });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
    expect(run.acted).toEqual([]);
    expectRevokedFirst(run);
    expectLogs(run, ['repo authorization failed: github_user_failed', REVOKED]);
    await expectNothingLeaked(run, attempt);
  });

  test('an action that throws is github_failed, logged without its message, and the token is still revoked', async () => {
    const attempt = await NOW_TX();
    const run = await callback(GOOD, attempt, {
      act: async () => {
        throw new Error(`boom with ${TOKEN}`);
      },
    });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
    expectRevokedFirst(run);
    expectLogs(run, ['repo authorization failed: unexpected', REVOKED]);
    await expectNothingLeaked(run, attempt);
  });

  test('a revocation GitHub doesn\'t confirm (or that throws) is a warning, without the token', async () => {
    const attempt = await NOW_TX();
    for (const revoke of [
      async () => false,
      async () => {
        throw new Error(`network down for ${TOKEN}`);
      },
    ]) {
      const run = await callback(GOOD, attempt, { revoke });
      expect(run.response.headers.get('location')).toBe('/contribute/task/7?copy=ready');
      expect(run.logs).toEqual([NOT_CONFIRMED]);
      expect(run.levels).toEqual(['warn']);
      await expectNothingLeaked(run, attempt);
    }
  });

  test('a code GitHub won\'t exchange: github_failed by its code, and no token to revoke', async () => {
    const attempt = await NOW_TX();
    const run = await callback(GOOD, attempt, {
      exchange: async () => {
        throw new AuthError('bad_verification_code', `bad ${CODE} ${APP.clientSecret}`);
      },
    });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
    expect(run.ran).not.toContain('revoke');
    expect(run.ran).not.toContain('kept alive');
    expect(run.acted).toEqual([]);
    expect(run.logs).toEqual(['repo authorization failed: bad_verification_code']);
    await expectNothingLeaked(run, attempt);
  });

  test('a state that doesn\'t match: github_failed, and nothing is exchanged', async () => {
    const attempt = await NOW_TX();
    for (const state of ['definitely-not-it', '', `${GOOD.state}x`, GOOD.state.slice(1)]) {
      const run = await callback({ state, code: CODE }, attempt);
      expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
      expect(run.ran).toEqual(['attempt spent']);
    }
    const missing = await callback({ code: CODE }, attempt);
    expect(missing.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
  });

  test('GitHub said no (error=access_denied): github_denied, and nothing is exchanged', async () => {
    const attempt = await NOW_TX();
    const run = await callback({ state: GOOD.state, error: 'access_denied' }, attempt);
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_denied');
    expect(run.ran).toEqual(['attempt spent']);
  });

  test('the OAuth App switched off since: not_configured', async () => {
    const run = await callback(GOOD, await NOW_TX(), { app: async () => null });
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=not_configured');
    expect(run.ran).toEqual(['attempt spent']);
  });

  test('signed out (or the practice account) by the time GitHub sends you back: signed_out', async () => {
    for (const session of [null, PRACTICE]) {
      const run = await callback(GOOD, await NOW_TX(), { session: async () => session });
      expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=signed_out');
      expect(run.ran).toEqual(['attempt spent']);
    }
  });

  test('no code: github_failed, nothing exchanged', async () => {
    const run = await callback({ state: GOOD.state }, await NOW_TX());
    expect(run.response.headers.get('location')).toBe('/contribute/task/7?repo_error=github_failed');
    expect(run.ran).toEqual(['attempt spent']);
  });

  test('no repo attempt to go by (none, a sign-in\'s, an agent\'s): to the board, saying it expired', async () => {
    const signIn = await openTransaction(
      await sealTransaction({ state: GOOD.state, verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', next: '/contribute/task/7' }, SECRET),
      [SECRET],
    );
    const agent = await NOW_TX({ purpose: 'agent', rail: 'copilot', action: undefined } as Partial<TransactionInput>);
    for (const attempt of [null, signIn, agent]) {
      const run = await callback(GOOD, attempt);
      expectOnlyTaskPage(run, null);
      expect(run.ran).toEqual(['attempt spent']);
    }
  });

  test('lands only on the sealed task\'s page, whatever `next` or the query says', async () => {
    // A `next` that is somewhere else entirely is never where the browser goes.
    const attempt = await NOW_TX({ next: '/me/settings', taskId: 12 });
    const run = await callback({ ...GOOD, next: 'https://evil.example', redirect_uri: '//evil.example' }, attempt);
    expectOnlyTaskPage(run, 12);
    expect(run.response.headers.get('location')).toBe('/contribute/task/12?copy=ready');
  });
});

test.describe('revokeNow (both callbacks\' revocation, review-web W-M1)', () => {
  test('starts the revocation before it returns, and says when GitHub confirmed it, at info', async () => {
    const ran: string[] = [];
    const logged: [string, string][] = [];
    const running = revokeNow(
      async () => {
        ran.push('revoking');
        return true;
      },
      (line, level) => logged.push([line, level]),
      'agent authorization',
    );
    // Already under way: nothing waits for the response, or for anyone to call it later.
    expect(ran).toEqual(['revoking']);
    await running;
    expect(logged).toEqual([['agent authorization: one-time GitHub token revoked', 'info']]);
  });

  test('warns when GitHub doesn\'t confirm it, or the call throws, and never rejects', async () => {
    for (const revoke of [
      async () => false,
      async () => {
        throw new Error('fetch failed');
      },
    ]) {
      const logged: [string, string][] = [];
      await expect(revokeNow(revoke, (line, level) => logged.push([line, level]), 'repo authorization')).resolves.toBeUndefined();
      expect(logged).toEqual([['repo authorization: GitHub did not confirm the one-time token was revoked', 'warn']]);
    }
  });

  test('both callbacks hand after() the revocation already running, never a callback for later', () => {
    const read = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8');
    const copilot = read('apps/web/src/app/auth/callback/route.ts');
    expect(copilot).toMatch(/after\(\s*revokeNow\(/);
    expect(copilot).not.toMatch(/after\(\s*async\s*\(\)\s*=>\s*\{\s*const revoked = await revokeGitHubToken/);
    const repo = read('apps/web/src/app/auth/github/repo/callback/route.ts');
    expect(repo).toMatch(/keepAlive: \(running\) => \{\s*after\(running\);/);
  });
});

test.describe('withOneTimeToken (shared by the Copilot start and the repo callback)', () => {
  function steps<T>(userId: string | Error, act: () => Promise<T>) {
    const ran: string[] = [];
    return {
      ran,
      given: {
        userIdOf: async (token: string) => {
          ran.push(`user ${token}`);
          if (userId instanceof Error) throw userId;
          return userId;
        },
        act: async (token: string) => {
          ran.push(`act ${token}`);
          return act();
        },
        revoke: (token: string) => {
          ran.push(`revoke ${token}`);
        },
      },
    };
  }

  test('acts, then revokes', async () => {
    const { ran, given } = steps('1', async () => ({ ok: true, pr: 3 }));
    await expect(withOneTimeToken('t', '1', given)).resolves.toEqual({ ok: true, pr: 3 });
    expect(ran).toEqual(['user t', 'act t', 'revoke t']);
  });

  test('someone else\'s token: wrong_account, no action, revoked', async () => {
    const { ran, given } = steps('2', async () => ({ ok: true }));
    await expect(withOneTimeToken('t', '1', given)).resolves.toEqual({ ok: false, code: 'wrong_account' });
    expect(ran).toEqual(['user t', 'revoke t']);
  });

  test('an action that throws still revokes, and the error surfaces', async () => {
    const { ran, given } = steps('1', async () => {
      throw new Error('act failed');
    });
    await expect(withOneTimeToken('t', '1', given)).rejects.toThrow('act failed');
    expect(ran).toEqual(['user t', 'act t', 'revoke t']);
  });

  test('a user that can\'t be read still revokes, and the error surfaces', async () => {
    const { ran, given } = steps(new Error('github_user_failed'), async () => ({ ok: true }));
    await expect(withOneTimeToken('t', '1', given)).rejects.toThrow('github_user_failed');
    expect(ran).toEqual(['user t', 'revoke t']);
  });
});

test.describe('how long the server waits on the API', () => {
  test('45 s for either action, inside a 60 s callback that always keeps 12 s to revoke the token', () => {
    expect(REPO_ACTION_TIMEOUT_MS).toEqual({ copy: 45_000, review: 45_000 });
    expect(CALLBACK_MAX_SECONDS).toBe(60);
    expect(REVOKE_RESERVE_MS).toBe(12_000);
    expect(actionTimeoutMs('copy', 0)).toBe(45_000);
    expect(actionTimeoutMs('review', 2_000)).toBe(45_000);
    // A slow exchange leaves less for the action, never less for the revocation.
    expect(actionTimeoutMs('copy', 10_000)).toBe(38_000);
    expect(actionTimeoutMs('copy', 30_000)).toBe(18_000);
    for (const elapsed of [0, 1_000, 3_000, 10_000, 20_000, 40_000, 47_000]) {
      expect(elapsed + actionTimeoutMs('copy', elapsed) + REVOKE_RESERVE_MS, String(elapsed)).toBeLessThanOrEqual(60_000);
    }
    // Past the budget it still sends, with a second's wait, rather than not at all; a clock gone backwards counts as none.
    expect(actionTimeoutMs('review', 59_000)).toBe(1_000);
    expect(actionTimeoutMs('copy', -5_000)).toBe(45_000);
  });

  test('the callback route\'s maxDuration is that same 60 (Next reads it without running the file)', () => {
    const route = readFileSync(join(__dirname, '..', '..', 'apps/web/src/app/auth/github/repo/callback/route.ts'), 'utf8');
    expect(/^export const maxDuration = (\d+);$/m.exec(route)?.[1]).toBe(String(CALLBACK_MAX_SECONDS));
  });
});

test.describe('what /api/bridge/copy\'s answer needs said (copiedState)', () => {
  test('only a plain false for synced or branchFromLatest counts', () => {
    expect(copiedState({ fullName: 'maya/forge-app', branch: 'task/1-x', synced: true, branchCreated: true, branchFromLatest: true })).toEqual({});
    expect(copiedState({ synced: false, branchFromLatest: true })).toEqual({ synced: false });
    expect(copiedState({ synced: true, branchFromLatest: false })).toEqual({ latest: false });
    expect(copiedState({ synced: false, branchFromLatest: false })).toEqual({ synced: false, latest: false });
    for (const body of [null, 'x', [], {}, { synced: 'false', branchFromLatest: 0 }, { synced: null }]) {
      expect(copiedState(body), JSON.stringify(body)).toEqual({});
    }
  });
});

test.describe('the pull request in /api/bridge/review\'s answer', () => {
  test('is its number when it has one that could be a pull request\'s', () => {
    expect(reviewedPullRequest({ pullRequest: { number: 42, url: 'https://github.com/verastd/forge-app/pull/42' }, created: true })).toBe(42);
    for (const body of [null, 'x', [], {}, { pullRequest: null }, { pullRequest: { number: '42' } }, { pullRequest: { number: 0 } }, { pullRequest: { number: 1.5 } }, { pullRequest: { number: 1e10 } }]) {
      expect(reviewedPullRequest(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

/* --- the OAuth App's settings ---------------------------------------------------------------- */

test.describe('GITHUB_REPO_CLIENT_ID and GITHUB_REPO_CLIENT_SECRET (repoAppSettings)', () => {
  const ENV = { clientId: 'Ov23liAbCdEf01234567', clientSecret: 'e2e-fake-settings-secret', signInClientId: 'Iv23liSignIn', origin: 'https://forge.example' };

  test('usable settings switch the feature on', () => {
    expect(repoAppSettings(ENV)).toEqual({ clientId: ENV.clientId, clientSecret: ENV.clientSecret, origin: ENV.origin });
    // An older OAuth App's 20-hex-character id works too.
    expect(repoAppSettings({ ...ENV, clientId: '0123456789abcdef0123' })).not.toBeNull();
  });

  test('anything unset or unusable switches it off', () => {
    for (const [label, overrides] of [
      ['no client id', { clientId: undefined }],
      ['an empty client id', { clientId: '' }],
      ['a client id with a space', { clientId: 'Ov23 li' }],
      ['a client id with a slash', { clientId: 'Ov23/li' }],
      ['a client id that is the sign-in App\'s', { clientId: 'Iv23liSignIn' }],
      ['no secret', { clientSecret: undefined }],
      ['an empty secret', { clientSecret: '' }],
      ['a secret with a space', { clientSecret: 'abc def' }],
      ['a secret Basic auth cannot carry', { clientSecret: 'clé-secrète' }],
      ['a secret over 200 characters', { clientSecret: 'x'.repeat(201) }],
      ['no public origin', { origin: null }],
    ] as const) {
      expect(repoAppSettings({ ...ENV, ...overrides }), label).toBeNull();
    }
  });
});

/* --- the task page's words ---------------------------------------------------------------------- */

test.describe('what the repo callback sends back, in plain words', () => {
  test('reads each outcome from the query string, an error first', () => {
    expect(readRepoOutcome({ copy: 'ready' })).toEqual({ kind: 'copied' });
    expect(readRepoOutcome({ review: 'sent', pr: '42' })).toEqual({ kind: 'sent', pr: 42 });
    expect(readRepoOutcome({ review: 'sent' })).toEqual({ kind: 'sent' });
    expect(readRepoOutcome({ review: 'sent', pr: '0' })).toEqual({ kind: 'sent' });
    expect(readRepoOutcome({ review: 'sent', pr: '<b>1</b>' })).toEqual({ kind: 'sent' });
    expect(readRepoOutcome({ repoError: 'github_failed', status: '502' })).toEqual({
      kind: 'error',
      failure: { code: 'github_failed', upstreamStatus: 502 },
    });
    // A status only goes with the codes it explains.
    expect(readRepoOutcome({ repoError: 'no_changes', status: '409' })).toEqual({ kind: 'error', failure: { code: 'no_changes' } });
    expect(readRepoOutcome({ repoError: 'github_failed', status: 'x' })).toEqual({ kind: 'error', failure: { code: 'github_failed' } });
    expect(readRepoOutcome({ copy: 'ready', repoError: 'wrong_account' })).toEqual({ kind: 'error', failure: { code: 'wrong_account' } });
    expect(readRepoOutcome({ repoError: '<script>alert(1)</script>' })).toEqual({ kind: 'error', failure: { code: 'unknown' } });
    expect(readRepoOutcome({ copy: 'yes', review: 'maybe' })).toBeNull();
    expect(readRepoOutcome({})).toBeNull();
  });

  test('copy=ready carries synced=0 and latest=0 only as exactly that', () => {
    expect(readRepoOutcome({ copy: 'ready', synced: '0' })).toEqual({ kind: 'copied', synced: false });
    expect(readRepoOutcome({ copy: 'ready', latest: '0' })).toEqual({ kind: 'copied', latest: false });
    expect(readRepoOutcome({ copy: 'ready', synced: '0', latest: '0' })).toEqual({ kind: 'copied', synced: false, latest: false });
    for (const value of ['1', 'false', '', 'no', '00']) {
      expect(readRepoOutcome({ copy: 'ready', synced: value, latest: value }), value).toEqual({ kind: 'copied' });
    }
    // Only beside a copy that is ready.
    expect(readRepoOutcome({ review: 'sent', pr: '4', synced: '0' })).toEqual({ kind: 'sent', pr: 4 });
    expect(copiedSentences({})).toEqual([COPY_READY_SENTENCE]);
    expect(copiedSentences({ synced: false, latest: false })).toEqual([
      COPY_READY_SENTENCE,
      COPY_NOT_SYNCED_SENTENCE,
      COPY_NOT_LATEST_SENTENCE,
    ]);
    expect(COPY_NOT_SYNCED_SENTENCE).toBe(
      "FORGE couldn't bring your copy fully up to date, because it has changes of its own. That doesn't stop your agent: it works on this task's own branch.",
    );
    expect(COPY_NOT_LATEST_SENTENCE).toBe(
      "Your agent's branch starts from your copy's main, which may be behind FORGE's latest code. Ask your agent to bring the branch up to date with FORGE's code first.",
    );
  });

  test('head_taken carries the pull request in the way, as a number only', () => {
    expect(readRepoOutcome({ repoError: 'head_taken', pr: '77' })).toEqual({
      kind: 'error',
      failure: { code: 'head_taken', pullRequest: 77 },
    });
    for (const pr of ['0', 'x', '-3', '1234567890', '<b>7</b>', '7#x']) {
      expect(readRepoOutcome({ repoError: 'head_taken', pr }), pr).toEqual({ kind: 'error', failure: { code: 'head_taken' } });
    }
    // Only head_taken names a pull request.
    expect(readRepoOutcome({ repoError: 'no_changes', pr: '77' })).toEqual({ kind: 'error', failure: { code: 'no_changes' } });
    expect(describeRepoError({ code: 'head_taken', pullRequest: 77 })).toBe(
      "Someone else opened pull request #77 from your copy's branch. FORGE can't send yours while it's open. Ask a maintainer to close it.",
    );
    expect(describeRepoError('head_taken')).toBe(
      "Someone else opened a pull request from your copy's branch. FORGE can't send yours while it's open. Ask a maintainer to close it.",
    );
  });

  test('step 3 says what the pull request will say in the person\'s name', () => {
    expect(REVIEW_SAYS_SENTENCE).toBe(
      "FORGE opens the pull request in your name. It says, for you, that your agent didn't change or delete any existing tests (FORGE checks that first) and that an AI agent did the work.",
    );
    expect(REVIEW_SAYS_SENTENCE).not.toMatch(/fork/i);
  });

  test('a count of files goes only with the refusals that name files, and only as a number', () => {
    expect(readRepoOutcome({ repoError: 'protected_paths', files: '3' })).toEqual({
      kind: 'error',
      failure: { code: 'protected_paths', files: 3 },
    });
    expect(readRepoOutcome({ repoError: 'tests_modified', files: '1' })).toEqual({
      kind: 'error',
      failure: { code: 'tests_modified', files: 1 },
    });
    for (const files of ['0', '1000', 'x', '-1', '.github/workflows/ci.yml', '<b>2</b>']) {
      expect(readRepoOutcome({ repoError: 'tests_modified', files }), files).toEqual({
        kind: 'error',
        failure: { code: 'tests_modified' },
      });
    }
    expect(readRepoOutcome({ repoError: 'no_changes', files: '3' })).toEqual({ kind: 'error', failure: { code: 'no_changes' } });
  });

  test('every code the callback or the API can send has its own sentence, and none says "fork"', () => {
    const codes = [...REPO_ERROR_CODES];
    // The API's codes, the web's own, the review's checks, and everything the Bridge answers besides.
    for (const code of [
      ...REPO_ACTION_ERRORS,
      ...WEB_REPO_ERRORS,
      ...REVIEW_CHECK_ERRORS,
      'not_claimed',
      'task_not_found',
      'bridge-disabled',
    ]) {
      expect(codes, code).toContain(code);
    }
    const generic = describeRepoError('unknown');
    const sentences = new Set<string>();
    for (const code of codes) {
      const sentence = describeRepoError(code);
      expect(sentence, code).not.toBe(generic);
      expect(sentence, code).not.toMatch(/fork/i);
      expect(sentence, code).toMatch(/^[A-Z“"].*[.!]$/);
      sentences.add(sentence);
    }
    // not_holder and not_claimed say the same thing, as everywhere else on the page.
    expect(sentences.size).toBe(codes.length - 1);
    for (const sentence of [
      COPY_READY_SENTENCE,
      COPY_NOT_SYNCED_SENTENCE,
      COPY_NOT_LATEST_SENTENCE,
      sentForReviewSentence(42),
      sentForReviewSentence(undefined),
      generic,
    ]) {
      expect(sentence).not.toMatch(/fork/i);
    }
  });

  test('the sentences that carry a number', () => {
    expect(describeRepoError({ code: 'github_failed', upstreamStatus: 422 })).toBe(
      "GitHub turned down one of FORGE's requests (error 422). Try again in a minute: FORGE picks up where it stopped.",
    );
    expect(describeRepoError('github_failed')).toBe("GitHub didn't finish the approval, so FORGE did nothing. Please try again.");
    expect(describeRepoError({ code: 'api_failed', upstreamStatus: 502 })).toBe(
      "FORGE's service didn't answer properly (error 502), so it may not have gone through. Reload the page to see where things stand.",
    );
    expect(describeRepoError({ code: 'tests_modified', files: 2 })).toBe(
      "Your agent changed 2 test files that were already there, so FORGE didn't send it. Ask your agent to undo that and put any new tests in new files, then send it for review again.",
    );
    expect(describeRepoError({ code: 'tests_modified', files: 1 })).toBe(
      "Your agent changed a test file that was already there, so FORGE didn't send it. Ask your agent to undo that and put any new tests in new files, then send it for review again.",
    );
    expect(describeRepoError('tests_modified')).toBe(
      "Your agent changed tests that were already there, so FORGE didn't send it. Ask your agent to undo that and put any new tests in new files, then send it for review again.",
    );
    expect(describeRepoError({ code: 'protected_paths', files: 3 })).toBe(
      "Your agent changed 3 files that contributors can't change, so FORGE didn't send it. Ask your agent to undo those changes, then send it for review again.",
    );
    expect(describeRepoError({ code: 'protected_paths', files: 1 })).toBe(
      "Your agent changed a file that contributors can't change, so FORGE didn't send it. Ask your agent to undo that change, then send it for review again.",
    );
    expect(describeRepoError('protected_paths')).toBe(
      "Your agent changed some files that contributors can't change, so FORGE didn't send it. Ask your agent to undo those changes, then send it for review again.",
    );
    expect(describeRepoError('too_large')).toBe(
      "This change is too big for one task, so FORGE didn't send it. Ask your agent to keep to what the task asks, then send it for review again.",
    );
    expect(describeRepoError('checks_unavailable')).toBe(
      "FORGE couldn't check the change just now, so nothing was sent. Try again in a few minutes.",
    );
    expect(sentForReviewSentence(42)).toBe('Sent for review: pull request #42. Its checks show up below as they run.');
    expect(sentForReviewSentence(undefined)).toBe('Sent for review. Its checks show up below as they run.');
    expect(COPY_READY_SENTENCE).toBe('Your copy is ready. Your agent can work in it now.');
  });

  test('a ?review=sent is believed only when the status shows that pull request on verastd/forge-app', () => {
    const at = (prUrl: string | undefined) => ({ prUrl });
    expect(reviewSentBy(at('https://github.com/verastd/forge-app/pull/42'), 42)).toBe(true);
    expect(reviewSentBy(at('https://github.com/verastd/forge-app/pull/42'), undefined)).toBe(true);
    expect(reviewSentBy(at('https://github.com/verastd/forge-app/pull/43'), 42)).toBe(false);
    expect(reviewSentBy(at('https://github.com/someone/forge-app/pull/42'), 42)).toBe(false);
    expect(reviewSentBy(at('http://github.com/verastd/forge-app/pull/42'), 42)).toBe(false);
    expect(reviewSentBy(at('https://github.com.evil.example/verastd/forge-app/pull/42'), 42)).toBe(false);
    expect(reviewSentBy(at(undefined), 42)).toBe(false);
    expect(reviewSentBy(null, undefined)).toBe(false);
    expect(upstreamPullRequest(at('https://github.com/verastd/forge-app/pull/7#discussion'))).toEqual({
      url: 'https://github.com/verastd/forge-app/pull/7#discussion',
      number: 7,
    });
  });
});

test.describe('when "Send for review" is offered (reviewState)', () => {
  const event = (overrides: Record<string, unknown>) => ({ at: '2026-10-05T10:00:00Z', source: 'forge', message: 'x', kind: 'claimed', ...overrides });
  const status = (overrides: Record<string, unknown> = {}) =>
    ({ stage: 'agent_working', events: [event({})], ...overrides }) as Parameters<typeof reviewState>[1];
  const pushed = event({ source: 'agent', kind: 'progress', stage: 'pushed' });
  const done = event({ source: 'agent', kind: 'progress', stage: 'done' });
  const pr = 'https://github.com/verastd/forge-app/pull/42';

  test('waits for the status, so a stale "can send" never offers a second pull request', () => {
    expect(reviewState({ canSendForReview: true }, null, false)).toBe('waiting');
  });

  test('ready when the API says the copy has work to send, or the agent says it pushed or is done', () => {
    expect(reviewState({ canSendForReview: true }, status(), false)).toBe('ready');
    expect(reviewState({}, status({ events: [pushed] }), false)).toBe('ready');
    expect(reviewState({}, status({ events: [done] }), false)).toBe('ready');
    expect(reviewState({ canSendForReview: false }, status({ events: [pushed] }), false)).toBe('ready');
    expect(reviewState({}, status(), false)).toBe('waiting');
    // Only the agent's own word counts, not a FORGE line that happens to say "pushed".
    expect(reviewState({}, status({ events: [event({ stage: 'pushed' })] }), false)).toBe('waiting');
  });

  test('sent once the pull request is open, in checks, in review or merged', () => {
    for (const stage of ['in_checks', 'in_review', 'shipping', 'shipped']) {
      expect(reviewState({ canSendForReview: true }, status({ stage, prUrl: pr, events: [pushed] }), false), stage).toBe('sent');
    }
    // Closed without merging (back to agent working): there is something to send again.
    expect(reviewState({ canSendForReview: true }, status({ stage: 'agent_working', prUrl: pr }), false)).toBe('ready');
  });

  test('the practice app, which has no pull request: sent once its pretend review (or its pretend agent) sent one', () => {
    expect(reviewState({}, status({ events: [pushed, event({ kind: 'review_sent' })] }), true)).toBe('sent');
    expect(reviewState({}, status({ events: [pushed, event({ source: 'agent', kind: 'progress', stage: 'pr_opened' })] }), true)).toBe('sent');
    expect(reviewState({}, status({ events: [pushed] }), true)).toBe('ready');
  });
});

test.describe('the copy in the "Open my agent" links', () => {
  const brief = compileBrief({ id: 1, title: 'T', civilianSummary: 'S', url: 'https://github.com/verastd/forge-app/issues/1' }, [], 'maya', 'maya/forge-app-1');
  const links = (copy: string | null | undefined, login: string | null = 'maya', long = false) =>
    Object.fromEntries(
      launchLinks({ taskId: 1, brief: long ? 'x'.repeat(8000) : brief, login, apiBase: 'https://api.forge.test', copy }).map((launch) => [
        launch.rail,
        launch.href ?? '',
      ]),
    );

  test('name the copy when there is one, wherever the agent takes a repository', () => {
    const href = links('maya/forge-app-1');
    expect(new URL(href['claude-code'] ?? '').searchParams.get('repositories')).toBe('maya/forge-app-1');
    expect(new URL(href['claude-cli'] ?? '').searchParams.get('repo')).toBe('maya/forge-app-1');
    expect(new URL(href.codex ?? '').searchParams.get('originUrl')).toBe('https://github.com/maya/forge-app-1.git');
  });

  test('fall back to <login>/forge-app with no copy, or one that isn\'t a repository\'s full name', () => {
    for (const copy of [null, undefined, '', 'maya', 'maya/', '/forge-app', 'maya/../x', 'maya/forge app', 'https://github.com/maya/forge-app-1']) {
      const href = links(copy);
      expect(new URL(href['claude-code'] ?? '').searchParams.get('repositories'), String(copy)).toBe('maya/forge-app');
    }
    // The practice account (no login) and no copy: no repository at all.
    expect(new URL(links(null, null)['claude-code'] ?? '').searchParams.has('repositories')).toBe(false);
  });

  test('a long brief\'s prompt_url asks the API for the brief with the copy, only when the copy is the login\'s own', () => {
    const own = new URL(new URL(links('Maya/forge-app-1', 'maya', true)['claude-code'] ?? '').searchParams.get('prompt_url') ?? '');
    expect(own.pathname).toBe('/api/bridge/tasks/1/brief');
    expect(Object.fromEntries(own.searchParams)).toEqual({ login: 'maya', copy: 'Maya/forge-app-1' });
    const other = new URL(new URL(links('someone/forge-app', 'maya', true)['claude-code'] ?? '').searchParams.get('prompt_url') ?? '');
    expect(Object.fromEntries(other.searchParams)).toEqual({ login: 'maya' });
    const none = new URL(new URL(links(null, 'maya', true)['claude-code'] ?? '').searchParams.get('prompt_url') ?? '');
    expect(Object.fromEntries(none.searchParams)).toEqual({ login: 'maya' });
  });
});

test.describe('timeAgo ("up to date 5 minutes ago")', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  test('says how long ago, in words', () => {
    const ago = (ms: number) => timeAgo(new Date(NOW - ms).toISOString(), NOW);
    expect(ago(-30_000)).toBe('just now');
    expect(ago(20_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(3 * 60 * 60_000)).toBe('3 hours ago');
    expect(ago(26 * 60 * 60_000)).toBe('yesterday');
    expect(ago(4 * 24 * 60 * 60_000)).toBe('4 days ago');
    expect(ago(20 * 24 * 60 * 60_000)).toMatch(/^on /);
    expect(timeAgo('not a time', NOW)).toBe('at some point');
  });
});

/* --- the practice app's pretend copy and review ------------------------------------------------- */

test.describe('the practice app\'s three steps (lib/offline.ts)', () => {
  const task = TASK_FIXTURES[0];
  if (task === undefined) throw new Error('no task fixtures');
  const T0 = Date.parse('2026-10-05T12:00:00Z');

  test('Get started makes a pretend copy, Refresh brings it up to date, and the task shows it', () => {
    const { practice } = localClaim(task, T0);
    expect(localTaskDetail(task, practice).copy).toBeUndefined();
    const first = localCopy(task, practice, T0 + 1000);
    expect(first.result).toMatchObject({ fullName: PRACTICE_COPY, synced: true, branchCreated: true, branchFromLatest: true });
    expect(first.practice.events.at(-1)).toMatchObject({ kind: 'copy_ready', source: 'forge' });
    expect(first.practice.events.at(-1)?.message).toMatch(/^Practice: .*Nothing was sent\.$/);
    const again = localCopy(task, first.practice, T0 + 60_000);
    expect(again.result.branchCreated).toBe(false);
    expect(localTaskDetail(task, again.practice).copy).toEqual({ fullName: PRACTICE_COPY, syncedAt: '2026-10-05T12:01:00Z' });
    // The practice brief never names the pretend copy.
    expect(localTaskDetail(task, again.practice).brief).toBe(localTaskDetail(task).brief);
  });

  test('a run in the copy holds at "ready to submit" until it is sent for review, then carries on', () => {
    const { practice: claimed } = localClaim(task, T0);
    const copied = localCopy(task, claimed, T0).practice;
    expect(localReview(copied, T0)).toEqual({ refused: 'no_changes' });
    const handed = localDispatch(task, copied, { rail: 'jules' }, T0 + 1000).practice;
    expect(stageFor(handed, T0 + 1000 + 50_000)).toBe('ready_to_submit');
    // An hour later it still waits for the person.
    expect(stageFor(handed, T0 + 60 * 60_000)).toBe('ready_to_submit');
    expect(localStatus(task.id, handed, T0 + 60 * 60_000).events.map((event) => event.stage)).not.toContain('pr_opened');

    const reviewed = localReview(handed, T0 + 60 * 60_000);
    if (!('practice' in reviewed)) throw new Error('the practice review was refused');
    expect(reviewed.practice.events.at(-1)).toMatchObject({ kind: 'review_sent', source: 'forge' });
    expect(stageFor(reviewed.practice, T0 + 60 * 60_000 + 1000)).toBe('in_checks');
    expect(stageFor(reviewed.practice, T0 + 60 * 60_000 + 46_000)).toBe('in_review');
  });

  test('without a copy there is nothing to review, and a run started before the copy keeps its old march', () => {
    const { practice: claimed } = localClaim(task, T0);
    expect(localReview(claimed, T0)).toEqual({ refused: 'no_copy' });
    const handed = localDispatch(task, claimed, { rail: 'jules' }, T0).practice;
    const copiedLater = localCopy(task, handed, T0 + 1000).practice;
    expect(stageFor(copiedLater, T0 + 100_000)).toBe('in_checks');
  });
});

/* --- the routes on the practice build's server ---------------------------------------------------- */

test.describe('POST /auth/github/repo on the practice build', () => {
  test('the practice account is refused outright: 403 practice_session', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await context.request.post('/auth/github/repo', {
      form: { taskId: '1', action: 'copy' },
      headers: { origin: baseURL ?? '' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'practice_session' });
    expect((await context.cookies()).find((cookie) => cookie.name === 'forge_oauth')).toBeUndefined();
  });

  test('a GitHub-shaped session on a build without GitHub sign-in: back to the task, not_configured', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100201', login: 'repo-check' });
    const response = await context.request.post('/auth/github/repo', {
      form: { taskId: '1', action: 'review' },
      headers: { origin: baseURL ?? '' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/contribute/task/1?repo_error=not_configured');
  });

  test('the BFF never forwards /copy or /review: GitHub\'s token only ever goes from the server', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', { sub: '4100202', login: 'bff-copy-check' });
    for (const path of ['/bff/bridge/copy', '/bff/bridge/review']) {
      const response = await context.request.post(path, {
        data: { taskId: 1, token: 'test-only-token' },
        headers: { origin: baseURL ?? '' },
      });
      expect(response.status(), path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'not_found' });
    }
  });
});
