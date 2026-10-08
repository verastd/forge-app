/**
 * The Upland Ledger BFF: the browser calls `/bff/ledger/*` on this origin, and
 * this handler checks the session, mints a 60-second API assertion and
 * forwards to `${FORGE_API_URL}/api/ledger/*`. The API (behind the
 * `upland_ledger` flag) checks the route against its allowlist and forwards
 * it to the ledger, which has no public address of its own. The browser never
 * holds anything the API accepts, and the API sees nothing of the browser's
 * but the path, the query string and the analytics query's JSON body.
 *
 * Same model as the Upland data BFF (`../../upland/[...path]/route.ts`):
 * - never mints on a server whose session keys are the public dev secret
 *   (503 `not_configured`, whoever is asking);
 * - signed out, or the practice account: 401 `unauthenticated`;
 * - path segments are `[a-z0-9._-]` (Antelope names have dots), at most 8,
 *   and never `.` or `..`; the query string at most 4 KiB (414);
 * - POST must come from a page on this origin (403 `bad_origin`), be JSON
 *   (415) and at most 16 KiB (413), read by the stream;
 * - up go only the assertion, `Accept` and, with a body, a JSON
 *   `Content-Type`; down come upstream's status and body with only the
 *   headers `bffResponseHeaders` allows, always `Cache-Control: private,
 *   no-store`;
 * - no answer in time is 504 `upstream_timeout`; refused, reset or DNS is 502
 *   `service_unreachable`.
 */
import { mintApiAssertion } from '@forge/auth';
import type { NextRequest } from 'next/server';

import { apiAssertionSecret, apiUrl, isTrustedOrigin, sessionKeys } from '../../../../lib/auth/config';
import { bffResponseHeaders, jsonError, readBody } from '../../../../lib/auth/http';
import { getSession } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[a-z0-9._-]{1,64}$/;
const MAX_SEGMENTS = 8;
const MAX_QUERY_BYTES = 4 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
/** JSON, with any parameters (`; charset=utf-8`). */
const JSON_TYPE = /^application\/json[\t ]*(?:;|$)/i;
/**
 * Until upstream answers with headers. The API gives the ledger 25 s, so this
 * waits a little longer and the browser hears the API's own 504.
 */
const HEADERS_TIMEOUT_MS = 30_000;
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

/** Whether every segment is plain: our characters only, and no dot segment. */
function plainPath(path: string[]): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_SEGMENTS &&
    path.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  );
}

async function forward(
  request: NextRequest,
  { params }: Context,
  method: 'GET' | 'POST',
): Promise<Response> {
  const { path } = await params;
  if (!plainPath(path)) return jsonError(404, 'not_found');
  const search = request.nextUrl.search;
  if (Buffer.byteLength(search, 'utf8') > MAX_QUERY_BYTES + 1) return jsonError(414, 'query_too_long');
  // Keys anyone can seal under: never mint, whoever seems to be asking.
  if (sessionKeys()?.practiceOnly) return jsonError(503, 'not_configured');

  const session = await getSession();
  // The practice account is nobody on GitHub, so the API has nobody to serve.
  if (session === null || session.demo) return jsonError(401, 'unauthenticated');

  const headers: Record<string, string> = { accept: 'application/json' };
  let body: Uint8Array | undefined;
  if (method === 'POST') {
    if (!isTrustedOrigin(request.headers.get('origin'), request.nextUrl.origin)) {
      return jsonError(403, 'bad_origin');
    }
    const type = request.headers.get('content-type');
    if (type === null || !JSON_TYPE.test(type)) return jsonError(415, 'unsupported_media_type');
    const read = await readBody(request, MAX_BODY_BYTES);
    if (read === null) return jsonError(413, 'too_large');
    body = read;
    headers['content-type'] = 'application/json';
  }

  const secret = apiAssertionSecret();
  // No https API to send the assertion to (FORGE_API_URL): nothing goes out.
  const base = apiUrl();
  if (secret === null || base === null) return jsonError(503, 'not_configured');
  try {
    headers.authorization = `Bearer ${await mintApiAssertion({ sub: session.sub, login: session.login }, secret)}`;
  } catch {
    // Only a GitHub identity can mint; anything else is nobody to the API.
    return jsonError(503, 'not_configured');
  }

  // The deadline covers the wait for upstream's headers only. The browser
  // going away cancels the upstream call too.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), HEADERS_TIMEOUT_MS);
  const upstreamPath = path.map((segment) => encodeURIComponent(segment)).join('/');
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/ledger/${upstreamPath}${search}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([deadline.signal, request.signal]),
    });
  } catch {
    if (deadline.signal.aborted) return jsonError(504, 'upstream_timeout');
    // Refused, reset or DNS.
    return jsonError(502, 'service_unreachable');
  } finally {
    clearTimeout(timer);
  }

  return new Response(NULL_BODY.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    headers: bffResponseHeaders(upstream.headers),
  });
}
