/**
 * GET /auth/callback — where GitHub sends the browser back. The attempt must
 * match the sealed transaction cookie (constant-time state check), and the
 * code is only good together with that cookie's PKCE verifier. The token is
 * used once, for `GET /user`, and dropped: no GitHub token is ever stored.
 */
import {
  AuthError,
  COOKIE,
  constantTimeEqual,
  cookieOptions,
  exchangeCode,
  fetchGitHubUser,
  openTransaction,
  safeNext,
} from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { githubAppConfig, isProduction, sessionKeys } from '../../../lib/auth/config';
import { redirectTo, signInFailed } from '../../../lib/auth/http';
import { setSessionCookie, signInAvailability } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const store = await cookies();
  const prod = isProduction();
  const tx = await openTransaction(store.get(COOKIE.transaction(prod))?.value, sessionKeys()?.open ?? []);
  // One attempt, one use: every response below, success or not, spends it.
  // Cleared with the attributes it was set with, or a browser keeps it.
  store.set(COOKIE.transaction(prod), '', { ...cookieOptions('transaction', prod), maxAge: 0 });
  if (tx === null) return signInFailed('expired');

  const params = request.nextUrl.searchParams;
  if (!constantTimeEqual(params.get('state') ?? '', tx.state)) return signInFailed('state');
  // GitHub's own refusal (`access_denied`) arrives with the state but no code.
  if (params.has('error')) return signInFailed('denied');

  const config = githubAppConfig();
  if ((await signInAvailability()) !== 'github' || config === null) return signInFailed('unavailable');
  const code = params.get('code');
  if (!code) return signInFailed('github');

  try {
    const { accessToken } = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: `${config.origin}/auth/callback`,
      codeVerifier: tx.verifier,
    });
    const user = await fetchGitHubUser(accessToken);
    await setSessionCookie({
      sub: String(user.id),
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      demo: false,
    });
  } catch (error) {
    // The code only: messages and requests could carry the code or a token.
    console.warn(`sign-in callback failed: ${error instanceof AuthError ? error.code : 'unexpected'}`);
    return signInFailed('github');
  }

  // Against the configured origin, never the Host header this request came with.
  return redirectTo(new URL(safeNext(tx.next), config.origin).toString());
}
