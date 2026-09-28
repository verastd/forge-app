/**
 * Demo mode is opt-in, explicit, and read in exactly one place.
 *
 * `NEXT_PUBLIC_FORGE_DEMO=1` builds the practice app: when the FORGE service is
 * unreachable, reads fall back to local fixtures and writes are simulated, all
 * of it labelled on screen. Any other value is live, where nothing is ever
 * substituted — a read that fails shows an error and a write that fails changes
 * nothing (PRD §4.9: the Bridge is a client, never a pretence).
 *
 * No other module may read this variable: the whole point is that one predicate
 * decides which app the contributor is looking at.
 *
 * It also decides whether the practice account can sign in at all: a live
 * build refuses practice sessions (`lib/auth/visitor.ts`). So the value is
 * fixed at build time (`env` in next.config.mjs inlines it, even when unset),
 * never read at runtime, and this stays Edge-safe for the middleware.
 */
export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_FORGE_DEMO === '1';
}
