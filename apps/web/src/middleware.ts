/**
 * Signed-out visitors to account and data pages, and to the connector's
 * consent page, go to /signin first, and come back afterwards. Edge runtime,
 * so it imports only `next/server`, `@forge/auth` and the Edge-safe
 * `lib/auth/visitor` (no `@forge/flags`, no `node:`). "Signed in" means
 * exactly what `getSession()` means, so a session the pages would refuse
 * never gets past here. The pages' data still goes through the BFF, which
 * checks again.
 *
 * The connector's proxied paths (`/mcp`, `/.well-known/*`, `/oauth/token`
 * and the rest of CONNECTOR_PATHS in next.config.mjs) and the consent form's
 * handler (`/oauth/authorize/decision`) are deliberately not matched: agents
 * call the former with no cookies, and the handler answers a signed-out POST
 * itself rather than being bounced to /signin.
 */
import { safeNext } from '@forge/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { visitorSession } from './lib/auth/visitor';

/** The consent page. Exactly this path: its form handler lives below it. */
const CONSENT_PATH = '/oauth/authorize';

export const config = {
  // Phase 2 swapped /upland for /apps/data.
  matcher: ['/me/:path*', '/apps/data/:path*', '/oauth/authorize'],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if ((await visitorSession(request.cookies)) !== null) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  // `safeNext` refuses a path over 2048 characters. Real consent URLs are
  // about 500 to 600, but one that is longer anyway comes back without its
  // query and says to start again from the agent, rather than the visitor
  // landing on the home page with no idea why.
  const fallback = pathname === CONSENT_PATH ? CONSENT_PATH : '/';
  const query = new URLSearchParams({ next: safeNext(pathname + search, fallback) });
  return NextResponse.redirect(new URL(`/signin?${query.toString()}`, request.url), 307);
}
