/**
 * POST /auth/github/agent — "Start GitHub Copilot" on a task page. Copilot is
 * started with the contributor's own GitHub authorization, so this asks
 * GitHub for a one-time one: a fresh state and PKCE pair, sealed into the
 * transaction cookie as an `agent` attempt for this task and rail, then off to
 * GitHub's authorize page exactly as sign-in goes. The callback
 * (`/auth/callback`) spends the token on one start through the API and drops
 * it; nothing stores it.
 *
 * Refused unless the form comes from a page on this origin (403), and for
 * anyone who is not signed in with GitHub: signed out goes to /signin and
 * back to the task, the practice account gets a 403. Whether Copilot may be
 * started at all (the `agent_start` flag and the API's allowlist) is the
 * API's call, made when the callback asks it to start.
 */
import {
  authorizeUrl,
  COOKIE,
  cookieOptions,
  createPkcePair,
  randomToken,
  sealTransaction,
} from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { githubAppConfig, isProduction, sessionKeys } from '../../../../lib/auth/config';
import { jsonError, readBody, redirectTo } from '../../../../lib/auth/http';
import { isSameOrigin } from '../../../../lib/bff-forward';
import { getSession, signInAvailability } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The form holds one task number; nothing legitimate comes near this. */
const MAX_BODY_BYTES = 1024;
const TASK_ID = /^[1-9][0-9]{0,8}$/;
/** The only rail started with a GitHub authorization (credential kind `github`). */
const RAIL = 'copilot';

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, 'bad_origin');

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return jsonError(413, 'too_large');
  const field = new URLSearchParams(new TextDecoder().decode(body)).get('taskId') ?? '';
  if (!TASK_ID.test(field)) return jsonError(400, 'bad_request');
  const taskId = Number(field);
  const taskPage = `/contribute/task/${taskId}`;

  const session = await getSession();
  if (session === null) return redirectTo(`/signin?${new URLSearchParams({ next: taskPage }).toString()}`);
  if (session.demo) return jsonError(403, 'practice_session');

  const config = githubAppConfig();
  const keys = sessionKeys();
  if (config === null || keys === null || keys.practiceOnly || (await signInAvailability()) !== 'github') {
    return redirectTo(`${taskPage}?start_error=github_not_configured`);
  }

  const state = randomToken();
  const { verifier, challenge } = await createPkcePair();
  const prod = isProduction();
  (await cookies()).set(
    COOKIE.transaction(prod),
    await sealTransaction({ state, verifier, next: taskPage, purpose: 'agent', taskId, rail: RAIL }, keys.seal),
    cookieOptions('transaction', prod),
  );

  return redirectTo(
    authorizeUrl({
      clientId: config.clientId,
      redirectUri: `${config.origin}/auth/callback`,
      state,
      codeChallenge: challenge,
    }),
    303,
  );
}
