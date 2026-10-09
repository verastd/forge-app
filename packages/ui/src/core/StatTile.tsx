/**
 * StatTile (handoff core/StatTile.jsx, PRD 5.1 / CM-06). Own loading and error
 * state. `animate` ticks the value on client-side change only (adapted Number
 * Ticker, 600 ms ease-out cubic, skipped under prefers-reduced-motion); never
 * used for balances, money-flow amounts, countdowns, or selection counts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Icon } from './Icon';
import { LiveIndicator } from './LiveIndicator';
import type { LiveStatus } from './LiveIndicator';
import { Skeleton } from './Skeleton';

export interface StatTileProps {
  label: string;
  value?: number | string;
  format?: Intl.NumberFormatOptions;
  delta?: number;
  deltaLabel?: string;
  unit?: string;
  state?: 'ready' | 'loading' | 'error';
  live?: LiveStatus;
  hint?: string;
  animate?: boolean;
  /** Called by the error state's "Retry" link (the handoff rendered it without a handler). */
  onRetry?: () => unknown;
  style?: CSSProperties;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function StatTile({ label, value, format, delta, deltaLabel, unit, state = 'ready', live, hint, animate = false, onRetry, style }: StatTileProps) {
  const fmt = useMemo(() => (typeof value === 'number' ? new Intl.NumberFormat(undefined, format) : null), [format, value]);
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    if (!animate || typeof value !== 'number' || prev.current === value || prefersReducedMotion()) {
      setShown(value);
      prev.current = value;
      return undefined;
    }
    const target = value;
    const from = typeof prev.current === 'number' ? prev.current : 0;
    const start = performance.now();
    const dur = 600;
    let raf = 0;
    const step = (t: number): void => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(from + (target - from) * e);
      if (p < 1) raf = requestAnimationFrame(step);
      else prev.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  // Without `animate` render the prop directly, so a new value never shows one stale frame.
  const display = animate ? shown : value;
  const text = typeof display === 'number' && fmt ? fmt.format(display) : display;
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        padding: '14px 16px',
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          font: 'var(--type-caption)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-wide)',
          fontWeight: 600,
          fontSize: 11,
        }}
      >
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {label}
          {hint && <Icon name="info" size={12} />}
        </span>
        {live && <LiveIndicator status={live} />}
      </div>
      {state === 'loading' ? (
        <>
          <Skeleton height={26} width="60%" />
          <Skeleton height={12} width="35%" />
        </>
      ) : state === 'error' ? (
        <span role="alert" style={{ font: 'var(--type-body-sm)', color: 'var(--state-error)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="circle-alert" size={14} /> Failed to load{' '}
          {onRetry && (
            <button
              type="button"
              onClick={() => void onRetry()}
              style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline', color: 'var(--text-link)' }}
            >
              Retry
            </button>
          )}
        </span>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span aria-hidden={animate ? 'true' : undefined} className="em-num" style={{ font: 'var(--type-num-lg)', color: 'var(--text-primary)', minWidth: '3ch' }}>
              {text}
            </span>
            {animate && <span className="em-sr">{fmt && typeof value === 'number' ? fmt.format(value) : value}</span>}
            {unit && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{unit}</span>}
          </div>
          {delta != null && (
            <span
              className="em-num"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                font: 'var(--type-caption)',
                color: up ? 'var(--price-up)' : down ? 'var(--price-down)' : 'var(--text-muted)',
                fontWeight: 500,
              }}
            >
              <Icon name={up ? 'trending-up' : down ? 'trending-down' : 'minus'} size={12} />
              {up ? '+' : ''}
              {delta}%{deltaLabel && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> {deltaLabel}</span>}
            </span>
          )}
        </>
      )}
    </div>
  );
}
