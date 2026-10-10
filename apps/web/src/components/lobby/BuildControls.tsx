'use client';

/**
 * Building with bricks, under Play: the Lego bot's maker row (shape, colour,
 * Make brick) and everyone's hands (Pick up / Place, Turn, Drop, and for the
 * Lego bot Remove), each with its key.
 *
 * Every state says itself, on the buttons and on the line under them:
 * - the build loading ("Loading the bricks…", a spinner), or failed to load
 *   ("Try again");
 * - checking who you are, or why you can only look (signed out, the practice
 *   account);
 * - a write under way: its button shows a spinner and says so (Making…,
 *   Picking up…, Placing…, Dropping…, Removing…), and every button waits;
 * - holding a brick: whether it fits where it's aimed, and why not;
 * - not holding: what you're pointing at and whether you can take it.
 */

import { BRICK, BRICK_COLORS, BRICK_SHAPES } from '@forge/lobby';
import { useId } from 'react';

import styles from './Lobby.module.css';
import { Spinner } from './icons';
import type { BrickCommand, BrickState } from './scene/bricks/controller';

export const INITIAL_BRICKS: BrickState = {
  sync: 'loading',
  access: 'checking',
  maker: false,
  count: 0,
  shape: 4,
  color: 0,
  busy: null,
  held: null,
  aim: null,
  target: null,
};

export interface BuildControlsProps {
  state: BrickState;
  onCommand(command: BrickCommand): void;
}

const shapeLabel = (id: string | null): string => BRICK_SHAPES.find((shape) => shape.id === id)?.label ?? 'brick';

function note(state: BrickState): string {
  if (state.sync === 'loading') return 'Loading the bricks…';
  if (state.sync === 'error') return 'Couldn’t load the bricks.';
  switch (state.busy) {
    case 'making':
      return 'Making a brick…';
    case 'picking':
      return 'Picking it up…';
    case 'placing':
      return 'Placing it…';
    case 'dropping':
      return 'Putting it down…';
    case 'removing':
      return 'Removing it…';
    case null:
      break;
  }
  switch (state.access) {
    case 'checking':
      return 'Checking who you are…';
    case 'signed-out':
      return 'Sign in with GitHub to build. Until then, look around.';
    case 'practice':
      return 'The practice account can only look: sign in with GitHub to build.';
    case 'unavailable':
      return 'Building isn’t available right now.';
    case 'member':
      break;
  }
  if (state.held) {
    if (!state.aim) return `Holding a ${shapeLabel(state.held)}: aim at the floor or a brick.`;
    return state.aim.fits ? 'It fits: E to place it, R to turn it.' : (state.aim.why ?? 'It doesn’t fit there.');
  }
  if (state.target) {
    return state.target.can === 'pick'
      ? `A ${state.target.label}: E to pick it up.`
      : 'Part of a build: only the Lego bot can take it out.';
  }
  return state.maker ? 'You’re the Lego bot: B makes a brick.' : 'Point at a loose brick to pick it up.';
}

export function BuildControls({ state, onCommand }: BuildControlsProps) {
  const noteId = useId();
  const ready = state.sync === 'ready' && state.access === 'member';
  const waiting = state.busy !== null;
  const loading = state.sync === 'loading' || state.access === 'checking' || waiting;
  const holding = state.held !== null;
  const canUse = holding ? state.aim?.fits === true : state.target?.can === 'pick';
  const useLabel = state.busy === 'picking' ? 'Picking up…' : state.busy === 'placing' ? 'Placing…' : holding ? 'Place' : 'Pick up';

  return (
    <div className={styles.viewBar} data-control="build" data-sync={state.sync} data-access={state.access}>
      {state.maker && (
        <div className={styles.view} role="group" aria-label="Make bricks">
          <label className={styles.buildPick}>
            <span className={styles.srOnly}>Brick shape</span>
            <select
              value={state.shape}
              disabled={!ready || waiting}
              aria-keyshortcuts="1 2 3 4 5 6 7 8 9"
              onChange={(event) => onCommand({ kind: 'shape', index: Number(event.target.value) })}
            >
              {BRICK_SHAPES.map((shape, index) => (
                <option key={shape.id} value={index}>
                  {index + 1} · {shape.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.buildPick}>
            <span className={styles.srOnly}>Brick colour</span>
            <span className={styles.swatch} style={{ background: BRICK_COLORS[state.color]?.hex }} aria-hidden="true" />
            <select
              value={state.color}
              disabled={!ready || waiting}
              aria-keyshortcuts="C Shift+C"
              onChange={(event) => onCommand({ kind: 'paint', index: Number(event.target.value) })}
            >
              {BRICK_COLORS.map((colour, index) => (
                <option key={colour.id} value={index}>
                  {colour.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!ready || waiting || holding}
            aria-busy={state.busy === 'making' || undefined}
            aria-keyshortcuts="B"
            onClick={() => onCommand({ kind: 'make' })}
          >
            {state.busy === 'making' && <Spinner />}
            {state.busy === 'making' ? 'Making…' : 'Make brick'}
            <kbd className={styles.key}>B</kbd>
          </button>
        </div>
      )}
      <div className={styles.view} role="group" aria-label="Build" aria-describedby={noteId}>
        <button
          type="button"
          disabled={!ready || waiting || !canUse}
          aria-busy={state.busy === 'picking' || state.busy === 'placing' || undefined}
          aria-keyshortcuts="E"
          onClick={() => onCommand({ kind: 'use' })}
        >
          {(state.busy === 'picking' || state.busy === 'placing') && <Spinner />}
          {useLabel}
          <kbd className={styles.key}>E</kbd>
        </button>
        <button type="button" disabled={!ready || waiting || !holding} aria-keyshortcuts="R" onClick={() => onCommand({ kind: 'rotate' })}>
          Turn
          <kbd className={styles.key}>R</kbd>
        </button>
        <button
          type="button"
          disabled={!ready || waiting || !holding}
          aria-busy={state.busy === 'dropping' || undefined}
          aria-keyshortcuts="Q"
          onClick={() => onCommand({ kind: 'drop' })}
        >
          {state.busy === 'dropping' && <Spinner />}
          {state.busy === 'dropping' ? 'Dropping…' : 'Drop'}
          <kbd className={styles.key}>Q</kbd>
        </button>
        {state.maker && (
          <button
            type="button"
            disabled={!ready || waiting || (!holding && state.target === null)}
            aria-busy={state.busy === 'removing' || undefined}
            aria-keyshortcuts="X"
            onClick={() => onCommand({ kind: 'remove' })}
          >
            {state.busy === 'removing' && <Spinner />}
            {state.busy === 'removing' ? 'Removing…' : 'Remove'}
            <kbd className={styles.key}>X</kbd>
          </button>
        )}
      </div>
      <p id={noteId} className={styles.viewNote} role="status">
        {loading && <Spinner />}
        <span>{note(state)}</span>
        {state.sync === 'error' && (
          <button type="button" className={styles.reverbRetry} onClick={() => onCommand({ kind: 'retry' })}>
            Try again
          </button>
        )}
        {state.sync === 'ready' && (
          <span className={styles.brickCount} data-count={state.count}>
            {state.count.toLocaleString('en')} / {BRICK.limit.toLocaleString('en')} bricks
          </span>
        )}
      </p>
    </div>
  );
}
