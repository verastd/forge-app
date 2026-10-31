/**
 * The Google side of sign-in, the second way in beside GitHub: the authorize
 * redirect (OpenID Connect, `openid email profile`, PKCE S256), the
 * code-for-token exchange, and the profile from Google's userinfo endpoint.
 * As with GitHub, nothing here keeps the token: the callback trades it for the
 * profile and drops it.
 *
 * A Google member is not a GitHub account and must never pass for one. Their
 * session `sub` is `google:<Google's sub>` (never a bare number, which every
 * GitHub-id check refuses), and their handle starts `g.`, which no GitHub
 * login can, so a name tag or an `@handle` can't impersonate anyone on
 * GitHub. Whatever `fetchGoogleUser` returns can always be sealed.
 */
import { AuthError } from './errors.js';
import { fetchJson, isAvatarUrl, isDisplayName } from './github.js';
import type { FetchLike } from './github.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'openid email profile';

/** Google's `sub`: a stable account id in decimal (21 digits today; room for more). */
const GOOGLE_ID = /^[0-9]{1,40}$/;
/** A Google member's session `sub`. */
const GOOGLE_SUB = /^google:[0-9]{1,40}$/;
/** A Google member's handle: `g.` and up to 37 lower-case letters, digits and hyphens (39 in all, GitHub's limit). */
const GOOGLE_LOGIN = /^g\.[a-z0-9](?:[a-z0-9-]{0,36})$/;

export function isGoogleSub(value: unknown): value is string {
  return typeof value === 'string' && GOOGLE_SUB.test(value);
}

export function isGoogleLogin(value: unknown): value is string {
  return typeof value === 'string' && GOOGLE_LOGIN.test(value);
}

export interface GoogleAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface GoogleExchangeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
}

/** A Google member as a session holds them. */
export interface GoogleUser {
  /** `google:<Google's sub>`. */
  sub: string;
  /** `g.<handle>`. */
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * Google's authorize URL for one sign-in attempt: the code flow with an S256
 * PKCE challenge, `openid email profile` and nothing wider, and the account
 * chooser every time (`prompt=select_account`), so someone with several
 * Google accounts picks one rather than being signed in as whichever is open.
 */
export function googleAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }: GoogleAuthorizeUrlParams): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Trades the callback's `code`, with the PKCE verifier, for an access token.
 *
 * @throws AuthError `exchange_failed` for anything but a 2xx JSON object with
 *   a non-empty `access_token` (Google refuses with a 4xx, so its own error
 *   codes are never echoed).
 */
export async function exchangeGoogleCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = globalThis.fetch,
}: GoogleExchangeParams): Promise<{ accessToken: string }> {
  const body = await fetchJson(
    fetchImpl,
    TOKEN_URL,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
      }).toString(),
    },
    'exchange_failed',
  );
  const { access_token: accessToken } = body;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AuthError('exchange_failed');
  }
  return { accessToken };
}

/**
 * A handle for a Google member from their name: `g.` and the words
 * lower-cased and joined with hyphens, ASCII letters and digits only, cut to
 * fit. `g.member` when nothing usable is left. Never from their email, which
 * a handle would put on every name tag. Not unique, and it needn't be: the
 * `sub` is who they are, the handle only what their tag says.
 */
export function googleHandle(name: string | null): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 37)
    .replace(/-+$/, '');
  return `g.${slug === '' ? 'member' : slug}`;
}

/**
 * The signed-in Google member, from the userinfo endpoint.
 *
 * @throws AuthError `google_user_failed` on a network error or timeout, a
 *   non-2xx status, or a body without a decimal `sub`. A name over 256
 *   characters, or a picture that isn't an https URL of at most 2048, is
 *   dropped rather than refused.
 * @throws AuthError `google_email_unverified` when Google says the account's
 *   email is not verified.
 */
export async function fetchGoogleUser(accessToken: string, fetchImpl: FetchLike = globalThis.fetch): Promise<GoogleUser> {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new AuthError('google_user_failed');
  }
  const body = await fetchJson(
    fetchImpl,
    USERINFO_URL,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } },
    'google_user_failed',
  );
  const { sub, name, email_verified: verified, picture } = body;
  if (typeof sub !== 'string' || !GOOGLE_ID.test(sub)) {
    throw new AuthError('google_user_failed');
  }
  if (verified === false) {
    throw new AuthError('google_email_unverified');
  }
  const displayName = typeof name === 'string' && name.trim() !== '' && isDisplayName(name.trim()) ? name.trim() : null;
  return {
    sub: `google:${sub}`,
    login: googleHandle(displayName),
    name: displayName,
    avatarUrl: typeof picture === 'string' && isAvatarUrl(picture) ? picture : null,
  };
}
