/**
 * NumberField (handoff controls/NumberField.jsx, adapted ScrubField SEL-18).
 * Filter numbers only, never money. value: number | null (null = no bound).
 * Fully controlled; commits on blur/Enter only when changed; rejects garbage;
 * out-of-range shows an error; arrow nudge (Shift ×10); Escape reverts;
 * optional drag scrub on the label.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';

import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export interface NumberFieldProps {
  value: number | null;
  onCommit?: (v: number | null) => void;
  label?: string;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  width?: number | string;
  scrub?: boolean;
  error?: string;
  pending?: boolean;
  disabledReason?: string;
  size?: 'dense' | 'standard' | 'comfortable';
  style?: CSSProperties;
}

const HEIGHTS = { dense: 'var(--control-dense)', standard: 'var(--control-standard)', comfortable: 'var(--control-comfortable)' } as const;

const show = (v: number | null): string => (v == null ? '' : String(v));

/** '' → null, a plain decimal → number, anything else → NaN. Commas are ignored. */
function parseNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (t === '') return null;
  if (!/^-?\d*\.?\d+$/.test(t)) return NaN;
  return Number(t);
}

export function NumberField({
  value,
  onCommit,
  label,
  prefix,
  suffix,
  min,
  max,
  step = 1,
  placeholder = 'Any',
  width = 120,
  scrub = true,
  error,
  pending,
  disabledReason,
  size = 'standard',
  style,
}: NumberFieldProps) {
  const [text, setText] = useState(show(value));
  useEffect(() => {
    setText(show(value));
  }, [value]);
  const parsed = parseNumber(text);
  const num = typeof parsed === 'number' && !Number.isNaN(parsed) ? parsed : null;
  const range = num != null && ((min != null && num < min) || (max != null && num > max));
  const invalid = Number.isNaN(parsed) || range;
  const err =
    error ||
    (Number.isNaN(parsed)
      ? 'Enter a number'
      : range
        ? `Must be ${min != null ? `≥ ${min}` : ''}${min != null && max != null ? ' and ' : ''}${max != null ? `≤ ${max}` : ''}`
        : null);
  const clamp = (v: number): number => {
    let r = v;
    if (min != null) r = Math.max(min, r);
    if (max != null) r = Math.min(max, r);
    return +r.toFixed(6);
  };
  const commit = (): void => {
    if (invalid) return;
    if (parsed !== value) onCommit?.(parsed);
  };
  const nudge = (d: number): void => {
    const v = clamp((num ?? min ?? 0) + d);
    setText(String(v));
    // Only when it changed (the source re-committed the same bound at min/max).
    if (v !== value) onCommit?.(v);
  };
  // Enter commits and blurs; the blur must not commit a second time before
  // the parent re-renders with the new value (the source double-fired).
  const skipBlur = useRef(false);
  const drag = useRef<{ x: number; v: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!scrub || disabledReason) return;
    drag.current = { x: e.clientX, v: num ?? min ?? 0 };
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!drag.current) return;
    const dv = Math.round((e.clientX - drag.current.x) / 4) * step;
    setText(String(clamp(drag.current.v + dv)));
  };
  const onUp = (): void => {
    if (!drag.current) return;
    drag.current = null;
    commit();
  };
  const h = HEIGHTS[size];
  return (
    <label style={{ display: 'inline-grid', gap: 4, width, ...style }}>
      {label && (
        <span
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-muted)',
            cursor: scrub && !disabledReason ? 'ew-resize' : 'default',
            userSelect: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {label}
          {scrub && !disabledReason && <Icon name="move-horizontal" size={11} style={{ opacity: 0.6 }} />}
        </span>
      )}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          overflow: 'hidden',
          height: h,
          boxSizing: 'border-box',
          border: `1px solid ${err ? 'var(--state-error)' : 'var(--border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-card)',
          padding: '0 6px 0 var(--control-padding-x)',
          gap: 4,
          opacity: disabledReason ? 0.55 : 1,
        }}
      >
        {prefix && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{prefix}</span>}
        <input
          role="spinbutton"
          inputMode="decimal"
          aria-invalid={!!err || undefined}
          aria-valuenow={num ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-disabled={disabledReason ? true : undefined}
          readOnly={!!disabledReason}
          title={disabledReason}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              skipBlur.current = true;
              e.currentTarget.blur();
              skipBlur.current = false;
            }
            // A disabled field is read-only; the source still nudged and committed.
            if (disabledReason) return;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(step * (e.shiftKey ? 10 : 1));
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(-step * (e.shiftKey ? 10 : 1));
            }
            if (e.key === 'Escape') setText(show(value));
          }}
          style={{
            all: 'unset',
            flex: '1 1 0',
            width: 0,
            minWidth: 0,
            font: 'var(--type-num)',
            color: 'var(--text-primary)',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        {suffix && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{suffix}</span>}
        {pending && <Spinner size={12} label="" />}
      </span>
      {err && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {err}
        </span>
      )}
    </label>
  );
}
