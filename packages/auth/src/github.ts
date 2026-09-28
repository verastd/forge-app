/**
 * The GitHub side of sign-in: the authorize redirect, the code-for-token
 * exchange and `GET /user`. Nothing here keeps the token. The callback trades
 * it for the profile and drops it, because Phase 1 stores no GitHub token.
 *
 * GitHub's profile formats live here too. A session carries a GitHub
 * identity, so the session and the API assertion validate with these same
 * checks, and whatever `fetchGitHubUser` returns can always be sealed.
 */
import { AuthError } from './errors.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_AGENT = 'forge-web';
const TIMEOUT_MS = 10_000;

/** Alphanumerics and hyphens, 1 to 39 characters, no leading hyphen. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub user id in decimal: no sign, no leading zero. */
const USER_ID = /^[1-9][0-9]{0,19}$/;
/** GitHub's own error codes look like `bad_verification_code`; anything else is not echoed. */
const ERROR_CODE = /^[a-z_]{1,64}$/;
const MAX_NAME_LENGTH = 256;
const MAX_AVATAR_URL_LENGTH = 2048;

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN.test(value);
}

export function isGitHubUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID.test(value);
}

export function isDisplayName(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_NAME_LENGTH);
}

export function isAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The part of `fetch` these calls use. Tests inject a fake; the default is `globalThis.fetch`. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface ExchangeCodeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * GitHub's authorize URL for one sign-in attempt, with an S256 PKCE challenge.
 * There is no `scope`: a GitHub App's permissions come from its registration,
 * and `GET /user` needs none.
 */
export function authorizeUrl({ clientId, redirectUri, state, codeChallenge }: AuthorizeUrlParams): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Trades the callback's `code`, together with the PKCE verifier, for a user
 * access token.
 *
 * @throws AuthError whose `code` is GitHub's own error code
 *   (`bad_verification_code`, `redirect_uri_mismatch`, ...). GitHub refuses
 *   with HTTP 200 and an `error` field.
 * @throws AuthError `exchange_failed` for anything else: a network error or
 *   timeout, a non-2xx status, a body that is not a JSON object, a missing or
 *   empty `access_token`, or an error value other than a plain
 *   `[a-z_]{1,64}` code.
 */
export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = globalThis.fetch,
}: ExchangeCodeParams): Promise<{ accessToken: string }> {
  const body = await fetchJson(
    fetchImpl,
    TOKEN_URL,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    },
    'exchange_failed',
  );
  const { error, access_token: accessToken } = body;
  if (error !== undefined && error !== null) {
    throw new AuthError(typeof error === 'string' && ERROR_CODE.test(error) ? error : 'exchange_failed');
  }
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AuthError('exchange_failed');
  }
  return { accessToken };
}

/**
 * The signed-in user's profile, from `GET /user`.
 *
 * @throws AuthError `github_user_failed` on a network error or timeout, a
 *   non-2xx status, or a body that is not a valid user. A valid user has an
 *   `id` that is a positive safe integer and a `login` in GitHub's format.
 *   Its `name` is a string of at most 256 characters or null. Its
 *   `avatar_url` is an https URL of at most 2048 characters or null.
 */
export async function fetchGitHubUser(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GitHubUser> {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AuthError('github_user_failed');
  }
  const body = await fetchJson(
    fetchImpl,
    USER_URL,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    'github_user_failed',
  );
  const { id, login, name, avatar_url: avatarUrl } = body;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !isGitHubLogin(login) ||
    !isDisplayName(name) ||
    !isAvatarUrl(avatarUrl)
  ) {
    throw new AuthError('github_user_failed');
  }
  return { id, login, name, avatarUrl };
}

/**
 * The JSON object `url` answers with, or AuthError(`failure`). The error never
 * carries the request, so the client secret, the code and the token cannot
 * reach a log through it. `redirect: 'error'` means the body and headers,
 * credentials included, only ever go to the URL given here.
 */
async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  failure: string,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) body = await response.json();
  } catch {
    // A network error, the timeout, a redirect, or a body that is not JSON.
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AuthError(failure);
  }
  return body as Record<string, unknown>;
}
