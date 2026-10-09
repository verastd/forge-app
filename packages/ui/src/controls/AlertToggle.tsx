/**
 * AlertToggle (handoff controls/AlertToggle.jsx, adapted BellToggle SEL-23).
 * Controlled aria-pressed bell. status: off | on | pending | error | denied |
 * locked. Constant accessible name = the rule label; pending ignores input;
 * error reverts with message + Retry; denied shows an OS fix link.
 *
 * Pass `status` to drive it, or return a Promise from `onChange` to let it run
 * its own lifecycle: pending until the promise settles, `on` only follows the
 * parent after it resolves, a rejection shows the error (persistent) with a
 * Retry that re-sends the same change.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import type { IconName } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export type AlertToggleStatus = 'off' | 'on' | 'pending' | 'error' | 'denied' | 'locked';

export interface AlertToggleProps {
  on?: boolean;
  /** Return a Promise to get pending / error handling for free. */
  onChange?: (v: boolean) => void | Promise<unknown>;
  label: string;
  status?: AlertToggleStatus;
  error?: string;
  onRetry?: () => void;
  deniedHelpHref?: string;
  lockedTier?: string;
  count?: number;
  size?: 'dense' | 'standard';
  style?: CSSProperties;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

const ICON: Record<AlertToggleStatus, IconName> = { off: 'bell', on: 'bell-ring', error: 'bell', denied: 'bell-off', locked: 'lock', pending: 'bell' };

export function AlertToggle({ on = false, onChange, label, status, error, onRetry, deniedHelpHref, lockedTier, count, size = 'standard', style }: AlertToggleProps) {
  const [inner, setInner] = useState<'pending' | 'error' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const st: AlertToggleStatus = status || inner || (on ? 'on' : 'off');
  const inert = st === 'pending' || st === 'locked' || st === 'denied';
  const h = size === 'dense' ? 28 : 32;
  const send = (v: boolean): void => {
    last.current = v;
    const r = onChange?.(v);
    if (!isThenable(r)) return;
    setErr(null);
    setInner('pending');
    r.then(
      () => {
        if (alive.current) setInner(null);
      },
      (e: unknown) => {
        if (!alive.current) return;
        setErr(e instanceof Error && e.message ? e.message : null);
        setInner('error');
      },
    );
  };
  // In error the bell shows the reverted value, so a click retries `!on`
  // (the source always sent `true`, which could never turn an alert off).
  const target = st === 'on' ? false : st === 'error' ? !on : true;
  const retry = onRetry ?? (inner === 'error' ? () => send(last.current) : undefined);
  const btn = (
    <button
      type="button"
      aria-pressed={st === 'on'}
      aria-label={label}
      aria-busy={st === 'pending' || undefined}
      aria-disabled={inert || undefined}
      onClick={() => {
        if (!inert) send(target);
      }}
      style={{
        all: 'unset',
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: h,
        padding: '0 10px 0 8px',
        borderRadius: 'var(--radius-pill)',
        border: `1px solid ${st === 'on' ? 'var(--accent)' : st === 'error' ? 'var(--state-error)' : 'var(--border-subtle)'}`,
        background: st === 'on' ? 'var(--accent-soft)' : 'var(--surface-card)',
        color: st === 'on' ? 'var(--accent-strong)' : st === 'error' ? 'var(--state-error)' : 'var(--text-secondary)',
        font: 'var(--type-label)',
        fontSize: 'var(--text-xs)',
        cursor: inert ? 'not-allowed' : 'pointer',
        opacity: st === 'locked' || st === 'denied' ? 0.6 : 1,
        transition: 'all var(--dur-fast)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {st === 'pending' ? <Spinner size={14} label="" /> : <Icon name={ICON[st]} size={14} />}
      <span>{st === 'on' ? 'Notifying' : st === 'pending' ? 'Saving' : st === 'denied' ? 'Blocked' : st === 'locked' ? lockedTier || 'Locked' : 'Notify me'}</span>
      {count != null && count > 0 && (
        <span
          aria-label={`${count} alerts`}
          className="em-num"
          style={{
            marginLeft: 2,
            padding: '0 5px',
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            background: 'var(--state-error)',
            color: 'var(--on-danger)',
            font: 'var(--type-eyebrow)',
            fontSize: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
  const wrapped =
    st === 'locked' ? (
      <Hint persistent content={`Requires ${lockedTier || 'a paid plan'}`}>
        {btn}
      </Hint>
    ) : st === 'denied' ? (
      <Hint persistent content="Notifications are blocked in your browser settings.">
        {btn}
      </Hint>
    ) : (
      btn
    );
  return (
    <span style={{ display: 'inline-grid', gap: 4, justifyItems: 'start' }}>
      {wrapped}
      {st === 'error' && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error || err || 'Couldn’t save'}{' '}
          <button type="button" onClick={retry} style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-link)', textDecoration: 'underline' }}>
            Retry
          </button>
        </span>
      )}
      {st === 'denied' && deniedHelpHref && (
        <a href={deniedHelpHref} style={{ font: 'var(--type-caption)', color: 'var(--text-link)' }}>
          How to allow notifications
        </a>
      )}
    </span>
  );
}
