/**
 * POST /auth/demo — the practice app's stand-in for GitHub: signs in as the
 * practice account. Live builds answer 404; `isDemoMode()` is compiled in.
 */
import { AuthError, safeNext } from '@forge/auth';
import type { NextRequest } from 'next/server';

import { isTrustedOrigin } from '../../../lib/auth/config';
import { jsonError, readBody, redirectTo, signInFailed } from '../../../lib/auth/http';
import { isDemoMode } from '../../../lib/mode';
import { setSessionCookie } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * The form holds one `next` path of up to 2048 characters (`safeNext`'s cap,
 * which a connector consent URL needs), form-encoded: up to three bytes a
 * character. Nothing legitimate comes near this.
 */
const MAX_BODY_BYTES = 8192;

export async function POST(request: NextRequest): Promise<Response> {
  if (!isDemoMode()) return jsonError(404, 'not_found');
  if (!isTrustedOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return jsonError(403, 'bad_origin');
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return jsonError(413, 'too_large');
  const next = safeNext(new URLSearchParams(new TextDecoder().decode(body)).get('next'));

  try {
    await setSessionCookie({
      sub: 'demo',
      login: 'you',
      name: 'Practice account',
      avatarUrl: null,
      demo: true,
    });
  } catch (error) {
    // No usable session secret: a demo build served outside `next dev` without one.
    if (error instanceof AuthError) return signInFailed('unavailable');
    throw error;
  }
  return redirectTo(next);
}
