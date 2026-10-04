/**
 * Which answer a page may show (review-pages L2). A page reads a proposal
 * on a timer, when the tab comes back and after a deadline, while the member
 * may be writing to it: a read that left before a write and lands after it
 * would put the old state back, Second button and all, and announce a change
 * that never happened.
 *
 * So every read takes a ticket when it leaves. Its answer is shown only if
 * nothing newer is on screen, no write is in flight, and no write started or
 * finished since the read left (it may describe the proposal before that
 * write). A write's own answer is always the newest thing there is.
 */
export class Freshness {
  private counter = 0;
  private shown = 0;
  private barrier = 0;
  private writing = 0;

  /** A read is leaving: its ticket. */
  read(): number {
    this.counter += 1;
    return this.counter;
  }

  /** May the read with `ticket` be shown? If so, it is now what's on screen. */
  accept(ticket: number): boolean {
    if (this.writing > 0 || ticket < this.barrier || ticket <= this.shown) return false;
    this.shown = ticket;
    return true;
  }

  /** A write is leaving: every read already out is stale from now on. */
  writeStarted(): void {
    this.writing += 1;
    this.counter += 1;
    this.barrier = this.counter;
  }

  /**
   * A write is over (answered or not). Reads that left while it was out are
   * stale too. Returns the ticket its answer is shown under, with {@link acceptWrite}.
   */
  writeEnded(): number {
    this.writing = Math.max(0, this.writing - 1);
    this.counter += 1;
    this.barrier = this.counter;
    return this.counter;
  }

  /** Show a write's answer (`writeEnded`'s ticket), unless something newer is on screen already. */
  acceptWrite(ticket: number): boolean {
    if (ticket <= this.shown) return false;
    this.shown = ticket;
    return true;
  }
}
