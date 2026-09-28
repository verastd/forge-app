/**
 * Response helpers for the auth routes and the BFF. Everything here is
 * `no-store`: a cached redirect or error would outlive the cookie it was about.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** The `error` values the /signin page explains. */
export type SignInError = 'unavailable' | 'expired' | 'state' | 'denied' | 'github';

/**
 * A redirect. A same-origin path stays relative, so the browser resolves it
 * against the URL it actually requested; the Host header never decides where
 * it points.
 */
export function redirectTo(location: string, status: 302 | 303 = 303): Response {
  return new Response(null, { status, headers: { Location: location, ...NO_STORE } });
}

export function signInFailed(error: SignInError): Response {
  return redirectTo(`/signin?error=${error}`);
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/** The API's JSON and its CSV exports, with any parameters (`; charset=utf-8`). */
const PASSED_CONTENT_TYPE = /^(?:application\/json|text\/csv)[\t ]*(?:;|$)/i;

/**
 * The only headers the BFF gives the browser from an upstream response,
 * whatever upstream sends:
 * - `Content-Type` when it is JSON or CSV, else `application/octet-stream`,
 *   so an upstream `text/html` (say) never renders on this origin;
 * - `Content-Disposition`, which names a CSV export's file;
 * - `Cache-Control: private, no-store`, because the data is per user.
 * Everything else (cookies, CORS, redirects, server banners) stays behind.
 */
export function bffResponseHeaders(upstream: Headers): Headers {
  const type = upstream.get('content-type');
  const headers = new Headers({
    'content-type': type !== null && PASSED_CONTENT_TYPE.test(type) ? type : 'application/octet-stream',
    'cache-control': 'private, no-store',
  });
  const disposition = upstream.get('content-disposition');
  if (disposition !== null) headers.set('content-disposition', disposition);
  return headers;
}

/**
 * The request body, or null once it passes `limit` bytes. Reads the stream
 * itself rather than trusting Content-Length, and stops reading at the limit.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
