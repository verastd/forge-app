/**
 * Sign-in settings, read from the environment at call time rather than at
 * module load, so one build serves whatever each server is configured with.
 *
 * Edge-safe on purpose: the middleware imports this module, so it may import
 * nothing but `@forge/auth` (no `@forge/flags`, no `node:` built-ins).
 */
import { MIN_SECRET_LENGTH, resolveSessionKeys } from '@forge/auth';
import type { SessionKeys } from '@forge/auth';

/** Production picks the `__Host-` cookies and `Secure`. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

function strong(secret: string | undefined): string | null {
  return secret !== undefined && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

// On globalThis, not in a module variable: `next dev` re-evaluates modules as
// it recompiles, and the warning is meant once per process, not per request.
// (The Edge middleware's sandbox has its own global, so it may say it once too.)
const WARNED_SHORT_SECRET = Symbol.for('forge.auth.warnedShortSessionSecret');

/**
 * The keys this server seals and opens sessions with, or null when nobody can
 * sign in. The rules live in `resolveSessionKeys`: only `next dev` with
 * FORGE_SESSION_SECRET unset falls back to the public dev secret, and those
 * keys are practice-only.
 */
export function sessionKeys(): SessionKeys | null {
  const keys = resolveSessionKeys({
    secret: process.env.FORGE_SESSION_SECRET,
    previous: process.env.FORGE_SESSION_SECRET_PREVIOUS,
    development: isDevelopment(),
  });
  if (typeof keys !== 'string') return keys;
  const processState = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (keys === 'too_short' && !processState[WARNED_SHORT_SECRET]) {
    processState[WARNED_SHORT_SECRET] = true;
    console.warn(`FORGE_SESSION_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters; sign-in is disabled`);
  }
  return null;
}

/**
 * FORGE_PUBLIC_ORIGIN in canonical form (`https://forge.example`), or null
 * unless it is an http(s) URL with no path, query, fragment or credentials.
 * The OAuth redirect_uri, the callback's final redirect and the Origin checks
 * all use it, never the request's Host header.
 */
export function publicOrigin(): string | null {
  const raw = process.env.FORGE_PUBLIC_ORIGIN;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const http = url.protocol === 'https:' || url.protocol === 'http:';
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  return http && bare ? url.origin : null;
}

/**
 * Whether a state-changing request's `Origin` header is our own. Only a
 * development server with FORGE_PUBLIC_ORIGIN unset falls back to the
 * request's own origin; a set but invalid value refuses everything.
 */
export function isTrustedOrigin(origin: string | null, requestOrigin: string): boolean {
  const unset = !process.env.FORGE_PUBLIC_ORIGIN;
  const expected = unset && isDevelopment() ? requestOrigin : publicOrigin();
  return origin !== null && expected !== null && origin === expected;
}

export interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
  origin: string;
}

/** Everything the GitHub round trip needs, or null if any piece is missing. */
export function githubAppConfig(): GitHubAppConfig | null {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const origin = publicOrigin();
  if (!clientId || !clientSecret || origin === null) return null;
  return { clientId, clientSecret, origin };
}

/**
 * FORGE_API_ASSERTION_SECRET exactly as stored (the API does not trim it
 * either), or null if too short.
 */
export function apiAssertionSecret(): string | null {
  return strong(process.env.FORGE_API_ASSERTION_SECRET);
}

/**
 * Where the BFF forwards to. A server-side setting first, since the API may
 * sit on a private address the browser never sees.
 */
export function apiUrl(): string {
  const base = process.env.FORGE_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
  return base.replace(/\/+$/, '');
}
