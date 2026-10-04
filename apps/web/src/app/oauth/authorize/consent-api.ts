/**
 * The consent flow's calls to the API (contract §5), made server-side only:
 *
 * - `POST /api/oauth/authorize/check` with no identity, before the consent
 *   screen is drawn;
 * - `POST /api/oauth/authorize/approve` or `/deny` with a 60-second assertion
 *   for the signed-in visitor, minted exactly as the upland BFF mints one.
 *
 * Every answer is parsed with the shared zod schemas, and every way it can go
 * wrong comes back as a value the page or the handler turns into words; none
 * of them throws. Server-only: it reads FORGE_API_ASSERTION_SECRET. (The
 * `server-only` package is not a dependency of this app, so nothing enforces
 * that; never import this from a client component.)
 */
import { mintApiAssertion } from '@forge/auth';
import type { ApiIdentity } from '@forge/auth';
import { AuthorizeCheckSchema, AuthorizeDecisionSchema, AuthorizeErrorSchema } from '@forge/shared';
import type { AuthorizeCheck, AuthorizeParams } from '@forge/shared';

import { apiAssertionSecret, apiUrl } from '../../../lib/auth/config';
import { clientRedirect } from './oauth-request';

/** Until the API has answered in full. Both calls are a few database reads. */
const TIMEOUT_MS = 10_000;
/** Far more than any of these answers; a bigger one is not the API we know. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Why there is nothing to show but an error, and never a redirect. */
export type ConsentFailure =
  /** The API refused the request and named no safe place to send the visitor (400, or 422 for a malformed body). */
  | { kind: 'invalid'; description?: string }
  /** The `mcp_connector` flag is off (404 `connector-disabled`). */
  | { kind: 'off' }
  /** Anything else: the API down or misconfigured (503 `connector_unavailable`), slow, or answering something unexpected. */
  | { kind: 'unavailable' };

export type CheckOutcome =
  | { kind: 'consent'; check: AuthorizeCheck }
  /**
   * A 400 whose `redirectTo` passed `clientRedirect`: the client may be told,
   * but only if the visitor chooses to go back (a button, never an automatic
   * redirect), so this page can't bounce anyone anywhere unasked.
   */
  | { kind: 'return'; to: string; description?: string }
  | ConsentFailure;

export type DecisionOutcome = { kind: 'redirect'; to: string } | ConsentFailure;

export type Decision = 'allow' | 'deny';

interface ApiAnswer {
  status: number;
  /** The parsed JSON body, or undefined if it was not JSON. */
  body: unknown;
}

/** At most `limit` bytes of `response`'s body as text, or null past that. */
async function readText(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
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
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * POST `params` as JSON to the API, or null if it could not be reached in
 * time, or there is no https API to send it to (`apiUrl`).
 */
async function post(path: string, params: AuthorizeParams, authorization?: string): Promise<ApiAnswer | null> {
  const base = apiUrl();
  if (base === null) return null;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (authorization !== undefined) headers.authorization = authorization;
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await readText(response, MAX_RESPONSE_BYTES);
    let body: unknown;
    try {
      body = text === null ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch {
    // Refused, reset, DNS, or the deadline.
    return null;
  }
}

/** What every endpoint here shares: 404 off, a 400/422 refusal, anything else unavailable. */
function failure(answer: ApiAnswer | null): ConsentFailure {
  if (answer === null) return { kind: 'unavailable' };
  const { status, body } = answer;
  if (status === 404) {
    const error = AuthorizeErrorSchema.safeParse(body);
    return error.success && error.data.error === 'connector-disabled' ? { kind: 'off' } : { kind: 'unavailable' };
  }
  if (status === 400) {
    const error = AuthorizeErrorSchema.safeParse(body);
    return error.success && error.data.errorDescription !== undefined
      ? { kind: 'invalid', description: error.data.errorDescription }
      : { kind: 'invalid' };
  }
  if (status === 422) return { kind: 'invalid' };
  return { kind: 'unavailable' };
}

/**
 * Asks the API whether `params` is a request worth showing a consent screen
 * for. A 400 with a `redirectTo` that passes `clientRedirect` offers the
 * visitor a way back to the client with the error (`return`); one without
 * stays here.
 */
export async function checkAuthorization(params: AuthorizeParams): Promise<CheckOutcome> {
  const answer = await post('/api/oauth/authorize/check', params);
  if (answer?.status === 200) {
    const check = AuthorizeCheckSchema.safeParse(answer.body);
    return check.success ? { kind: 'consent', check: check.data } : { kind: 'unavailable' };
  }
  if (answer?.status === 400) {
    const error = AuthorizeErrorSchema.safeParse(answer.body);
    const to = error.success ? clientRedirect(error.data.redirectTo) : null;
    if (error.success && to !== null) {
      const { errorDescription } = error.data;
      return { kind: 'return', to, ...(errorDescription === undefined ? {} : { description: errorDescription }) };
    }
  }
  return failure(answer);
}

/**
 * Records the visitor's Allow or Cancel with the API, as `identity`, and
 * returns where to send the browser: the API's `redirectTo` from a 200, and
 * nothing else. Any refusal becomes an error page, even one that names a
 * `redirectTo`: after the visitor has chosen, the only address the browser
 * is ever sent to is one the API returned as the outcome of that choice.
 */
export async function recordDecision(
  decision: Decision,
  params: AuthorizeParams,
  identity: ApiIdentity,
): Promise<DecisionOutcome> {
  const secret = apiAssertionSecret();
  if (secret === null) return { kind: 'unavailable' };
  let assertion: string;
  try {
    assertion = await mintApiAssertion({ sub: identity.sub, login: identity.login }, secret);
  } catch {
    // Not a GitHub identity: the practice account, which callers refuse before this.
    return { kind: 'unavailable' };
  }
  const path = decision === 'allow' ? '/api/oauth/authorize/approve' : '/api/oauth/authorize/deny';
  const answer = await post(path, params, `Bearer ${assertion}`);
  if (answer?.status === 200) {
    const result = AuthorizeDecisionSchema.safeParse(answer.body);
    const to = result.success ? clientRedirect(result.data.redirectTo) : null;
    return to === null ? { kind: 'unavailable' } : { kind: 'redirect', to };
  }
  return failure(answer);
}
