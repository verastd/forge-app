/**
 * Segment (handoff controls/Segment.jsx, adapted RubberSegment SEL-15).
 * Controlled radiogroup, 2–4 options. Click + keyboard paths; unknown value
 * selects nothing; per-option disabledReason / locked. Highlight is
 * positioned from CSS (no measurement first frame).
 */
import type { CSSProperties, KeyboardEvent } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import type { IconName } from '../core/Icon';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Accessible name when the label is empty or a glyph. */
  ariaLabel?: string;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
}

export interface SegmentProps<T extends string = string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value?: T;
  onChange?: (v: T) => void;
  label?: string;
  size?: 'dense' | 'standard' | 'comfortable';
  fullWidth?: boolean;
  style?: CSSProperties;
}

const HEIGHTS = { dense: 28, standard: 32, comfortable: 36 } as const;
const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function Segment<T extends string = string>({ options, value, onChange, label, size = 'standard', fullWidth, style }: SegmentProps<T>) {
  const idx = options.findIndex((o) => o.value === value);
  const h = HEIGHTS[size];
  const n = options.length || 1;
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.key in STEP) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    // Home/End start at the ends and walk inward; arrows walk from the current
    // option. Either way inert (disabled/locked) options are skipped, and if
    // every option is inert nothing changes.
    const dir = e.key === 'Home' ? 1 : e.key === 'End' ? -1 : (STEP[e.key] ?? 1);
    let i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : ((idx < 0 ? 0 : idx) + dir + n) % n;
    let found = false;
    for (let k = 0; k < n; k++) {
      const o = options[i];
      if (o && !o.disabledReason && !o.locked) {
        found = true;
        break;
      }
      i = (i + dir + n) % n;
    }
    if (!found) return;
    const next = options[i];
    if (next) onChange?.(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      style={{
        position: 'relative',
        display: fullWidth ? 'grid' : 'inline-grid',
        gridTemplateColumns: `repeat(${n}, ${fullWidth ? '1fr' : 'auto'})`,
        padding: 2,
        background: 'var(--track)',
        borderRadius: 'var(--radius-md)',
        height: h,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {idx >= 0 && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            bottom: 2,
            left: `calc(2px + (100% - 4px) * ${idx} / ${n})`,
            width: `calc((100% - 4px) / ${n})`,
            background: 'var(--surface-card)',
            borderRadius: 4,
            boxShadow: 'var(--elevation-1)',
            transition: 'left var(--dur-base) var(--ease-spring)',
          }}
        />
      )}
      {options.map((o, i) => {
        const inert = !!o.disabledReason || !!o.locked;
        const btn = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={i === idx}
            aria-label={o.ariaLabel}
            aria-disabled={inert || undefined}
            tabIndex={i === (idx < 0 ? 0 : idx) ? 0 : -1}
            onClick={() => {
              if (!inert) onChange?.(o.value);
            }}
            draggable={false}
            style={{
              all: 'unset',
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '0 10px',
              height: '100%',
              borderRadius: 4,
              cursor: inert ? 'not-allowed' : 'pointer',
              font: 'var(--type-label)',
              fontSize: size === 'dense' ? 'var(--text-xs)' : 'var(--text-sm)',
              color: i === idx ? 'var(--text-primary)' : 'var(--text-muted)',
              opacity: inert ? 0.55 : 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              boxSizing: 'border-box',
              transition: 'color var(--dur-fast)',
            }}
          >
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
            {o.locked && <Icon name="lock" size={11} />}
          </button>
        );
        return inert ? (
          <Hint key={o.value} persistent content={o.locked ? `Requires ${o.lockedTier || 'a paid plan'}` : o.disabledReason}>
            {btn}
          </Hint>
        ) : (
          btn
        );
      })}
    </div>
  );
}
