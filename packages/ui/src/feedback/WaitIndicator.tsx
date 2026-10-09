/**
 * WaitIndicator (handoff feedback/WaitIndicator.jsx, adapted LatticeLoader
 * SEL-22). Wait states with elapsed time from the server's startedAt.
 * status: working | done | error. notice: null | 'slow' | 'timeout' | custom
 * text (announced on change). Retry/Cancel render outside. The lattice cells
 * are .em-motion, so they hold still under reduced motion.
 */
import type { CSSProperties } from 'react';

import { Icon } from '../core/Icon';

export interface WaitIndicatorProps {
  status?: 'working' | 'done' | 'error';
  label?: string;
  doneLabel?: string;
  errorLabel?: string;
  /** Seconds since the server's startedAt. */
  elapsed?: number;
  notice?: 'slow' | 'timeout' | (string & {}) | null;
  grid?: 3 | 4;
  style?: CSSProperties;
}

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

export function WaitIndicator({
  status = 'working',
  label = 'Working',
  doneLabel = 'Done',
  errorLabel = 'Failed',
  elapsed,
  notice,
  grid = 3,
  style,
}: WaitIndicatorProps) {
  const c = status === 'done' ? 'var(--state-success)' : status === 'error' ? 'var(--state-error)' : 'var(--accent)';
  const n = grid * grid;
  return (
    <div role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 12, ...style }}>
      <span aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: `repeat(${grid}, 6px)`, gap: 3, width: grid * 6 + (grid - 1) * 3 }}>
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            className="em-motion"
            style={{
              width: 6,
              height: 6,
              borderRadius: 1.5,
              background: c,
              opacity: status === 'working' ? 0.35 : 1,
              animation: status === 'working' ? `em-lattice 1.6s ease-in-out ${((i % grid) + Math.floor(i / grid)) * 0.12}s infinite` : 'none',
            }}
          />
        ))}
      </span>
      <span style={{ display: 'grid', gap: 2 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            font: 'var(--type-label)',
            color: status === 'error' ? 'var(--state-error)' : 'var(--text-primary)',
          }}
        >
          {status === 'done' && <Icon name="check" size={14} style={{ color: c }} />}
          {status === 'error' && <Icon name="circle-alert" size={14} />}
          {status === 'done' ? doneLabel : status === 'error' ? errorLabel : label}
          {elapsed != null && status === 'working' && (
            <span className="em-num" style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
              {fmt(elapsed)}
            </span>
          )}
        </span>
        {notice && (
          <span role="status" style={{ font: 'var(--type-caption)', color: notice === 'timeout' ? 'var(--state-error)' : 'var(--text-muted)' }}>
            {notice === 'slow' ? 'Still working, Upland is slow' : notice === 'timeout' ? 'Timed out after 10 min. Retry or cancel.' : notice}
          </span>
        )}
      </span>
    </div>
  );
}
