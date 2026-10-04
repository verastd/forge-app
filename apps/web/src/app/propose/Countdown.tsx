'use client';

/**
 * A proposal's deadline as a countdown: "Debate ends in 2d 04h", ticking.
 *
 * Every countdown on a page runs off one shared one-second clock
 * (`lib/ticker`), on the server's time (`lib/server-clock`), so a floor of
 * hundreds of cards costs one timer and a visitor whose clock is off still
 * sees the API's deadlines. A proposal with nothing to count down (decided,
 * no deadline) doesn't listen to the clock at all, and while the floor is
 * paused a deadline says so rather than running down: the API moves it later
 * by the time the floor was paused.
 *
 * Ticking text is no use to a screen reader, so the visible countdown is a
 * `timer` (whose updates are not announced). With `announce`, the page's one
 * countdown also keeps a polite live copy that changes only once a day, an
 * hour or a minute ("Debate ends in 2 days").
 */

import { useSyncExternalStore } from 'react';
import type { ProposalState } from '@forge/shared';

import { deadlineLabel, isActive, msUntil, pausedLabel } from '../../lib/proposals-format';
import { subscribeTicker, tickerNow } from '../../lib/ticker';
import styles from './propose.module.css';

/** The server's time, from the page's one shared ticker: a new value every second. */
export function useNow(): number {
  return useSyncExternalStore(subscribeTicker, tickerNow, tickerNow);
}

interface CountdownProps {
  state: ProposalState;
  deadline: string | undefined;
  /** The floor is paused: no deadline runs. */
  paused?: boolean;
  announce?: boolean;
}

export function DeadlineCountdown({ state, deadline, paused = false, announce = false }: CountdownProps) {
  if (!isActive(state) || deadline === undefined) {
    return null;
  }
  if (paused) {
    return <span className={`${styles.countdown} ${styles.countdownPaused}`}>{pausedLabel(state)}</span>;
  }
  return <Ticking state={state} deadline={deadline} announce={announce} />;
}

function Ticking({ state, deadline, announce }: { state: ProposalState; deadline: string; announce: boolean }) {
  const now = useNow();
  const ticking = deadlineLabel(state, deadline, now);
  if (ticking === null) {
    return null;
  }
  const left = msUntil(deadline, now);
  const className = `${styles.countdown} ${left !== null && left <= 0 ? styles.countdownOver : ''}`;
  if (!announce) {
    return (
      <span role="timer" className={className}>
        {ticking}
      </span>
    );
  }
  return (
    <>
      <span className={className} aria-hidden="true">
        {ticking}
      </span>
      <span className="visually-hidden" aria-live="polite">
        {deadlineLabel(state, deadline, now, 'spoken')}
      </span>
    </>
  );
}
