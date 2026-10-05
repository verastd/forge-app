/**
 * The signed-in visitor, read from the sealed session cookie.
 *
 * Server-only: it reads request cookies and the flag file. (The `server-only`
 * package is not a dependency of this app, so nothing enforces that; never
 * import this from a client component.)
 */
import { AuthError, COOKIE, cookieOptions, sealSession, sessionAllowed } from '@forge/auth';
import type { SessionClaims, SessionInput } from '@forge/auth';
import { loadFlags } from '@forge/flags';
import { cookies } from 'next/headers';

import { githubAppConfig, githubRepoConfig, isProduction, sessionKeys } from './auth/config';
import type { GitHubAppConfig } from './auth/config';
import { visitorSession } from './auth/visitor';
import { isDemoMode } from './mode';

/** What pages may show about the visitor: never the sub, iat or exp. */
export type PublicSession = { login: string; name: string | null; avatarUrl: string | null; demo: boolean };

/** Which sign-in the /signin page offers. */
export type SignInAvailability = 'demo' | 'github' | 'unavailable';

/**
 * The session claims, or null for no, expired, tampered or wrongly-keyed
 * cookie, and for a session this server refuses (see `visitorSession`): a
 * practice session in a live build, or a real one under the dev secret.
 */
export async function getSession(): Promise<SessionClaims | null> {
  return visitorSession(await cookies());
}

export async function getPublicSession(): Promise<PublicSession | null> {
  const session = await getSession();
  if (session === null) return null;
  const { login, name, avatarUrl, demo } = session;
  return { login, name, avatarUrl, demo };
}

/**
 * Every sign-in needs usable session keys. The practice build offers only the
 * practice account; GitHub needs keys that are not the public dev secret, the
 * flag, and the whole GitHub App config.
 */
export async function signInAvailability(): Promise<SignInAvailability> {
  const keys = sessionKeys();
  if (keys === null) return 'unavailable';
  if (isDemoMode()) return 'demo';
  if (keys.practiceOnly || githubAppConfig() === null) return 'unavailable';
  const flags = await loadFlags();
  return flags.github_signin ? 'github' : 'unavailable';
}

/**
 * FORGE's OAuth App for "your copy" and "Send for review" (Phase 7), or null
 * while that is off: its settings are missing or unusable
 * (`githubRepoConfig`), or sign-in here isn't GitHub, since only a GitHub
 * account can have a copy. The task page shows the three steps only when this
 * is set, and `POST /auth/github/repo` and its callback check it again.
 */
export async function repoApp(): Promise<GitHubAppConfig | null> {
  const config = githubRepoConfig();
  if (config === null) return null;
  return (await signInAvailability()) === 'github' ? config : null;
}

/**
 * Seals `claims` under the current secret and sets the session cookie. Only a
 * Route Handler or Server Action may call this.
 *
 * @throws AuthError `not_configured` without usable keys, or for a session
 *   this server would refuse to count (a real one under the public dev
 *   secret, a practice one in a live build); else whatever `sealSession`
 *   throws for invalid claims.
 */
export async function setSessionCookie(claims: SessionInput): Promise<void> {
  const keys = sessionKeys();
  if (keys === null || !sessionAllowed(claims, keys, { demoBuild: isDemoMode() })) {
    throw new AuthError('not_configured', 'no session secret this server may seal that session with');
  }
  const token = await sealSession(claims, keys.seal);
  const prod = isProduction();
  (await cookies()).set(COOKIE.session(prod), token, cookieOptions('session', prod));
}

/**
 * Expires the session cookie with the attributes it was set with.
 * `cookies().delete()` would not: it omits Secure, and browsers then ignore
 * the deletion of a `__Host-` cookie.
 */
export async function clearSessionCookie(): Promise<void> {
  const prod = isProduction();
  (await cookies()).set(COOKIE.session(prod), '', { ...cookieOptions('session', prod), maxAge: 0 });
}
