/**
 * GET /auth/callback — where GitHub sends the browser back. The attempt must
 * match the sealed transaction cookie (constant-time state check), and the
 * code is only good together with that cookie's PKCE verifier. The token is
 * used once, for `GET /user`, and dropped: no GitHub token is ever stored.
 *
 * An `agent` attempt (POST /auth/github/agent, "Start GitHub Copilot") comes
 * back here too, and takes its own branch below; the sign-in path is
 * unchanged.
 */
import {
  AuthError,
  COOKIE,
  constantTimeEqual,
  cookieOptions,
  exchangeCode,
  fetchGitHubUser,
  openTransaction,
  safeNext,
} from '@forge/auth';
import type { TransactionClaims } from '@forge/auth';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { githubAppConfig, isProduction, sessionKeys } from '../../../lib/auth/config';
import { redirectTo, signInFailed } from '../../../lib/auth/http';
import { postAsUser } from '../../../lib/bff-forward';
import type { ApiOutcome } from '../../../lib/bff-forward';
import { getSession, setSessionCookie, signInAvailability } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const store = await cookies();
  const prod = isProduction();
  const tx = await openTransaction(store.get(COOKIE.transaction(prod))?.value, sessionKeys()?.open ?? []);
  // One attempt, one use: every response below, success or not, spends it.
  // Cleared with the attributes it was set with, or a browser keeps it.
  store.set(COOKIE.transaction(prod), '', { ...cookieOptions('transaction', prod), maxAge: 0 });
  if (tx === null) return signInFailed('expired');
  if (tx.purpose === 'agent') return agentCallback(request, tx);

  const params = request.nextUrl.searchParams;
  if (!constantTimeEqual(params.get('state') ?? '', tx.state)) return signInFailed('state');
  // GitHub's own refusal (`access_denied`) arrives with the state but no code.
  if (params.has('error')) return signInFailed('denied');

  const config = githubAppConfig();
  if ((await signInAvailability()) !== 'github' || config === null) return signInFailed('unavailable');
  const code = params.get('code');
  if (!code) return signInFailed('github');

  try {
    const { accessToken } = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: `${config.origin}/auth/callback`,
      codeVerifier: tx.verifier,
    });
    const user = await fetchGitHubUser(accessToken);
    await setSessionCookie({
      sub: String(user.id),
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      demo: false,
    });
  } catch (error) {
    // The code only: messages and requests could carry the code or a token.
    console.warn(`sign-in callback failed: ${error instanceof AuthError ? error.code : 'unexpected'}`);
    return signInFailed('github');
  }

  // Against the configured origin, never the Host header this request came with.
  return redirectTo(new URL(safeNext(tx.next), config.origin).toString());
}

/**
 * The `agent` attempt: GitHub's one-time authorization to start Copilot on one
 * task. The token must belong to the GitHub account signed in here. It goes to
 * the API in one dispatch request, as the credential for that one start (the
 * API never saves a `copilot` credential), and is dropped when this returns:
 * it is never stored, logged or sent anywhere else. Every outcome lands back on
 * the task page, which says what happened: `?started=<rail>` or
 * `?start_error=<code>` (plus `&status=` for `rail_failed`).
 */
async function agentCallback(
  request: NextRequest,
  tx: Extract<TransactionClaims, { purpose: 'agent' }>,
): Promise<Response> {
  const taskPage = `/contribute/task/${tx.taskId}`;
  const back = (outcome: Record<string, string>): Response =>
    redirectTo(`${taskPage}?${new URLSearchParams(outcome).toString()}`);
  const failed = (code: string, status?: number): Response =>
    back({ start_error: code, ...(status === undefined ? {} : { status: String(status) }) });

  const params = request.nextUrl.searchParams;
  if (!constantTimeEqual(params.get('state') ?? '', tx.state)) return failed('github_failed');
  // GitHub's own refusal (`access_denied`) arrives with the state but no code.
  if (params.has('error')) return failed('github_denied');
  // Only Copilot is started with a GitHub authorization.
  if (tx.rail !== 'copilot') return failed('github_failed');

  const config = githubAppConfig();
  if ((await signInAvailability()) !== 'github' || config === null) return failed('github_not_configured');
  const session = await getSession();
  if (session === null || session.demo) return failed('signed_out');
  const code = params.get('code');
  if (!code) return failed('github_failed');

  let outcome: ApiOutcome;
  try {
    const { accessToken } = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: `${config.origin}/auth/callback`,
      codeVerifier: tx.verifier,
    });
    const user = await fetchGitHubUser(accessToken);
    if (String(user.id) !== session.sub) return failed('wrong_account');
    outcome = await postAsUser('/api/bridge/dispatch', session, {
      taskId: tx.taskId,
      rail: tx.rail,
      credential: { key: accessToken },
    });
  } catch (error) {
    // The code only: messages and requests could carry the code or a token.
    console.warn(`agent authorization failed: ${error instanceof AuthError ? error.code : 'unexpected'}`);
    return failed('github_failed');
  }
  return outcome.ok ? back({ started: tx.rail }) : failed(outcome.code, outcome.status);
}
