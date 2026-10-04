'use client';

/**
 * A proposal's public record (Phase 5 contract §1 and §4): the debate thread
 * with its comment box, and the timeline of everything that happened. All
 * of it is plain text from the API, rendered as text.
 *
 * The detail brings the newest comments; "Show earlier comments" pages back
 * through the rest. What a member types stays in the box until it is posted:
 * when posting fails, the reason is said above the box, and if the box has
 * gone because the proposal moved on (the vote closed, say), what they wrote
 * is shown with it, so nothing typed is lost.
 *
 * A timeline line of a kind this build doesn't know yet (the API grew one)
 * is shown as the plain line it is.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { PROPOSAL_LIMITS } from '@forge/shared';
import type { ProposalComment } from '@forge/shared';

import { Chip } from '../../../components/Chip';
import { formatTimestamp } from '../../../lib/format';
import type { DisplayDetail, DisplayEvent } from '../../../lib/proposals';
import { checkComment, eventText, isAdminEvent } from '../../../lib/proposals-format';
import type { ProposalAction } from '../../../lib/proposals-format';
import { CountedField } from '../fields';
import styles from '../propose.module.css';
import { Busy, OutcomeLine } from './problem';
import type { Outcome } from './problem';

export function DebateThread({
  detail,
  thread,
  moreComments,
  loadingEarlier,
  earlierProblem,
  onShowEarlier,
  busy,
  outcome,
  onComment,
}: {
  detail: DisplayDetail;
  /** The comments to show, oldest first: the detail's, and any earlier pages opened. */
  thread: readonly ProposalComment[];
  /** Older comments than `thread` exist. */
  moreComments: boolean;
  loadingEarlier: boolean;
  earlierProblem: string | null;
  onShowEarlier: () => void;
  busy: ProposalAction | null;
  outcome: Outcome | null;
  onComment: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const { proposal, you } = detail;
  const working = busy !== null;
  const canComment = you?.canComment === true;
  /** The box is gone, and what was in it wasn't posted: show it, so it isn't lost. */
  const unsent = !canComment && outcome?.tone === 'problem' && text.trim() !== '' ? text : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (working) return;
    const checked = checkComment(text);
    if (!checked.ok) {
      setError(checked.errors.text);
      document.getElementById('comment-text')?.focus();
      return;
    }
    setError(undefined);
    void onComment(checked.value).then((posted) => {
      if (posted) setText('');
    });
  };

  return (
    <section className="card stack" aria-labelledby="debate-title">
      <h2 id="debate-title" className="section-title">
        Debate
      </h2>
      {moreComments && (
        <div className={styles.more}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onShowEarlier}
            aria-disabled={loadingEarlier || undefined}
            aria-busy={loadingEarlier || undefined}
          >
            {loadingEarlier && <span className="spinner" aria-hidden="true" />}
            {loadingEarlier ? 'Loading earlier comments…' : 'Show earlier comments'}
          </button>
          {earlierProblem !== null && (
            <p className={styles.problem} role="alert">
              {earlierProblem}
            </p>
          )}
        </div>
      )}
      {thread.length === 0 ? (
        <p className="faint">
          {proposal.state === 'submitted' ? 'Debate opens once someone seconds it.' : 'No comments yet.'}
        </p>
      ) : (
        <ol className={styles.thread} aria-label="Comments">
          {thread.map((entry) => (
            <li key={entry.id} id={`comment-${entry.id}`} tabIndex={-1} className={styles.comment}>
              <p className={styles.commentHead}>
                <strong>{entry.author}</strong>{' '}
                <time dateTime={entry.at} className={styles.when}>
                  {formatTimestamp(entry.at)}
                </time>
              </p>
              <p className={styles.commentText}>{entry.text}</p>
            </li>
          ))}
        </ol>
      )}
      <OutcomeLine part="debate" outcome={outcome}>
        {unsent !== null && (
          <>
            <p>What you wrote, which wasn&apos;t posted:</p>
            <blockquote className={styles.unsent}>{unsent}</blockquote>
          </>
        )}
      </OutcomeLine>
      {canComment && (
        <form className={styles.form} onSubmit={submit} noValidate aria-label="Add a comment">
          <CountedField
            id="comment-text"
            label="Add to the debate"
            help="Plain text, in the open: everyone can read it, with your name on it."
            value={text}
            onChange={setText}
            max={PROPOSAL_LIMITS.comment}
            error={error}
            multiline
            rows={4}
            readOnly={working}
          />
          <div className="row">
            <button type="submit" className="btn" aria-disabled={working || undefined} aria-busy={busy === 'comment' || undefined}>
              <Busy when={busy === 'comment'} idle="Post comment" working="Posting…" />
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function Timeline({ events }: { events: readonly DisplayEvent[] }) {
  return (
    <section className="card stack" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="section-title">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="faint">Nothing has happened yet.</p>
      ) : (
        <ol className={styles.timeline}>
          {events.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <time dateTime={entry.at} className={styles.when}>
                {formatTimestamp(entry.at)}
              </time>
              <span className={styles.what}>
                {isAdminEvent(entry.kind) && (
                  <>
                    <Chip tone="warn">Admin</Chip>{' '}
                  </>
                )}
                {eventText(entry)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
