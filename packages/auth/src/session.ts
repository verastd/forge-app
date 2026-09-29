/**
 * The session cookie: a signed-in identity sealed as a JWE (`dir` + A256GCM)
 * under a 256-bit key HKDF-derived from FORGE_SESSION_SECRET, so it is both
 * confidential and tamper-evident without a database.
 *
 * The sealing core (`deriveKey`, `sealToken`, `openToken`) also seals the
 * OAuth transaction cookie, under its own HKDF info. The two kinds get
 * different keys, so neither can ever open as the other.
 */
import { EncryptJWT, jwtDecrypt } from 'jose';
import type { JWTPayload } from 'jose';

import { SESSION_TTL_SECONDS } from './cookies.js';
import { AuthError } from './errors.js';
import { isAvatarUrl, isDisplayName, isGitHubLogin, isGitHubUserId } from './github.js';

/** The shortest secret this package seals, opens or signs with. */
export const MIN_SECRET_LENGTH = 32;

/** How far ahead `iat` may be: a token minted by a server whose clock runs a little fast. */
const CLOCK_SKEW_SECONDS = 60;

const SESSION_INFO = 'forge-session-v1';
const SESSION_KEYS = new Set(['v', 'sub', 'login', 'name', 'avatarUrl', 'demo', 'iat', 'exp']);

const encoder = new TextEncoder();

export interface TimeOptions {
  /** The current time in whole seconds since the epoch. Defaults to the wall clock; tests pin it. */
  now?: number;
}

export interface SessionClaims {
  v: 1;
  /** The GitHub user id in decimal, or `'demo'` for the practice account. */
  sub: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  demo: boolean;
  iat: number;
  exp: number;
}

/** What callers seal. `sealSession` adds `v`, `iat` and `exp`. */
export type SessionInput = Omit<SessionClaims, 'v' | 'iat' | 'exp'>;

const wallClock = (): number => Math.floor(Date.now() / 1000);

function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `now` if given, else the wall clock, in whole seconds.
 *
 * @throws RangeError unless the result is a non-negative integer. A fractional
 *   `iat` would seal a token that the strict reader then refuses.
 */
export function nowSeconds(now: number | undefined): number {
  const value = now ?? wallClock();
  if (!isEpochSeconds(value)) {
    throw new RangeError(`now must be a non-negative whole number of seconds, got ${String(now)}`);
  }
  return value;
}

export function isStrongSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * The 256-bit A256GCM key for `info` under `secret`: HKDF-SHA256 with an empty
 * salt. `info` alone separates the keys of the different token kinds.
 */
export async function deriveKey(secret: string, info: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * `claims` plus `iat` (now) and `exp` (`iat + ttlSeconds`), as a compact JWE
 * (`alg: 'dir'`, `enc: 'A256GCM'`) under the key for `info`.
 *
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws RangeError if `options.now` is not a whole number of seconds.
 */
export async function sealToken(
  claims: JWTPayload,
  secret: string,
  info: string,
  ttlSeconds: number,
  options: TimeOptions | undefined,
): Promise<string> {
  if (!isStrongSecret(secret)) {
    throw new AuthError('weak_secret', `secrets must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const iat = nowSeconds(options?.now);
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .encrypt(await deriveKey(secret, info));
}

/**
 * Opens a token from `sealToken` with the first secret that decrypts it,
 * trying each one in order (current, then previous) and skipping any shorter
 * than 32 characters. `read` validates the payload. Never throws: garbage, the
 * wrong key, tampering, expiry, an invalid clock or an invalid payload all
 * come back as null.
 */
export async function openToken<T>(
  token: unknown,
  secrets: unknown,
  info: string,
  options: TimeOptions | undefined,
  read: (payload: Record<string, unknown>, now: number) => T | null,
): Promise<T | null> {
  const now = options?.now ?? wallClock();
  if (!isEpochSeconds(now) || typeof token !== 'string' || !Array.isArray(secrets)) return null;
  for (const secret of secrets) {
    if (!isStrongSecret(secret)) continue;
    try {
      const { payload } = await jwtDecrypt(token, await deriveKey(secret, info), {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
        // We never seal with `zip`, so refuse it outright rather than
        // decompress anything (jose would, up to 250 kB, by default).
        maxDecompressedLength: 0,
        currentDate: new Date(now * 1000),
      });
      return read(payload, now);
    } catch {
      // Not sealed under this secret, or tampered, malformed or expired.
    }
  }
  return null;
}

/**
 * `iat` and `exp`, if they are whole seconds describing a token that lives at
 * most `maxLifetime`, has not expired, and was not issued further ahead than
 * the clock skew allows.
 */
export function readTimes(
  payload: Record<string, unknown>,
  now: number,
  maxLifetime: number,
): { iat: number; exp: number } | null {
  const { iat, exp } = payload;
  if (!isEpochSeconds(iat) || !isEpochSeconds(exp)) return null;
  const lifetime = exp - iat;
  // jose refuses `exp <= now` already. It is restated so that every rule reads here.
  if (lifetime <= 0 || lifetime > maxLifetime || exp <= now || iat > now + CLOCK_SKEW_SECONDS) {
    return null;
  }
  return { iat, exp };
}

/** The identity fields of `value`, or null unless every one is valid. */
function readIdentity(value: unknown): SessionInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sub, login, name, avatarUrl, demo } = value as Record<string, unknown>;
  if (
    typeof demo !== 'boolean' ||
    // A GitHub user id, or `'demo'`, which only the practice account may carry.
    !(isGitHubUserId(sub) || (demo && sub === 'demo')) ||
    !isGitHubLogin(login) ||
    !isDisplayName(name) ||
    !isAvatarUrl(avatarUrl)
  ) {
    return null;
  }
  return { sub, login, name, avatarUrl, demo };
}

function readSession(payload: Record<string, unknown>, now: number): SessionClaims | null {
  // Only this module mints sessions, so an unknown key means a payload shape
  // this code does not know: refuse it rather than guess.
  if (payload.v !== 1 || !Object.keys(payload).every((key) => SESSION_KEYS.has(key))) return null;
  const identity = readIdentity(payload);
  const times = readTimes(payload, now, SESSION_TTL_SECONDS);
  if (identity === null || times === null) return null;
  return { v: 1, ...identity, ...times };
}

/**
 * A session token for `claims`, valid for 7 days from now. Always seal with
 * the current secret. Keys other than the five identity fields are dropped.
 *
 * @throws AuthError `invalid_claims` if `openSession` would refuse `claims`,
 *   for example a `'demo'` sub without `demo: true`, or a name over 256
 *   characters.
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws RangeError if `options.now` is not a whole number of seconds.
 */
export async function sealSession(claims: SessionInput, secret: string, options?: TimeOptions): Promise<string> {
  const identity = readIdentity(claims);
  if (identity === null) {
    throw new AuthError('invalid_claims', 'a session holds a valid GitHub identity or the practice account');
  }
  return sealToken({ v: 1, ...identity }, secret, SESSION_INFO, SESSION_TTL_SECONDS, options);
}

/**
 * The claims in a session token, or null. Tries each secret in order (current,
 * then previous) and skips any that are missing or shorter than 32
 * characters. Never throws. A missing, garbled, tampered, expired or
 * wrongly-keyed token is null, and so is a transaction token or a payload
 * that fails any check.
 */
export async function openSession(
  token: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
  options?: TimeOptions,
): Promise<SessionClaims | null> {
  return openToken(token, secrets, SESSION_INFO, options, readSession);
}
