/**
 * Server-only: how this origin speaks to the API for someone. Used by the
 * Bridge BFF (`/bff/bridge/*`), the connected-agents BFF
 * (`/bff/oauth/grants*`), the Proposals and notifications BFFs
 * (`/bff/proposals*`, `/bff/notifications*`), the Copilot callback's one
 * server-side start, the repo callback's one copy or review ("your copy",
 * "Send for review": `/api/bridge/copy` and `/review` are never reachable
 * from the browser, only from here) and the sign-in callback's members hello.
 *
 * Same model as the Upland BFF (`app/bff/upland/[...path]/route.ts`), which
 * keeps its own copy so its behaviour stays exactly as it is:
 *
 * - a 60-second API assertion is minted per request from the session cookie,
 *   never on a server whose session keys are the public dev secret;
 * - the practice account is refused (403 `practice_session`): it is nobody on
 *   GitHub, so the API has nobody to serve;
 * - only an allowlist of headers goes either way: up, the assertion, `Accept`
 *   and a JSON `Content-Type`; down, a JSON `Content-Type` (anything else
 *   becomes `application/octet-stream`), `Cache-Control: no-store`, and a
 *   `Retry-After` in whole seconds when upstream sends one (the dispatch rate
 *   limit). Cookies, the browser's own headers and whatever else upstream
 *   adds stay behind;
 * - request bodies are JSON and at most 16 KB (a route may allow more:
 *   `maxBodyBytes`), read by the stream rather than by trusting
 *   Content-Length;
 * - state-changing methods must come from a page on this origin;
 * - nothing goes to an API that isn't https (`apiUrl`): 503 `not_configured`;
 * - a request the API took but didn't answer in time is 504
 *   `upstream_timeout`, not `service_unreachable`: a start or a relay may
 *   still be happening behind it, so nobody may be told that nothing changed.
 *
 * Nothing here logs a request or response body: a dispatch body carries the
 * contributor's agent key.
 */
import { mintApiAssertion } from '@forge/auth';
import type { SessionClaims } from '@forge/auth';
import type { NextRequest } from 'next/server';

import { apiAssertionSecret, apiUrl, isTrustedOrigin, sessionKeys } from './auth/config';
import { readBody } from './auth/http';
import { getSession } from './session';

export const MAX_BODY_BYTES = 16 * 1024;
/** Until upstream answers with headers. */
export const READ_TIMEOUT_MS = 25_000;
/**
 * A start waits on the vendor's API behind the API (20 s there, plus our own
 * work). The browser waits longer than this (lib/api.ts), so it hears this
 * server's 504 rather than giving up first.
 */
export const START_TIMEOUT_MS = 45_000;

/** Statuses a Response may not carry a body with. */
const NULL_BODY = new Set([101, 204, 205, 304]);
/** JSON, with any parameters (`; charset=utf-8`). */
const JSON_TYPE = /^application\/json[\t ]*(?:;|$)/i;

/** `{"error": code}` with `status`, never cached. */
export function bffError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Whether a state-changing request came from a page on this origin: an
 * `Origin` that is ours (`isTrustedOrigin`), or the browser's own
 * `Sec-Fetch-Site: same-origin`, which no page can forge.
 */
export function isSameOrigin(request: NextRequest): boolean {
  if (isTrustedOrigin(request.headers.get('origin'), request.nextUrl.origin)) return true;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export interface ForwardSpec {
  /** PATCH and PUT are the Proposals BFF's (`/bff/proposals/*`): an edit, the settings, a draft task. */
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  /** The API path, already validated and encoded by the route, e.g. `/api/bridge/claim`. */
  upstreamPath: string;
  /** `optional`: forwarded as nobody when signed out. `required`: 401 when signed out. */
  identity: 'required' | 'optional';
  timeoutMs?: number;
  /**
   * The body cap, when a route needs more than {@link MAX_BODY_BYTES}: a
   * proposal's 4,000-character pitch can run past 16 KB as UTF-8.
   */
  maxBodyBytes?: number;
}

/** The methods that carry a request body here. */
const WITH_BODY: ReadonlySet<ForwardSpec['method']> = new Set(['POST', 'PATCH', 'PUT']);

/** The assertion header for `session`, or null when this server cannot vouch for anyone. */
async function assertionFor(session: Pick<SessionClaims, 'sub' | 'login'>): Promise<string | null> {
  const secret = apiAssertionSecret();
  if (secret === null) return null;
  try {
    return `Bearer ${await mintApiAssertion({ sub: session.sub, login: session.login }, secret)}`;
  } catch {
    // Only a GitHub identity can mint; anything else is nobody to the API.
    return null;
  }
}

function responseHeaders(upstream: Headers): Headers {
  const type = upstream.get('content-type');
  const headers = new Headers({
    'content-type': type !== null && JSON_TYPE.test(type) ? type : 'application/octet-stream',
    'cache-control': 'no-store',
  });
  // A rate limit's wait (dispatch_limit), as whole seconds and nothing else.
  const retryAfter = upstream.get('retry-after')?.trim();
  if (retryAfter !== undefined && /^[0-9]{1,6}$/.test(retryAfter)) headers.set('retry-after', retryAfter);
  return headers;
}

/** Check, vouch and forward one browser request to the API (see the module comment). */
export async function forward(request: NextRequest, spec: ForwardSpec): Promise<Response> {
  if (spec.method !== 'GET' && !isSameOrigin(request)) return bffError(403, 'bad_origin');
  // Keys anyone can seal under: never mint, whoever seems to be asking.
  if (sessionKeys()?.practiceOnly) return bffError(503, 'not_configured');
  const base = apiUrl();
  if (base === null) return bffError(503, 'not_configured');

  const session = await getSession();
  if (session?.demo === true) return bffError(403, 'practice_session');
  if (session === null && spec.identity === 'required') return bffError(401, 'unauthenticated');

  const headers: Record<string, string> = { accept: 'application/json' };
  let body: Uint8Array | undefined;
  if (WITH_BODY.has(spec.method)) {
    const read = await readBody(request, spec.maxBodyBytes ?? MAX_BODY_BYTES);
    if (read === null) return bffError(413, 'too_large');
    if (read.byteLength > 0) {
      const type = request.headers.get('content-type');
      if (type === null || !JSON_TYPE.test(type)) return bffError(415, 'unsupported_media_type');
      headers['content-type'] = 'application/json';
      body = read;
    }
  }
  if (session !== null) {
    const authorization = await assertionFor(session);
    if (authorization === null) return bffError(503, 'not_configured');
    headers.authorization = authorization;
  }

  // The deadline covers the wait for upstream's headers only. The browser
  // going away cancels the upstream call too.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), spec.timeoutMs ?? READ_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${spec.upstreamPath}`, {
      method: spec.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([deadline.signal, request.signal]),
    });
  } catch {
    // The deadline: the API has the request and may still act on it.
    if (deadline.signal.aborted) return bffError(504, 'upstream_timeout');
    // Refused, reset or DNS.
    return bffError(502, 'service_unreachable');
  } finally {
    clearTimeout(timer);
  }

  return new Response(NULL_BODY.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  });
}

/** What the API said to a server-side call: success, or its error code (and `status`, for `rail_failed`). */
export type ApiOutcome = { ok: true } | { ok: false; code: string; status?: number };

/** A refusal, worded as {@link ApiOutcome} words it. */
export type ApiRefusal = Extract<ApiOutcome, { ok: false }>;

/**
 * What the API said to a server-side call, keeping a success's JSON body
 * (null when it isn't JSON). A refusal that lists `paths` (the files a review
 * was refused for) comes back with how many, as `files`, and never the paths;
 * one that names a pull request (`prNumber`: `head_taken`), with its number as `pr`.
 */
export type ApiResult = { ok: true; body: unknown } | (ApiRefusal & { files?: number; pr?: number });

/** The one server-side POST behind {@link postAsUser} and {@link postAsUserForResult}, or why it got no answer. */
async function sendAsUser(
  path: string,
  session: Pick<SessionClaims, 'sub' | 'login'>,
  payload: unknown,
  timeoutMs: number,
): Promise<Response | ApiRefusal> {
  const authorization = await assertionFor(session);
  const base = apiUrl();
  if (authorization === null || base === null) return { ok: false, code: 'not_configured' };
  try {
    return await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization },
      body: JSON.stringify(payload),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Out of time, the API may still be starting it; anything else never reached it.
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, code: timedOut ? 'upstream_timeout' : 'service_unreachable' };
  }
}

/** A refusal body's fields, or none. */
function refusalFields(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * The API's refusal in `body` (from `response`): its own error code, or
 * `fallback` when the body names none, with the `status` it carries
 * (GitHub's or a vendor's), or the response's own status for the fallback.
 */
function refusalOf(response: Response, body: unknown, fallback: string): ApiRefusal {
  const fields = refusalFields(body);
  const code = typeof fields.error === 'string' && /^[a-z][a-z_-]{0,39}$/.test(fields.error) ? fields.error : fallback;
  const status =
    typeof fields.status === 'number' && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599
      ? fields.status
      : code === fallback
        ? response.status
        : undefined;
  return { ok: false, code, ...(status === undefined ? {} : { status }) };
}

/**
 * POST `payload` as JSON to the API path `path`, speaking for `session`, from
 * this server (no browser request behind it). The payload may hold a
 * credential: it goes to the API and nowhere else, and is never logged.
 */
export async function postAsUser(
  path: string,
  session: Pick<SessionClaims, 'sub' | 'login'>,
  payload: unknown,
  timeoutMs = START_TIMEOUT_MS,
): Promise<ApiOutcome> {
  const response = await sendAsUser(path, session, payload, timeoutMs);
  if (!(response instanceof Response)) return response;
  if (response.ok) {
    // The body is the DispatchResult; nothing here needs it, so it is not read.
    await response.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  return refusalOf(response, await response.json().catch(() => null), 'rail_failed');
}

/**
 * {@link postAsUser}, keeping the answer: a success comes back with its JSON
 * body, for the caller to check against the contract ("Send for review" needs
 * the pull request's number). A refusal that names no code is `api_failed`,
 * with the API's status, one that lists `paths` says only how many
 * (`files`), and one that names a pull request gives its number (`pr`). Same
 * rules otherwise: the payload (here, GitHub's one-time token) goes to the
 * API and nowhere else, and is never logged.
 */
export async function postAsUserForResult(
  path: string,
  session: Pick<SessionClaims, 'sub' | 'login'>,
  payload: unknown,
  timeoutMs = START_TIMEOUT_MS,
): Promise<ApiResult> {
  const response = await sendAsUser(path, session, payload, timeoutMs);
  if (!(response instanceof Response)) return response;
  if (response.ok) return { ok: true, body: await response.json().catch(() => null) };
  const body: unknown = await response.json().catch(() => null);
  const refusal = refusalOf(response, body, 'api_failed');
  const { paths, prNumber } = refusalFields(body);
  return {
    ...refusal,
    ...(Array.isArray(paths) && paths.length > 0 ? { files: Math.min(paths.length, 999) } : {}),
    ...(typeof prNumber === 'number' && Number.isSafeInteger(prNumber) && prNumber > 0 && prNumber <= 999_999_999
      ? { pr: prNumber }
      : {}),
  };
}
