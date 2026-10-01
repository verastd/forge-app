/**
 * The connected-agents BFF, for /me: `GET /bff/oauth/grants` lists the agents
 * the signed-in contributor connected to FORGE (the FORGE connector's OAuth
 * grants), and `DELETE /bff/oauth/grants/<id>` disconnects one, revoking every
 * token in it. Forwarded to `${FORGE_API_URL}/api/oauth/grants[/<id>]` under
 * the same rules as the Bridge BFF (`lib/bff-forward.ts`): a signed-in GitHub
 * session is required, the practice account is refused, and a DELETE must
 * come from this origin.
 */
import type { NextRequest } from 'next/server';

import { bffError, forward } from '../../../../../lib/bff-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A grant id as the API issues them: URL-safe, bounded. */
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface Context {
  params: Promise<{ id?: string[] }>;
}

export async function GET(request: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  if (id !== undefined && id.length > 0) return bffError(404, 'not_found');
  return forward(request, { method: 'GET', upstreamPath: '/api/oauth/grants', identity: 'required' });
}

export async function DELETE(request: NextRequest, { params }: Context): Promise<Response> {
  const { id } = await params;
  const grant = id?.length === 1 ? id[0] : undefined;
  if (grant === undefined || !GRANT_ID.test(grant)) return bffError(404, 'not_found');
  return forward(request, {
    method: 'DELETE',
    upstreamPath: `/api/oauth/grants/${encodeURIComponent(grant)}`,
    identity: 'required',
  });
}
