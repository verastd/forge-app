/**
 * The notifications BFF, for the bell: `GET /bff/notifications` (the newest
 * 30 and the unread count) and `POST /bff/notifications/read` (`{ids?}`, all
 * when absent), forwarded to `${FORGE_API_URL}/api/notifications*` as the
 * signed-in GitHub member (Phase 5 contract §3 and §4). Both need a session:
 * notifications are per member. The rules every forward follows are in
 * `lib/bff-forward.ts`; anything not listed here is a 404, and no query
 * string is forwarded.
 */
import type { NextRequest } from 'next/server';

import { bffError, forward } from '../../../../lib/bff-forward';
import type { ForwardSpec } from '../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Longer than the forward's own 25 s wait on the API (`lib/bff-forward.ts`), so
 * the browser hears this route's 504 `upstream_timeout` rather than the host's
 * own timeout page.
 */
export const maxDuration = 30;

const SEGMENT = /^[a-z0-9_-]{1,64}$/;

const ROUTES: ReadonlyArray<{ method: ForwardSpec['method']; path: string }> = [
  { method: 'GET', path: '' },
  { method: 'POST', path: 'read' },
];

interface Context {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'GET');
}

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'POST');
}

async function handle(request: NextRequest, { params }: Context, method: ForwardSpec['method']): Promise<Response> {
  const path = (await params).path ?? [];
  if (path.length > 1 || !path.every((segment) => SEGMENT.test(segment))) return bffError(404, 'not_found');
  const joined = path.join('/');
  if (!ROUTES.some((route) => route.method === method && route.path === joined)) return bffError(404, 'not_found');

  return forward(request, {
    method,
    upstreamPath: joined === '' ? '/api/notifications' : `/api/notifications/${joined}`,
    identity: 'required',
  });
}
