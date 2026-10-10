'use client';

/**
 * The mechanic's tools, under building: his library of blueprints (upload,
 * choose, delete), the chosen blueprint's controls (Build, Turn, Size, Put
 * away), and Take down. Shown to the mechanic, and to admins (who get
 * "Be the mechanic", for testing); everyone else just sees the machines.
 *
 * Every state says itself, on the buttons and on the line under them:
 * - the machines loading, or failed to load ("Try again"); the library
 *   loading, empty, or failed to load ("Try again");
 * - an upload: reading the file and finding its parts, then sending it, with
 *   a progress bar and Cancel; why it failed, until dismissed;
 * - the chosen blueprint downloading (a progress bar), failed ("Try again"),
 *   or ready: whether it fits where it's aimed, and why not;
 * - a write under way: its button shows a spinner and says so (Building…,
 *   Taking down…, Switching…, Deleting…), and the others wait;
 * - taking a machine down asks first ("Take down V8?", with Cancel), the
 *   machine outlined in red until it's confirmed;
 * - a machine going up ("Building V8: part 14 of 26"), and machines whose
 *   blueprints are still on their way.
 */

import { MACHINE } from '@forge/lobby';
import { MACHINE_BLUEPRINT_MAX_BYTES, MACHINE_SCALE_MAX, MACHINE_SCALE_MIN } from '@forge/shared';
import { useId, useRef } from 'react';

import styles from './Lobby.module.css';
import { Spinner } from './icons';
import type { LibraryItem, MachineCommand, MachineState } from './scene/machines/controller';

export const INITIAL_MACHINES: MachineState = {
  sync: 'loading',
  access: 'checking',
  mechanic: false,
  canStandIn: false,
  standIn: false,
  count: 0,
  busy: null,
  library: { status: 'idle', items: [] },
  upload: null,
  uploadError: null,
  deleting: null,
  chosen: null,
  target: null,
  takeDown: null,
  assembling: null,
  loadingModels: 0,
};

export interface MachineControlsProps {
  state: MachineState;
  onCommand(command: MachineCommand): void;
}

const metres = (item: LibraryItem): string => item.metres.map((m) => m.toFixed(1)).join(' × ') + ' m';
const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

function note(state: MachineState): string {
  if (state.sync === 'loading') return 'Loading the machines…';
  if (state.sync === 'error') return 'Couldn’t load the machines.';
  switch (state.busy) {
    case 'building':
      return `Sending ${state.chosen?.name ?? 'the build'}…`;
    case 'taking-down':
      return 'Taking it down…';
    case 'switching':
      return 'Switching…';
    case null:
      break;
  }
  if (state.access === 'checking') return 'Checking who you are…';
  if (state.takeDown) return `Take down ${state.takeDown.name}? Shift+X again to confirm.`;
  if (state.chosen) {
    const { chosen } = state;
    if (chosen.load === 'loading') return `Downloading ${chosen.name}… ${percent(chosen.progress)}`;
    if (chosen.load === 'error') return `Couldn’t load ${chosen.name}.`;
    if (!chosen.aim) return 'Aim at the floor to place it.';
    if (chosen.aim.fits) return `It fits: E builds it (${chosen.parts} parts), R turns it, + and − size it, Q puts it away.`;
    return chosen.aim.why ?? 'It doesn’t fit there.';
  }
  if (state.assembling) return `Building ${state.assembling.name}: part ${Math.min(state.assembling.part + 1, state.assembling.parts)} of ${state.assembling.parts}`;
  if (state.loadingModels > 0) return `Loading ${state.loadingModels} machine${state.loadingModels === 1 ? '' : 's'}…`;
  if (state.target) return `${state.target.name}: Shift+X to take it down.`;
  if (state.standIn) return 'Testing as the mechanic: choose a blueprint to build.';
  return state.mechanic ? 'You’re the mechanic: choose a blueprint to build, or upload one.' : 'Admins can take over the mechanic to test it.';
}

export function MachineControls({ state, onCommand }: MachineControlsProps) {
  const noteId = useId();
  const sizeId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!state.mechanic && !state.canStandIn) return null;

  const ready = state.sync === 'ready' && state.access === 'member';
  const waiting = state.busy !== null;
  const { library, upload, chosen } = state;
  const spinning =
    state.sync === 'loading' || state.access === 'checking' || waiting || chosen?.load === 'loading' || state.assembling !== null || state.loadingModels > 0;

  return (
    <div className={styles.viewBar} data-control="machines" data-sync={state.sync} data-library={library.status}>
      {state.canStandIn && (
        <div className={styles.view} role="group" aria-label="Testing the mechanic">
          <button
            type="button"
            aria-pressed={state.standIn}
            disabled={!ready || waiting}
            aria-busy={state.busy === 'switching' || undefined}
            onClick={() => onCommand({ kind: 'stand-in', on: !state.standIn })}
          >
            {state.busy === 'switching' && <Spinner />}
            {state.busy === 'switching' ? 'Switching…' : state.standIn ? 'Being the mechanic' : 'Be the mechanic'}
          </button>
        </div>
      )}

      {state.mechanic && (
        <section className={styles.machineShop} aria-label="Blueprints">
          <header className={styles.machineHead}>
            <span>Blueprints</span>
            <input
              ref={fileRef}
              type="file"
              accept=".glb,model/gltf-binary"
              className={styles.srOnly}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onCommand({ kind: 'upload', file });
              }}
            />
            <button
              type="button"
              disabled={!ready || upload !== null}
              aria-busy={upload !== null || undefined}
              title={`A .glb model (binary glTF from Tripo, Blender or a CAD tool), up to ${MACHINE_BLUEPRINT_MAX_BYTES / 1024 / 1024} MB`}
              onClick={() => fileRef.current?.click()}
            >
              {upload && <Spinner />}
              {upload ? 'Uploading…' : 'Upload…'}
            </button>
          </header>

          {upload && (
            <div className={styles.machineUpload} data-stage={upload.stage}>
              <span>
                {upload.stage === 'reading'
                  ? `Reading ${upload.name} and finding its parts…`
                  : upload.stage === 'finishing'
                    ? `Checking ${upload.name}…`
                    : `Uploading ${upload.name} (${upload.parts ?? '?'} parts)… ${percent(upload.progress)}`}
              </span>
              <progress
                max={1}
                value={upload.stage === 'reading' ? undefined : upload.progress}
                aria-label={`Uploading ${upload.name}`}
              />
              <button type="button" onClick={() => onCommand({ kind: 'cancel-upload' })}>
                Cancel
              </button>
            </div>
          )}
          {state.uploadError && (
            <p className={`${styles.viewNote} ${styles.machineError}`} role="alert">
              <span>{state.uploadError}</span>
              <button type="button" className={styles.reverbRetry} onClick={() => onCommand({ kind: 'dismiss-upload-error' })}>
                OK
              </button>
            </p>
          )}

          {(library.status === 'loading' || library.status === 'idle') && (
            <p className={styles.viewNote} role="status">
              <Spinner />
              <span>Loading the library…</span>
            </p>
          )}
          {library.status === 'error' && (
            <p className={styles.viewNote} role="alert">
              <span>Couldn’t load the library.</span>
              <button type="button" className={styles.reverbRetry} onClick={() => onCommand({ kind: 'library' })}>
                Try again
              </button>
            </p>
          )}
          {library.status === 'ready' && library.items.length === 0 && !upload && (
            <p className={styles.viewNote}>No blueprints yet: upload a .glb to build from.</p>
          )}
          {library.items.length > 0 && (
            <ul className={styles.machineLibrary} aria-label="Library">
              {library.items.map((item) => {
                const isChosen = chosen?.id === item.id;
                const deleting = state.deleting === item.id;
                return (
                  <li key={item.id} data-chosen={isChosen || undefined}>
                    <button
                      type="button"
                      className={styles.machinePick}
                      aria-pressed={isChosen}
                      disabled={!ready || waiting || deleting}
                      onClick={() => onCommand(isChosen ? { kind: 'put-away' } : { kind: 'choose', id: item.id })}
                    >
                      <span className={styles.machineName}>{item.name}</span>
                      <span className={styles.machineMeta}>
                        {item.parts} parts · {metres(item)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.machineDelete}
                      disabled={!ready || waiting || state.deleting !== null}
                      aria-busy={deleting || undefined}
                      aria-label={`Delete ${item.name}`}
                      title="Delete from the library (machines built from it stay)"
                      onClick={() => onCommand({ kind: 'delete-blueprint', id: item.id })}
                    >
                      {deleting ? <Spinner /> : '×'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {state.mechanic && chosen && (
        <div className={styles.view} role="group" aria-label={`Build ${chosen.name}`} data-load={chosen.load}>
          {chosen.load === 'loading' && (
            <span className={styles.machineDownload}>
              <Spinner />
              <progress max={1} value={chosen.progress} aria-label={`Downloading ${chosen.name}`} />
            </span>
          )}
          {chosen.load === 'error' && (
            <button type="button" onClick={() => onCommand({ kind: 'retry-model' })}>
              Try again
            </button>
          )}
          {chosen.load === 'ready' && (
            <>
              <button
                type="button"
                disabled={!ready || waiting || chosen.aim?.fits !== true}
                aria-busy={state.busy === 'building' || undefined}
                aria-keyshortcuts="E"
                onClick={() => onCommand({ kind: 'build' })}
              >
                {state.busy === 'building' && <Spinner />}
                {state.busy === 'building' ? 'Building…' : `Build ${chosen.name}`}
                <kbd className={styles.key}>E</kbd>
              </button>
              <button type="button" disabled={waiting} aria-keyshortcuts="R" onClick={() => onCommand({ kind: 'turn', step: 1 })}>
                Turn
                <kbd className={styles.key}>R</kbd>
              </button>
              <label className={styles.buildPick} htmlFor={sizeId}>
                <span>Size ×{chosen.scale.toFixed(2)}</span>
                <input
                  id={sizeId}
                  type="range"
                  min={MACHINE_SCALE_MIN}
                  max={MACHINE_SCALE_MAX}
                  step={0.05}
                  value={chosen.scale}
                  disabled={waiting}
                  aria-keyshortcuts="+ -"
                  onChange={(event) => onCommand({ kind: 'scale', value: Number(event.target.value) })}
                />
              </label>
            </>
          )}
          <button type="button" disabled={waiting} aria-keyshortcuts="Q" onClick={() => onCommand({ kind: 'put-away' })}>
            Put away
            <kbd className={styles.key}>Q</kbd>
          </button>
        </div>
      )}

      {state.mechanic && (
        <div className={styles.view} role="group" aria-label="Machines">
          <button
            type="button"
            className={state.takeDown ? styles.takeDownConfirm : undefined}
            disabled={!ready || waiting || (state.takeDown === null && state.target === null)}
            aria-busy={state.busy === 'taking-down' || undefined}
            aria-keyshortcuts="Shift+X"
            data-take-down={state.takeDown ? 'confirm' : undefined}
            onClick={() => onCommand({ kind: 'take-down' })}
          >
            {state.busy === 'taking-down' && <Spinner />}
            {state.busy === 'taking-down'
              ? 'Taking down…'
              : state.takeDown
                ? `Take down ${state.takeDown.name}?`
                : state.target
                  ? `Take down ${state.target.name}`
                  : 'Take down machine'}
            <kbd className={styles.key}>⇧X</kbd>
          </button>
          {state.takeDown && state.busy === null && (
            <button type="button" onClick={() => onCommand({ kind: 'cancel-take-down' })}>
              Cancel
            </button>
          )}
        </div>
      )}

      <p id={noteId} className={`${styles.viewNote} ${styles.buildNote}`} role="status">
        {spinning && <Spinner />}
        <span>{note(state)}</span>
        {state.sync === 'error' && (
          <button type="button" className={styles.reverbRetry} onClick={() => onCommand({ kind: 'retry' })}>
            Try again
          </button>
        )}
        {state.sync === 'ready' && (
          <span className={styles.brickCount} data-machines={state.count}>
            {state.count} / {MACHINE.limit} machines
          </span>
        )}
      </p>
    </div>
  );
}
