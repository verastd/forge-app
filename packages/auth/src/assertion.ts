/**
 * The web-to-API assertion. The Next route handlers (the BFF) mint it from a
 * signed-in session and send it to FastAPI, which verifies it on every
 * `/api/upland/*` route. The API pins HS256, `iss`, `aud` and a lifetime of
 * at most 120 seconds, so this module refuses to mint anything the API would
 * reject.
 */
import { SignJWT } from 'jose';

import { AuthError } from './errors.js';
import { isGitHubLogin, isGitHubUserId } from './github.js';
import { isStrongSecret, MIN_SECRET_LENGTH, nowSeconds } from './session.js';
import type { TimeOptions } from './session.js';

const MAX_TTL_SECONDS = 120;
const DEFAULT_TTL_SECONDS = 60;

const encoder = new TextEncoder();

/** Who the assertion speaks for. A `SessionClaims` fits as-is. */
export interface ApiIdentity {
  sub: string;
  login: string;
}

export interface AssertionOptions extends TimeOptions {
  /** Lifetime in whole seconds, from 1 to 120. Defaults to 60. */
  ttlSeconds?: number;
}

/**
 * An HS256 JWT (protected header `{alg: 'HS256', typ: 'JWT'}`) with `iss`
 * `forge-web`, `aud` `forge-api`, `sub`, `login`, `iat` and `exp`. The key is
 * the UTF-8 bytes of `secret` (FORGE_API_ASSERTION_SECRET).
 *
 * @throws RangeError if `ttlSeconds` is not a whole number from 1 to 120, or
 *   `now` is not a whole number of seconds.
 * @throws AuthError `weak_secret` if `secret` is shorter than 32 characters.
 * @throws AuthError `invalid_identity` unless `sub` is a GitHub user id and
 *   `login` a GitHub login. That makes demo sessions (`sub: 'demo'`) unable
 *   to mint, by design.
 */
export async function mintApiAssertion(
  { sub, login }: ApiIdentity,
  secret: string,
  options: AssertionOptions = {},
): Promise<string> {
  const { now, ttlSeconds = DEFAULT_TTL_SECONDS } = options;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be a whole number from 1 to ${MAX_TTL_SECONDS}, got ${String(ttlSeconds)}`);
  }
  if (!isStrongSecret(secret)) {
    throw new AuthError('weak_secret', `secrets must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!isGitHubUserId(sub) || !isGitHubLogin(login)) {
    throw new AuthError('invalid_identity', 'only a GitHub identity can call the API');
  }
  const iat = nowSeconds(now);
  return new SignJWT({ login })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('forge-web')
    .setAudience('forge-api')
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(encoder.encode(secret));
}
