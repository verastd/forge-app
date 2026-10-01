'use client';

/**
 * After the hand-off: where the task is, what happened, and what to do next
 * (Phase 4). Driven by the API's status (`BridgeStatus`) and, once a pull
 * request exists, its checks (`CheckResults`).
 *
 * - the stage and its plain-English detail, then a short timeline of events.
 *   An agent's own words arrive through the FORGE connector and are untrusted:
 *   they are shown as text only, cleaned of control characters and cut short;
 * - "Watch it work" (the agent's session) and "Open the pull request on
 *   GitHub" (the compare page) until a pull request exists, then the pull
 *   request and its checks;
 * - when checks fail, the notes: sent to the agent FORGE started when its
 *   vendor takes follow-ups (Jules, Cursor, Devin, with a saved key), or left
 *   for an agent with the connector to read, with a hidden copy as the
 *   fallback;
 * - "Release this task", behind a confirm step.
 */

import { useCallback, useState } from 'react';
import { isStartRail, railMeta } from '@forge/shared';
import type { BridgeStatus, CheckResults, CheckRun, FeedbackResponse, Rail } from '@forge/shared';

import { Chip } from '../Chip';
import type { ChipTone } from '../Chip';
import { CopyBox } from '../CopyBox';
import { StatusStepper } from '../StatusStepper';
import { errorCode, sendNotes } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { canRelayNotes, describeTaskError, plainText, safeHttpsUrl } from '../../lib/handoff';
import { PRACTICE_NOTE } from '../../lib/offline';
import styles from './contribute.module.css';

const GITHUB = ['github.com'] as const;
/** The timeline is short on purpose: the newest few lines. */
const TIMELINE_LENGTH = 8;

function checkTone(check: CheckRun): { tone: ChipTone; label: string } {
  if (check.status !== 'completed') {
    return { tone: 'info', label: check.status === 'queued' ? 'waiting' : 'running' };
  }
  switch (check.conclusion) {
    case 'success':
      return { tone: 'ok', label: 'passed' };
    case 'neutral':
    case 'skipped':
      return { tone: 'neutral', label: 'skipped' };
    default:
      return { tone: 'danger', label: 'failed' };
  }
}

function ChecksSummary({ checks }: { checks: CheckResults }) {
  if (checks.state === 'no_pr') {
    return null;
  }
  const failed = checks.checks.filter((check) => checkTone(check).tone === 'danger').length;
  const headline =
    checks.state === 'passed'
      ? 'All checks passed.'
      : checks.state === 'failed'
        ? `${failed} of ${checks.checks.length} checks failed.`
        : 'The checks are running.';
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="muted">{headline}</p>
      {checks.state !== 'passed' && checks.checks.length > 0 && (
        <ul className={styles.checks}>
          {checks.checks.map((check, index) => {
            const { tone, label } = checkTone(check);
            const link = safeHttpsUrl(check.url, GITHUB);
            return (
              <li key={`${check.name}-${index}`}>
                <Chip tone={tone}>{label}</Chip>
                <span>{plainText(check.name, 120)}</span>
                {link !== null && (
                  <a className="faint" href={link} target="_blank" rel="noopener noreferrer">
                    details ↗
                  </a>
                )}
                {check.summary !== undefined && tone === 'danger' && (
                  <span className={styles.checkSummary}>{plainText(check.summary, 240)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Notes({
  taskId,
  checks,
  rail,
  practice,
}: {
  taskId: number;
  checks: CheckResults;
  /** The last hand-off's rail, if known. */
  rail: Rail | null;
  practice: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<FeedbackResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Only a start rail whose vendor takes follow-up notes can be sent them (Jules, Cursor, Devin).
  const started = rail !== null && isStartRail(rail) && canRelayNotes(rail) ? railMeta(rail) : null;

  const send = useCallback(() => {
    setSending(true);
    setFailure(null);
    void sendNotes(taskId)
      .then((result) => {
        setSent(result.data);
      })
      .catch((error: unknown) => {
        setFailure(describeTaskError(errorCode(error)));
      })
      .finally(() => {
        setSending(false);
      });
  }, [taskId]);

  const notes = sent?.notes ?? checks.notes;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h3 className={styles.sub}>Notes for your agent</h3>
      {started !== null ? (
        <>
          <div className="row">
            <button
              type="button"
              className={`btn btn-primary ${styles.wrap}`}
              onClick={send}
              disabled={sending}
              aria-busy={sending || undefined}
            >
              {sending && <span className="spinner" aria-hidden="true" />}
              {sending ? 'Sending the notes…' : `Send the notes to ${started.label}`}
            </button>
          </div>
          <div role="status" aria-live="polite">
            {sent !== null &&
              (sent.relayed ? (
                <p className="muted">
                  Sent to {railMeta(sent.relayedTo ?? started.id).label}. It takes another pass from here.
                  {practice ? ` ${PRACTICE_NOTE}` : ''}
                </p>
              ) : (
                <p className="muted">
                  Nothing was sent: FORGE passes notes on to {started.label} only with a key you saved.
                  If your agent has the FORGE connector, it can read these itself.
                </p>
              ))}
          </div>
          {failure !== null && (
            <p className="muted" role="alert">
              {failure}
            </p>
          )}
        </>
      ) : (
        <p className="muted">If your agent has the FORGE connector, it can read these itself.</p>
      )}
      {notes !== '' && (
        <details className="disclosure">
          <summary>Using another agent? Copy the notes</summary>
          <div className="disclosure-body">
            <CopyBox label="Notes for your agent" text={notes} />
          </div>
        </details>
      )}
    </div>
  );
}

export function TaskProgress({
  taskId,
  status,
  statusFailed,
  checks,
  rail,
  practice,
  onRelease,
}: {
  taskId: number;
  status: BridgeStatus | null;
  statusFailed: boolean;
  checks: CheckResults | null;
  /** The last hand-off's rail: the status's own, or one this page just started. */
  rail: Rail | null;
  practice: boolean;
  /** Resolves true when the task was released. */
  onRelease: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const release = useCallback(() => {
    setReleasing(true);
    void onRelease().then((released) => {
      if (!released) {
        setReleasing(false);
      }
    });
  }, [onRelease]);

  const sessionUrl = safeHttpsUrl(status?.sessionUrl);
  const prUrl = safeHttpsUrl(status?.prUrl, GITHUB);
  const compareUrl = prUrl === null ? safeHttpsUrl(status?.compareUrl, GITHUB) : null;
  const events = (status?.events ?? []).slice(-TIMELINE_LENGTH);
  const lastRail = status?.rail ?? rail;

  return (
    <section className="card stack" aria-labelledby="progress-title">
      <h2 id="progress-title" className="section-title">
        Where it is
      </h2>
      <div aria-live="polite" className="stack">
        {status === null ? (
          statusFailed ? (
            <p className="muted" role="alert">
              We can&apos;t check on this one just now. Your agent carries on either way — come back in
              a few minutes.
            </p>
          ) : (
            <p className="loading-line">
              <span className="spinner" aria-hidden="true" />
              Checking where it is…
            </p>
          )
        ) : (
          <>
            <StatusStepper status={status} />
            {statusFailed && (
              <p className="faint" role="alert">
                This is the last thing we heard. We can&apos;t check for anything newer just now.
              </p>
            )}
          </>
        )}
      </div>

      {(sessionUrl !== null || compareUrl !== null || prUrl !== null) && (
        <div className={styles.links}>
          {sessionUrl !== null && (
            <a className="btn btn-sm" href={sessionUrl} target="_blank" rel="noopener noreferrer">
              Watch it work
            </a>
          )}
          {compareUrl !== null && (
            <a className="btn btn-sm" href={compareUrl} target="_blank" rel="noopener noreferrer">
              Open the pull request on GitHub
            </a>
          )}
          {prUrl !== null && (
            <a className="btn btn-sm" href={prUrl} target="_blank" rel="noopener noreferrer">
              Your pull request on GitHub
            </a>
          )}
        </div>
      )}

      {checks !== null && <ChecksSummary checks={checks} />}
      {checks !== null && checks.state === 'failed' && (
        <Notes taskId={taskId} checks={checks} rail={lastRail} practice={practice} />
      )}

      {events.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <h3 className={styles.sub}>What happened</h3>
          <ol className={styles.timeline}>
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span className={styles.when}>{formatTime(event.at)}</span>
                <span className={styles.what}>
                  <span className={styles.who}>{event.source === 'agent' ? 'Your agent: ' : 'FORGE: '}</span>
                  {plainText(event.message, event.source === 'agent' ? 300 : 500)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <hr className="divider" />
      {confirming ? (
        <div className={styles.confirm} role="group" aria-labelledby="release-question">
          <p id="release-question">
            Release this task? It goes back on the board for someone else. Anything your agent already
            pushed stays in your fork.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={release}
              disabled={releasing}
              aria-busy={releasing || undefined}
            >
              {releasing && <span className="spinner" aria-hidden="true" />}
              {releasing ? 'Releasing…' : 'Yes, release it'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={releasing}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Release this task
          </button>
          <span className="faint">Changed your mind? Hand it back and someone else can pick it up.</span>
        </div>
      )}
    </section>
  );
}
