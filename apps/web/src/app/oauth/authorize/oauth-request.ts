/**
 * The pure parts of the connector's consent flow (contract §3, §9): the OAuth
 * authorization request mapped onto the API's `AuthorizeParams`, the
 * same-origin rule for the Allow/Cancel POST, the check on any address the
 * API sends the browser to, and how an app's self-declared name is shown.
 *
 * No I/O and no runtime imports, so `tests/e2e/connect.spec.ts` runs these
 * directly (apps/web has no unit-test runner of its own).
 */
import type { AuthorizeParams } from '@forge/shared';

/** The consent page. Its form handler is `${CONSENT_PATH}/decision`. */
export const CONSENT_PATH = '/oauth/authorize';

/**
 * The authorization request parameters FORGE forwards, as OAuth names them
 * (the query and the consent form's hidden fields) and as the API's
 * `AuthorizeParams` does. Anything else in the query is ignored, as OAuth
 * says an unrecognised parameter must be.
 */
export const OAUTH_FIELDS = [
  ['response_type', 'responseType'],
  ['client_id', 'clientId'],
  ['redirect_uri', 'redirectUri'],
  ['code_challenge', 'codeChallenge'],
  ['code_challenge_method', 'codeChallengeMethod'],
  ['state', 'state'],
  ['scope', 'scope'],
  ['resource', 'resource'],
] as const satisfies ReadonlyArray<readonly [string, keyof AuthorizeParams]>;

export type OAuthField = (typeof OAUTH_FIELDS)[number][0];

/**
 * The longest single value forwarded: the API's own ceiling for the longest
 * one, the signed client_id (MAX_CLIENT_ID_LENGTH in services/oauth.py), which
 * carries up to ten redirect URIs. The API applies the real limits.
 */
export const MAX_VALUE_LENGTH = 8192;

/** Every value a name has: `URLSearchParams.getAll` fits, and so does `fromRecord`. */
export type ParamSource = (name: string) => readonly string[];

export type ParamsResult =
  | { ok: true; params: AuthorizeParams }
  /**
   * - `empty`: none of the OAuth parameters at all (someone opened the page
   *   directly, or came back from sign-in without the query);
   * - `repeated`: a parameter given twice, which OAuth forbids and which has
   *   no single value to forward;
   * - `too_long`: a value over MAX_VALUE_LENGTH.
   */
  | { ok: false; reason: 'empty' | 'repeated' | 'too_long' };

/** A `ParamSource` over Next's `searchParams`, where a repeated name arrives as an array. */
export function fromRecord(record: Readonly<Record<string, string | string[] | undefined>>): ParamSource {
  return (name) => {
    if (!Object.hasOwn(record, name)) return [];
    const value = record[name];
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
}

/**
 * The request as `AuthorizeParams`. A missing required parameter is sent as
 * '' rather than refused here: only the API can tell whether the client and
 * its redirect URI are good enough to be told about the error, or whether the
 * visitor must see it instead. Optional ones are left out when absent.
 */
export function authorizeParamsFrom(getAll: ParamSource): ParamsResult {
  const values = new Map<OAuthField, string>();
  for (const [field] of OAUTH_FIELDS) {
    const all = getAll(field);
    if (all.length > 1) return { ok: false, reason: 'repeated' };
    const value = all[0];
    if (value === undefined) continue;
    if (value.length > MAX_VALUE_LENGTH) return { ok: false, reason: 'too_long' };
    values.set(field, value);
  }
  if (values.size === 0) return { ok: false, reason: 'empty' };

  const params: AuthorizeParams = {
    responseType: values.get('response_type') ?? '',
    clientId: values.get('client_id') ?? '',
    redirectUri: values.get('redirect_uri') ?? '',
    codeChallenge: values.get('code_challenge') ?? '',
    codeChallengeMethod: values.get('code_challenge_method') ?? '',
  };
  const state = values.get('state');
  const scope = values.get('scope');
  const resource = values.get('resource');
  if (state !== undefined) params.state = state;
  if (scope !== undefined) params.scope = scope;
  if (resource !== undefined) params.resource = resource;
  return { ok: true, params };
}

/**
 * `params` back under their OAuth names, in a fixed order, absent optional
 * ones left out: the consent form's hidden fields and the consent URL.
 */
export function oauthFields(params: AuthorizeParams): Array<[OAuthField, string]> {
  const fields: Array<[OAuthField, string]> = [];
  for (const [field, key] of OAUTH_FIELDS) {
    const value = params[key];
    if (value !== undefined) fields.push([field, value]);
  }
  return fields;
}

/** The consent page's own path and query for `params`. */
export function consentPath(params: AuthorizeParams): string {
  return `${CONSENT_PATH}?${new URLSearchParams(oauthFields(params)).toString()}`;
}

/** The part of a header list the origin check reads: `Headers` fits. */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Whether a POST came from a page on this site (contract §9): its `Origin`
 * is the public origin, or the browser says `Sec-Fetch-Site: same-origin`.
 * Both are headers a page's script cannot set, and a browser on another site
 * sends neither, so a cross-site form posting Allow is refused. (A non-browser
 * client can send anything, but it has no visitor's cookie to ride on.)
 */
export function isSameOriginPost(headers: HeaderSource, publicOrigin: string | null): boolean {
  const origin = headers.get('origin');
  if (origin !== null && publicOrigin !== null && origin === publicOrigin) return true;
  return headers.get('sec-fetch-site') === 'same-origin';
}

/** Schemes a browser must never be sent to, whatever the API says (contract §9). */
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Longer than any redirect URI plus code, state and iss could be. */
const MAX_REDIRECT_LENGTH = 8192;

/**
 * Where to send the browser for an address the API returned (`redirectTo`),
 * serialized so it is safe in a Location header, or null. The API built it
 * from a redirect URI it validated; this is a second, independent check: an
 * absolute URL with no whitespace, control characters or fragment, not one
 * of the blocked schemes, and plain `http:` only to a loopback host. A
 * private-use scheme (`cursor://…`, `vscode://…`) is fine: that is how a
 * desktop app gets its code back.
 */
export function clientRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (BLOCKED_SCHEMES.has(url.protocol) || url.hash !== '' || value.includes('#')) return null;
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.href;
}

/**
 * Where an address that passed {@link clientRedirect} sends the browser, for
 * the "Return to …" button: its host (with a port that isn't the scheme's
 * default), or "the app <scheme>" for an app's `scheme:/path`, which names no
 * host, as the API's `redirectHost` says it. Never the address itself.
 */
export function returnTarget(to: string): string {
  const url = new URL(to);
  return url.host !== '' ? url.host : `the app ${url.protocol.slice(0, -1)}`;
}

/** Whether `host` (an API-reported redirect host, port or not) is this computer. */
export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  // A bare IPv6 address has colons of its own: its last group is not a port.
  if (lower === '::1') return true;
  return LOOPBACK_HOSTS.has(lower.replace(/:\d+$/, ''));
}

/** The scopes the consent screen's can and can't lists describe: `forge.tasks`, the only one there is. */
export const DESCRIBED_SCOPES: ReadonlySet<string> = new Set(['forge.tasks']);

/**
 * Whether the consent screen describes everything in `scopes` (the API's
 * `AuthorizeCheck.scopes`). A scope it can't put into words must never be
 * granted by a screen that doesn't mention it, so anything else means no
 * consent screen at all until the web learns to describe it.
 */
export function scopesDescribed(scopes: readonly string[]): boolean {
  return scopes.every((scope) => DESCRIBED_SCOPES.has(scope));
}

/**
 * Characters that can hide or reorder what a name appears to say: controls,
 * zero-width characters, bidi overrides and isolates, invisible fillers and
 * variation selectors.
 */
// Each code point is listed to be removed on its own, so no class member is meant to combine with the next.
// eslint-disable-next-line no-control-regex, no-misleading-character-class -- controls and fillers are exactly what this strips
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;

/**
 * Untrusted text (an app's self-declared name, the host it named) as it may
 * be shown: invisible and reordering characters removed, whitespace runs
 * collapsed, at most `max` characters (an ellipsis marks a cut), and
 * `fallback` if nothing is left. React escapes the rest.
 */
export function displayText(raw: string, max: number, fallback: string): string {
  const cleaned = raw.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(cleaned);
  if (chars.length === 0) return fallback;
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : cleaned;
}
