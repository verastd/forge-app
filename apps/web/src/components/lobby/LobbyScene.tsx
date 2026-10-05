'use client';

/**
 * The 3D view's React host. Lobby.tsx loads it with `next/dynamic` and
 * `ssr: false`, so three.js and the scene ship in their own chunk and only
 * /apps ever downloads them.
 *
 * Each mount makes its own canvas and gives it to `createCave`, and each
 * unmount disposes the scene and throws the canvas away: a canvas whose
 * WebGL context was released can never get another, and React's development
 * double mount would otherwise hand the second scene a dead one. A throw
 * while building reaches Lobby's error boundary; a throw in a later frame
 * arrives through `onError`.
 *
 * The camera is saved when a panel opens (Lobby does that), when this view
 * unmounts, and when the page is hidden, so "← Lobby" returns to it.
 */

import { APPS } from '@forge/lobby';
import type { CameraState } from '@forge/lobby';
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import styles from './Lobby.module.css';
import type { PresenceFeed } from './presence/types';
import { createCave } from './scene/createCave';
import type { Cave, CaveHud } from './scene/createCave';
import type { Hit } from './scene/controls';

/** Everything the scene tells the shell. */
export interface SceneEvents {
  onReady(): void;
  onLost(): void;
  onError(error: unknown): void;
  onPick(hit: Hit, pose: CameraState): void;
  onFocus(focus: string): void;
  onPeers(count: number): void;
  /** The view is going away (unmount or page hide): the camera, for saving. */
  onLeave(pose: CameraState): void;
}

export interface LobbySceneProps {
  initial: CameraState;
  reducedMotion: boolean;
  /** Draw people as robot avatars (the `lobby_avatars` flag), not orbs. Read once at mount. */
  avatars: boolean;
  feed: RefObject<PresenceFeed | null>;
  /** The shell's HUD elements, read once when the scene mounts. */
  hud(): Omit<CaveHud, 'people'> | null;
  events: SceneEvents;
}

const cls = (name: string): string => styles[name] ?? '';
const PEER_CLASSES = {
  peer: cls('peer'),
  tag: cls('tag'),
  talking: cls('talking'),
};

export default function LobbyScene({ initial, reducedMotion, avatars, feed, hud, events }: LobbySceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const peopleRef = useRef<HTMLDivElement>(null);
  const caveRef = useRef<Cave | null>(null);
  const eventsRef = useRef(events);
  const motionRef = useRef(reducedMotion);

  useEffect(() => {
    eventsRef.current = events;
  });

  useEffect(() => {
    motionRef.current = reducedMotion;
    caveRef.current?.setState({ reducedMotion });
  }, [reducedMotion]);

  useEffect(() => {
    const host = hostRef.current;
    const people = peopleRef.current;
    const elements = hud();
    if (!host || !people || !elements) {
      return undefined;
    }
    const canvas = document.createElement('canvas');
    canvas.className = cls('canvas');
    host.prepend(canvas);

    let cave: Cave;
    try {
      cave = createCave(canvas, {
        apps: APPS,
        initial,
        reducedMotion: motionRef.current,
        avatars,
        feed: () => feed.current,
        hud: { ...elements, people },
        classes: PEER_CLASSES,
        onReady: () => eventsRef.current.onReady(),
        onLost: () => eventsRef.current.onLost(),
        onError: (error) => eventsRef.current.onError(error),
        onPick: (hit, pose) => eventsRef.current.onPick(hit, pose),
        onFocus: (focus) => eventsRef.current.onFocus(focus),
        onPeers: (count) => eventsRef.current.onPeers(count),
      });
    } catch (error) {
      canvas.remove();
      throw error;
    }
    caveRef.current = cave;

    const onPageHide = (): void => eventsRef.current.onLeave(cave.pose());
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      eventsRef.current.onLeave(cave.pose());
      caveRef.current = null;
      cave.dispose();
      canvas.remove();
    };
    // Built once per mount: `initial` is the spawn point, and everything
    // else is read through refs so a re-render never rebuilds the cave.
  }, []);

  return (
    <div ref={hostRef} className={styles.stage}>
      <div ref={peopleRef} className={styles.people} aria-hidden="true" />
    </div>
  );
}
