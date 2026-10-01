/**
 * The Bridge BFF: the browser calls `/bff/bridge/*` on this origin for
 * anything that needs to know who is asking, and this handler checks the
 * session, mints a 60-second API assertion and forwards to
 * `${FORGE_API_URL}/api/bridge/*` (see `lib/bff-forward.ts` for the rules
 * every forward follows).
 *
 * Only the routes the web app uses get through, each with the identity it
 * needs (Phase 4 contract §5): the public reads (`rails`, `tasks`,
 * `tasks/<id>`, `status/<id>`, `checks/<id>`) are forwarded as nobody when
 * signed out and personalized when signed in; everything else needs a
 * signed-in GitHub session. Path segments are checked one by one before they
 * are joined (no dots, slashes or escapes can survive), and anything not
 * listed is a 404. No query string is forwarded: no route here takes one.
 */
import type { NextRequest } from 'next/server';

import { bffError, forward, START_TIMEOUT_MS } from '../../../../lib/bff-forward';
import type { ForwardSpec } from '../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[a-z0-9_-]{1,64}$/;
const MAX_SEGMENTS = 3;
const ID = '[1-9][0-9]{0,8}';
const RAIL = '[a-z][a-z0-9-]{0,31}';

interface Route {
  method: ForwardSpec['method'];
  path: RegExp;
  identity: ForwardSpec['identity'];
  timeoutMs?: number;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: /^rails$/, identity: 'optional' },
  { method: 'GET', path: /^tasks$/, identity: 'optional' },
  { method: 'GET', path: new RegExp(`^tasks/${ID}$`), identity: 'optional' },
  { method: 'GET', path: new RegExp(`^status/${ID}$`), identity: 'optional' },
  { method: 'GET', path: new RegExp(`^checks/${ID}$`), identity: 'optional' },
  { method: 'GET', path: /^profile$/, identity: 'required' },
  { method: 'GET', path: /^me\/keys$/, identity: 'required' },
  { method: 'GET', path: /^me\/fork$/, identity: 'required' },
  { method: 'DELETE', path: new RegExp(`^me/keys/${RAIL}$`), identity: 'required' },
  { method: 'POST', path: /^claim$/, identity: 'required' },
  { method: 'POST', path: /^dispatch$/, identity: 'required', timeoutMs: START_TIMEOUT_MS },
  { method: 'POST', path: new RegExp(`^release/${ID}$`), identity: 'required' },
  { method: 'POST', path: new RegExp(`^feedback/${ID}$`), identity: 'required', timeoutMs: START_TIMEOUT_MS },
  { method: 'POST', path: new RegExp(`^submit/${ID}$`), identity: 'required' },
];

interface Context {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'GET');
}

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'POST');
}

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  return handle(request, context, 'DELETE');
}

async function handle(request: NextRequest, { params }: Context, method: Route['method']): Promise<Response> {
  const { path } = await params;
  if (path.length === 0 || path.length > MAX_SEGMENTS || !path.every((segment) => SEGMENT.test(segment))) {
    return bffError(404, 'not_found');
  }
  const joined = path.join('/');
  const route = ROUTES.find((candidate) => candidate.method === method && candidate.path.test(joined));
  if (route === undefined) return bffError(404, 'not_found');

  return forward(request, {
    method,
    upstreamPath: `/api/bridge/${path.map((segment) => encodeURIComponent(segment)).join('/')}`,
    identity: route.identity,
    ...(route.timeoutMs === undefined ? {} : { timeoutMs: route.timeoutMs }),
  });
}
