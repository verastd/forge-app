'use client';

/**
 * Building with bricks, under Play: the Lego bot's maker row (shape, colour,
 * Make brick) and everyone's hands (Pick up / Place, Turn, Drop, and for the
 * Lego bot Remove and Take down build), each with its key.
 *
 * Every state says itself, on the buttons and on the line under them:
 * - the build loading ("Loading the bricks…", a spinner), or failed to load
 *   ("Try again");
 * - checking who you are, or why you can only look (signed out, the practice
 *   account);
 * - a write under way: its button shows a spinner and says so (Making…,
 *   Picking up…, Placing…, Dropping…, Removing…, Taking down…), and every
 *   button waits;
 * - taking down a whole build asks first: the button turns into "Take down
 *   all N?" (with Cancel) and the build is outlined until it's confirmed;
 * - holding a brick: whether it fits where it's aimed, and why not;
 * - not holding: what you're pointing at and whether you can take it.
 *
 * An admin also gets "Be the Lego bot": the brick maker's keys and powers,
 * for testing, while someone else wears the backpack (Switching… while the
 * API answers).
 */

import { BLUEPRINT_MAX, BLUEPRINT_PARTS, BRICK, BRICK_COLORS, BRICK_SHAPES } from '@forge/lobby';
import { useId, useRef } from 'react';

import styles from './Lobby.module.css';
import { Spinner } from './icons';
import type { BrickCommand, BrickState } from './scene/bricks/controller';

export const INITIAL_BRICKS: BrickState = {
  sync: 'loading',
  access: 'checking',
  maker: false,
  canStandIn: false,
  standIn: false,
  count: 0,
  shape: 4,
  color: 0,
  busy: null,
  held: null,
  aim: null,
  target: null,
  heldBuild: null,
  takeDown: null,
  blueprint: null,
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
    case 'taking-down':
      return 'Taking down the build…';
    case 'switching':
      return 'Switching…';
    case 'reading':
      return 'Reading the blueprint…';
    case 'building':
      return `Building ${state.blueprint?.name ?? 'it'}: ${state.blueprint?.bricks.toLocaleString('en') ?? ''} bricks…`;
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
  if (state.blueprint) {
    const { aim } = state.blueprint;
    if (!aim) return 'Aim at the floor to place the blueprint.';
    if (aim.fits) return `It fits: E builds all ${state.blueprint.bricks.toLocaleString('en')} bricks, R turns it, Q puts it away.`;
    return `${aim.blocked.toLocaleString('en')} brick${aim.blocked === 1 ? '' : 's'} won’t fit here: ${aim.why ?? ''}`;
  }
  if (state.takeDown) {
    const n = state.takeDown.count.toLocaleString('en');
    return `Take down all ${n} brick${state.takeDown.count === 1 ? '' : 's'} of the outlined build? Shift+X again to confirm.`;
  }
  if (state.held) {
    if (!state.aim) return `Holding a ${shapeLabel(state.held)}: aim at the floor or a brick.`;
    return state.aim.fits ? 'It fits: E to place it, R to turn it.' : (state.aim.why ?? 'It doesn’t fit there.');
  }
  if (state.target) {
    const { build } = state.target;
    if (state.maker && build !== null) {
      return `A ${state.target.label} of a ${build.toLocaleString('en')}-brick build: E to pick it up, X to remove it, Shift+X to take down the whole build.`;
    }
    return state.target.can === 'pick'
      ? `A ${state.target.label}: E to pick it up.`
      : 'Part of a build: only the Lego bot can take it out.';
  }
  if (state.standIn) return 'Testing as the Lego bot: B makes a brick.';
  return state.maker ? 'You’re the Lego bot: B makes a brick.' : 'Point at a loose brick to pick it up.';
}

export function BuildControls({ state, onCommand }: BuildControlsProps) {
  const noteId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = state.sync === 'ready' && state.access === 'member';
  const waiting = state.busy !== null;
  const loading = state.sync === 'loading' || state.access === 'checking' || waiting;
  const blueprintOut = state.blueprint !== null;
  const holding = state.held !== null;
  const canUse = holding ? state.aim?.fits === true : state.target?.can === 'pick';
  const useLabel = state.busy === 'picking' ? 'Picking up…' : state.busy === 'placing' ? 'Placing…' : holding ? 'Place' : 'Pick up';

  return (
    <div className={styles.viewBar} data-control="build" data-sync={state.sync} data-access={state.access}>
      {state.canStandIn && (
        <div className={styles.view} role="group" aria-label="Testing">
          <button
            type="button"
            aria-pressed={state.standIn}
            disabled={!ready || waiting}
            aria-busy={state.busy === 'switching' || undefined}
            onClick={() => onCommand({ kind: 'stand-in', on: !state.standIn })}
          >
            {state.busy === 'switching' && <Spinner />}
            {state.busy === 'switching' ? 'Switching…' : state.standIn ? 'Being the Lego bot' : 'Be the Lego bot'}
          </button>
        </div>
      )}
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
            disabled={!ready || waiting || holding || blueprintOut}
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
      {state.maker && (
        <div className={styles.view} role="group" aria-label="Blueprint" data-blueprint={state.blueprint ? 'out' : 'none'}>
          <input
            ref={fileRef}
            type="file"
            accept=".ldr,.mpd,.ldraw,.l3b"
            className={styles.srOnly}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onCommand({ kind: 'blueprint', file });
            }}
          />
          {!state.blueprint ? (
            <button
              type="button"
              disabled={!ready || waiting || holding}
              aria-busy={state.busy === 'reading' || undefined}
              title={`An LDraw file (.ldr or .mpd, from BrickLink Studio, LeoCAD or Mecabricks), up to ${BLUEPRINT_MAX.toLocaleString('en')} bricks of: ${BLUEPRINT_PARTS.map((p) => `${p.label} (${p.part})`).join(', ')}`}
              onClick={() => fileRef.current?.click()}
            >
              {state.busy === 'reading' && <Spinner />}
              {state.busy === 'reading' ? 'Reading…' : 'Load blueprint…'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={!ready || waiting || state.blueprint.aim?.fits !== true}
                aria-busy={state.busy === 'building' || undefined}
                aria-keyshortcuts="E"
                onClick={() => onCommand({ kind: 'use' })}
              >
                {state.busy === 'building' && <Spinner />}
                {state.busy === 'building' ? 'Building…' : `Build ${state.blueprint.name}`}
                <kbd className={styles.key}>E</kbd>
              </button>
              <button type="button" disabled={!ready || waiting} aria-keyshortcuts="R" onClick={() => onCommand({ kind: 'rotate' })}>
                Turn
                <kbd className={styles.key}>R</kbd>
              </button>
              <button type="button" disabled={waiting} aria-keyshortcuts="Q" onClick={() => onCommand({ kind: 'put-away' })}>
                Put away
                <kbd className={styles.key}>Q</kbd>
              </button>
            </>
          )}
        </div>
      )}
      {state.blueprint?.skipped && <p className={styles.viewNote}>{state.blueprint.skipped}</p>}
      <div className={styles.view} role="group" aria-label="Build" aria-describedby={noteId}>
        <button
          type="button"
          disabled={!ready || waiting || blueprintOut || !canUse}
          aria-busy={state.busy === 'picking' || state.busy === 'placing' || undefined}
          aria-keyshortcuts="E"
          onClick={() => onCommand({ kind: 'use' })}
        >
          {(state.busy === 'picking' || state.busy === 'placing') && <Spinner />}
          {useLabel}
          <kbd className={styles.key}>E</kbd>
        </button>
        <button type="button" disabled={!ready || waiting || blueprintOut || !holding} aria-keyshortcuts="R" onClick={() => onCommand({ kind: 'rotate' })}>
          Turn
          <kbd className={styles.key}>R</kbd>
        </button>
        <button
          type="button"
          disabled={!ready || waiting || blueprintOut || !holding}
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
        {state.maker && (
          <button
            type="button"
            className={state.takeDown ? styles.takeDownConfirm : undefined}
            disabled={!ready || waiting || (state.takeDown === null && (state.target?.build ?? state.heldBuild) == null)}
            aria-busy={state.busy === 'taking-down' || undefined}
            aria-keyshortcuts="Shift+X"
            data-take-down={state.takeDown ? 'confirm' : undefined}
            onClick={() => onCommand({ kind: 'take-down' })}
          >
            {state.busy === 'taking-down' && <Spinner />}
            {state.busy === 'taking-down'
              ? 'Taking down…'
              : state.takeDown
                ? `Take down all ${state.takeDown.count.toLocaleString('en')}?`
                : 'Take down build'}
            <kbd className={styles.key}>⇧X</kbd>
          </button>
        )}
        {state.maker && state.takeDown && state.busy === null && (
          <button type="button" onClick={() => onCommand({ kind: 'cancel-take-down' })}>
            Cancel
          </button>
        )}
      </div>
      <p id={noteId} className={`${styles.viewNote} ${styles.buildNote}`} role="status">
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
