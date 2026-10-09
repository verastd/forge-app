/**
 * SpeedSlider (handoff controls/SpeedSlider.jsx, adapted WakeSlider SEL-19).
 * Playback speed 1–100×. Lit bars + value text; onChange during drag,
 * onCommit on release / key-up. Focusable when disabled, with a reason.
 * Never used as a time scrubber.
 */
import { useRef } from 'react';
import type { CSSProperties } from 'react';

export interface SpeedSliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  bars?: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  label?: string;
  formatValue?: (v: number) => string;
  disabledReason?: string;
  width?: number | string;
  style?: CSSProperties;
}

const defaultFormat = (v: number): string => `${v}×`;

export function SpeedSlider({
  value = 1,
  min = 1,
  max = 100,
  step = 1,
  bars = 32,
  onChange,
  onCommit,
  label = 'Playback speed',
  formatValue = defaultFormat,
  disabledReason,
  width = 240,
  style,
}: SpeedSliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (value - min) / (max - min);
  const lit = Math.round(pct * bars);
  const fromX = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect();
    const p = r && r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    return Math.round((min + p * (max - min)) / step) * step;
  };
  const drag = useRef(false);
  const keyed = useRef(false);
  const KEYS: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 };
  return (
    <div style={{ display: 'inline-grid', gap: 6, width, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
        <span>{label}</span>
        <span className="em-num" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
          {formatValue(value)}
        </span>
      </div>
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatValue(value)}
        aria-disabled={disabledReason ? true : undefined}
        title={disabledReason}
        onPointerDown={(e) => {
          if (disabledReason) return;
          drag.current = true;
          const el = e.currentTarget;
          if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
          onChange?.(fromX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (drag.current) onChange?.(fromX(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = false;
          onCommit?.(fromX(e.clientX));
        }}
        onPointerCancel={() => {
          drag.current = false;
        }}
        onKeyDown={(e) => {
          if (disabledReason) return;
          const d = KEYS[e.key];
          let v = value;
          if (d != null) v = value + d;
          else if (e.key === 'Home') v = min;
          else if (e.key === 'End') v = max;
          else return;
          e.preventDefault();
          keyed.current = true;
          onChange?.(Math.max(min, Math.min(max, v)));
        }}
        onKeyUp={() => {
          // Only after a key that moved it (the source committed on every
          // key-up, e.g. the Tab that focused it, and while disabled).
          if (!keyed.current) return;
          keyed.current = false;
          onCommit?.(value);
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${bars}, 1fr)`,
          gap: 2,
          height: 28,
          alignItems: 'end',
          cursor: disabledReason ? 'not-allowed' : 'pointer',
          opacity: disabledReason ? 0.55 : 1,
          borderRadius: 4,
          touchAction: 'none',
        }}
      >
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            data-lit={i < lit || undefined}
            style={{
              height: `${40 + 60 * Math.pow(i / bars, 0.7)}%`,
              borderRadius: 1,
              background: i < lit ? (i === lit - 1 ? 'var(--accent-strong)' : 'var(--accent)') : 'var(--track)',
              transition: 'background var(--dur-fast)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
