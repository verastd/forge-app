/**
 * POST /auth/signout — the account menu's form. POST plus an Origin check, so
 * another site cannot sign people out behind their backs.
 */
import type { NextRequest } from 'next/server';

import { isTrustedOrigin } from '../../../lib/auth/config';
import { jsonError, redirectTo } from '../../../lib/auth/http';
import { clearSessionCookie } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  if (!isTrustedOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
    return jsonError(403, 'bad_origin');
  }
  await clearSessionCookie();
  return redirectTo('/');
}
