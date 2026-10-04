'use client';

/**
 * After the hand-off: where the task is, what happened, and what to do next
 * (Phase 4). Driven by the API's status (`BridgeStatus`) and, once a pull
 * request exists, its checks (`CheckResults`).
 *
 * - the stage and its plain-English detail, then a short timeline of events.
 *   An agent's own words arrive through the FORGE connector and are untrusted:
 *   they are shown as text only, cleaned of control characters and cut short;
 * - "Watch it work" (the agent's session, on its vendor's own site) and, once
 *   the task has gone to an agent, the compare page to open the pull request
 *   from, until a pull request exists; then the pull request and its checks;
 * - a closed "Opened a pull request FORGE can't see?" to hand one in by its
 *   link, for an agent that used another branch;
 * - when checks fail, the notes: sent to the agent FORGE started when the
 *   status says FORGE can (`canRelay`: Jules, Cursor or Devin, with the saved
 *   key that started it), or left for an agent with the connector to read,
 *   with a hidden copy as the fallback;
 * - "Release this task", behind a confirm step.
 */

import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { railMeta } from '@forge/shared';
import type { BridgeStatus, CheckResults, CheckRun, StartRail } from '@forge/shared';

import { Chip } from '../Chip';
import type { ChipTone } from '../Chip';
import { CopyBox } from '../CopyBox';
import { StatusStepper } from '../StatusStepper';
import { failureOf, fetchStatus, mayHaveHappened, sendNotes, submitPullRequest } from '../../lib/api';
import { formatTime } from '../../lib/format';
import {
  canRelayNotes,
  describeRelayError,
  describeTaskError,
  lastStartRail,
  notRelayedSentence,
  plainText,
  relayedSince,
  safeHttpsUrl,
  sessionLink,
  showsCompareLink,
} from '../../lib/handoff';
import { PRACTICE_NOTE } from '../../lib/offline';
import styles from './contribute.module.css';

const GITHUB = ['github.com'] as const;
/** The timeline is short on purpose: the newest few lines. */
const TIMELINE_LENGTH = 8;
/** As for a start (StartRails): a relay the status shows from this long before the click counts. */
const RELAY_SKEW_MS = 2 * 60_000;

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

interface Said {
  text: string;
  /** Read out at once (role=alert) rather than politely. */
  alert?: boolean;
  checking?: boolean;
}

/** After a relay that got no answer: whether the status shows the notes went, or that it doesn't yet. */
async function checkRelay(taskId: number, rail: StartRail, label: string, sinceMs: number): Promise<Said> {
  try {
    const { data } = await fetchStatus(taskId, true);
    if (relayedSince(data, rail, sinceMs)) {
      return { text: `Sent to ${label}. It takes another pass from here.` };
    }
  } catch {
    // The status can't be read either: say only what is known.
  }
  return {
    text: `FORGE didn't hear back, and there's no sign yet that the notes reached ${label}. Look at “What happened” below in a minute before you send them again.`,
    alert: true,
  };
}

function Notes({
  taskId,
  checks,
  status,
  practice,
  onChange,
}: {
  taskId: number;
  checks: CheckResults;
  status: BridgeStatus | null;
  practice: boolean;
  /** A relay was tried: the status (and with it `canRelay`) is read again. */
  onChange: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [notesNow, setNotesNow] = useState<string | null>(null);
  // Only when the API says a relay would really happen: the right vendor, and the saved key that started it.
  const rail = status !== null && status.canRelay === true ? lastStartRail(status) : null;
  const started = rail !== null && canRelayNotes(rail) ? railMeta(rail) : null;

  const send = useCallback(() => {
    if (rail === null || started === null) {
      return;
    }
    const pressedAt = Date.now();
    setSending(true);
    setSaid(null);
    void sendNotes(taskId)
      .then((result) => {
        setNotesNow(result.data.notes);
        setSaid(
          result.data.relayed
            ? {
                text: `Sent to ${railMeta(result.data.relayedTo ?? rail).label}. It takes another pass from here.${practice ? ` ${PRACTICE_NOTE}` : ''}`,
              }
            : { text: notRelayedSentence(started.label) },
        );
      })
      .catch(async (error: unknown) => {
        if (mayHaveHappened(error)) {
          // No answer is not a "no": the vendor may have them already.
          setSaid({ text: 'The notes may have been sent. Checking…', checking: true });
          setSaid(await checkRelay(taskId, rail, started.label, pressedAt - RELAY_SKEW_MS));
        } else {
          setSaid({ text: describeRelayError(failureOf(error), started), alert: true });
        }
      })
      .finally(() => {
        setSending(false);
        onChange();
      });
  }, [onChange, practice, rail, started, taskId]);

  const notes = notesNow ?? checks.notes;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <h3 className={styles.sub}>Notes for your agent</h3>
      {started !== null ? (
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
      ) : (
        <p className="muted">If your agent has the FORGE connector, it can read these itself.</p>
      )}
      {/* Outside the button's branch: a relay that changes `canRelay` still says what happened. */}
      <div role="status" aria-live="polite">
        {said !== null && said.alert !== true && (
          <p className="muted">
            {said.checking === true && <span className="spinner" aria-hidden="true" />}
            {said.text}
          </p>
        )}
      </div>
      {said !== null && said.alert === true && (
        <p className="muted" role="alert">
          {said.text}
        </p>
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

/**
 * Hand in a pull request by its link: for one FORGE can't find by itself,
 * because the agent opened it from another branch (contract §5, submit).
 */
function HandIn({ taskId, onChange }: { taskId: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const value = new FormData(form).get('prUrl');
      const prUrl = typeof value === 'string' ? value.trim() : '';
      if (prUrl === '' || busy) {
        return;
      }
      setBusy(true);
      setSaid(null);
      void submitPullRequest(taskId, prUrl)
        .then(() => {
          form.reset();
          setSaid({ text: 'FORGE has your pull request. Its checks show up here as they run.' });
          onChange();
        })
        .catch((error: unknown) => {
          if (mayHaveHappened(error)) {
            // No answer is not a "no": FORGE may have it. The status, read
            // again, shows the pull request if it does.
            setSaid({ text: describeTaskError('upstream_timeout', taskId), alert: true });
            onChange();
            return;
          }
          setSaid({ text: describeTaskError(failureOf(error), taskId), alert: true });
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [busy, onChange, taskId],
  );

  return (
    <details className="disclosure">
      <summary>Opened a pull request FORGE can&apos;t see?</summary>
      <form className="disclosure-body stack" onSubmit={submit}>
        <p className="muted">
          FORGE looks for one on the task&apos;s branch. If your agent used another branch, paste the pull
          request&apos;s link here.
        </p>
        <div className={styles.field}>
          <label htmlFor={`hand-in-${taskId}`}>Your pull request&apos;s link</label>
          <input
            id={`hand-in-${taskId}`}
            name="prUrl"
            type="url"
            inputMode="url"
            className={`text-input ${styles.input}`}
            placeholder="https://github.com/verastd/forge-app/pull/…"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={500}
            disabled={busy}
          />
        </div>
        <div className="row">
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Handing it in…' : 'Hand it in'}
          </button>
        </div>
        <div role="status" aria-live="polite">
          {said !== null && said.alert !== true && <p className="muted">{said.text}</p>}
        </div>
        {said !== null && said.alert === true && (
          <p className="muted" role="alert">
            {said.text}
          </p>
        )}
      </form>
    </details>
  );
}

export function TaskProgress({
  taskId,
  status,
  statusFailed,
  checks,
  practice,
  onRelease,
  onChange,
}: {
  taskId: number;
  status: BridgeStatus | null;
  statusFailed: boolean;
  checks: CheckResults | null;
  practice: boolean;
  /** Resolves true when the task was released. */
  onRelease: () => Promise<boolean>;
  /** Something here changed the task (notes sent, a pull request handed in): read the status again. */
  onChange: () => void;
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

  const sessionUrl = status === null ? null : sessionLink(status.sessionUrl, lastStartRail(status));
  const prUrl = safeHttpsUrl(status?.prUrl, GITHUB);
  // Before the task has gone to an agent there is no branch, so nothing to compare yet.
  const compareUrl =
    prUrl === null && status !== null && showsCompareLink(status) ? safeHttpsUrl(status.compareUrl, GITHUB) : null;
  const events = (status?.events ?? []).slice(-TIMELINE_LENGTH);

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
              When your agent has pushed its branch: open the pull request
            </a>
          )}
          {prUrl !== null && (
            <a className="btn btn-sm" href={prUrl} target="_blank" rel="noopener noreferrer">
              Your pull request on GitHub
            </a>
          )}
        </div>
      )}
      {status !== null && prUrl === null && <HandIn taskId={taskId} onChange={onChange} />}

      {checks !== null && <ChecksSummary checks={checks} />}
      {checks !== null && checks.state === 'failed' && (
        <Notes taskId={taskId} checks={checks} status={status} practice={practice} onChange={onChange} />
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
