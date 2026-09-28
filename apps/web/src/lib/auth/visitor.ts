/**
 * Who a request's session cookie signs in: the one rule the Edge middleware
 * and the server's `getSession()` share. Edge-safe like `./config`: it imports
 * only `@forge/auth`, `./config` and `../mode`, which reads nothing but an
 * env var inlined at build time.
 */
import { acceptSession, COOKIE } from '@forge/auth';
import type { SessionClaims } from '@forge/auth';

import { isDemoMode } from '../mode';
import { isProduction, sessionKeys } from './config';

/** The part of a cookie jar this reads: Next's request cookies and `cookies()` both fit. */
interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/**
 * The visitor's session, or null for anyone this server does not count as
 * signed in: no usable keys, no valid cookie, a practice session in a live
 * build, or anything but the practice account under the public dev secret.
 */
export async function visitorSession(cookies: CookieJar): Promise<SessionClaims | null> {
  const keys = sessionKeys();
  if (keys === null) return null;
  return acceptSession(cookies.get(COOKIE.session(isProduction()))?.value, keys, { demoBuild: isDemoMode() });
}
