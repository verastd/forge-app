/**
 * The avatars BFF (behind `lobby_avatars`, which the API enforces): the
 * lobby reads every robot's look from `GET /bff/avatars` (forwarded as
 * nobody when signed out), the account menu asks `GET /bff/avatars/me`
 * whether to link the caller to the editor, and the admin's avatar editor paints robots,
 * gives them chestplates and keeps the head library through the rest, as the
 * signed-in GitHub member. Whether the caller is an admin is the API's to
 * decide, never this file's.
 *
 * Forwarded to `${FORGE_API_URL}/api/avatars*` under `lib/bff-forward.ts`'s
 * rules (the practice account refused, writes from this origin only, header
 * allowlists both ways, `no-store`). Uploads are JSON with the file in
 * base64, so the chest and head routes allow bodies sized to their files'
 * own limits. Path segments are checked before they are joined, anything not
 * listed is a 404, and no query string is forwarded. Stored files are served
 * by `assets/[sha256]/route.ts`.
 */
import { AVATAR_CHEST_VIDEO_MAX_BYTES, AVATAR_HEAD_MAX_BYTES } from '@forge/shared';
import type { NextRequest } from 'next/server';

import { bffError, forward } from '../../../../lib/bff-forward';
import type { ForwardSpec } from '../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Longer than the forward's own 25 s wait on the API, so the browser hears its 504. */
export const maxDuration = 30;

const MEMBER = 'gh:[0-9]{1,20}';
const HEAD = '[a-z0-9][a-z0-9-]{0,39}';
const SEGMENT = new RegExp(`^(?:members|heads|chest|${MEMBER}|${HEAD})$`);
/** Room for a base64 file of `limit` bytes and the JSON around it. */
const uploadCap = (limit: number): number => 4 * Math.ceil(limit / 3) + 4096;

interface Route {
  method: ForwardSpec['method'];
  path: RegExp;
  identity: ForwardSpec['identity'];
  maxBodyBytes?: number;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: /^$/, identity: 'optional' },
  { method: 'GET', path: /^me$/, identity: 'required' },
  { method: 'GET', path: /^members$/, identity: 'required' },
  { method: 'PUT', path: new RegExp(`^members/${MEMBER}$`), identity: 'required' },
  { method: 'DELETE', path: new RegExp(`^members/${MEMBER}$`), identity: 'required' },
  {
    method: 'PUT',
    path: new RegExp(`^members/${MEMBER}/chest$`),
    identity: 'required',
    // A clip may be bigger than an image: the cap is the bigger of the two.
    maxBodyBytes: uploadCap(AVATAR_CHEST_VIDEO_MAX_BYTES),
  },
  { method: 'DELETE', path: new RegExp(`^members/${MEMBER}/chest$`), identity: 'required' },
  {
    method: 'PUT',
    path: new RegExp(`^heads/${HEAD}$`),
    identity: 'required',
    maxBodyBytes: uploadCap(AVATAR_HEAD_MAX_BYTES),
  },
  { method: 'DELETE', path: new RegExp(`^heads/${HEAD}$`), identity: 'required' },
  { method: 'PUT', path: new RegExp(`^heads/${HEAD}/placement$`), identity: 'required' },
  { method: 'PUT', path: new RegExp(`^heads/${HEAD}/owner$`), identity: 'required' },
];

interface Context {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'GET');
}

export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'PUT');
}

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'DELETE');
}

async function handle(request: NextRequest, { params }: Context, method: ForwardSpec['method']): Promise<Response> {
  const path = (await params).path ?? [];
  if (path.length > 3 || !path.every((segment) => SEGMENT.test(segment))) return bffError(404, 'not_found');
  const joined = path.join('/');
  const route = ROUTES.find((r) => r.method === method && r.path.test(joined));
  if (!route) return bffError(404, 'not_found');

  return forward(request, {
    method,
    upstreamPath: joined === '' ? '/api/avatars' : `/api/avatars/${joined}`,
    identity: route.identity,
    ...(route.maxBodyBytes === undefined ? {} : { maxBodyBytes: route.maxBodyBytes }),
  });
}
