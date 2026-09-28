/**
 * The e2e test secrets, and the demo server's API port, defined in exactly
 * one place.
 *
 * `playwright.config.ts` puts these in both dev servers' env, and
 * `helpers/session.ts` seals cookies with the same values — importing from
 * here rather than each hard-coding its own copy is what keeps them from
 * drifting apart. Obviously-fake and >= 32 ASCII characters (`@forge/auth`'s
 * `MIN_SECRET_LENGTH`); never used outside a local Playwright run.
 */
export const SESSION_SECRET = 'e2e-only-session-secret-not-for-production-use';
export const ASSERTION_SECRET = 'e2e-only-assertion-secret-not-for-production';

/**
 * Where the demo server's BFF forwards (`FORGE_API_URL`). Closed, so every
 * forward fails fast with a 502, except while the BFF header test in
 * `auth.spec.ts` stands a hostile stand-in API up on it.
 */
export const DEMO_API_PORT = 3190;
