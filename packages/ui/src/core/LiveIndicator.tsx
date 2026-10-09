/**
 * LiveIndicator (handoff core/LiveIndicator.jsx, PRD 5.4). status: connecting
 * | live | reconnecting | paused | offline | error. Shows last event time,
 * reconnect attempt, next-poll countdown (when interval ≥ 30 s) and an
 * optional "N new" pill.
 */
import type { CSSProperties } from 'react';

import { Button } from './Button';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'offline' | 'error';

export interface LiveIndicatorProps {
  status?: LiveStatus;
  updatedAt?: string;
  attempt?: number;
  nextPollIn?: number;
  onResume?: () => void;
  onRetry?: () => void;
  reason?: string;
  newCount?: number;
  onJumpToNew?: () => void;
  style?: CSSProperties;
}

export function LiveIndicator({ status = 'connecting', updatedAt, attempt, nextPollIn, onResume, onRetry, reason, newCount, onJumpToNew, style }: LiveIndicatorProps) {
  const states: Record<LiveStatus, { c: string; t: string; pulse?: boolean }> = {
    connecting: { c: 'var(--state-neutral)', t: 'Connecting', pulse: true },
    live: { c: 'var(--state-live)', t: 'LIVE', pulse: true },
    reconnecting: { c: 'var(--state-reconnecting)', t: `Reconnecting${attempt ? ` (attempt ${attempt})` : ''}`, pulse: true },
    paused: { c: 'var(--state-neutral)', t: 'Paused' },
    offline: { c: 'var(--state-offline)', t: 'Offline' },
    error: { c: 'var(--state-error)', t: reason || 'Error' },
  };
  const m = states[status];
  return (
    <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: 'var(--type-caption)', color: 'var(--text-secondary)', ...style }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: m.c,
          fontWeight: 600,
          letterSpacing: status === 'live' ? 'var(--tracking-wide)' : 0,
        }}
      >
        <span
          aria-hidden="true"
          className={m.pulse ? 'em-motion' : undefined}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: m.c,
            boxShadow: status === 'live' ? `0 0 0 3px color-mix(in oklab, ${m.c} 25%, transparent)` : 'none',
            animation: m.pulse ? 'em-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        {m.t}
      </span>
      {status === 'live' && updatedAt && <span className="em-num">Updated {updatedAt} UTC</span>}
      {status === 'live' && nextPollIn != null && (
        <span className="em-num" style={{ color: 'var(--text-muted)' }}>
          next in {nextPollIn}s
        </span>
      )}
      {status === 'paused' && (
        <Button size="dense" variant="ghost" onClick={onResume} style={{ height: 24, padding: '0 8px' }}>
          Resume
        </Button>
      )}
      {(status === 'offline' || status === 'error') && (
        <Button size="dense" variant="ghost" onClick={onRetry} style={{ height: 24, padding: '0 8px' }}>
          Retry
        </Button>
      )}
      {newCount != null && newCount > 0 && (
        <button
          type="button"
          onClick={onJumpToNew}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            font: 'var(--type-eyebrow)',
            fontSize: 11,
          }}
        >
          ↑ {newCount} new
        </button>
      )}
    </span>
  );
}
