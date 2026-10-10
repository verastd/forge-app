/**
 * The bricks BFF (behind `apps_lobby`, which the API enforces): the lobby
 * reads the cave's bricks from `GET /bff/lobby/bricks?since=<rev>` (forwarded
 * as nobody when signed out), and builds with the rest as the signed-in
 * GitHub member: `GET me` says who you are and whether you make bricks, the brick maker makes (`POST`) and takes away (`DELETE
 * {id}`), anyone picks up (`PUT {id}/pick`) and places (`PUT {id}/place`).
 * Who is the brick maker is the API's to decide, never this file's.
 *
 * Forwarded to `${FORGE_API_URL}/api/lobby/bricks*` under
 * `lib/bff-forward.ts`'s rules (the practice account refused, writes from
 * this origin only, header allowlists both ways, `no-store`). Path segments
 * are checked before they are joined, anything not listed is a 404, and the
 * only query forwarded is a whole-number `since`.
 */
import type { NextRequest } from 'next/server';

import { bffError, forward } from '../../../../../lib/bff-forward';
import type { ForwardSpec } from '../../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Longer than the forward's own 25 s wait on the API, so the browser hears its 504. */
export const maxDuration = 30;

const BRICK = '[0-9a-f]{12}';
const SEGMENT = new RegExp(`^(?:me|pick|place|${BRICK})$`);
const SINCE = /^[0-9]{1,15}$/;

interface Route {
  method: ForwardSpec['method'];
  path: RegExp;
  identity: ForwardSpec['identity'];
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: /^$/, identity: 'optional' },
  { method: 'GET', path: /^me$/, identity: 'required' },
  { method: 'POST', path: /^$/, identity: 'required' },
  { method: 'PUT', path: new RegExp(`^${BRICK}/pick$`), identity: 'required' },
  { method: 'PUT', path: new RegExp(`^${BRICK}/place$`), identity: 'required' },
  { method: 'DELETE', path: new RegExp(`^${BRICK}$`), identity: 'required' },
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

export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'PUT');
}

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'DELETE');
}

async function handle(request: NextRequest, { params }: Context, method: ForwardSpec['method']): Promise<Response> {
  const path = (await params).path ?? [];
  if (path.length > 2 || !path.every((segment) => SEGMENT.test(segment))) return bffError(404, 'not_found');
  const joined = path.join('/');
  const route = ROUTES.find((r) => r.method === method && r.path.test(joined));
  if (!route) return bffError(404, 'not_found');

  let upstreamPath = joined === '' ? '/api/lobby/bricks' : `/api/lobby/bricks/${joined}`;
  if (method === 'GET' && joined === '') {
    const since = request.nextUrl.searchParams.get('since');
    if (since !== null) {
      if (!SINCE.test(since)) return bffError(400, 'invalid_request');
      upstreamPath += `?since=${since}`;
    }
  }
  return forward(request, { method, upstreamPath, identity: route.identity });
}
