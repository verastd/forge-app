/**
 * The OAuth transaction cookie holds one GitHub authorization attempt's
 * `state` and PKCE verifier, plus where to land afterwards. It is sealed
 * exactly like the session, but under its own HKDF info (`forge-oauth-tx-v1`),
 * so neither token can stand in for the other.
 *
 * Two kinds of attempt share it:
 * - a sign-in carries nothing more;
 * - an `agent` attempt (the Contribute page's "Start GitHub Copilot") also
 *   carries the task and the rail it authorizes, so the callback spends the
 *   one-time GitHub token on starting that agent instead of signing anyone in.
 *
 * The agent fields are all or nothing: a payload with only some of them, or a
 * purpose this code does not know, opens as no transaction at all.
 */
import { TRANSACTION_TTL_SECONDS } from './cookies.js';
import { AuthError } from './errors.js';
import { safeNext } from './redirect.js';
import { openToken, readTimes, sealToken } from './session.js';
import type { TimeOptions } from './session.js';

const TRANSACTION_INFO = 'forge-oauth-tx-v1';
const TRANSACTION_KEYS = new Set(['state', 'verifier', 'next', 'purpose', 'taskId', 'rail', 'iat', 'exp']);

/** What `randomToken(32)` makes, as `state` and the PKCE verifier both are: 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A rail id as `@forge/shared` spells them (`copilot`, `claude-routine`).
 * This package does not depend on that list, so it checks the shape only;
 * the route that seals an attempt decides which rails it may authorize.
 */
const RAIL = /^[a-z][a-z0-9-]{0,31}$/;

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
};

/** What callers seal. `sealTransaction` adds `iat` and `exp`. */
export type TransactionInput = SignInAttempt | AgentAttempt;

export type TransactionClaims = TransactionInput & { iat: number; exp: number };

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

const isTaskId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isRail = (value: unknown): value is string => typeof value === 'string' && RAIL.test(value);

/** The attempt's fields of `value`, or null unless every one is valid. Any other key is dropped. */
function readAttempt(value: unknown): TransactionInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { state, verifier, next, purpose, taskId, rail } = value as Record<string, unknown>;
  // `next` must already be what `safeNext` makes of it.
  if (!isToken(state) || !isToken(verifier) || typeof next !== 'string' || safeNext(next) !== next) {
    return null;
  }
  if (purpose === undefined && taskId === undefined && rail === undefined) {
    return { state, verifier, next };
  }
  if (purpose === 'agent' && isTaskId(taskId) && isRail(rail)) {
    return { state, verifier, next, purpose, taskId, rail };
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
 *   `createPkcePair()`) and `next` already equals `safeNext(next)`; and, for
 *   an agent attempt, unless `purpose` is `'agent'`, `taskId` a positive
 *   whole number and `rail` a rail id (`[a-z][a-z0-9-]{0,31}`). Agent fields
 *   without `purpose: 'agent'` are refused, not dropped.
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws RangeError if `options.now` is not a whole number of seconds.
 */
export async function sealTransaction(tx: TransactionInput, secret: string, options?: TimeOptions): Promise<string> {
  const attempt = readAttempt(tx);
  if (attempt === null) {
    throw new AuthError(
      'invalid_claims',
      'a transaction holds a 43-character state and verifier, a safe next path and, for an agent attempt, a task id and a rail',
    );
  }
  return sealToken(attempt, secret, TRANSACTION_INFO, TRANSACTION_TTL_SECONDS, options);
}

/**
 * The claims in a transaction token, or null. Tries each secret in order
 * (current, then previous) and skips any that are missing or shorter than 32
 * characters. Never throws, on the same terms as `openSession`. A sign-in
 * attempt opens with no `purpose`; an agent attempt with `purpose: 'agent'`,
 * its `taskId` and its `rail`.
 */
export async function openTransaction(
  token: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
  options?: TimeOptions,
): Promise<TransactionClaims | null> {
  return openToken(token, secrets, TRANSACTION_INFO, options, readTransaction);
}
