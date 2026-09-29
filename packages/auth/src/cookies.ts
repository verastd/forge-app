/**
 * Names, attributes and lifetimes of the two cookies sign-in sets. The sealed
 * tokens take their `exp` from the same constants as the cookies' Max-Age, so
 * a cookie never outlives the token inside it, or the other way round.
 */

/** Absolute session lifetime: 7 days, never extended by activity. */
export const SESSION_TTL_SECONDS = 604_800;

/** One sign-in attempt, from the redirect to GitHub until the callback. */
export const TRANSACTION_TTL_SECONDS = 600;

export const COOKIE = {
  // `__Host-` pins a cookie to this exact origin (Secure, Path=/, no Domain),
  // so neither a sibling subdomain nor an HTTP man-in-the-middle can plant
  // one. Browsers refuse it without HTTPS, hence the plain names in dev.
  session: (prod: boolean): string => (prod ? '__Host-forge_session' : 'forge_session'),
  // A planted transaction cookie would finish the planter's own sign-in in
  // the victim's browser (login CSRF), so it needs the prefix just as much.
  transaction: (prod: boolean): string => (prod ? '__Host-forge_oauth' : 'forge_oauth'),
} as const;

export type CookieKind = 'session' | 'transaction';

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  /** Always `/`: `__Host-` requires it. */
  path: '/';
  secure: boolean;
  maxAge: number;
}

/**
 * Attributes for `kind`, in the shape Next's `cookies().set()` takes. Each call
 * returns a fresh object, so callers may spread or override it (for example
 * `maxAge: 0` to clear the cookie).
 *
 * SameSite=Lax, not Strict: GitHub's redirect back to /auth/callback is a
 * cross-site top-level navigation, and it must carry the transaction cookie.
 */
export function cookieOptions(kind: CookieKind, prod: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: prod,
    maxAge: kind === 'transaction' ? TRANSACTION_TTL_SECONDS : SESSION_TTL_SECONDS,
  };
}
