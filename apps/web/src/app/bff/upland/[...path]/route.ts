/**
 * The Upland data BFF: the browser calls `/bff/upland/*` on this origin, and
 * this handler checks the session, mints a 60-second API assertion and
 * forwards to `${FORGE_API_URL}/api/upland/*`. The browser never holds
 * anything the API accepts, and the API sees nothing of the browser's but
 * the path, the query and a POST body.
 *
 * It never mints on a server whose session keys are the public dev secret
 * (503 `not_configured`, whoever is asking): anyone can seal a cookie under
 * that secret, so no session there can vouch for anyone to the API.
 *
 * What goes back is upstream's status and body, with only the headers
 * `bffResponseHeaders` allows: `Content-Type` if it is JSON or CSV (anything
 * else becomes `application/octet-stream`), `Content-Disposition`, and always
 * `Cache-Control: private, no-store`, whatever upstream says.
 */
import { mintApiAssertion } from '@forge/auth';
import type { NextRequest } from 'next/server';

import { apiAssertionSecret, apiUrl, isTrustedOrigin, sessionKeys } from '../../../../lib/auth/config';
import { bffResponseHeaders, jsonError, readBody } from '../../../../lib/auth/http';
import { getSession } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[a-z0-9_-]+$/;
const MAX_SEGMENTS = 8;
const MAX_BODY_BYTES = 16 * 1024;
/** Until upstream answers with headers. A long CSV export may stream for longer than this. */
const HEADERS_TIMEOUT_MS = 25_000;
/** Statuses a Response may not carry a body with. */
const NULL_BODY = new Set([101, 204, 205, 304]);

interface Context {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return forward(request, context, 'GET');
}

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return forward(request, context, 'POST');
}

async function forward(
  request: NextRequest,
  { params }: Context,
  method: 'GET' | 'POST',
): Promise<Response> {
  const { path } = await params;
  if (path.length > MAX_SEGMENTS || !path.every((segment) => SEGMENT.test(segment))) {
    return jsonError(404, 'not_found');
  }
  // Keys anyone can seal under: never mint, whoever seems to be asking.
  if (sessionKeys()?.practiceOnly) return jsonError(503, 'not_configured');

  const session = await getSession();
  // The practice account is nobody on GitHub, so the API has nobody to serve.
  if (session === null || session.demo) return jsonError(401, 'unauthenticated');

  const headers: Record<string, string> = {};
  let body: Uint8Array | undefined;
  if (method === 'POST') {
    if (!isTrustedOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return jsonError(403, 'bad_origin');
    }
    const read = await readBody(request, MAX_BODY_BYTES);
    if (read === null) return jsonError(413, 'too_large');
    body = read;
    const contentType = request.headers.get('content-type');
    if (contentType !== null) headers['content-type'] = contentType;
  }

  const secret = apiAssertionSecret();
  // No https API to send the assertion to (FORGE_API_URL): nothing goes out.
  const base = apiUrl();
  if (secret === null || base === null) return jsonError(503, 'not_configured');
  const assertion = await mintApiAssertion({ sub: session.sub, login: session.login }, secret);
  headers.authorization = `Bearer ${assertion}`;

  // The deadline covers the wait for upstream's headers only: once they arrive
  // the body streams for as long as it takes (undici still aborts a body that
  // stalls between chunks). The browser going away cancels the upstream call.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), HEADERS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/upland/${path.join('/')}${request.nextUrl.search}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([deadline.signal, request.signal]),
    });
  } catch {
    // Refused, reset, DNS, or the deadline.
    return jsonError(502, 'service_unreachable');
  } finally {
    clearTimeout(timer);
  }

  return new Response(NULL_BODY.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    headers: bffResponseHeaders(upstream.headers),
  });
}
