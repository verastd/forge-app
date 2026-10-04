'use client';

/**
 * "Your agent keys" on /me: the keys FORGE saved, encrypted, because you
 * ticked "Remember it" when you started an agent ("Start it for me"). Only
 * the hint the API sends is ever shown (the last few characters), never a
 * key. Remove deletes one for good. With the vault off, FORGE can't use the
 * keys it saved, but they are still listed so they can be removed.
 */

import { useCallback, useEffect, useState } from 'react';
import { railMeta } from '@forge/shared';
import type { Rail, SavedCredentialList } from '@forge/shared';

import { errorCode, fetchSavedKeys, removeSavedKey } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { describeTaskError, plainText } from '../../lib/handoff';
import styles from './me.module.css';

export function AgentKeys({ practice }: { practice: boolean }) {
  const [list, setList] = useState<SavedCredentialList | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<Rail | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (practice) {
      return;
    }
    let cancelled = false;
    setFailed(false);
    void fetchSavedKeys()
      .then((result) => {
        if (!cancelled) {
          setList(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [practice, attempt]);

  const remove = useCallback((rail: Rail) => {
    const label = railMeta(rail).label;
    setRemoving(rail);
    setMessage(null);
    void removeSavedKey(rail)
      .then((result) => {
        setList(result);
        setMessage({ text: `Removed your ${label} key. FORGE no longer has it.`, error: false });
      })
      .catch((error: unknown) => {
        setMessage({ text: describeTaskError(errorCode(error)), error: true });
      })
      .finally(() => {
        setRemoving(null);
      });
  }, []);

  let body;
  if (practice) {
    body = <p className="muted">Not available with a practice account.</p>;
  } else if (failed) {
    body = (
      <div className="stack" role="alert">
        <p className="muted">We can&apos;t show your agent keys just now. Nothing has changed.</p>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  } else if (list === null) {
    body = (
      <p className="loading-line" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        Loading your keys…
      </p>
    );
  } else if (list.credentials.length === 0) {
    body = (
      <p className="muted">
        {list.vault
          ? 'No saved keys. When FORGE starts an agent for you, you can ask it to remember the key, encrypted, so next time is one click.'
          : "This FORGE server doesn't save keys, so there are none here. You give your key each time FORGE starts an agent for you."}
      </p>
    );
  } else {
    body = (
      <>
        {!list.vault && (
          <p className="muted">FORGE can&apos;t use saved keys right now; you can still remove them.</p>
        )}
        <ul className={styles.items}>
          {list.credentials.map((credential) => {
            const label = railMeta(credential.rail).label;
            return (
              <li key={credential.rail} className={styles.item}>
                <div className={styles.itemText}>
                  <p className={styles.itemName}>{label}</p>
                  <p className="faint">
                    Key ending {plainText(credential.hint, 16)} · saved {formatDate(credential.savedAt)} ·{' '}
                    {credential.lastUsedAt === undefined
                      ? 'not used yet'
                      : `last used ${formatDate(credential.lastUsedAt)}`}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    remove(credential.rail);
                  }}
                  disabled={removing !== null}
                  aria-busy={removing === credential.rail || undefined}
                  aria-label={`Remove your ${label} key`}
                >
                  {removing === credential.rail ? 'Removing…' : 'Remove'}
                </button>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <section className="card stack" aria-labelledby="agent-keys-title">
      <h2 id="agent-keys-title" className="section-title">
        Your agent keys
      </h2>
      {body}
      <div role="status" aria-live="polite">
        {message !== null && (
          <p className={message.error ? styles.error : 'muted'}>{message.text}</p>
        )}
      </div>
    </section>
  );
}
