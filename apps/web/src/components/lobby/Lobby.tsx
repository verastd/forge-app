'use client';

/**
 * The Apps lobby's shell: everything around the 3D view.
 *
 * - The `apps_lobby` flag. While it loads there is no canvas; switched off,
 *   the page is its heading and directory plus one line saying so.
 * - A WebGL2 probe on a throwaway canvas before the scene mounts. Without
 *   WebGL2 the directory still works and the page says the view can't show.
 * - The scene itself (LobbyScene, loaded on the client only), inside an
 *   error boundary. A lost WebGL context, a throw while building or a throw
 *   in a frame all end in the same "Reload to try again" state.
 * - The page's heading and directory. While the 3D wall is the page (from
 *   the server's first render, through loading, to the wall on screen) both
 *   are out of sight but still in the page for screen readers; the
 *   directory shows while a keyboard user is in it. Without the wall
 *   (switched off, no WebGL2, or a view that broke) they are the page.
 * - Presence: one feed per visit, connected on mount and closed on unmount.
 *   The scene publishes to it and draws its peers every frame; the people
 *   HUD (VoicePanel) shows its voice snapshot and is the only other thing
 *   that talks to it: the mic, deafen, per-person mute, "Turn on sound",
 *   "Try again" after a join that failed in this browser, and "Rejoin here"
 *   after the lobby was opened in another tab or device.
 * - `?view=2d`, the 2D lobby: the heading and the app tiles, no cave and no
 *   voice, linked from under the Enter gate's button for anyone who'd
 *   rather not go in.
 * - The Enter gate, over the view while it builds: who's here and one Enter
 *   button. That press is the browser's gesture for sound, so the room is
 *   heard from the first step, and it asks for the mic. Pressed before the
 *   view is up, it says it is entering until it is. Once per page load:
 *   coming back from an app goes straight in.
 * - The cave is its own experience: a tap on a lit panel saves the camera and
 *   opens the app; a tap on an empty slot stays in the cave and only says so
 *   (the toast). Exit, top left whenever the wall is the page, is the other
 *   way out: home, to `/`, which unmounts all of this, the presence and
 *   voice feed with it, as any navigation does. Any visit to /apps starts
 *   from the camera this tab saved, if it saved one; otherwise at the
 *   centre, facing the app named by `?from=<slug>`. Coming back from an app
 *   (`?from=<slug>`) to the page without its wall puts keyboard focus on
 *   that app's directory link; with the wall, SiteChrome's arrival focus on
 *   the page's h1 stands (see ArrivalFocus).
 * - The toast, the touch stick and the lift buttons, as in the prototype,
 *   and Exit. No hint line: the cave is left clear.
 * - A join that failed in this browser tries once more by itself, once the
 *   scene is up (a slow phone may simply have been busy building it).
 *
 * The root carries `data-lobby` and the state attributes e2e reads:
 * `data-lobby-state`, `data-gate` (open, entering or gone, while the view
 * is the page), `data-focus`, `data-motion`, `data-peers`,
 * `data-voice` (unavailable, off or on), `data-feed`, `data-sound`
 * (blocked, on, or none without voice), `data-room-sound` and
 * `data-deafened` here, and `data-x/y/z/yaw/pitch`, which the scene writes
 * itself ten times a second.
 */

import { useFlags } from '@forge/flags/react';
import {
  CAMERA_STORAGE_ITEM,
  CAMERA_VIEW_STORAGE_ITEM,
  INITIAL_CAMERA,
  appBySlug,
  facing,
  nextCameraView,
  parseCameraState,
  parseCameraView,
  serializeCameraState,
  slotIndex,
} from '@forge/lobby';
import type { CameraState, CameraView } from '@forge/lobby';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Component, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, RefObject } from 'react';

import { demoFlagFallback } from '../../lib/flags';
import { isDemoMode } from '../../lib/mode';
import { useSession } from '../SessionProvider';
import styles from './Lobby.module.css';
import type { LobbySceneProps, SceneEvents } from './LobbyScene';
import { isFallback, publishLobbyState } from './lobbyState';
import type { LobbyState } from './lobbyState';
import { createPresenceFeed } from './presence/types';
import type { PresenceFeed } from './presence/types';
import type { Hit } from './scene/controls';
import type { SelfRobotState } from './scene/peers';
import { ViewToggle } from './ViewToggle';
import { PlayControls } from './PlayControls';
import type { PlayState } from './scene/play';
import { PeopleIcon, Spinner } from './icons';
import { VoicePanel, roomCount, useFeedState, useFeedSummary, wantMicOnEntry } from './VoicePanel';

const LobbyScene = dynamic(() => import('./LobbyScene'), { ssr: false });

const MESSAGES: Partial<Record<LobbyState, string>> = {
  off: 'The 3D lobby is switched off right now.',
  unsupported: "This browser can't show the 3D lobby.",
  lost: 'The 3D view stopped. Reload to try again.',
};

const TOAST_MS = 1800;
/** What the toast calls each view. */
const VIEW_NAMES: Record<CameraView, string> = { first: 'First person', third: 'Third person', front: 'Front view' };

/**
 * For a browser that runs no script (inside `<noscript>`): the heading and
 * the directory back in sight, undoing `.aside` and `.directoryAside`.
 */
const NO_SCRIPT_SHOWS_THE_PAGE =
  "[data-lobby] [data-heading='aside'], [data-lobby] [data-directory='aside'] {" +
  ' position: static !important; width: auto !important; height: auto !important;' +
  ' margin: 0 !important; overflow: visible !important; clip: auto !important;' +
  ' clip-path: none !important; white-space: normal !important; }';

const cx =(...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

// ---------- reduced motion, as a store ----------

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeMotion(onChange: () => void): () => void {
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const reducedMotionNow = (): boolean => window.matchMedia(MOTION_QUERY).matches;
/** Full motion on the server, so the first client render matches the markup. */
const reducedMotionOnServer = (): boolean => false;

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, reducedMotionNow, reducedMotionOnServer);
}

// ---------- WebGL2, and the camera in session storage ----------

let webgl2: boolean | null = null;

/**
 * Asks a throwaway canvas for a WebGL2 context, then gives the context
 * straight back. Once per page load: the answer doesn't change, and every
 * probe costs a context.
 */
function supportsWebGL2(): boolean {
  if (webgl2 === null) {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      webgl2 = gl !== null;
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

function readSavedCamera(): CameraState | null {
  try {
    return parseCameraState(window.sessionStorage.getItem(CAMERA_STORAGE_ITEM));
  } catch {
    return null;
  }
}

/** The view this browser last chose (first person when none, or storage is blocked). */
function readSavedView(): CameraView {
  try {
    return parseCameraView(window.localStorage.getItem(CAMERA_VIEW_STORAGE_ITEM)) ?? 'first';
  } catch {
    return 'first';
  }
}

function saveView(view: CameraView): void {
  try {
    window.localStorage.setItem(CAMERA_VIEW_STORAGE_ITEM, view);
  } catch {
    // Storage blocked: the view still holds for this visit.
  }
}

function saveCamera(pose: CameraState): void {
  try {
    window.sessionStorage.setItem(CAMERA_STORAGE_ITEM, serializeCameraState(pose));
  } catch {
    // Storage is off or full: the lobby just opens at the start next time.
  }
}

/**
 * Where the camera starts: where this tab last left the lobby, if it saved a
 * camera (sessionStorage is per tab, so a new tab starts fresh). Otherwise
 * the centre, facing the app named by `?from=<slug>`, or slot 0 for an
 * unknown slug or no `from` at all.
 */
function spawnFor(from: string | null): CameraState {
  const saved = readSavedCamera();
  if (saved !== null) {
    return saved;
  }
  const app = from === null ? undefined : appBySlug(from);
  return app ? { ...INITIAL_CAMERA, yaw: facing(slotIndex(app.slot)) } : INITIAL_CAMERA;
}

// ---------- the scene's mount ----------

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Reads `?from=` once, inside its own Suspense boundary so the rest of the page still prerenders. */
function SceneHost(props: Omit<LobbySceneProps, 'initial'>) {
  const params = useSearchParams();
  const [initial] = useState(() => spawnFor(params.get('from')));
  return <LobbyScene initial={initial} {...props} />;
}

/** Nobody has put keyboard focus anywhere yet: nothing, or the h1 SiteChrome focused on arrival. */
function focusUntouched(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (active instanceof HTMLElement && active.matches('main h1'));
}

/**
 * Back from an app (`?from=<slug>`) to the lobby without its 3D wall
 * (`fallback`: switched off, no WebGL2, or a view that broke): keyboard
 * focus goes to that app's link in the directory, the way in there, so Tab
 * carries on from where the visitor left. The link is marked
 * `data-arrival-focus` too, which SiteChrome's focus-on-arrival prefers to
 * the page's h1. Focus somebody already moved stays where it is.
 *
 * While the wall is the page this does nothing: the directory is out of
 * sight there, and focus moved into it would either reveal it on arrival or
 * leave a sighted keyboard user on something they cannot see. SiteChrome's
 * arrival focus on the page's h1 stands instead. The h1 is out of sight too,
 * but it is the page's heading, not a control: a screen reader announces the
 * page, the camera keys (scene/controls.ts) work from there as from
 * anywhere that isn't a field or a button, and the first Tab goes on into
 * the directory, which shows itself while focus is in it.
 */
function ArrivalFocus({ root, fallback }: { root: RefObject<HTMLDivElement | null>; fallback: boolean }) {
  const from = useSearchParams().get('from');
  useEffect(() => {
    if (!fallback) {
      return undefined;
    }
    const app = from === null ? undefined : appBySlug(from);
    const link = app ? root.current?.querySelector<HTMLElement>(`a[data-slug="${app.slug}"]`) : null;
    if (!link) {
      return undefined;
    }
    link.setAttribute('data-arrival-focus', '');
    if (focusUntouched()) {
      link.focus({ preventScroll: true });
    }
    return () => link.removeAttribute('data-arrival-focus');
  }, [from, root, fallback]);
  return null;
}

/** `?view=2d`, read inside its own Suspense boundary (as `?from=` is) and handed up. */
function ViewParam({ onFlat }: { onFlat(flat: boolean): void }) {
  const flat = useSearchParams().get('view') === '2d';
  useEffect(() => {
    onFlat(flat);
  }, [flat, onFlat]);
  return null;
}

/** The 2D lobby: the same page with no cave, and nothing about voice. */
export const FLAT_LOBBY_HREF = '/apps?view=2d';

// ---------- the Enter gate ----------

/** Entered once in this page load: the browser has had its gesture, so the gate doesn't come back. */
let enteredThisLoad = false;

type GatePhase = 'open' | 'entering' | 'gone';

/**
 * Over the view until you're in: the lobby's name, who's here, and Enter.
 * Pressed before the view is up, the button says it is entering, and the
 * gate fades once the view is there.
 */
function EnterGate({
  feed,
  phase,
  onEnter,
}: {
  feed: PresenceFeed | null;
  phase: GatePhase;
  onEnter(): void;
}) {
  const room = roomCount(useFeedState(feed));
  const entering = phase === 'entering';
  return (
    <div className={cx(styles.gate, phase === 'gone' && styles.gateOff)} data-enter-gate="">
      <div className={styles.gateHead}>
        <span className={styles.gateName}>Apps · the lobby</span>
        <span className={cx(styles.gateWho, room.talking > 0 && styles.lit)}>
          {room.sees ? (
            <>
              <PeopleIcon />
              {`${room.here} here · ${room.talking} talking`}
            </>
          ) : (
            room.finding && (
              <>
                <Spinner />
                Finding who&apos;s here…
              </>
            )
          )}
        </span>
      </div>
      <button
        type="button"
        className={styles.enter}
        aria-busy={entering || undefined}
        aria-disabled={entering || undefined}
        onClick={onEnter}
      >
        {entering ? (
          <>
            <Spinner />
            Entering
          </>
        ) : (
          'Enter'
        )}
      </button>
      <Link href={FLAT_LOBBY_HREF} className={styles.gateFlat}>
        Take me to the 2D lobby instead
      </Link>
    </div>
  );
}

// ---------- the shell ----------

export function Lobby({ heading, directory }: { heading: ReactNode; directory: ReactNode }) {
  const router = useRouter();
  const { session } = useSession();
  const { flags, loading } = useFlags(demoFlagFallback());
  const reducedMotion = useReducedMotion();

  const [webgl, setWebgl] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [broken, setBroken] = useState(false);
  const [ready, setReady] = useState(false);
  const [focus, setFocus] = useState('');
  const [peerCount, setPeerCount] = useState(0);
  const [feed, setFeed] = useState<PresenceFeed | null>(null);
  const [toast, setToast] = useState({ text: '', on: false, id: 0 });
  const [entered, setEntered] = useState(() => enteredThisLoad);
  /** First or third person: this browser's choice, read after mount (the server has no storage). */
  const [view, setView] = useState<CameraView>('first');
  const [self, setSelf] = useState<SelfRobotState>('off');
  const [retrySelf, setRetrySelf] = useState(0);
  /** Catch: where you are in a game, as the scene says; presses go to it by count. */
  const [play, setPlay] = useState<PlayState>({ phase: 'unavailable', other: null, waving: false });
  const [ballPress, setBallPress] = useState(0);
  const [wavePress, setWavePress] = useState(0);
  /** The 2D lobby chosen (`?view=2d`): the 3D view never starts. */
  const [flat, setFlat] = useState(false);

  /** The same feed, for the scene, which reads it every frame. */
  const feedRef = useRef<PresenceFeed | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const riseRef = useRef<HTMLButtonElement>(null);
  const fallRef = useRef<HTMLButtonElement>(null);

  const enabled = !loading && flags.apps_lobby && !flat;
  const live = enabled && webgl === 'yes' && !broken;

  useEffect(() => {
    if (enabled && webgl === 'unknown') {
      setWebgl(supportsWebGL2() ? 'yes' : 'no');
    }
  }, [enabled, webgl]);

  // One presence feed while the 3D view is up.
  const login = session?.login ?? null;
  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const next = createPresenceFeed({ demo: isDemoMode(), me: login === null ? null : { name: login } });
    feedRef.current = next;
    setFeed(next);
    // The feed says what changed (onVoice): the panel and the root's attributes read it as a store.
    void next.connect();
    return () => {
      if (feedRef.current === next) {
        feedRef.current = null;
      }
      next.close();
      setFeed(null);
      setPeerCount(0);
      setFocus('');
    };
  }, [live, login]);

  const presence = useFeedSummary(feed);
  const practice = isDemoMode();

  // A join that failed in this browser (more likely while the scene is still
  // building, on a slow phone) gets one more go by itself, once the scene is
  // up; after that it's the panel's "Try again".
  const retried = useRef<PresenceFeed | null>(null);
  useEffect(() => {
    if (ready && presence.failed && feed !== null && retried.current !== feed) {
      retried.current = feed;
      void feed.connect();
    }
  }, [ready, presence.failed, feed]);

  useEffect(() => {
    if (!toast.on) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToast((current) => ({ ...current, on: false })), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast.on, toast.id]);

  const say = useCallback((text: string) => setToast((current) => ({ text, on: true, id: current.id + 1 })), []);

  useEffect(() => {
    setView(readSavedView());
  }, []);

  const avatars = flags.lobby_avatars;
  /** Third person and front need robots: without them it's always first. */
  const shownView: CameraView = avatars ? view : 'first';
  const chooseView = (next: CameraView): void => {
    if (next !== 'first' && !avatars) {
      say('No third person: robots are off in this lobby');
      return;
    }
    setView(next);
    saveView(next);
    say(`${VIEW_NAMES[next]} · V to switch`);
  };

  // The chrome around the lobby (SiteChrome's lobby nav) follows its state.
  useEffect(() => () => publishLobbyState('none'), []);

  /** The cave is its own experience: nothing in it leaves but a lit app and Exit. */
  const open = (hit: Hit, pose: CameraState): void => {
    if (!hit.lit) {
      say('Empty slot');
      return;
    }
    const app = appBySlug(hit.slug);
    if (!app) {
      return;
    }
    saveCamera(pose);
    say(`Opening ${app.title}`);
    router.push(app.route);
  };

  const events: SceneEvents = {
    onReady: () => setReady(true),
    onLost: () => setBroken(true),
    onError: () => setBroken(true),
    onPick: open,
    onFocus: setFocus,
    onPeers: setPeerCount,
    onLeave: saveCamera,
    onToggleView: () => chooseView(nextCameraView(shownView)),
    onSelf: setSelf,
    onPlay: setPlay,
    onPlayEvent: say,
  };

  const hud = useCallback(() => {
    const root = rootRef.current;
    if (!root) {
      return null;
    }
    return {
      root,
      mic: micRef.current,
      stick: stickRef.current,
      knob: knobRef.current,
      rise: riseRef.current,
      fall: fallRef.current,
    };
  }, []);

  /**
   * Joins again: "Rejoin here" (the room keeps one seat per member, so this
   * takes it back from the other tab), "Rejoin" and "Try again".
   */
  const rejoin = (): Promise<void> | void => feedRef.current?.connect();

  /** The gate's Enter: inside the press, let the browser play sound, and ask for the mic once voice is up. */
  const enter = (): void => {
    if (entered) {
      return;
    }
    enteredThisLoad = true;
    setEntered(true);
    wantMicOnEntry();
    void feedRef.current?.resumeAudio();
  };

  const state: LobbyState = flat
    ? 'flat'
    : loading
      ? 'loading'
      : !flags.apps_lobby
        ? 'off'
        : webgl === 'no'
          ? 'unsupported'
          : broken
            ? 'lost'
            : ready && webgl === 'yes'
              ? 'ready'
              : 'loading';
  useEffect(() => {
    publishLobbyState(state);
  }, [state]);
  const message = MESSAGES[state];
  /** No wall to show: the heading, the message and the directory are the page. */
  const fallback = isFallback(state);
  const gate: GatePhase = !entered ? 'open' : ready ? 'gone' : 'entering';

  // Into the 2D lobby from the gate's link: focus to the page's h1, now the page, not left on the link that went.
  useEffect(() => {
    const h1 = rootRef.current?.querySelector<HTMLElement>('h1');
    if (state !== 'flat' || !h1 || !focusUntouched()) {
      return;
    }
    if (!h1.hasAttribute('tabindex')) {
      h1.setAttribute('tabindex', '-1');
    }
    h1.focus({ preventScroll: true });
  }, [state]);

  // The gate going with focus on its button (a keyboard press of Enter):
  // focus to the page's h1, as on any arrival, not left on something gone.
  useEffect(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    if (gate !== 'gone' || root === null || !(active instanceof HTMLElement) || active.closest('[data-enter-gate]') === null) {
      return;
    }
    const h1 = root.querySelector<HTMLElement>('h1');
    if (h1 !== null) {
      if (!h1.hasAttribute('tabindex')) {
        h1.setAttribute('tabindex', '-1');
      }
      h1.focus({ preventScroll: true });
    }
  }, [gate]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-lobby=""
      data-lobby-state={state}
      data-gate={live ? gate : undefined}
      data-focus={live ? focus : ''}
      data-motion={reducedMotion ? 'reduced' : 'full'}
      data-peers={String(live ? peerCount : 0)}
      data-voice={presence.voice}
      data-feed={presence.feed}
      data-sound={presence.sound}
      data-room-sound={presence.roomSound}
      data-deafened={String(presence.deafened)}
    >
      {live && (
        <SceneBoundary onError={() => setBroken(true)}>
          <Suspense fallback={null}>
            <SceneHost
              reducedMotion={reducedMotion}
              avatars={avatars}
              view={shownView}
              selfName={login ?? ''}
              retrySelf={retrySelf}
              ballPress={ballPress}
              wavePress={wavePress}
              feed={feedRef}
              hud={hud}
              events={events}
            />
          </Suspense>
        </SceneBoundary>
      )}
      {live && <EnterGate feed={feed} phase={gate} onEnter={enter} />}
      <Suspense fallback={null}>
        <ViewParam onFlat={setFlat} />
      </Suspense>

      <Suspense fallback={null}>
        <ArrivalFocus root={rootRef} fallback={fallback} />
      </Suspense>

      <div className={cx(styles.overlay, fallback && styles.page)}>
        <div className={styles.intro}>
          {/* The way out of the cave, while the wall is the page: home. Without the
              wall the page is a normal page, with the site nav, so it has none. */}
          {!fallback && (
            <Link href="/" className={styles.exit} aria-label="Exit the cave">
              Exit
            </Link>
          )}
          {/* While the wall is the page, from the server's first render on, the wall is
              the heading and the directory: both step out of sight but stay in the page
              for screen readers (the h1 is still the page's heading), and the directory
              shows again while a keyboard user is in it. Without the wall they are the
              page, so they show. */}
          <div className={cx(!fallback && styles.aside)} data-heading={fallback ? 'shown' : 'aside'}>
            {heading}
          </div>
          {message && (
            <p className={styles.message} role="status">
              {message}
            </p>
          )}
          <div className={cx(!fallback && styles.directoryAside)} data-directory={fallback ? 'shown' : 'aside'}>
            {directory}
          </div>
          {/* A browser that runs no script never gets the wall, and the state stays at
              the server's 'loading': there the heading and the directory are the page,
              so this undoes their hiding. Only such a browser reads it, so a visitor
              with scripts never sees them come and go while the wall loads. */}
          <noscript>
            <style>{NO_SCRIPT_SHOWS_THE_PAGE}</style>
          </noscript>
          {/* After the heading and the directory in the page's order (out of sight in the cave), so Exit
              stays the stop just before the h1; on screen they sit right under Exit. */}
          {!fallback && live && (
            <ViewToggle
              view={shownView}
              avatars={avatars}
              self={self}
              onChange={chooseView}
              onRetry={() => setRetrySelf((n) => n + 1)}
            />
          )}
          {!fallback && live && avatars && (
            <PlayControls state={play} onBall={() => setBallPress((n) => n + 1)} onWave={() => setWavePress((n) => n + 1)} />
          )}
        </div>
        {live && <VoicePanel feed={feed} micRef={micRef} practice={practice} onRejoin={rejoin} />}
      </div>

      {live && (
        <>
          <div ref={stickRef} className={styles.stick} aria-hidden="true">
            <div ref={knobRef} />
          </div>
          <div className={styles.lift}>
            <button ref={riseRef} type="button" aria-label="Rise">
              ▲
            </button>
            <button ref={fallRef} type="button" aria-label="Fall">
              ▼
            </button>
          </div>
        </>
      )}
      <div className={cx(styles.toast, toast.on && styles.on)} role="status" aria-live="polite">
        {toast.text}
      </div>
    </div>
  );
}
