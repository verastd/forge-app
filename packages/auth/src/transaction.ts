/**
 * The OAuth transaction cookie holds one GitHub authorization attempt's
 * `state` and PKCE verifier, plus where to land afterwards. It is sealed
 * exactly like the session, but under its own HKDF info (`forge-oauth-tx-v1`),
 * so neither token can stand in for the other.
 *
 * Three kinds of attempt share it:
 * - a sign-in carries nothing more;
 * - an `agent` attempt (the Contribute page's "Start GitHub Copilot") also
 *   carries the task and the rail it authorizes, so the callback spends the
 *   one-time GitHub token on starting that agent instead of signing anyone in;
 * - a `repo` attempt (the task page's "Get started", "Refresh your copy" and
 *   "Send for review", through FORGE's OAuth App) carries the task and the
 *   one action it authorizes, `copy` or `review`, so its own callback spends
 *   the one-time token on that action and nothing else.
 *
 * Each kind's fields are all or nothing, and belong to that kind alone: a
 * payload with only some of them, another kind's field, or a purpose this
 * code does not know, opens as no transaction at all.
 */
import { TRANSACTION_TTL_SECONDS } from './cookies.js';
import { AuthError } from './errors.js';
import { safeNext } from './redirect.js';
import { openToken, readTimes, sealToken } from './session.js';
import type { TimeOptions } from './session.js';

const TRANSACTION_INFO = 'forge-oauth-tx-v1';
const TRANSACTION_KEYS = new Set(['state', 'verifier', 'next', 'purpose', 'taskId', 'rail', 'action', 'iat', 'exp']);

/** What `randomToken(32)` makes, as `state` and the PKCE verifier both are: 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A rail id as `@forge/shared` spells them (`copilot`, `claude-routine`).
 * This package does not depend on that list, so it checks the shape only;
 * the route that seals an attempt decides which rails it may authorize.
 */
const RAIL = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a `repo` attempt may do with its one-time token: set up (or refresh)
 * the person's copy and the task's branch in it, or open the pull request
 * from it ("Send for review"). Nothing else.
 */
export const REPO_ACTIONS = ['copy', 'review'] as const;
export type RepoAction = (typeof REPO_ACTIONS)[number];

/** True for `copy` or `review`, and nothing else. */
export function isRepoAction(value: unknown): value is RepoAction {
  return typeof value === 'string' && (REPO_ACTIONS as readonly string[]).includes(value);
}

/**
 * One sign-in attempt. (Type aliases rather than interfaces: they carry the
 * implicit index signature jose's `JWTPayload` asks for.)
 */
export type SignInAttempt = {
  state: string;
  verifier: string;
  next: string;
  purpose?: undefined;
  taskId?: undefined;
  rail?: undefined;
  action?: undefined;
};

/** One authorization that starts an agent on a task. Never signs anyone in. */
export type AgentAttempt = {
  state: string;
  verifier: string;
  next: string;
  purpose: 'agent';
  /** The Bridge task to start: a positive whole number. */
  taskId: number;
  /** The rail to start, e.g. `copilot`. */
  rail: string;
  action?: undefined;
};

/**
 * One authorization of FORGE's OAuth App for one action on a task: `copy`
 * or `review`. Never signs anyone in, never starts an agent.
 */
export type RepoAttempt = {
  state: string;
  verifier: string;
  next: string;
  purpose: 'repo';
  /** The Bridge task the action is for: a positive whole number. */
  taskId: number;
  /** What the token may be spent on. */
  action: RepoAction;
  rail?: undefined;
};

/** What callers seal. `sealTransaction` adds `iat` and `exp`. */
export type TransactionInput = SignInAttempt | AgentAttempt | RepoAttempt;

export type TransactionClaims = TransactionInput & { iat: number; exp: number };

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

const isTaskId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isRail = (value: unknown): value is string => typeof value === 'string' && RAIL.test(value);

/** The attempt's fields of `value`, or null unless every one is valid. Any other key is dropped. */
function readAttempt(value: unknown): TransactionInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { state, verifier, next, purpose, taskId, rail, action } = value as Record<string, unknown>;
  // `next` must already be what `safeNext` makes of it.
  if (!isToken(state) || !isToken(verifier) || typeof next !== 'string' || safeNext(next) !== next) {
    return null;
  }
  if (purpose === undefined && taskId === undefined && rail === undefined && action === undefined) {
    return { state, verifier, next };
  }
  if (purpose === 'agent' && isTaskId(taskId) && isRail(rail) && action === undefined) {
    return { state, verifier, next, purpose, taskId, rail };
  }
  if (purpose === 'repo' && isTaskId(taskId) && isRepoAction(action) && rail === undefined) {
    return { state, verifier, next, purpose, taskId, action };
  }
  return null;
}

function readTransaction(payload: Record<string, unknown>, now: number): TransactionClaims | null {
  if (!Object.keys(payload).every((key) => TRANSACTION_KEYS.has(key))) return null;
  const attempt = readAttempt(payload);
  const times = readTimes(payload, now, TRANSACTION_TTL_SECONDS);
  if (attempt === null || times === null) return null;
  return { ...attempt, ...times };
}

/**
 * A transaction token for one attempt, valid for 10 minutes from now. Pass
 * `next` through `safeNext` first.
 *
 * @throws AuthError `invalid_claims` unless `state` and `verifier` are
 *   43-character base64url strings (from `randomToken()` and
 *   `createPkcePair()`) and `next` already equals `safeNext(next)`; for an
 *   agent attempt, unless `purpose` is `'agent'`, `taskId` a positive whole
 *   number and `rail` a rail id (`[a-z][a-z0-9-]{0,31}`); and for a repo
 *   attempt, unless `purpose` is `'repo'`, `taskId` a positive whole number
 *   and `action` one of {@link REPO_ACTIONS}. A kind's fields without its
 *   `purpose`, or beside another kind's, are refused, not dropped.
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws RangeError if `options.now` is not a whole number of seconds.
 */
export async function sealTransaction(tx: TransactionInput, secret: string, options?: TimeOptions): Promise<string> {
  const attempt = readAttempt(tx);
  if (attempt === null) {
    throw new AuthError(
      'invalid_claims',
      'a transaction holds a 43-character state and verifier, a safe next path and, for an agent or repo attempt, a task id and its rail or action',
    );
  }
  return sealToken(attempt, secret, TRANSACTION_INFO, TRANSACTION_TTL_SECONDS, options);
}

/**
 * The claims in a transaction token, or null. Tries each secret in order
 * (current, then previous) and skips any that are missing or shorter than 32
 * characters. Never throws, on the same terms as `openSession`. A sign-in
 * attempt opens with no `purpose`; an agent attempt with `purpose: 'agent'`,
 * its `taskId` and its `rail`; a repo attempt with `purpose: 'repo'`, its
 * `taskId` and its `action`.
 */
export async function openTransaction(
  token: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
  options?: TimeOptions,
): Promise<TransactionClaims | null> {
  return openToken(token, secrets, TRANSACTION_INFO, options, readTransaction);
}
