/**
 * Server time, for the Propose countdowns and the reads timed to a deadline
 * (review-pages L5). A visitor's clock can be minutes out, and the API's
 * deadlines are on the server's clock: a countdown run on the visitor's clock
 * says "Debate ends in 1m 57s" after the API has closed debate.
 *
 * Every answer that carries a readable `Date` header pins down the offset
 * between the two clocks (this origin's BFFs always send one; a cross-origin
 * API answer only when its CORS policy exposes it):
 *
 *     server time when it answered  ∈ [D, D + 1 s)       (Date is whole seconds)
 *     local time when it answered   ∈ [sent, received]
 *     offset = server − local       ∈ [D − received, D + 1 s − sent]
 *
 * Each answer's bracket is intersected with what is known so far, so the
 * estimate tightens; one that doesn't overlap (the visitor's clock was
 * changed) starts again from itself. The offset used is the point of the
 * bracket closest to zero: a clock that agrees with the server as far as the
 * headers can tell is left alone, so a countdown never jitters by a second.
 */

export interface OffsetBracket {
  /** The smallest offset (server − local, ms) the answers allow. */
  lo: number;
  /** The largest. */
  hi: number;
}

export class ServerClock {
  private bracket: OffsetBracket | null = null;

  /** Take one answer's `Date` header, sent and received at these local times. */
  note(date: string | null | undefined, sentMs: number, receivedMs: number): void {
    if (date === null || date === undefined || !(receivedMs >= sentMs)) return;
    const server = Date.parse(date);
    if (Number.isNaN(server)) return;
    const next: OffsetBracket = { lo: server - receivedMs, hi: server + 1000 - sentMs };
    const known = this.bracket;
    if (known === null) {
      this.bracket = next;
      return;
    }
    const lo = Math.max(known.lo, next.lo);
    const hi = Math.min(known.hi, next.hi);
    this.bracket = lo <= hi ? { lo, hi } : next;
  }

  /** What is known, for tests. */
  known(): OffsetBracket | null {
    return this.bracket;
  }

  /** Server time minus local time, in ms: 0 until an answer says otherwise. */
  offset(): number {
    const known = this.bracket;
    if (known === null) return 0;
    if (known.lo > 0) return known.lo;
    if (known.hi < 0) return known.hi;
    return 0;
  }

  /** The server's time now, as best this page knows it. */
  now(localMs: number = Date.now()): number {
    return localMs + this.offset();
  }
}

/** The page's one server clock. */
export const serverClock = new ServerClock();

/** The server's time now (ms since the epoch). */
export function serverNow(): number {
  return serverClock.now();
}
