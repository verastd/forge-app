/**
 * GET /auth/google/callback — where Google sends the browser back. Only a
 * `google` attempt is taken (a GitHub one is refused, as GitHub's callback
 * refuses this one), its state checked in constant time, and the code is only
 * good with that attempt's PKCE verifier. The token is used once, for the
 * userinfo, and dropped. The member is signed in as `google:<id>` with a `g.`
 * handle (@forge/auth's google.ts): never a GitHub identity.
 */
import {
  AuthError,
  COOKIE,
  constantTimeEqual,
  cookieOptions,
  exchangeGoogleCode,
  fetchGoogleUser,
  openTransaction,
  safeNext,
} from '@forge/auth';
import type { GoogleUser } from '@forge/auth';
import { cookies } from 'next/headers';
import { after } from 'next/server';
import type { NextRequest } from 'next/server';

import { isProduction, sessionKeys } from '../../../../lib/auth/config';
import { redirectTo, signInFailed } from '../../../../lib/auth/http';
import { postAsUser } from '../../../../lib/bff-forward';
import { googleSignIn, setSessionCookie } from '../../../../lib/session';
import { sayHello } from '../../callback/members-hello';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const store = await cookies();
  const prod = isProduction();
  const tx = await openTransaction(store.get(COOKIE.transaction(prod))?.value, sessionKeys()?.open ?? []);
  // One attempt, one use, whatever happens below.
  store.set(COOKIE.transaction(prod), '', { ...cookieOptions('transaction', prod), maxAge: 0 });
  if (tx === null) return signInFailed('expired');
  if (tx.purpose !== 'google') return signInFailed('state');

  const params = request.nextUrl.searchParams;
  if (!constantTimeEqual(params.get('state') ?? '', tx.state)) return signInFailed('state');
  // Google's own refusal (`access_denied`) arrives with the state but no code.
  if (params.has('error')) return signInFailed('google_denied');

  const config = await googleSignIn();
  if (config === null) return signInFailed('unavailable');
  const code = params.get('code');
  if (!code) return signInFailed('google');

  let user: GoogleUser;
  try {
    const { accessToken } = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: `${config.origin}/auth/google/callback`,
      codeVerifier: tx.verifier,
    });
    user = await fetchGoogleUser(accessToken);
    await setSessionCookie({ sub: user.sub, login: user.login, name: user.name, avatarUrl: user.avatarUrl, demo: false });
  } catch (error) {
    // The code only: messages and requests could carry the code or a token.
    const reason = error instanceof AuthError ? error.code : 'unexpected';
    console.warn(`google sign-in callback failed: ${reason}`);
    return signInFailed(reason === 'google_email_unverified' ? 'google_unverified' : 'google');
  }

  // The members hello, as after a GitHub sign-in: after the redirect, best effort.
  after(async () => {
    const outcome = await sayHello({ sub: user.sub, login: user.login }, (path, who, timeoutMs) => postAsUser(path, who, {}, timeoutMs));
    if (!outcome.ok) console.warn(`members hello: ${outcome.code}`);
  });

  return redirectTo(new URL(safeNext(tx.next), config.origin).toString());
}
