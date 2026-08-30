'use client';

/**
 * A one-bit global: is anything on screen coming from local demo data?
 *
 * `src/lib/api.ts` flips this the first time a fetcher falls back, and the nav
 * shows a small pill so nobody mistakes the parachute for the product. Only the
 * demo app can reach that path — the live one has no fallbacks to flip it — so
 * this stays false for everybody we ship to.
 */

import { useSyncExternalStore } from 'react';

let degraded = false;
const listeners = new Set<() => void>();

export function markDegraded(): void {
  if (degraded) {
    return;
  }
  degraded = true;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return degraded;
}

/** Always false on the server, so the first client render matches the markup. */
function getServerSnapshot(): boolean {
  return false;
}

export function useDegraded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
