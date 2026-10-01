/**
 * POST /oauth/authorize/decision: the consent page's Allow and Cancel
 * (contract §1, §9). Each refusal below is a plain HTML page that goes
 * nowhere; the only redirect is the 303 at the end. In order:
 *
 * 1. Same-origin (`Origin` is the public origin, or `Sec-Fetch-Site:
 *    same-origin`), or 403: a page on another site cannot press Allow.
 * 2. Session keys that are the public dev secret: 503, as the BFF answers,
 *    since anyone can seal a session under them.
 * 3. A urlencoded form of at most 32 KB, with exactly one `decision` (allow or
 *    deny) and the request's OAuth parameters, or 400.
 * 4. A real session: 401 when signed out (with a way to sign in and come
 *    back to the same consent screen), 403 for a practice one.
 * 5. The API records the decision as the visitor (a fresh assertion, as the
 *    BFF mints) and names where the browser goes: 303 there. Every failure
 *    is an error page, never a redirect to anything the form carried.
 */
import { safeNext } from '@forge/auth';
import type { NextRequest } from 'next/server';

import { publicOrigin, sessionKeys } from '../../../../lib/auth/config';
import { readBody } from '../../../../lib/auth/http';
import { getSession } from '../../../../lib/session';
import { recordDecision } from '../consent-api';
import { NOTICES } from '../copy';
import type { NoticeKind } from '../copy';
import { authorizeParamsFrom, CONSENT_PATH, consentPath, isSameOriginPost } from '../oauth-request';
import { errorPageHtml } from './error-page';
import type { PageLink } from './error-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The form is the request's parameters plus `decision`. At the API's limits
 * (an 8 KB client_id, a 2 KB state that may triple when percent-encoded) it
 * stays under 20 KB; nothing legitimate comes near this.
 */
const MAX_FORM_BYTES = 32 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded[\t ]*(?:;|$)/i;

function errorPage(status: number, kind: NoticeKind, primary?: PageLink): Response {
  return new Response(errorPageHtml(NOTICES[kind], primary), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginPost(request.headers, publicOrigin())) return errorPage(403, 'crossOrigin');
  if (sessionKeys()?.practiceOnly) return errorPage(503, 'unavailable');

  if (!FORM_TYPE.test(request.headers.get('content-type') ?? '')) return errorPage(400, 'invalid');
  const body = await readBody(request, MAX_FORM_BYTES);
  if (body === null) return errorPage(413, 'invalid');
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const decisions = form.getAll('decision');
  const decision = decisions.length === 1 ? decisions[0] : undefined;
  const mapped = authorizeParamsFrom((name) => form.getAll(name));
  if ((decision !== 'allow' && decision !== 'deny') || !mapped.ok) return errorPage(400, 'invalid');

  const session = await getSession();
  if (session === null) {
    // Signing in brings the visitor back to this same consent screen; a
    // consent URL too long for `next` comes back bare and says to start over.
    const next = safeNext(consentPath(mapped.params), CONSENT_PATH);
    return errorPage(401, 'signedOut', { href: `/signin?${new URLSearchParams({ next }).toString()}`, label: 'Sign in' });
  }
  // The practice account is nobody on GitHub, so there is nobody to connect.
  if (session.demo) return errorPage(403, 'practice');

  const outcome = await recordDecision(decision, mapped.params, { sub: session.sub, login: session.login });
  switch (outcome.kind) {
    case 'redirect':
      return new Response(null, { status: 303, headers: { location: outcome.to, 'cache-control': 'no-store' } });
    case 'invalid':
      return errorPage(400, 'invalid');
    case 'off':
      return errorPage(404, 'off');
    case 'unavailable':
      return errorPage(502, 'unavailable');
  }
}
