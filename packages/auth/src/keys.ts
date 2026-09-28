/**
 * Which secrets a server seals and opens sessions with, and which of the
 * sessions it opens count as signed in. Pure functions of the environment,
 * so the rules are tested here rather than only in a running server:
 *
 * - FORGE_SESSION_SECRET seals, and opens alongside
 *   FORGE_SESSION_SECRET_PREVIOUS while rotating.
 * - Unset or empty, and only under `next dev`: the public DEV_SESSION_SECRET,
 *   which vouches for the practice account and nobody else.
 * - Set but shorter than 32 characters: no keys at all, never the fallback.
 * - A practice session counts only in a build that offers practice sign-in.
 */
import { isStrongSecret, openSession } from './session.js';
import type { SessionClaims, SessionInput, TimeOptions } from './session.js';

/**
 * What `next dev` seals with when FORGE_SESSION_SECRET is unset, so a fresh
 * checkout can use the practice account. It is public (it is right here), so
 * anyone can seal any cookie under it: it may only ever carry the practice
 * account, and nothing sealed under it may reach the API.
 */
export const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-change-me';

export interface SessionKeyEnv {
  /** FORGE_SESSION_SECRET, exactly as the environment holds it. */
  secret: string | undefined;
  /** FORGE_SESSION_SECRET_PREVIOUS, set only while rotating. */
  previous: string | undefined;
  /** Whether this is `next dev` (NODE_ENV=development). */
  development: boolean;
}

export interface SessionKeys {
  /** Seals new sessions and sign-in attempts. */
  seal: string;
  /** Opens them, current first. */
  open: readonly string[];
  /**
   * The keys are the public DEV_SESSION_SECRET: they seal and accept the
   * practice account only, and the web must never mint an API assertion.
   */
  practiceOnly: boolean;
}

/** Why a server has no keys: FORGE_SESSION_SECRET is missing, or set but too short. */
export type NoSessionKeys = 'unset' | 'too_short';

function practiceKeys(): SessionKeys {
  return { seal: DEV_SESSION_SECRET, open: [DEV_SESSION_SECRET], practiceOnly: true };
}

/**
 * The keys a server with this environment has, or why it has none.
 *
 * The public dev secret never sits beside a real one: set on purpose as
 * FORGE_SESSION_SECRET it gives practice-only keys, exactly like the
 * fallback, and as FORGE_SESSION_SECRET_PREVIOUS it is dropped. Without a
 * usable current secret the previous one is ignored too, so a leftover
 * cannot keep anybody signed in.
 */
export function resolveSessionKeys({ secret, previous, development }: SessionKeyEnv): SessionKeys | NoSessionKeys {
  if (secret === undefined || secret === '') return development ? practiceKeys() : 'unset';
  // A typo'd or truncated secret is a mistake to surface, not a reason to fall back.
  if (!isStrongSecret(secret)) return 'too_short';
  if (secret === DEV_SESSION_SECRET) return practiceKeys();
  const open = isStrongSecret(previous) && previous !== DEV_SESSION_SECRET ? [secret, previous] : [secret];
  return { seal: secret, open, practiceOnly: false };
}

export interface AcceptOptions extends TimeOptions {
  /** Whether this build offers practice sign-in (the web's `isDemoMode()`). */
  demoBuild: boolean;
}

/**
 * Whether a server with `keys` may seal a session of this kind, or count one
 * as signed in: the practice account only in a build that offers practice
 * sign-in, and a real identity only under keys that are not public.
 */
export function sessionAllowed(
  session: Pick<SessionInput, 'demo'>,
  keys: SessionKeys,
  { demoBuild }: Pick<AcceptOptions, 'demoBuild'>,
): boolean {
  return session.demo ? demoBuild : !keys.practiceOnly;
}

/**
 * The session in `token` if a server with `keys` counts it as signed in, else
 * null: `openSession` under `keys.open`, then `sessionAllowed`. Never throws.
 */
export async function acceptSession(
  token: string | null | undefined,
  keys: SessionKeys,
  options: AcceptOptions,
): Promise<SessionClaims | null> {
  const claims = await openSession(token, keys.open, options);
  return claims !== null && sessionAllowed(claims, keys, options) ? claims : null;
}
