/**
 * One use of a one-time GitHub user token, for both flows that get one: the
 * Copilot start (`callback/agent-start.ts`, the GitHub App's token) and "your
 * copy" / "Send for review" (`github/repo/flow.ts`, the OAuth App's token).
 * Check the token belongs to the GitHub account signed in here, do the one
 * thing it was asked for, and revoke it afterwards, whatever happened, so it
 * is good for that one action and no more.
 *
 * Each step comes in as a function, so the e2e suite runs this without GitHub
 * or the API (tests/e2e/hardening.spec.ts, tests/e2e/repo-flow.spec.ts).
 * Nothing here logs, keeps or returns the token.
 */

export interface OneTimeTokenSteps<T> {
  /** The token's GitHub user id, in decimal. Throws when GitHub won't say. */
  userIdOf: (token: string) => Promise<string>;
  /** The one action, with the token as its credential. */
  act: (token: string) => Promise<T>;
  /** Revokes the token. Best effort: it must not throw. */
  revoke: (token: string) => void | Promise<void>;
}

/** The token is someone else's: nothing was done with it. */
export type WrongAccount = { ok: false; code: 'wrong_account' };

/**
 * What the action came to, or `wrong_account` when the token belongs to
 * another GitHub account than `sessionSub` (then `act` never runs). A failure
 * to read the token's user throws, after the token is revoked.
 */
export async function withOneTimeToken<T>(
  token: string,
  sessionSub: string,
  steps: OneTimeTokenSteps<T>,
): Promise<T | WrongAccount> {
  try {
    if ((await steps.userIdOf(token)) !== sessionSub) return { ok: false, code: 'wrong_account' };
    return await steps.act(token);
  } finally {
    await steps.revoke(token);
  }
}

/** A server log line, and how loud: `info` for news, `warn` for something to look at. */
export type LogLine = (line: string, level: 'info' | 'warn') => void;

/**
 * Revokes a one-time token now, and resolves once GitHub has answered,
 * logging which (`<label>: one-time GitHub token revoked`, or a warning that
 * GitHub didn't confirm it), never the token. Never rejects.
 *
 * For Next's `after()`, hand it the promise this returns, `after(revokeNow(…))`:
 * the revocation is then already running when the response goes, and `after`
 * only keeps the function alive until it is done. `after(() => …)` would wait
 * for the connection to close, which has already happened when the browser
 * left while FORGE waited on GitHub or the API; that callback never runs, and
 * the token would stay live (review-web W-M1).
 */
export async function revokeNow(revoke: () => Promise<boolean>, log: LogLine, label: string): Promise<void> {
  let revoked = false;
  try {
    revoked = await revoke();
  } catch {
    // Best effort, like revokeGitHubToken itself: say so below.
  }
  if (revoked) {
    log(`${label}: one-time GitHub token revoked`, 'info');
  } else {
    log(`${label}: GitHub did not confirm the one-time token was revoked`, 'warn');
  }
}
