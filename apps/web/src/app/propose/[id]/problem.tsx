'use client';

/**
 * What the panels on a proposal's page share: what a write came to, said in
 * words next to the part of the page it came from; where keyboard focus goes
 * next; and a button's working state.
 *
 * Focus never drops to the page (review-pages M4). Opening a confirm step
 * moves focus into it, cancelling returns it to the button that opened it,
 * and once a write is over focus moves to the line that says how it went
 * (`OutcomeLine`), which is also a live region, so it is heard either way.
 * A button stays focusable while its request runs: it is `aria-disabled` and
 * ignores presses, rather than `disabled`, which would throw focus away.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { ProposalAction } from '../../../lib/proposals-format';
import styles from '../propose.module.css';

/** What a write came to, said in words, next to the part of the page it came from. */
export interface Outcome {
  action: ProposalAction;
  /** `ok`: it went through. `problem`: it didn't, or it may not have. */
  tone: 'ok' | 'problem';
  message: string;
  /** `one_active_proposal`: your proposal already on the floor. */
  proposalId?: number;
}

/** The three parts of the page a write's outcome is said in, and the id of each one's line. */
export type OutcomePart = 'part' | 'admin' | 'debate';

export const OUTCOME_ID: Readonly<Record<OutcomePart, string>> = {
  part: 'part-outcome',
  admin: 'admin-outcome',
  debate: 'debate-outcome',
};

/**
 * Where an outcome is said: always on the page (empty until there is one), so
 * focus can move to it and a screen reader hears what it says. A problem is an
 * `alert`, anything else a `status`; `children` add to a problem (a comment
 * that wasn't posted, say).
 */
export function OutcomeLine({ part, outcome, children }: { part: OutcomePart; outcome: Outcome | null; children?: ReactNode }) {
  return (
    <div id={OUTCOME_ID[part]} tabIndex={-1} className={styles.outcomeLine}>
      {outcome !== null &&
        (outcome.tone === 'problem' ? (
          <div className={styles.problem} role="alert">
            <p>{outcome.message}</p>
            {outcome.proposalId !== undefined && (
              <Link href={`/propose/${outcome.proposalId}`} className={styles.inlineLink}>
                See your proposal
              </Link>
            )}
            {children}
          </div>
        ) : (
          <p className={styles.outcome} role="status">
            {outcome.message}
          </p>
        ))}
    </div>
  );
}

/**
 * `focusNext(id)`: the element with that id takes focus once the page has
 * drawn what the same event changed (a confirm step opening, or closing).
 */
export function useFocusNext(): (id: string) => void {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const id = pending.current;
    if (id === null) return;
    pending.current = null;
    document.getElementById(id)?.focus();
  });
  return useCallback((id: string) => {
    pending.current = id;
  }, []);
}

export function Busy({ when, idle, working }: { when: boolean; idle: string; working: string }) {
  return (
    <>
      {when && <span className="spinner" aria-hidden="true" />}
      {when ? working : idle}
    </>
  );
}
