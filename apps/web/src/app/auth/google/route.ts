/**
 * GET /auth/google?next= — starts one Google sign-in attempt, as
 * /auth/signin does for GitHub: a fresh state and PKCE pair sealed into the
 * short-lived transaction cookie (as a `google` attempt, which only
 * /auth/google/callback opens), then off to Google's account chooser.
 * Without Google configured, or sign-in off, it goes back to /signin.
 */
import { COOKIE, cookieOptions, createPkcePair, googleAuthorizeUrl, randomToken, safeNext, sealTransaction } from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { isProduction, sessionKeys } from '../../../lib/auth/config';
import { redirectTo, signInFailed } from '../../../lib/auth/http';
import { googleSignIn } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const config = await googleSignIn();
  const keys = sessionKeys();
  if (config === null || keys === null) return signInFailed('unavailable');

  const state = randomToken();
  const { verifier, challenge } = await createPkcePair();
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  const prod = isProduction();
  (await cookies()).set(
    COOKIE.transaction(prod),
    await sealTransaction({ state, verifier, next, purpose: 'google' }, keys.seal),
    cookieOptions('transaction', prod),
  );

  return redirectTo(
    googleAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: `${config.origin}/auth/google/callback`,
      state,
      codeChallenge: challenge,
    }),
    302,
  );
}
