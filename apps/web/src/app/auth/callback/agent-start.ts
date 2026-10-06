/**
 * The Copilot start's one use of GitHub's one-time user token (the
 * callback's `agent` branch, once the code is exchanged): check the token
 * belongs to the account signed in here, start Copilot with it, and revoke it
 * afterwards, whatever happened, so it is good for that one start and no
 * more. The steps themselves are `withOneTimeToken` (`../one-time-token.ts`),
 * which "your copy" and "Send for review" share.
 *
 * Each step comes in as a function, so tests/e2e/hardening.spec.ts runs this
 * without GitHub or the API. Nothing here logs, keeps or returns the token.
 */
import type { ApiOutcome } from '../../../lib/bff-forward';
import { withOneTimeToken } from '../one-time-token';

export interface TokenSteps {
  /** The token's GitHub user id, in decimal. Throws when GitHub won't say. */
  userIdOf: (token: string) => Promise<string>;
  /** The one start, with the token as its credential. */
  dispatch: (token: string) => Promise<ApiOutcome>;
  /** Revokes the token. Best effort: it must not throw. */
  revoke: (token: string) => void | Promise<void>;
}

/**
 * What the start came to: the API's answer, or `wrong_account` when the token
 * is someone else's (then nothing is started). A failure to read the user
 * throws, after the token is revoked.
 */
export async function startWithToken(token: string, sessionSub: string, steps: TokenSteps): Promise<ApiOutcome> {
  return withOneTimeToken(token, sessionSub, { userIdOf: steps.userIdOf, act: steps.dispatch, revoke: steps.revoke });
}
