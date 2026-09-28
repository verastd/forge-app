/**
 * Ways into a session for e2e tests, without ever talking to GitHub:
 * `signInAs` seals a real (non-demo) session cookie directly, `demoSignIn`
 * drives the practice app's own button on the real `/signin` page, and
 * `plantPracticeSession` seals a practice session for the live build to
 * refuse. See notes-1D-1E.md for the cookie name, attributes and claims shape
 * these rely on.
 *
 * Module resolution: these specs live at the repo root (`tests/e2e`), but
 * `@forge/auth` is a dependency of `apps/web` only — pnpm's workspace layout
 * symlinks it into `apps/web/node_modules/@forge/auth`, never into the repo
 * root, so a bare `from '@forge/auth'` cannot resolve from here (confirmed
 * with `require.resolve` before writing this). Importing the built package
 * by relative path works instead, and its own `jose` import then resolves
 * from `packages/auth/node_modules` exactly as it does for `apps/web` — so
 * this only needs `make setup` (which builds `packages/*`), same as the app
 * itself.
 */
import {
  COOKIE,
  cookieOptions,
  sealSession,
} from '../../../packages/auth/dist/index.js';
import type { SessionInput } from '../../../packages/auth/dist/index.js';
import type { BrowserContext, Page } from '@playwright/test';

import { SESSION_SECRET } from './env';

/** Both e2e servers run `next dev`, so it's always the plain, non-`__Host-` name. */
const SESSION_COOKIE_NAME = COOKIE.session(false);

export interface SignInAsOptions extends Omit<SessionInput, 'demo' | 'name' | 'avatarUrl'> {
  name?: string | null;
  avatarUrl?: string | null;
  /** Seconds since the epoch to seal as `iat`. Defaults to now; back-date it
   * (e.g. by 8 days) to mint a session that reads as already-expired. */
  now?: number;
}

/**
 * Seals `{sub, login, name, avatarUrl, demo: false}` under the shared test
 * secret and injects it as `forge_session` — no browser round trip, so
 * live-project tests can exercise a real GitHub-shaped session without
 * GitHub. `baseURL` fixes the cookie's origin (and therefore the
 * non-`__Host-` name and `Secure: false`, matching every e2e server).
 */
export async function signInAs(
  context: BrowserContext,
  baseURL: string,
  { sub, login, name = null, avatarUrl = null, now }: SignInAsOptions,
): Promise<void> {
  const token = await sealSession({ sub, login, name, avatarUrl, demo: false }, SESSION_SECRET, { now });
  await addSessionCookie(context, baseURL, token);
}

/**
 * Seals the practice account's session exactly as `POST /auth/demo` would,
 * under the shared test secret, and injects it. Only for proving that a
 * build without practice sign-in (the live one) refuses it: on the demo
 * build, sign in through the real button with `demoSignIn` instead.
 */
export async function plantPracticeSession(context: BrowserContext, baseURL: string): Promise<void> {
  const token = await sealSession(
    { sub: 'demo', login: 'you', name: 'Practice account', avatarUrl: null, demo: true },
    SESSION_SECRET,
  );
  await addSessionCookie(context, baseURL, token);
}

async function addSessionCookie(context: BrowserContext, baseURL: string, token: string): Promise<void> {
  const { httpOnly } = cookieOptions('session', false);
  // `url` alone: Playwright derives domain/path/secure from it, and rejects
  // a cookie given both `url` and `path` (they'd have to agree, and path is
  // '/' for a bare origin like this one anyway).
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: token,
      url: baseURL,
      httpOnly,
      sameSite: 'Lax',
    },
  ]);
}

/**
 * Clicks through the real practice-account button. Call it once the browser
 * is already showing `/signin` — directly, or via a redirect from a gated
 * page — so the caller decides how it got there, and therefore what `next`
 * carries through the sign-in.
 */
export async function demoSignIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue with the practice account' }).click();
}
