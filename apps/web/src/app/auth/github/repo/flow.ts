/**
 * "Your copy" and "Send for review" (Phase 7 contract §2): the round trip
 * through FORGE's OAuth App behind the task page's Get started, Refresh your
 * copy and Send for review buttons.
 *
 * 1. `POST /auth/github/repo` (`startRepoAuthorization`): a form from a page
 *    on this origin, holding the task and the action (`copy` or `review`). A
 *    fresh state and PKCE pair are sealed into the transaction cookie as a
 *    `repo` attempt for that task and action, and the browser goes to
 *    GitHub's authorize page for the OAuth App, asking for `public_repo` and
 *    nothing more (after the first approval GitHub normally sends it straight
 *    back without a page).
 * 2. `GET /auth/github/repo/callback` (`finishRepoAuthorization`): the
 *    attempt is opened and spent, the state compared in constant time, the
 *    code exchanged with the OAuth App's credentials and the verifier, and the
 *    one-time token used once (`withOneTimeToken`): it must be the signed-in
 *    account's, then the API does the one action with it
 *    (`/api/bridge/copy` or `/api/bridge/review`), and the token is revoked
 *    with the OAuth App's credentials, whatever happened: the revocation
 *    starts as soon as the action is over, and Next's `after()` keeps the
 *    function alive until GitHub has answered, so a browser that left in the
 *    meantime can't stop it.
 *
 * The browser only ever lands back on the sealed task's page, saying what
 * happened: `?copy=ready` (with `&synced=0` when the copy couldn't be
 * brought up to date, `&latest=0` when the task's branch was made from the
 * copy's own main), `?review=sent&pr=<n>` or `?repo_error=<code>` (with
 * `&status=<n>` when the API gave one, `&files=<n>` when it named the files
 * a review was refused for: how many, never which, and `&pr=<n>` when it
 * named a pull request in the way: `head_taken`). With no attempt to
 * go by, it lands on the task board with `?repo_error=expired`. The token is never
 * logged (only error codes are), stored, put in a URL or a cookie, or sent
 * anywhere but GitHub and the API.
 *
 * Every outside step comes in as a function, so tests/e2e/repo-flow.spec.ts
 * runs both halves without Next, GitHub or the API; the route files wire the
 * real ones. So do the few `@forge/auth` calls (`AuthKit`): this module
 * imports nothing from that package at runtime, because the e2e runner can't
 * load it by name (its exports are ESM only) and loads its build instead.
 */
import type * as Auth from '@forge/auth';
import type { ExchangeCodeParams, RepoAction, SessionClaims, TransactionClaims } from '@forge/auth';

import { jsonError, readBody, redirectTo } from '../../../../lib/auth/http';
import type { RepoAppSettings } from '../../../../lib/auth/repo-app';
import { revokeNow, withOneTimeToken } from '../../one-time-token';
import type { LogLine } from '../../one-time-token';

/** Where GitHub sends the browser back: the OAuth App's registered callback URL is the origin plus this. */
export const REPO_CALLBACK_PATH = '/auth/github/repo/callback';

/**
 * How long the server waits on the API for each action, at most: the API
 * keeps a copy within 40 s in all (its wait for GitHub to make a new copy
 * included), and a review is a few reads and one write.
 */
export const REPO_ACTION_TIMEOUT_MS: Readonly<Record<RepoAction, number>> = { copy: 45_000, review: 45_000 };

/**
 * The callback's own time limit, in seconds: its route's `maxDuration`, which
 * must be this same number (repo-flow.spec.ts checks). 60 because Vercel
 * refuses to deploy a limit above the plan's maximum, and 60 fits every plan.
 */
export const CALLBACK_MAX_SECONDS = 60;

/** Kept back from that limit, whatever came before, for the token's revocation (10 s at most) and the redirect. */
export const REVOKE_RESERVE_MS = 12_000;

/**
 * How long the API may take for `action` once the callback has already spent
 * `elapsedMs` (the code exchange, whose user it is): its own limit, cut so the
 * revocation that runs after the response still fits in the function's time.
 */
export function actionTimeoutMs(action: RepoAction, elapsedMs: number): number {
  const left = CALLBACK_MAX_SECONDS * 1000 - REVOKE_RESERVE_MS - Math.max(0, elapsedMs);
  return Math.max(1000, Math.min(REPO_ACTION_TIMEOUT_MS[action], left));
}

/** The form holds a task number and an action; nothing legitimate comes near this. */
export const MAX_FORM_BYTES = 1024;
const TASK_ID = /^[1-9][0-9]{0,8}$/;

/** The `@forge/auth` calls the flow makes: the routes pass the package's own. */
export type AuthKit = Pick<
  typeof Auth,
  'AuthError' | 'constantTimeEqual' | 'createPkcePair' | 'isRepoAction' | 'publicRepoAuthorizeUrl' | 'randomToken' | 'sealTransaction'
>;

/** FORGE's OAuth App (`githubRepoConfig`). */
export type RepoApp = RepoAppSettings;

/** Who is asking, as the session says. */
export type Visitor = Pick<SessionClaims, 'sub' | 'login' | 'demo'>;

export interface StartSteps {
  auth: Pick<AuthKit, 'createPkcePair' | 'isRepoAction' | 'publicRepoAuthorizeUrl' | 'randomToken' | 'sealTransaction'>;
  /** The form came from a page on this origin (`isSameOrigin`). */
  sameOrigin: (request: Request) => boolean;
  session: () => Promise<Visitor | null>;
  /**
   * The OAuth App and the key to seal the attempt with, or null while the
   * feature is off: the app isn't configured, or sign-in here isn't GitHub.
   */
  setup: () => Promise<{ app: RepoApp; seal: string } | null>;
  /** Sets the transaction cookie to `sealed`. */
  keep: (sealed: string) => Promise<void>;
}

/** The page a task's attempt starts from and comes back to. */
export function taskPagePath(taskId: number): string {
  return `/contribute/task/${taskId}`;
}

/**
 * POST /auth/github/repo. Refused unless the form comes from a page on this
 * origin (403 `bad_origin`); a body over 1 KiB is 413; a task that isn't a
 * task number, or an action other than `copy` and `review`, is 400. Signed
 * out goes to sign-in and back to the task, the practice account gets 403
 * `practice_session`, and with the feature off the task page hears
 * `?repo_error=not_configured`. Whether the person may act on the task at
 * all (holding the claim, the Bridge switched on, the hourly limit) is the
 * API's call, made when the callback asks it.
 */
export async function startRepoAuthorization(request: Request, steps: StartSteps): Promise<Response> {
  const { auth } = steps;
  if (!steps.sameOrigin(request)) return jsonError(403, 'bad_origin');

  const body = await readBody(request, MAX_FORM_BYTES);
  if (body === null) return jsonError(413, 'too_large');
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const taskField = form.get('taskId') ?? '';
  const action = form.get('action') ?? '';
  if (!TASK_ID.test(taskField) || !auth.isRepoAction(action)) return jsonError(400, 'bad_request');
  const taskId = Number(taskField);
  const taskPage = taskPagePath(taskId);

  const session = await steps.session();
  if (session === null) return redirectTo(`/signin?${new URLSearchParams({ next: taskPage }).toString()}`);
  if (session.demo) return jsonError(403, 'practice_session');

  const setup = await steps.setup();
  if (setup === null) return redirectTo(`${taskPage}?repo_error=not_configured`);

  const state = auth.randomToken();
  const { verifier, challenge } = await auth.createPkcePair();
  await steps.keep(
    await auth.sealTransaction({ state, verifier, next: taskPage, purpose: 'repo', taskId, action }, setup.seal),
  );
  return redirectTo(
    auth.publicRepoAuthorizeUrl({
      clientId: setup.app.clientId,
      redirectUri: `${setup.app.origin}${REPO_CALLBACK_PATH}`,
      state,
      codeChallenge: challenge,
    }),
    303,
  );
}

/**
 * What the API made of the action: done (for a copy, whether it couldn't be
 * brought up to date, `synced: false`, or its branch was made from the copy's
 * own main, `latest: false`; for a review, the pull request's number), or its
 * refusal, with GitHub's `status` and how many `files` it named, when it gave
 * them.
 */
export type RepoActOutcome =
  | { ok: true; pr?: number; synced?: false; latest?: false }
  | { ok: false; code: string; status?: number; files?: number; pr?: number };

export interface CallbackSteps {
  auth: Pick<AuthKit, 'AuthError' | 'constantTimeEqual'>;
  /** The sealed attempt, opened and spent: the cookie is cleared, whatever happens next. */
  attempt: () => Promise<TransactionClaims | null>;
  session: () => Promise<Visitor | null>;
  /** The OAuth App, or null while the feature is off. */
  app: () => Promise<RepoApp | null>;
  /** The code and verifier for a token (`exchangeCode`). */
  exchange: (params: Omit<ExchangeCodeParams, 'fetchImpl'>) => Promise<{ accessToken: string }>;
  /** The token's GitHub user id, in decimal (`fetchGitHubUser`). Throws when GitHub won't say. */
  userIdOf: (token: string) => Promise<string>;
  /** The one action, through the API, with the token as its credential. */
  act: (action: RepoAction, taskId: number, token: string, who: Pick<SessionClaims, 'sub' | 'login'>) => Promise<RepoActOutcome>;
  /** Revokes the token with the OAuth App's own credentials: true once GitHub confirms. Never throws. */
  revoke: (app: RepoApp, token: string) => Promise<boolean>;
  /**
   * Keeps the function alive until `running`, already started, settles:
   * Next's `after(promise)`. Never a callback to run later, which Next would
   * hold until the connection closes, a moment already past if the browser
   * left while FORGE waited (review-web W-M1).
   */
  keepAlive: (running: Promise<void>) => void;
  /** One line for the server log. Only codes go in: never a token, a code or a secret. */
  log: LogLine;
}

/**
 * GET /auth/github/repo/callback, from `url` (the request's own). See the
 * module comment for what it does; every way out is a redirect to the sealed
 * task's page, or to the board when there is no attempt to go by.
 */
export async function finishRepoAuthorization(url: URL, steps: CallbackSteps): Promise<Response> {
  const { auth } = steps;
  const attempt = await steps.attempt();
  // No repo attempt (none, expired, tampered, or a sign-in's or an agent's): no task to go back to.
  if (attempt === null || attempt.purpose !== 'repo') return redirectTo('/contribute?repo_error=expired');

  const taskPage = taskPagePath(attempt.taskId);
  const back = (outcome: Record<string, string>): Response =>
    redirectTo(`${taskPage}?${new URLSearchParams(outcome).toString()}`);
  const failed = (code: string, details: { status?: number; files?: number; pr?: number } = {}): Response =>
    back({
      repo_error: code,
      ...(details.status === undefined ? {} : { status: String(details.status) }),
      ...(details.files === undefined ? {} : { files: String(details.files) }),
      ...(details.pr === undefined ? {} : { pr: String(details.pr) }),
    });

  const params = url.searchParams;
  if (!auth.constantTimeEqual(params.get('state') ?? '', attempt.state)) return failed('github_failed');
  // GitHub's own refusal (`access_denied`) arrives with the state but no code.
  if (params.has('error')) return failed('github_denied');

  const app = await steps.app();
  if (app === null) return failed('not_configured');
  const session = await steps.session();
  if (session === null || session.demo) return failed('signed_out');
  const code = params.get('code');
  if (!code) return failed('github_failed');

  let outcome: RepoActOutcome;
  try {
    const { accessToken } = await steps.exchange({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code,
      redirectUri: `${app.origin}${REPO_CALLBACK_PATH}`,
      codeVerifier: attempt.verifier,
    });
    outcome = await withOneTimeToken(accessToken, session.sub, {
      userIdOf: steps.userIdOf,
      act: (token) => steps.act(attempt.action, attempt.taskId, token, { sub: session.sub, login: session.login }),
      // Started now, not after the response: the redirect doesn't wait on GitHub, and `keepAlive`
      // holds the function open until it is done. Logged either way, without the token.
      revoke: (token) => {
        steps.keepAlive(revokeNow(() => steps.revoke(app, token), steps.log, 'repo authorization'));
      },
    });
  } catch (error) {
    // The code only: messages and requests could carry the code or a token.
    steps.log(`repo authorization failed: ${error instanceof auth.AuthError ? error.code : 'unexpected'}`, 'warn');
    return failed('github_failed');
  }

  if (!outcome.ok) {
    steps.log(`repo ${attempt.action}: ${outcome.code}${outcome.status === undefined ? '' : ` ${outcome.status}`}`, 'warn');
    return failed(outcome.code, { status: outcome.status, files: outcome.files, pr: outcome.pr });
  }
  if (attempt.action === 'copy') {
    return back({
      copy: 'ready',
      ...(outcome.synced === false ? { synced: '0' } : {}),
      ...(outcome.latest === false ? { latest: '0' } : {}),
    });
  }
  return back(outcome.pr === undefined ? { review: 'sent' } : { review: 'sent', pr: String(outcome.pr) });
}

/**
 * What POST /api/bridge/copy's answer (`CopyResult`) says needs a word on the
 * page: the copy couldn't be brought up to date (`synced: false`), or the
 * task's branch was made from the copy's own main (`branchFromLatest: false`).
 * Only a plain `false` counts; anything else says nothing.
 */
export function copiedState(body: unknown): { synced?: false; latest?: false } {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ...(fields.synced === false ? { synced: false } : {}),
    ...(fields.branchFromLatest === false ? { latest: false } : {}),
  };
}

/**
 * The pull request number in POST /api/bridge/review's answer
 * (`ReviewResult.pullRequest.number`), or undefined when it carries none
 * that could be a pull request's: then the page says "sent" without one.
 */
export function reviewedPullRequest(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const pullRequest = (body as Record<string, unknown>).pullRequest;
  if (typeof pullRequest !== 'object' || pullRequest === null) return undefined;
  const number = (pullRequest as Record<string, unknown>).number;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 999_999_999
    ? number
    : undefined;
}
