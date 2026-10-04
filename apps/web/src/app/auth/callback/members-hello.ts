/**
 * The sign-in callback's members hello (Phase 5 contract §3 and §4): once a
 * GitHub sign-in has set the session, FORGE tells the API this member exists
 * (`POST /api/members/hello`, as the member, with an assertion), so they
 * count in the eligible set of the next proposal anyone seconds.
 *
 * Best effort and never in the way: one try, 3 seconds at most, run after
 * the redirect has gone (`after()` in `route.ts`), and nothing it does or
 * fails to do can hold up or break a sign-in. A member it misses is added by
 * their first proposals or notifications call instead.
 *
 * The request comes in as a function, so tests/e2e/propose-helpers.spec.ts
 * runs this without the API. Nothing here logs or keeps anything but the
 * outcome's code.
 */
import type { ApiOutcome } from '../../../lib/bff-forward';

export const MEMBERS_HELLO_PATH = '/api/members/hello';
export const HELLO_TIMEOUT_MS = 3000;

/** Who signed in: the session's GitHub user id and login. */
export interface Member {
  sub: string;
  login: string;
}

/** Sends `post` (normally `postAsUser`) one hello for `member`. Never throws; the outcome is for logging. */
export async function sayHello(
  member: Member,
  post: (path: string, member: Member, timeoutMs: number) => Promise<ApiOutcome>,
): Promise<ApiOutcome> {
  try {
    return await post(MEMBERS_HELLO_PATH, member, HELLO_TIMEOUT_MS);
  } catch {
    return { ok: false, code: 'unexpected' };
  }
}
