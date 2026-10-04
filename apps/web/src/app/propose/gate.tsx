'use client';

/**
 * The `proposals` kill switch, for every Propose screen.
 *
 * Flags fail closed (`@forge/flags/react`): an unreachable flag service reads
 * the same as a switch somebody threw, which is right for the live app, and
 * one that hasn't answered in 8 s counts as unreachable, so no page waits on
 * it longer than that. The practice app passes its all-on fallback
 * (`lib/flags.ts`), so silence shows the floor there, and an actual "off"
 * from the service still wins.
 */

import Link from 'next/link';
import { useFlags } from '@forge/flags/react';

import { demoFlagFallback } from '../../lib/flags';
import styles from './propose.module.css';

export interface ProposalsFlag {
  on: boolean;
  /** Still waiting on the flag service, with nothing on yet. */
  loading: boolean;
}

export function useProposalsFlag(): ProposalsFlag {
  const { flags, loading } = useFlags(demoFlagFallback());
  return { on: flags.proposals, loading: loading && !flags.proposals };
}

/** The fail-closed message (contract §4). */
export function SwitchedOff() {
  return (
    <div className="card stack" role="alert">
      <p>Proposals are switched off right now.</p>
      <p className="faint">Nothing on the floor is lost. Please look in again a bit later.</p>
      <p>
        <Link href="/" className="btn btn-ghost">
          Back to the app
        </Link>
      </p>
    </div>
  );
}

/**
 * The API says the floor is paused (`floorPaused`): members can't take part
 * just now (sign-in is switched off, say), so no deadline runs, and each one
 * moves later by the time it was paused once the floor opens again.
 */
export function FloorPaused() {
  return (
    <div className={styles.pausedBanner} role="note" aria-labelledby="floor-paused-title">
      <p id="floor-paused-title" className={styles.pausedTitle}>
        The floor is paused
      </p>
      <p>
        Members can&apos;t take part right now, so no deadline is running. When the floor opens again, every
        running deadline moves later by the time it was paused.
      </p>
    </div>
  );
}

/** A panel that is still fetching. */
export function Loading({ text }: { text: string }) {
  return (
    <div className="card stack" aria-busy="true">
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        {text}
      </p>
      <div className="skeleton" style={{ width: '45%' }} />
      <div className="skeleton" style={{ width: '70%' }} />
    </div>
  );
}
