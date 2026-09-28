/**
 * GET /auth/signin?next= — starts one GitHub sign-in attempt: a fresh state
 * and PKCE pair sealed into the short-lived transaction cookie, then off to
 * GitHub. Without the flag and the whole GitHub App config it goes back to
 * /signin, never to GitHub with half a configuration.
 */
import {
  authorizeUrl,
  COOKIE,
  cookieOptions,
  createPkcePair,
  randomToken,
  safeNext,
  sealTransaction,
} from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { githubAppConfig, isProduction, sessionKeys } from '../../../lib/auth/config';
import { redirectTo, signInFailed } from '../../../lib/auth/http';
import { signInAvailability } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const config = githubAppConfig();
  const keys = sessionKeys();
  if ((await signInAvailability()) !== 'github' || config === null || keys === null) {
    return signInFailed('unavailable');
  }

  const state = randomToken();
  const { verifier, challenge } = await createPkcePair();
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  const prod = isProduction();
  (await cookies()).set(
    COOKIE.transaction(prod),
    await sealTransaction({ state, verifier, next }, keys.seal),
    cookieOptions('transaction', prod),
  );

  return redirectTo(
    authorizeUrl({
      clientId: config.clientId,
      redirectUri: `${config.origin}/auth/callback`,
      state,
      codeChallenge: challenge,
    }),
    302,
  );
}
