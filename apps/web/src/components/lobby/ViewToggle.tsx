'use client';

/**
 * The camera: at your eye (1st person), behind your own robot (3rd person),
 * or in front of it (Front: your face and chestplate, as everyone else sees
 * you). Under Exit, always in reach; V steps through them from the keyboard.
 *
 * Every state says itself: the view you're in is pressed; out of first
 * person, while your robot is still on its way, the line under it says so
 * with a spinner; if its body couldn't load, it says that with a Try again;
 * and with robots off in this lobby the other two are disabled and the line
 * says why.
 */

import type { CameraView } from '@forge/lobby';
import { useId } from 'react';

import styles from './Lobby.module.css';
import type { SelfRobotState } from './scene/peers';
import { Spinner } from './icons';

export interface ViewToggleProps {
  view: CameraView;
  /** Robots are on (`lobby_avatars`): without them there is nothing to see from behind. */
  avatars: boolean;
  /** How your own robot is doing (the scene's word: 'off' in first person). */
  self: SelfRobotState;
  onChange(view: CameraView): void;
  /** Loads the robot body again after it failed. */
  onRetry(): void;
}

export function ViewToggle({ view, avatars, self, onChange, onRetry }: ViewToggleProps) {
  const noteId = useId();
  const shown: CameraView = avatars ? view : 'first';
  const out = shown !== 'first';
  const note = !avatars
    ? 'Robots are off in this lobby, so there’s no third person.'
    : out && self === 'loading'
      ? 'Loading your robot…'
      : out && self === 'failed'
        ? 'Your robot didn’t load.'
        : 'Press V to switch.';
  const button = (which: CameraView, label: string, needsRobot: boolean) => (
    <button type="button" aria-pressed={shown === which} disabled={needsRobot && !avatars} onClick={() => onChange(which)}>
      {label}
    </button>
  );

  return (
    <div className={styles.viewBar} data-control="view" data-self={out ? self : 'off'}>
      <div className={styles.view} role="group" aria-label="Camera view" aria-describedby={noteId}>
        {button('first', '1st person', false)}
        {button('third', '3rd person', true)}
        {button('front', 'Front', true)}
      </div>
      <p id={noteId} className={styles.viewNote} role="status">
        {out && self === 'loading' && <Spinner />}
        {note}
        {out && self === 'failed' && (
          <button type="button" className={styles.reverbRetry} onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
    </div>
  );
}
