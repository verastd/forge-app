/**
 * One clock for every countdown on a page (review-pages L4): a single
 * one-second interval, running only while something listens, instead of one
 * per card. A floor of hundreds of cards costs one timer, and a card with
 * nothing to count down doesn't listen at all. The time is the server's
 * (`./server-clock`), so every countdown agrees with the API's deadlines.
 *
 * Shaped for React's `useSyncExternalStore` (`subscribeTicker`, `tickerNow`),
 * and free of React so it can be tested on its own.
 */
import { serverNow } from './server-clock';

export const TICK_MS = 1000;

type Listener = () => void;

const listeners = new Set<Listener>();
let interval: ReturnType<typeof setInterval> | null = null;
let current = 0;

function tick(): void {
  current = serverNow();
  for (const listener of listeners) listener();
}

/** Listen to the ticks. The interval starts with the first listener and stops with the last. */
export function subscribeTicker(listener: Listener): () => void {
  listeners.add(listener);
  if (interval === null) {
    current = serverNow();
    interval = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

/**
 * The time of the latest tick. With nothing listening there are no ticks, so
 * it is read afresh, but at most once a second: two reads in a row give the
 * same value, as `useSyncExternalStore` requires.
 */
export function tickerNow(): number {
  if (interval === null) {
    const fresh = serverNow();
    if (fresh - current >= TICK_MS || fresh < current) current = fresh;
  }
  return current;
}

/** How many listeners, and whether the interval runs: for tests. */
export function tickerState(): { listeners: number; running: boolean } {
  return { listeners: listeners.size, running: interval !== null };
}
