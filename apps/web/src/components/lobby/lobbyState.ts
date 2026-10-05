'use client';

/**
 * The lobby's state, for the chrome around it. Lobby.tsx publishes it (the
 * same value as its root's `data-lobby-state`) and takes it back to 'none'
 * when it unmounts; SiteChrome's lobby nav (LobbyNav.tsx) reads it, so the
 * nav can step out of the way once the 3D wall is up, and stay put when the
 * page is a normal page without it.
 */

import { useSyncExternalStore } from 'react';

/** `flat`: the visitor chose the 2D lobby (`?view=2d`). */
export type LobbyState = 'loading' | 'ready' | 'unsupported' | 'lost' | 'off' | 'flat';

/** 'none' while no lobby is mounted. */
export type PublishedLobbyState = LobbyState | 'none';

let current: PublishedLobbyState = 'none';
const listeners = new Set<() => void>();

export function publishLobbyState(next: PublishedLobbyState): void {
  if (next === current) {
    return;
  }
  current = next;
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

function getSnapshot(): PublishedLobbyState {
  return current;
}

/** 'none' on the server, so the first client render matches the markup. */
function getServerSnapshot(): PublishedLobbyState {
  return 'none';
}

export function useLobbyState(): PublishedLobbyState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** No 3D wall to show: the 2D lobby chosen, the lobby switched off, no WebGL2, or a view that broke. The page is a normal page. */
export function isFallback(state: PublishedLobbyState): boolean {
  return state === 'flat' || state === 'off' || state === 'unsupported' || state === 'lost';
}
