/**
 * GET /auth/github/repo/callback — where GitHub sends the browser back after
 * "Get started", "Refresh your copy" or "Send for review" (the OAuth App's
 * registered callback URL is `<FORGE_PUBLIC_ORIGIN>/auth/github/repo/callback`).
 *
 * The rules are `finishRepoAuthorization` (`../flow.ts`); this file wires in
 * the real cookie, session, GitHub calls, the API and Next's `after`. The
 * one-time token goes to GitHub (whose user it is, then its revocation, with
 * the OAuth App's own credentials) and to the API (the one action), and
 * nowhere else: never a log, a URL or a cookie.
 */
import {
  AuthError,
  constantTimeEqual,
  COOKIE,
  cookieOptions,
  exchangeCode,
  fetchGitHubUser,
  openTransaction,
  revokeGitHubToken,
} from '@forge/auth';
import { cookies } from 'next/headers';
import { after } from 'next/server';
import type { NextRequest } from 'next/server';

import { isProduction, sessionKeys } from '../../../../../lib/auth/config';
import { postAsUserForResult } from '../../../../../lib/bff-forward';
import { getSession, repoApp } from '../../../../../lib/session';
import { actionTimeoutMs, copiedState, finishRepoAuthorization, reviewedPullRequest } from '../flow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * `CALLBACK_MAX_SECONDS` in `../flow.ts`, written out because Next reads this
 * file's config without running it. The action's wait is cut to fit, so the
 * token's revocation, which runs after the response, still has 12 s.
 */
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  return finishRepoAuthorization(request.nextUrl, {
    auth: { AuthError, constantTimeEqual },
    attempt: async () => {
      const store = await cookies();
      const prod = isProduction();
      const tx = await openTransaction(store.get(COOKIE.transaction(prod))?.value, sessionKeys()?.open ?? []);
      // One attempt, one use: every response, success or not, spends it.
      // Cleared with the attributes it was set with, or a browser keeps it.
      store.set(COOKIE.transaction(prod), '', { ...cookieOptions('transaction', prod), maxAge: 0 });
      return tx;
    },
    session: getSession,
    app: repoApp,
    exchange: (params) => exchangeCode(params),
    userIdOf: async (token) => String((await fetchGitHubUser(token)).id),
    act: async (action, taskId, token, who) => {
      // However long the exchange took, the revocation still fits in the time this function has.
      const timeoutMs = actionTimeoutMs(action, Date.now() - startedAt);
      const result = await postAsUserForResult(`/api/bridge/${action}`, who, { taskId, token }, timeoutMs);
      if (!result.ok) return result;
      if (action === 'copy') return { ok: true, ...copiedState(result.body) };
      const pr = reviewedPullRequest(result.body);
      return pr === undefined ? { ok: true } : { ok: true, pr };
    },
    revoke: (app, token) =>
      revokeGitHubToken({ clientId: app.clientId, clientSecret: app.clientSecret, accessToken: token }),
    // The promise form: the revocation is already running, and this keeps the function alive for it.
    keepAlive: (running) => {
      after(running);
    },
    log: (line, level) => {
      if (level === 'info') {
        console.info(line);
      } else {
        console.warn(line);
      }
    },
  });
}
