/**
 * The Proposals BFF: the browser calls `/bff/proposals*` on this origin for
 * anything that needs to know who is asking, and this handler checks the
 * session, mints a 60-second API assertion and forwards to
 * `${FORGE_API_URL}/api/proposals*` (Phase 5 contract §3 and §4; see
 * `lib/bff-forward.ts` for the rules every forward follows: the practice
 * account refused, writes from this origin only, header allowlists both
 * ways, `no-store`).
 *
 * Only the routes the web app uses get through, each with the identity it
 * needs: reading one proposal (and the list) is forwarded as nobody when
 * signed out and personalized when signed in; everything else needs a
 * signed-in GitHub session. Whether the caller may second, consent, vote or
 * act as an admin is the API's to decide, never this file's. Path segments
 * are checked one by one before they are joined (no dots, slashes or escapes
 * survive), anything not listed is a 404, and no query string is forwarded.
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
const MAX_SEGMENTS = 3;
const ID = '[1-9][0-9]{0,8}';
/**
 * A proposal's pitch is up to 4,000 characters and a draft task's text about
 * 3,600: as UTF-8 (4 bytes a character at most, 6 for an escaped control
 * character) either runs past the default 16 KB, so these routes allow 32 KB.
 */
const PROPOSAL_BODY_BYTES = 32 * 1024;

interface Route {
  method: ForwardSpec['method'];
  path: RegExp;
  identity: ForwardSpec['identity'];
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: /^$/, identity: 'optional' },
  { method: 'POST', path: /^$/, identity: 'required' },
  { method: 'GET', path: /^me$/, identity: 'required' },
  { method: 'PUT', path: /^settings$/, identity: 'required' },
  { method: 'GET', path: new RegExp(`^${ID}$`), identity: 'optional' },
  { method: 'PATCH', path: new RegExp(`^${ID}$`), identity: 'required' },
  { method: 'POST', path: new RegExp(`^${ID}/(?:withdraw|second|consent|comments|vote)$`), identity: 'required' },
  // `house-draft` is "Draft it again" (Phase 6 contract §1): the house model drafts the task once more. No body.
  { method: 'POST', path: new RegExp(`^${ID}/admin/(?:end-debate|close-vote|publish-task|house-draft)$`), identity: 'required' },
  { method: 'PUT', path: new RegExp(`^${ID}/admin/draft-task$`), identity: 'required' },
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

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'PATCH');
}

export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'PUT');
}

async function handle(request: NextRequest, { params }: Context, method: Route['method']): Promise<Response> {
  const path = (await params).path ?? [];
  if (path.length > MAX_SEGMENTS || !path.every((segment) => SEGMENT.test(segment))) {
    return bffError(404, 'not_found');
  }
  const joined = path.join('/');
  const route = ROUTES.find((candidate) => candidate.method === method && candidate.path.test(joined));
  if (route === undefined) return bffError(404, 'not_found');

  const suffix = path.map((segment) => `/${encodeURIComponent(segment)}`).join('');
  return forward(request, {
    method,
    upstreamPath: `/api/proposals${suffix}`,
    identity: route.identity,
    maxBodyBytes: PROPOSAL_BODY_BYTES,
  });
}
