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
 */
export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_FORGE_DEMO === '1';
}
