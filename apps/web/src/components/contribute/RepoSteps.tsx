'use client';

/**
 * The task page's steps around the agent (Phase 7): 1. Your copy and
 * 3. Send for review (2. Your agent is `AgentHandoff`), and the one sentence
 * that says what "Get started", "Refresh your copy" or "Send for review"
 * came to when GitHub sends the browser back.
 *
 * A contributor never needs to know what a fork is, so nothing here says it,
 * except the "What's this?" line, which says what GitHub calls it.
 *
 * Live, each button is a plain form post to /auth/github/repo: GitHub's
 * approval page has to be a top-level navigation. FORGE spends that one-time
 * approval on the one job and revokes it (`app/auth/github/repo/flow.ts`).
 * The practice app does each step in the tab, says so, and sends nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isValidCopy } from '@forge/shared';
import type { RepoCopy } from '@forge/shared';

import { failureOf, practiceCopy, practiceReview } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { copiedSentences, describeRepoError, plainText, REVIEW_SAYS_SENTENCE, sentForReviewSentence } from '../../lib/handoff';
import type { RepoOutcome, ReviewState } from '../../lib/handoff';
import { PRACTICE_NOTE } from '../../lib/offline';
import styles from './contribute.module.css';

/** How often "up to date 5 minutes ago" is worked out again. */
const CLOCK_MS = 60_000;

/** Where the buttons post: the OAuth App round trip. */
const REPO_ACTION_PATH = '/auth/github/repo';

/**
 * A step's heading: its number (a tick once it is done) and its name. The
 * number is decoration; the name is what a screen reader hears. Focusable, so
 * a claim can take keyboard and screen-reader users straight to step 1.
 */
export function StepTitle({ id, number, done, children }: { id: string; number: number; done: boolean; children: ReactNode }) {
  return (
    <h2 id={id} tabIndex={-1} className={styles.stepTitle}>
      <span className={`${styles.stepNumber} ${done ? styles.stepDone : ''}`} aria-hidden="true">
        {done ? '✓' : number}
      </span>
      {children}
    </h2>
  );
}

/**
 * What the repo callback sent back, said once: a success only when the task
 * backs it up (the caller checks), an error always.
 */
export function RepoOutcomeNote({ outcome }: { outcome: RepoOutcome }) {
  if (outcome.kind === 'error') {
    return (
      <div className={`${styles.outcome} ${styles.outcomeError}`} role="alert">
        <p className={styles.outcomeTitle}>{describeRepoError(outcome.failure)}</p>
      </div>
    );
  }
  const [title, ...more] = outcome.kind === 'copied' ? copiedSentences(outcome) : [sentForReviewSentence(outcome.pr)];
  return (
    <div className={`${styles.outcome} ${styles.outcomeOk}`} role="status">
      <p className={styles.outcomeTitle}>{title}</p>
      {more.map((sentence) => (
        <p key={sentence} className="muted">
          {sentence}
        </p>
      ))}
    </div>
  );
}

/** One of the buttons, live: a form post to GitHub's approval and back. */
function RepoActionForm({
  taskId,
  action,
  quiet,
  describedBy,
  children,
}: {
  taskId: number;
  action: 'copy' | 'review';
  /** A small, quiet button (Refresh your copy) rather than the step's main one. */
  quiet?: boolean;
  /** The id of the words that say what pressing it does in the person's name. */
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <form method="post" action={REPO_ACTION_PATH} className={styles.stepForm}>
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="action" value={action} />
      <button
        type="submit"
        className={quiet === true ? 'btn btn-ghost btn-sm' : `btn btn-primary ${styles.wrap}`}
        aria-describedby={describedBy}
      >
        {children}
      </button>
    </form>
  );
}

interface Said {
  text: string;
  tone: 'practice' | 'error';
}

/** A practice step's answer, or what stopped it. */
function SaidNote({ said }: { said: Said | null }) {
  return (
    <>
      <div role="status" aria-live="polite">
        {said !== null && said.tone === 'practice' && <p className="faint">{said.text}</p>}
      </div>
      <div role="alert">{said !== null && said.tone === 'error' && <p className="muted">{said.text}</p>}</div>
    </>
  );
}

/** The minute, kept fresh, for "up to date 5 minutes ago". */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** Step 1: FORGE makes (and keeps up to date) the contributor's own copy of FORGE's code on GitHub. */
export function CopyStep({
  taskId,
  practice,
  available,
  copy,
  onPracticeCopy,
}: {
  taskId: number;
  practice: boolean;
  /** FORGE's OAuth App is set up on this server (live), so the buttons can work. */
  available: boolean;
  /** The copy, once FORGE has set it up (`TaskDetail.copy`). */
  copy: RepoCopy | undefined;
  /** The practice app made (or refreshed) its pretend copy. */
  onPracticeCopy: (copy: RepoCopy) => void;
}) {
  const now = useMinute();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const usable = practice || available;

  const practise = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      const { data } = await practiceCopy(taskId);
      onPracticeCopy({ fullName: data.fullName, syncedAt: new Date().toISOString() });
      setSaid({ tone: 'practice', text: PRACTICE_NOTE });
    } catch (error) {
      setSaid({ tone: 'error', text: describeRepoError(failureOf(error)) });
    } finally {
      setBusy(false);
    }
  }, [busy, onPracticeCopy, taskId]);

  // Only a copy FORGE can name gets a link; the practice copy is pretend, so it never does.
  const name = copy === undefined ? null : plainText(copy.fullName, 140);
  const link = copy !== undefined && !practice && isValidCopy(copy.fullName) ? `https://github.com/${copy.fullName}` : null;
  const label = copy === undefined ? 'Get started' : 'Refresh your copy';

  return (
    <section className="card stack" aria-labelledby="copy-title">
      <StepTitle id="copy-title" number={1} done={copy !== undefined}>
        Your copy
      </StepTitle>
      {copy !== undefined ? (
        <p className="muted">
          Your copy is ready:{' '}
          {link === null ? (
            <span className={styles.copyName}>{name}</span>
          ) : (
            <a href={link} target="_blank" rel="noopener noreferrer" className={`${styles.copyName} ${styles.inlineLink}`}>
              {name}
              <span className="visually-hidden"> (opens on GitHub in a new tab)</span>
            </a>
          )}
          , up to date {timeAgo(copy.syncedAt, now)}.
        </p>
      ) : usable ? (
        <p className="muted">
          FORGE makes your own copy of FORGE&apos;s code on GitHub for your agent to work in. GitHub asks you
          once to allow it.
        </p>
      ) : (
        <p className="muted">Setting up your copy isn&apos;t available yet. You can still hand the task to your agent below.</p>
      )}

      {usable &&
        (practice ? (
          <div className={styles.stepForm}>
            {/* One button whose words change, so focus stays put after a practice Get started. */}
            <button
              type="button"
              className={copy === undefined ? `btn btn-primary ${styles.wrap}` : 'btn btn-ghost btn-sm'}
              onClick={() => void practise()}
              // Not `disabled`: a pressed button that disables itself throws keyboard focus out of the page.
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? (copy === undefined ? 'Setting up your copy…' : 'Refreshing your copy…') : label}
            </button>
          </div>
        ) : (
          <RepoActionForm taskId={taskId} action="copy" quiet={copy !== undefined}>
            {label}
          </RepoActionForm>
        ))}
      {practice && <SaidNote said={said} />}

      {usable && (
        <details className={styles.firstTime}>
          <summary>What&apos;s this?</summary>
          <p className="faint">
            GitHub calls it a fork: a copy of FORGE&apos;s code under your own GitHub account, where your agent
            works without touching FORGE&apos;s own. Each time you press a button here, GitHub gives FORGE a
            one-time permission, and FORGE cancels it as soon as that one job is done.
          </p>
        </details>
      )}
    </section>
  );
}

/** Step 3: once the agent has pushed its work, FORGE opens the pull request in the contributor's name. */
export function ReviewStep({
  taskId,
  practice,
  hasCopy,
  state,
  pullRequest,
  checking,
  onPracticeSent,
  onCheckAgain,
}: {
  taskId: number;
  practice: boolean;
  /** FORGE has set up the copy (`TaskDetail.copy`). */
  hasCopy: boolean;
  state: ReviewState;
  /** The task's pull request on verastd/forge-app, once there is one. */
  pullRequest: { url: string; number: number } | null;
  /** A "Check again" read is in flight. */
  checking: boolean;
  /** The practice app sent its pretend work for review. */
  onPracticeSent: () => void;
  /** Read the task again: has the agent pushed yet? */
  onCheckAgain: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const practise = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      await practiceReview(taskId);
      setSaid({ tone: 'practice', text: PRACTICE_NOTE });
      onPracticeSent();
    } catch (error) {
      setSaid({ tone: 'error', text: describeRepoError(failureOf(error)) });
    } finally {
      setBusy(false);
    }
  }, [busy, onPracticeSent, taskId]);

  let body: ReactNode;
  if (state === 'sent') {
    body =
      pullRequest === null ? (
        <p className="muted">Sent for review. Its checks and the review show up in &ldquo;Where it is&rdquo; below.</p>
      ) : (
        <p className="muted">
          Sent for review:{' '}
          <a href={pullRequest.url} target="_blank" rel="noopener noreferrer" className={styles.inlineLink}>
            pull request #{pullRequest.number}
            <span className="visually-hidden"> (opens on GitHub in a new tab)</span>
          </a>
          . Its checks and the review show up in &ldquo;Where it is&rdquo; below.
        </p>
      );
  } else if (!hasCopy) {
    body = (
      <p className="muted">
        Once your copy is set up and your agent has pushed its work, you send it for review from here.
      </p>
    );
  } else if (state === 'ready') {
    body = (
      <>
        <p className="muted">Your agent has pushed its work. Send it for review, and the checks start.</p>
        <p className="faint" id="review-says">
          {REVIEW_SAYS_SENTENCE}
        </p>
        {practice ? (
          <div className={styles.stepForm}>
            <button
              type="button"
              className={`btn btn-primary ${styles.wrap}`}
              onClick={() => void practise()}
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
              aria-describedby="review-says"
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Sending for review…' : 'Send for review'}
            </button>
          </div>
        ) : (
          <RepoActionForm taskId={taskId} action="review" describedBy="review-says">
            Send for review
          </RepoActionForm>
        )}
      </>
    );
  } else {
    body = (
      <>
        <p className="muted">
          When your agent has pushed its work, send it for review from here: FORGE opens the pull request in your
          name.
        </p>
        {!practice && (
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (!checking) {
                  onCheckAgain();
                }
              }}
              aria-disabled={checking || undefined}
              aria-busy={checking || undefined}
            >
              {checking && <span className="spinner" aria-hidden="true" />}
              {checking ? 'Checking…' : 'Check again'}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="card stack" aria-labelledby="review-title">
      <StepTitle id="review-title" number={3} done={state === 'sent'}>
        Send for review
      </StepTitle>
      {body}
      {practice && <SaidNote said={said} />}
    </section>
  );
}
