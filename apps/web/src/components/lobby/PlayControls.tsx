'use client';

/**
 * Catch and waving, under the View control: a ball (F) and a wave (G).
 *
 * Every state says itself, on the button and on the line under it:
 * - no ball: "Get a ball";
 * - holding one: "Throw to <name>" (whoever is ahead) or "Throw" (at nobody,
 *   to bounce off the floor and come back);
 * - winding up, and while it's in the air: a spinner, the button held;
 * - one coming at you: "Incoming!", the button held, the line saying from whom;
 * - waving: the wave's `requested` copy, the button held until the wave is done;
 * - not in a room yet (or it's gone): both held, and the line says why.
 *
 * And under those, the latest throw or wave in its catalog state (ADR-009,
 * `BEHAVIORS[...].states`), from the press to the outcome: `requested` with a
 * spinner, then `confirmed` or `rejected` within the entry's `confirmWithinMs`,
 * or `outOfRange` at once when nobody is there to see it. The copy is the
 * catalog's, never this file's. `useBehaviorState` works out which state it
 * is in (from the presses, the sends `watchSends` sees and the catcher's
 * word); the lobby root reports it as `data-behavior-state` and the people
 * panel announces a rejection.
 */

import { behaviorById } from '@forge/lobby';
import type { BehaviorEntry, BehaviorStateName, LobbyAction } from '@forge/lobby';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import styles from './Lobby.module.css';
import type { PresenceFeed } from './presence/types';
import type { PlayState } from './scene/play';
import { Spinner } from './icons';

function entry(id: string): BehaviorEntry {
  const found = behaviorById(id);
  if (found === null) {
    throw new Error(`No behaviour ${id} in the catalog`);
  }
  return found;
}

const WAVE = entry('wave');
const CATCH = entry('catch-and-throw');

/** The latest behaviour pressed, and the state it is in. `seq` counts every change, so the same state twice is still news. */
export interface BehaviorShown {
  entry: BehaviorEntry;
  state: BehaviorStateName;
  seq: number;
}

export interface BehaviorTracker {
  shown: BehaviorShown | null;
  /** The ball button, pressed (before the scene hears it). */
  pressBall(): void;
  /** The wave button, pressed (before the scene hears it). */
  pressWave(): void;
  /** An action the scene sent on the feed, and whether it went (watchSends). Stable across renders. */
  sent(action: LobbyAction, went: boolean): void;
}

/** `<kind>:<state>` for the lobby root's `data-behavior-state`. */
export function behaviorStateAttr(shown: BehaviorShown | null): string | undefined {
  return shown === null ? undefined : `${shown.entry.id}:${shown.state}`;
}

/**
 * The feed as the scene gets it: the same feed, saying each action sent on it
 * and whether it went, so a throw or wave from F or G is seen as well as one
 * from a button, and a send that failed is a rejection at once.
 */
export function watchSends(feed: PresenceFeed, onSend: (action: LobbyAction, went: boolean) => void): PresenceFeed {
  const watched = Object.create(feed) as PresenceFeed;
  watched.sendAction = (action) => {
    const went = feed.sendAction(action);
    onSend(action, went);
    return went;
  };
  return watched;
}

/**
 * Which state the latest throw or wave is in.
 *
 * A button press shows it at once: `requested`, or `outOfRange` with nobody
 * to see it (no one ahead to throw to, no one in the room to wave at). F and
 * G go straight to the scene, so its sends count as presses too. A send that
 * didn't go is `rejected`. A wave is `confirmed` once it's under way; a throw
 * when the catcher says they caught it, `rejected` when they say they missed.
 * By `confirmWithinMs` a `requested` state always has an outcome: a wave that
 * went out is confirmed (the scene may just not have drawn a frame yet), a
 * throw with no word from the catcher is rejected, though their late word
 * still counts.
 */
export function useBehaviorState(play: PlayState, feed: PresenceFeed | null, others: number): BehaviorTracker {
  const [shown, setShown] = useState<BehaviorShown | null>(null);
  const show = useCallback((next: BehaviorEntry, state: BehaviorStateName) => {
    setShown((current) => ({ entry: next, state, seq: (current?.seq ?? 0) + 1 }));
  }, []);
  /** Moves the latest state on, only if it's still `next` in `from`. */
  const advance = useCallback((next: BehaviorEntry, from: BehaviorStateName, state: BehaviorStateName) => {
    setShown((current) => (current?.entry === next && current.state === from ? { entry: next, state, seq: current.seq + 1 } : current));
  }, []);

  const latest = useRef({ play, others });
  useEffect(() => {
    latest.current = { play, others };
  }, [play, others]);
  /** A button press the scene hasn't sent yet: its state is already showing. */
  const pressed = useRef({ wave: false, ball: false });
  /** The latest wave went out. */
  const waveWent = useRef(false);
  /** A throw that's out and hasn't had the catcher's word yet. */
  const awaitingCatch = useRef(false);

  const pressBall = useCallback(() => {
    const { play: now } = latest.current;
    if (now.phase !== 'holding') return;
    pressed.current.ball = true;
    awaitingCatch.current = false;
    show(CATCH, now.other === null ? 'outOfRange' : 'requested');
  }, [show]);

  const pressWave = useCallback(() => {
    const { play: now, others: count } = latest.current;
    if (now.phase === 'unavailable' || now.waving) return;
    pressed.current.wave = true;
    waveWent.current = false;
    show(WAVE, count === 0 ? 'outOfRange' : 'requested');
  }, [show]);

  const sent = useCallback(
    (action: LobbyAction, went: boolean) => {
      if (action.kind === 'wave') {
        const fromPress = pressed.current.wave;
        pressed.current.wave = false;
        waveWent.current = went;
        if (!went) show(WAVE, 'rejected');
        else if (!fromPress) show(WAVE, latest.current.others === 0 ? 'outOfRange' : 'requested');
      } else if (action.kind === 'throw') {
        const fromPress = pressed.current.ball;
        pressed.current.ball = false;
        awaitingCatch.current = went && action.to !== null;
        const state: BehaviorStateName = !went ? 'rejected' : action.to === null ? 'outOfRange' : 'requested';
        // Pressed: already showing, its window already running, unless whoever's ahead changed during the wind-up.
        setShown((current) =>
          fromPress && current?.entry === CATCH && current.state === state ? current : { entry: CATCH, state, seq: (current?.seq ?? 0) + 1 },
        );
      }
    },
    [show],
  );

  // A wave under way: confirmed.
  const wasWaving = useRef(play.waving);
  useEffect(() => {
    if (!wasWaving.current && play.waving) advance(WAVE, 'requested', 'confirmed');
    wasWaving.current = play.waving;
  }, [play.waving, advance]);

  // The catcher's word on your throw.
  useEffect(() => {
    if (feed === null) return undefined;
    return feed.onAction((_from, action) => {
      if (action.kind !== 'catch' || !awaitingCatch.current || action.thrower !== feed.selfId()) return;
      awaitingCatch.current = false;
      show(CATCH, action.caught ? 'confirmed' : 'rejected');
    });
  }, [feed, show]);

  // By the entry's window, an outcome.
  useEffect(() => {
    if (shown === null || shown.state !== 'requested') return undefined;
    const { entry: pending } = shown;
    const timer = window.setTimeout(() => {
      advance(pending, 'requested', pending === WAVE && waveWent.current ? 'confirmed' : 'rejected');
    }, pending.confirmWithinMs);
    return () => window.clearTimeout(timer);
  }, [shown, advance]);

  return { shown, pressBall, pressWave, sent };
}

export interface PlayControlsProps {
  state: PlayState;
  /** The latest throw or wave and its catalog state (useBehaviorState). */
  behavior: BehaviorShown | null;
  onBall(): void;
  onWave(): void;
}

const BALL_LABEL: Record<PlayState['phase'], (other: string | null) => string> = {
  unavailable: () => 'Get a ball',
  none: () => 'Get a ball',
  holding: (other) => (other ? `Throw to ${other}` : 'Throw'),
  throwing: () => CATCH.states.requested,
  'in-flight': () => 'In the air…',
  incoming: () => 'Incoming!',
};

function note(state: PlayState): string {
  switch (state.phase) {
    case 'unavailable':
      return 'Join the room to play catch and wave.';
    case 'none':
      return 'Grab a ball and throw it to whoever’s in front of you.';
    case 'holding':
      return state.other ? `Face someone else to throw to them instead.` : 'Nobody ahead: it’ll bounce and come back.';
    case 'throwing':
      return 'Winding up…';
    case 'in-flight':
      return 'Waiting to see if they catch it…';
    case 'incoming':
      return `${state.other ?? 'Someone'} threw it to you: stay put to catch it.`;
  }
}

export function PlayControls({ state, behavior, onBall, onWave }: PlayControlsProps) {
  const noteId = useId();
  const busy = state.phase === 'throwing' || state.phase === 'in-flight' || state.phase === 'incoming';
  const unavailable = state.phase === 'unavailable';
  const requested = behavior?.state === 'requested';

  return (
    <div className={styles.viewBar} data-control="play" data-phase={state.phase}>
      <div className={styles.view} role="group" aria-label="Play" aria-describedby={noteId}>
        <button
          type="button"
          disabled={unavailable || busy}
          aria-busy={busy || undefined}
          aria-keyshortcuts="F"
          className={state.phase === 'incoming' ? styles.incoming : undefined}
          onClick={onBall}
        >
          {(state.phase === 'throwing' || state.phase === 'in-flight') && <Spinner />}
          {BALL_LABEL[state.phase](state.other)}
          <kbd className={styles.key}>F</kbd>
        </button>
        <button
          type="button"
          disabled={unavailable || state.waving}
          aria-busy={state.waving || undefined}
          aria-keyshortcuts="G"
          onClick={onWave}
        >
          {state.waving ? WAVE.states.requested : WAVE.title}
          <kbd className={styles.key}>G</kbd>
        </button>
      </div>
      <p id={noteId} className={styles.viewNote} role="status">
        {note(state)}
      </p>
      {behavior !== null && (
        <p
          className={styles.behaviorState}
          data-behavior={behavior.entry.id}
          data-state={behavior.state}
          aria-busy={requested || undefined}
        >
          {requested && <Spinner />}
          <span className={styles.behaviorTitle}>{behavior.entry.title}</span>
          {behavior.entry.states[behavior.state]}
        </p>
      )}
    </div>
  );
}
