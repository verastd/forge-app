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
 * - waving: "Waving…", the button held until the wave is done;
 * - not in a room yet (or it's gone): both held, and the line says why.
 */

import { useId } from 'react';

import styles from './Lobby.module.css';
import type { PlayState } from './scene/play';
import { Spinner } from './icons';

export interface PlayControlsProps {
  state: PlayState;
  onBall(): void;
  onWave(): void;
}

const BALL_LABEL: Record<PlayState['phase'], (other: string | null) => string> = {
  unavailable: () => 'Get a ball',
  none: () => 'Get a ball',
  holding: (other) => (other ? `Throw to ${other}` : 'Throw'),
  throwing: () => 'Throwing…',
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

export function PlayControls({ state, onBall, onWave }: PlayControlsProps) {
  const noteId = useId();
  const busy = state.phase === 'throwing' || state.phase === 'in-flight' || state.phase === 'incoming';
  const unavailable = state.phase === 'unavailable';

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
          {state.waving ? 'Waving…' : 'Wave'}
          <kbd className={styles.key}>G</kbd>
        </button>
      </div>
      <p id={noteId} className={styles.viewNote} role="status">
        {note(state)}
      </p>
    </div>
  );
}
