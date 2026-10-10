/**
 * The machines BFF (behind `apps_lobby`, which the API enforces). The lobby
 * reads the cave's machines (`GET /bff/lobby/machines?since=<rev>`) and the
 * mechanic's library (`GET blueprints`) as nobody, so the practice account
 * sees them too. Everything else goes as the signed-in GitHub member:
 * - `GET me` says whether you're the mechanic, and admins switch
 *   "Be the mechanic" (`PUT me/stand-in`).
 * - The mechanic builds (`POST`) and takes down (`DELETE {id}`) machines.
 * - The mechanic uploads blueprints in chunks (`POST blueprints`, then
 *   `PUT blueprints/{id}/chunks/{n}` and `POST blueprints/{id}/finish`) and
 *   deletes them (`DELETE blueprints/{id}`).
 * Who the mechanic is is the API's to decide, never this file's. A
 * blueprint's file comes from `assets/[sha256]/[n]/route.ts`.
 *
 * Forwarded to `${FORGE_API_URL}/api/lobby/machines*` under
 * `lib/bff-forward.ts`'s rules. Path segments are checked before they are
 * joined, anything not listed is a 404, and the only query forwarded is a
 * whole-number `since`.
 */
import type { NextRequest } from 'next/server';

import { MACHINE_CHUNK_BYTES } from '@forge/shared';

import { bffError, forward } from '../../../../../lib/bff-forward';
import type { ForwardSpec } from '../../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Longer than the forward's own 25 s wait on the API, so the browser hears its 504. */
export const maxDuration = 30;

const ID = '[0-9a-f]{12}';
const SEGMENT = new RegExp(`^(?:me|stand-in|blueprints|chunks|finish|[0-9]{1,2}|${ID})$`);
/** One chunk's base64 and the JSON around it. */
const CHUNK_BODY_MAX = 4 * Math.ceil(MACHINE_CHUNK_BYTES / 3) + 1024;
const SINCE = /^[0-9]{1,15}$/;

interface Route {
  method: ForwardSpec['method'];
  path: RegExp;
  identity: ForwardSpec['identity'];
  maxBodyBytes?: number;
}

const ROUTES: readonly Route[] = [
  // The machines and the library are public: asked as nobody.
  { method: 'GET', path: /^$/, identity: 'none' },
  { method: 'GET', path: /^blueprints$/, identity: 'none' },
  { method: 'GET', path: /^me$/, identity: 'required' },
  { method: 'PUT', path: /^me\/stand-in$/, identity: 'required' },
  { method: 'POST', path: /^$/, identity: 'required' },
  { method: 'DELETE', path: new RegExp(`^${ID}$`), identity: 'required' },
  { method: 'POST', path: /^blueprints$/, identity: 'required' },
  { method: 'PUT', path: new RegExp(`^blueprints/${ID}/chunks/[0-9]{1,2}$`), identity: 'required', maxBodyBytes: CHUNK_BODY_MAX },
  { method: 'POST', path: new RegExp(`^blueprints/${ID}/finish$`), identity: 'required' },
  { method: 'DELETE', path: new RegExp(`^blueprints/${ID}$`), identity: 'required' },
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
  if (path.length > 4 || !path.every((segment) => SEGMENT.test(segment))) return bffError(404, 'not_found');
  const joined = path.join('/');
  const route = ROUTES.find((r) => r.method === method && r.path.test(joined));
  if (!route) return bffError(404, 'not_found');

  let upstreamPath = joined === '' ? '/api/lobby/machines' : `/api/lobby/machines/${joined}`;
  if (method === 'GET' && joined === '') {
    const since = request.nextUrl.searchParams.get('since');
    if (since !== null) {
      if (!SINCE.test(since)) return bffError(400, 'invalid_request');
      upstreamPath += `?since=${since}`;
    }
  }
  return forward(request, {
    method,
    upstreamPath,
    identity: route.identity,
    ...(route.maxBodyBytes === undefined ? {} : { maxBodyBytes: route.maxBodyBytes }),
  });
}
