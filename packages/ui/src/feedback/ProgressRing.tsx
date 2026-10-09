/**
 * ProgressRing (handoff feedback/ProgressRing.jsx, adapted Animated Circular
 * Progress Bar SEL-07). Guards max <= min, clamps, shows 99 until value ===
 * max. status: idle | running | indeterminate | success | error. `valueText`
 * renders the "12 of 30" style label. The indeterminate spin is .em-motion.
 *
 * Port note (bug fix): aria-valuenow is clamped to [min, max] like the drawn
 * value; the .jsx passed the raw value, which can fall outside the range.
 */
import type { CSSProperties } from 'react';

import { Icon } from '../core/Icon';

export interface ProgressRingProps {
  value?: number;
  min?: number;
  max?: number;
  size?: number;
  stroke?: number;
  status?: 'idle' | 'running' | 'indeterminate' | 'success' | 'error';
  valueText?: string;
  label?: string;
  caption?: string;
  style?: CSSProperties;
}

export function ProgressRing({ value = 0, min = 0, max = 100, size = 96, stroke = 8, status = 'idle', valueText, label, caption, style }: ProgressRingProps) {
  const empty = max <= min;
  const raw = empty ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const pct = raw >= 1 ? 100 : Math.min(99, Math.floor(raw * 100));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const c = status === 'success' ? 'var(--state-success)' : status === 'error' ? 'var(--state-error)' : 'var(--accent)';
  const indet = status === 'indeterminate';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={empty ? undefined : min}
      aria-valuemax={empty ? undefined : max}
      aria-valuenow={empty || indet ? undefined : Math.max(min, Math.min(max, value))}
      aria-valuetext={valueText || (empty ? 'No data' : `${pct}%`)}
      style={{ display: 'inline-grid', gap: 6, justifyItems: 'center', ...style }}
    >
      <span style={{ position: 'relative', width: size, height: size, display: 'inline-grid', placeItems: 'center' }}>
        <svg
          aria-hidden="true"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={indet ? 'em-motion' : undefined}
          style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)', animation: indet ? 'em-spin 1.4s linear infinite' : 'none' }}
        >
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
          {!empty && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={c}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${indet ? circ * 0.25 : circ * raw} ${circ}`}
              style={{ transition: 'stroke-dasharray var(--dur-slow) var(--ease-out)' }}
            />
          )}
        </svg>
        <span style={{ position: 'relative', display: 'grid', justifyItems: 'center', gap: 0, textAlign: 'center' }}>
          {status === 'success' ? (
            <Icon name="check" size={size * 0.3} style={{ color: c }} />
          ) : status === 'error' ? (
            <Icon name="x" size={size * 0.3} style={{ color: c }} />
          ) : (
            <span
              className="em-num"
              style={{
                font: 'var(--type-num-lg)',
                fontSize: Math.max(11, size * (String(valueText || '').length > 4 ? 0.16 : 0.22)),
                color: empty ? 'var(--text-muted)' : 'var(--text-primary)',
              }}
            >
              {empty ? '—' : indet ? '…' : valueText || `${pct}%`}
            </span>
          )}
        </span>
      </span>
      {caption && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)', textAlign: 'center' }}>{caption}</span>}
    </div>
  );
}
