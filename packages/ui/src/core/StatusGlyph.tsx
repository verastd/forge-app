/**
 * StatusGlyph (handoff core/StatusGlyph.jsx, adapted StatusMark SEL-12).
 * status: pending | running | done | failed | cancelled | awaiting. Shape +
 * color + the product's own state word. No strike-through, full-opacity label.
 */
import type { CSSProperties, ReactNode } from 'react';

import { Icon } from './Icon';

export type GlyphStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'awaiting';

const COLORS: Record<GlyphStatus, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--accent)',
  awaiting: 'var(--accent)',
  done: 'var(--state-success)',
  failed: 'var(--state-error)',
  cancelled: 'var(--text-muted)',
};

export interface StatusGlyphProps {
  status?: GlyphStatus;
  label?: ReactNode;
  /** 0..1 for a measured ring; omit for an indeterminate spin. */
  progress?: number;
  size?: number;
  style?: CSSProperties;
}

export function StatusGlyph({ status = 'pending', label, progress, size = 16, style }: StatusGlyphProps) {
  const c = COLORS[status];
  const r = (size - 3) / 2;
  const circ = 2 * Math.PI * r;
  const ring = status === 'running' || status === 'awaiting';
  const spinning = ring && progress == null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', font: 'var(--type-body-sm)', ...style }}>
      <span
        aria-hidden="true"
        style={{ position: 'relative', width: size, height: size, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: c }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={spinning ? 'em-motion' : undefined}
          style={{ position: 'absolute', inset: 0, animation: spinning ? 'em-spin 1.1s linear infinite' : 'none' }}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill={status === 'done' || status === 'failed' ? c : 'none'}
            stroke={c}
            strokeWidth={1.5}
            strokeDasharray={ring ? `${circ * (progress ?? 0.3)} ${circ}` : undefined}
            strokeLinecap="round"
            opacity={status === 'pending' ? 0.7 : 1}
          />
        </svg>
        {status === 'done' && <Icon name="check" size={size * 0.62} style={{ color: 'var(--surface-card)', position: 'relative' }} />}
        {status === 'failed' && <Icon name="x" size={size * 0.62} style={{ color: 'var(--surface-card)', position: 'relative' }} />}
        {status === 'cancelled' && <span style={{ width: size * 0.45, height: 1.5, background: c, position: 'relative' }} />}
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}
