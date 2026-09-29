/**
 * The OAuth transaction cookie holds one sign-in attempt's `state` and PKCE
 * verifier, plus where to land afterwards. It is sealed exactly like the
 * session, but under its own HKDF info (`forge-oauth-tx-v1`), so neither
 * token can stand in for the other.
 */
import { TRANSACTION_TTL_SECONDS } from './cookies.js';
import { AuthError } from './errors.js';
import { safeNext } from './redirect.js';
import { openToken, readTimes, sealToken } from './session.js';
import type { TimeOptions } from './session.js';

const TRANSACTION_INFO = 'forge-oauth-tx-v1';
const TRANSACTION_KEYS = new Set(['state', 'verifier', 'next', 'iat', 'exp']);

/** What `randomToken(32)` makes, as `state` and the PKCE verifier both are: 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface TransactionClaims {
  state: string;
  verifier: string;
  next: string;
  iat: number;
  exp: number;
}

/** What callers seal. `sealTransaction` adds `iat` and `exp`. */
export type TransactionInput = Omit<TransactionClaims, 'iat' | 'exp'>;

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

/** The attempt's fields of `value`, or null unless every one is valid. */
function readAttempt(value: unknown): TransactionInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { state, verifier, next } = value as Record<string, unknown>;
  // `next` must already be what `safeNext` makes of it.
  if (!isToken(state) || !isToken(verifier) || typeof next !== 'string' || safeNext(next) !== next) {
    return null;
  }
  return { state, verifier, next };
}

function readTransaction(payload: Record<string, unknown>, now: number): TransactionClaims | null {
  if (!Object.keys(payload).every((key) => TRANSACTION_KEYS.has(key))) return null;
  const attempt = readAttempt(payload);
  const times = readTimes(payload, now, TRANSACTION_TTL_SECONDS);
  if (attempt === null || times === null) return null;
  return { ...attempt, ...times };
}

/**
 * A transaction token for one sign-in attempt, valid for 10 minutes from now.
 * Pass `next` through `safeNext` first.
 *
 * @throws AuthError `invalid_claims` unless `state` and `verifier` are
 *   43-character base64url strings (from `randomToken()` and
 *   `createPkcePair()`) and `next` already equals `safeNext(next)`.
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws RangeError if `options.now` is not a whole number of seconds.
 */
export async function sealTransaction(tx: TransactionInput, secret: string, options?: TimeOptions): Promise<string> {
  const attempt = readAttempt(tx);
  if (attempt === null) {
    throw new AuthError('invalid_claims', 'a transaction holds a 43-character state and verifier and a safe next path');
  }
  return sealToken(attempt, secret, TRANSACTION_INFO, TRANSACTION_TTL_SECONDS, options);
}

/**
 * The claims in a transaction token, or null. Tries each secret in order
 * (current, then previous) and skips any that are missing or shorter than 32
 * characters. Never throws, on the same terms as `openSession`.
 */
export async function openTransaction(
  token: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
  options?: TimeOptions,
): Promise<TransactionClaims | null> {
  return openToken(token, secrets, TRANSACTION_INFO, options, readTransaction);
}
