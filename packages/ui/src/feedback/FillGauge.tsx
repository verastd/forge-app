/**
 * FillGauge (handoff feedback/FillGauge.jsx, adapted SloshGauge SEL-27).
 * Non-interactive meter: current vs max with value text; over-limit state.
 * The liquid glides via --dur-slow, which reduced motion zeroes.
 */
import type { CSSProperties } from 'react';

export interface FillGaugeProps {
  current: number;
  max: number;
  unit?: string;
  label?: string;
  width?: number;
  height?: number;
  style?: CSSProperties;
}

const fmt = (n: number): string => n.toLocaleString();

export function FillGauge({ current = 0, max = 100, unit = '', label, width = 88, height = 150, style }: FillGaugeProps) {
  const over = current > max;
  // Bug fix: a negative `current` gave a negative CSS height; clamp at 0 like the top end.
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const c = over ? 'var(--state-warning)' : 'var(--accent)';
  const text = `${fmt(current)} of ${fmt(max)}${unit ? ` ${unit}` : ''}${over ? ' (over limit)' : ''}`;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.max(0, Math.min(current, max))}
      aria-valuetext={text}
      style={{ display: 'inline-grid', gap: 8, justifyItems: 'center', ...style }}
    >
      <span
        style={{
          position: 'relative',
          width,
          height,
          borderRadius: 'var(--radius-lg)',
          border: '1.5px solid var(--border-strong)',
          background: 'var(--track)',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <span
          aria-hidden="true"
          className="em-motion"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${pct * 100}%`,
            background: c,
            transition: 'height var(--dur-slow) var(--ease-out)',
          }}
        >
          <span style={{ position: 'absolute', top: -4, left: '-10%', width: '120%', height: 8, borderRadius: '50%', background: c, filter: 'brightness(1.15)' }} />
        </span>
        <span
          aria-hidden="true"
          className="em-num"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            font: 'var(--type-num-lg)',
            fontSize: 18,
            color: pct > 0.55 ? 'var(--on-accent)' : 'var(--text-primary)',
            textShadow: pct > 0.55 ? 'none' : undefined,
          }}
        >
          {Math.round(pct * 100)}%
        </span>
      </span>
      <span
        className="em-num"
        style={{ font: 'var(--type-caption)', color: over ? 'var(--state-warning)' : 'var(--text-secondary)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
      >
        {text}
      </span>
    </div>
  );
}
