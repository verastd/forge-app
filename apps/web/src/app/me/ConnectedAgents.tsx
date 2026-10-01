'use client';

/**
 * "Connected agents" on /me: the agents you connected to FORGE through the
 * FORGE connector (each an OAuth grant). An agent's name is whatever the app
 * called itself when it registered, so it is shown as text, next to where it
 * sends you back — the part an app can't make up. Disconnect revokes the
 * grant and every token in it. While the connector is switched off or not
 * set up on the API (`connector-disabled`, `connector_unavailable`), the
 * section isn't shown at all.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ConnectedAgentList } from '@forge/shared';

import { disconnectAgent, errorCode, fetchConnectedAgents } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { CONNECT_PATH, describeTaskError, plainText } from '../../lib/handoff';
import styles from './me.module.css';

/** The connector is switched off (`mcp_connector`) or not set up on the API: there is nothing to show. */
const CONNECTOR_OFF: ReadonlySet<string> = new Set(['connector-disabled', 'connector_unavailable']);

export function ConnectedAgents({ practice }: { practice: boolean }) {
  const [list, setList] = useState<ConnectedAgentList | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (practice) {
      return;
    }
    let cancelled = false;
    setFailed(false);
    void fetchConnectedAgents()
      .then((result) => {
        if (!cancelled) {
          setList(result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          if (CONNECTOR_OFF.has(errorCode(error))) {
            setHidden(true);
          } else {
            setFailed(true);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [practice, attempt]);

  const disconnect = useCallback((id: string, name: string) => {
    setRemoving(id);
    setMessage(null);
    void disconnectAgent(id)
      .then((result) => {
        setList(result);
        setMessage({ text: `Disconnected ${name}. It can no longer reach FORGE as you.`, error: false });
      })
      .catch((error: unknown) => {
        if (CONNECTOR_OFF.has(errorCode(error))) {
          setHidden(true);
          return;
        }
        setMessage({ text: describeTaskError(errorCode(error)), error: true });
      })
      .finally(() => {
        setRemoving(null);
      });
  }, []);

  if (hidden) {
    return null;
  }

  let body;
  if (practice) {
    body = <p className="muted">Not available with a practice account.</p>;
  } else if (failed) {
    body = (
      <div className="stack" role="alert">
        <p className="muted">We can&apos;t show your connected agents just now. Nothing has changed.</p>
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
        Loading your connected agents…
      </p>
    );
  } else if (list.agents.length === 0) {
    body = (
      <p className="muted">
        No agents are connected yet.{' '}
        <Link href={CONNECT_PATH} className={styles.link}>
          Connect your agent to FORGE
        </Link>{' '}
        once and it can pick up tasks and report progress by itself.
      </p>
    );
  } else {
    body = (
      <ul className={styles.items}>
        {list.agents.map((agent) => {
          const name = plainText(agent.clientName, 80) || 'An unnamed app';
          return (
            <li key={agent.id} className={styles.item}>
              <div className={styles.itemText}>
                <p className={styles.itemName}>{name}</p>
                <p className="faint">
                  Sends you back to {plainText(agent.redirectHost, 120)} · connected{' '}
                  {formatDate(agent.connectedAt)} ·{' '}
                  {agent.lastUsedAt === undefined ? 'not used yet' : `last used ${formatDate(agent.lastUsedAt)}`}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  disconnect(agent.id, name);
                }}
                disabled={removing !== null}
                aria-busy={removing === agent.id || undefined}
                aria-label={`Disconnect ${name}`}
              >
                {removing === agent.id ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="card stack" aria-labelledby="connected-agents-title">
      <h2 id="connected-agents-title" className="section-title">
        Connected agents
      </h2>
      {body}
      <div role="status" aria-live="polite">
        {message !== null && <p className={message.error ? styles.error : 'muted'}>{message.text}</p>}
      </div>
    </section>
  );
}
