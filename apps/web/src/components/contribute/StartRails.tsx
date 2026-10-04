'use client';

/**
 * "Start it for me": FORGE starts the contributor's agent through the
 * vendor's API, on their own account, and it opens a pull request from their
 * fork (Phase 4 contract §2, start rails).
 *
 * One button per start rail the API says is on. Choosing one opens its panel:
 * the one-time setup with real links, then whatever that rail needs to start —
 * nothing (a saved key, or Copilot's GitHub authorization) or a key pasted
 * once. A pasted key is read from the form when it is submitted, the form is
 * cleared straight away, and the key lives only in that one request: it is
 * never put in component state, never shown back, never logged. The key
 * fields carry a name of their own per vendor and ask password managers to
 * leave them alone, so one vendor's key is never offered into another's field.
 *
 * A start that gets no answer may still have happened (the vendor was slow,
 * the network dropped): the panel says so and reads the task's status before
 * it says anything else, never "nothing changed".
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ROUTINE_PROMPT } from '@forge/shared';
import type { Credential, RailInfo, StartRail } from '@forge/shared';

import { CopyBox } from '../CopyBox';
import { ConflictError, errorCode, failureOf, fetchStatus, mayHaveHappened, startAgent } from '../../lib/api';
import {
  credentialFields,
  describeStartError,
  keyName,
  sessionLink,
  setupStepLink,
  setupSteps,
  startedSentence,
  startedSince,
} from '../../lib/handoff';
import type { CredentialFieldName } from '../../lib/handoff';
import { PRACTICE_NOTE } from '../../lib/offline';
import styles from './contribute.module.css';

interface Message {
  tone: 'ok' | 'error' | 'practice' | 'checking';
  text: string;
  sessionUrl?: string | null;
  saved?: boolean;
}

/**
 * A start the status shows from this long before the click still counts as
 * this one: the API's clock and this browser's may differ a little. (A second
 * press within two minutes gets the API's `already_started` anyway.)
 */
const START_SKEW_MS = 2 * 60_000;

/** The form field for one part of a rail's credential: its own name per vendor (`jules-key`, `devin-orgId`). */
function inputName(rail: StartRail, field: CredentialFieldName): string {
  return `${rail}-${field}`;
}

/** A rail's one-time setup, each step linked where there is somewhere to go. */
export function SetupSteps({
  meta,
  vault,
  appSlug,
  connector = true,
}: {
  meta: Pick<RailInfo, 'id' | 'setup' | 'keyUrl'>;
  vault: boolean;
  appSlug: string | null;
  /** The `mcp_connector` flag: off, the "Connect your agent to FORGE" step is left out. */
  connector?: boolean;
}) {
  return (
    <ol className="steps">
      {setupSteps(meta, vault, connector).map((step) => {
        const link = setupStepLink(meta, step, appSlug);
        return (
          <li key={step}>
            {link === null ? (
              step
            ) : link.external ? (
              <a href={link.href} target="_blank" rel="noopener noreferrer" className={styles.inlineLink}>
                {step}
              </a>
            ) : (
              <Link href={link.href} className={styles.inlineLink}>
                {step}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Outcome({ message, label }: { message: Message; label: string }) {
  const tone =
    message.tone === 'ok' || message.tone === 'checking'
      ? styles.outcomeOk
      : message.tone === 'practice'
        ? styles.outcomePractice
        : styles.outcomeError;
  return (
    <div className={`${styles.outcome} ${tone}`}>
      <p className={styles.outcomeTitle}>
        {message.tone === 'checking' && <span className="spinner" aria-hidden="true" />}
        {message.text}
      </p>
      {message.tone === 'practice' && <p className="muted">{PRACTICE_NOTE}</p>}
      {message.saved === true && <p className="muted">Your key is saved, encrypted, for next time.</p>}
      {message.sessionUrl !== undefined && message.sessionUrl !== null && (
        <p>
          <a className="btn btn-sm" href={message.sessionUrl} target="_blank" rel="noopener noreferrer">
            Watch it work
            <span className="visually-hidden"> ({label}, opens in a new tab)</span>
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * After a start that got no answer: whether the task's status shows it
 * started (and where to watch it), or plain words that it doesn't yet.
 */
async function checkStart(
  taskId: number,
  rail: StartRail,
  label: string,
  sinceMs: number,
  identified: boolean,
): Promise<{ started: boolean; message: Message }> {
  try {
    const { data } = await fetchStatus(taskId, identified);
    if (startedSince(data, rail, sinceMs)) {
      return {
        started: true,
        message: { tone: 'ok', text: startedSentence(label), sessionUrl: sessionLink(data.sessionUrl, rail) },
      };
    }
  } catch {
    // The status can't be read either: say only what is known.
  }
  return {
    started: false,
    message: {
      tone: 'error',
      text: `FORGE didn't hear back, and this task shows no start yet. Check “Where it is” below in a minute before you start ${label} again.`,
    },
  };
}

export function StartRails({
  taskId,
  rails,
  vault,
  appSlug,
  practice,
  onStarted,
  onCheck,
}: {
  taskId: number;
  /** The start rails the API says are on, in display order. */
  rails: readonly RailInfo[];
  vault: boolean;
  appSlug: string | null;
  practice: boolean;
  /** A start went through (or had already): the page reads the status again. */
  onStarted: (rail: StartRail) => void;
  /** A start that got no answer was checked: the page reads the status again. */
  onCheck: () => void;
}) {
  const [open, setOpen] = useState<StartRail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [differentKey, setDifferentKey] = useState(false);
  /** Saved-key state learned since the list loaded: a start that saved one, a rejected one removed. */
  const [savedNow, setSavedNow] = useState<Partial<Record<StartRail, boolean>>>({});
  const heading = useRef<HTMLHeadingElement>(null);

  const choose = useCallback((rail: StartRail) => {
    setOpen((current) => (current === rail ? null : rail));
    setMessage(null);
    setDifferentKey(false);
  }, []);

  useEffect(() => {
    if (open !== null) {
      heading.current?.focus();
    }
  }, [open]);

  const meta = rails.find((rail) => rail.id === open);
  const railId = meta?.id as StartRail | undefined;
  const saved = meta !== undefined && railId !== undefined && (savedNow[railId] ?? meta.savedCredential === true);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>, useSaved: boolean) => {
      event.preventDefault();
      if (meta === undefined || railId === undefined || busy) {
        return;
      }
      const form = event.currentTarget;
      const data = new FormData(form);
      const field = (name: CredentialFieldName): string => {
        const value = data.get(inputName(railId, name));
        return typeof value === 'string' ? value.trim() : '';
      };
      let credential: Credential | undefined;
      if (!useSaved) {
        const orgId = field('orgId');
        const routineUrl = field('routineUrl');
        credential = {
          key: field('key'),
          ...(orgId === '' ? {} : { orgId }),
          ...(routineUrl === '' ? {} : { routineUrl }),
        };
      }
      const save = !useSaved && vault && data.get('remember') === 'on';
      // The key leaves the page's inputs as soon as it has been read.
      form.reset();
      setBusy(true);
      setMessage(null);
      const pressedAt = Date.now();
      try {
        const result = await startAgent({
          taskId,
          rail: railId,
          ...(credential === undefined ? {} : { credential }),
          ...(save ? { saveCredential: true } : {}),
        });
        const keptKey = result.data.credentialSaved === true;
        if (keptKey) {
          setSavedNow((current) => ({ ...current, [railId]: true }));
          setDifferentKey(false);
        }
        setMessage({
          tone: result.degraded ? 'practice' : 'ok',
          text: startedSentence(meta.label),
          sessionUrl: sessionLink(result.data.sessionUrl, railId),
          saved: keptKey,
        });
        onStarted(railId);
      } catch (error) {
        if (error instanceof ConflictError && error.code === 'already_started') {
          // The first press went through: say so, and where to watch it.
          setMessage({
            tone: 'ok',
            text: describeStartError(failureOf(error), meta),
            sessionUrl: sessionLink(error.extra.sessionUrl, railId),
          });
          onStarted(railId);
        } else if (mayHaveHappened(error)) {
          // No answer is not a "no": the API may be starting it right now.
          credential = undefined;
          setMessage({ tone: 'checking', text: 'It may have started. Checking…' });
          const checked = await checkStart(taskId, railId, meta.label, pressedAt - START_SKEW_MS, !practice);
          setMessage(checked.message);
          if (checked.started) {
            onStarted(railId);
          } else {
            onCheck();
          }
        } else {
          if (errorCode(error) === 'credential_rejected' && useSaved) {
            // The API deletes a saved key the vendor refused.
            setSavedNow((current) => ({ ...current, [railId]: false }));
          }
          setMessage({
            tone: 'error',
            text: describeStartError({ ...failureOf(error), usedSavedKey: useSaved }, meta),
          });
        }
      } finally {
        credential = undefined;
        setBusy(false);
      }
    },
    [busy, meta, onCheck, onStarted, practice, railId, taskId, vault],
  );

  let form: ReactNode = null;
  if (meta !== undefined && railId !== undefined) {
    const startLabel = busy ? (
      <>
        <span className="spinner" aria-hidden="true" />
        Starting…
      </>
    ) : (
      `Start ${meta.label}`
    );
    if (meta.credential === 'github' && !practice) {
      // A plain form POST: GitHub's authorize page has to be a top-level navigation.
      form = (
        <form method="post" action="/auth/github/agent" className={styles.form}>
          <input type="hidden" name="taskId" value={taskId} />
          <div className="row">
            <button type="submit" className={`btn btn-primary ${styles.wrap}`}>
              Start {meta.label}
            </button>
          </div>
          <p className="faint">
            FORGE asks GitHub for a one-time approval. If you&apos;ve approved FORGE before, GitHub may not
            show you a page. FORGE uses it for this one start, then revokes it.
          </p>
        </form>
      );
    } else if ((saved && !differentKey) || meta.credential === 'github') {
      form = (
        <form className={styles.form} onSubmit={(event) => void submit(event, true)}>
          <div className="row">
            <button
              type="submit"
              className={`btn btn-primary ${styles.wrap}`}
              disabled={busy}
              aria-busy={busy || undefined}
            >
              {startLabel}
            </button>
            {meta.credential !== 'github' && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setDifferentKey(true);
                  setMessage(null);
                }}
              >
                Use a different key
              </button>
            )}
          </div>
          {meta.credential !== 'github' && <p className="faint">Uses the key you saved with FORGE.</p>}
        </form>
      );
    } else {
      const fields = credentialFields(meta.credential, keyName(meta));
      form = (
        <form className={styles.form} autoComplete="off" onSubmit={(event) => void submit(event, false)}>
          {fields.map((field) => (
            <div className={styles.field} key={field.name}>
              <label htmlFor={`start-${meta.id}-${field.name}`}>{field.label}</label>
              <input
                id={`start-${meta.id}-${field.name}`}
                name={inputName(railId, field.name)}
                type="password"
                className={`text-input ${styles.input}`}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                // Password managers: never save or fill this (1Password, LastPass).
                data-1p-ignore=""
                data-lpignore="true"
                required
                maxLength={field.maxLength}
                disabled={busy}
              />
            </div>
          ))}
          {vault && (
            <div>
              <div className={styles.check}>
                <input id={`start-${meta.id}-remember`} name="remember" type="checkbox" disabled={busy} />
                <label htmlFor={`start-${meta.id}-remember`}>
                  Remember it, encrypted, so next time is one click
                </label>
              </div>
              <p className="faint" style={{ marginTop: 6 }}>
                You can remove saved keys on{' '}
                <Link href="/me" className={styles.inlineLink}>
                  your profile
                </Link>
                .
              </p>
            </div>
          )}
          <div className="row">
            <button
              type="submit"
              className={`btn btn-primary ${styles.wrap}`}
              disabled={busy}
              aria-busy={busy || undefined}
            >
              {startLabel}
            </button>
            {saved && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDifferentKey(false)}>
                Use my saved key
              </button>
            )}
          </div>
        </form>
      );
    }
  }

  return (
    <div className="stack">
      <ul className={styles.railGrid}>
        {rails.map((rail) => {
          const chosen = open === rail.id;
          return (
            <li key={rail.id} className={styles.railItem}>
              <button
                type="button"
                className={`rail ${chosen ? styles.railChosen : ''}`}
                aria-expanded={chosen}
                // Only the open rail's panel exists to be controlled.
                aria-controls={chosen ? `start-panel-${rail.id}` : undefined}
                onClick={() => choose(rail.id as StartRail)}
              >
                <span className="rail-head">
                  <span className="rail-name">{rail.label}</span>
                  {(savedNow[rail.id as StartRail] ?? rail.savedCredential === true) && (
                    <span className="chip chip-ok">key saved</span>
                  )}
                </span>
                {rail.plan !== undefined && <span className="rail-grade">{rail.plan}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {meta !== undefined && (
        <div
          id={`start-panel-${meta.id}`}
          className={styles.panel}
          role="region"
          aria-labelledby={`start-panel-${meta.id}-title`}
        >
          <h3 id={`start-panel-${meta.id}-title`} ref={heading} tabIndex={-1} className={styles.sub}>
            Start {meta.label}
          </h3>
          <p className="muted">{meta.blurb}</p>
          <div className="stack" style={{ gap: 10 }}>
            <p className="faint">Once, before your first start:</p>
            <SetupSteps meta={meta} vault={vault} appSlug={appSlug} />
          </div>
          {meta.id === 'claude-routine' && (
            <details className="disclosure">
              <summary>FORGE&apos;s routine prompt</summary>
              <div className="disclosure-body stack">
                <p className="muted">Paste this into your routine once, when you create it.</p>
                <CopyBox label="Routine prompt" text={ROUTINE_PROMPT} />
              </div>
            </details>
          )}
          {form}
          <div role="status" aria-live="polite">
            {message !== null && message.tone !== 'error' && <Outcome message={message} label={meta.label} />}
          </div>
          <div role="alert">
            {message !== null && message.tone === 'error' && <Outcome message={message} label={meta.label} />}
          </div>
        </div>
      )}
    </div>
  );
}
