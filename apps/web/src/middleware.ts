/**
 * Signed-out visitors to account and data pages go to /signin first, and come
 * back afterwards. Edge runtime, so it imports only `next/server`,
 * `@forge/auth` and the Edge-safe `lib/auth/visitor` (no `@forge/flags`, no
 * `node:`). "Signed in" means exactly what `getSession()` means, so a session
 * the pages would refuse never gets past here. The pages' data still goes
 * through the BFF, which checks again.
 */
import { safeNext } from '@forge/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { visitorSession } from './lib/auth/visitor';

export const config = {
  // Phase 2 swaps /upland for /apps/data.
  matcher: ['/me/:path*', '/upland/:path*'],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if ((await visitorSession(request.cookies)) !== null) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const query = new URLSearchParams({ next: safeNext(pathname + search) });
  return NextResponse.redirect(new URL(`/signin?${query.toString()}`, request.url), 307);
}
