/**
 * Chips (handoff controls/Chips.jsx, adapted JellyRadio SEL-16). Single-select
 * chip set with per-option locks. Unknown value selects nothing; locked chips
 * stay focusable with a reason; selected swell ≈ 1.04 with no neighbor
 * displacement. Arrow keys skip inert chips and move focus with the selection.
 */
import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';

export interface ChipOption<T extends string = string> {
  value: T;
  label: string;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
}

export interface ChipsProps<T extends string = string> {
  options: ReadonlyArray<ChipOption<T>>;
  value?: T;
  onChange?: (v: T) => void;
  label?: string;
  size?: 'dense' | 'standard';
  style?: CSSProperties;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

export function Chips<T extends string = string>({ options = [], value, onChange, label, size = 'standard', style }: ChipsProps<T>) {
  const h = size === 'dense' ? 26 : 30;
  const idx = options.findIndex((o) => o.value === value);
  const firstEnabled = options.findIndex((o) => !o.disabledReason && !o.locked);
  // With nothing selected the first enabled chip takes the tab stop; if every
  // chip is inert the first one still does, so the set stays reachable.
  const tabStop = idx < 0 ? Math.max(0, firstEnabled) : idx;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (i: number, e: KeyboardEvent<HTMLButtonElement>): void => {
    const d = STEP[e.key];
    if (!d) return;
    e.preventDefault();
    const n = options.length;
    // Walk from the focused chip, skipping inert ones; if none is enabled,
    // nothing changes (the source fell through and selected an inert chip).
    let j = i;
    let found = false;
    for (let k = 0; k < n; k++) {
      j = (j + d + n) % n;
      const o = options[j];
      if (o && !o.disabledReason && !o.locked) {
        found = true;
        break;
      }
    }
    const next = options[j];
    if (!found || !next) return;
    onChange?.(next.value);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, ...style }}>
      {options.map((o, i) => {
        const on = i === idx;
        const inert = !!o.disabledReason || !!o.locked;
        const chip = (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={inert || undefined}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => {
              if (!inert) onChange?.(o.value);
            }}
            onKeyDown={(e) => onKey(i, e)}
            style={{
              all: 'unset',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: h,
              padding: '0 10px',
              borderRadius: 'var(--radius-pill)',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
              background: on ? 'var(--accent)' : 'var(--surface-card)',
              color: on ? 'var(--on-accent)' : 'var(--text-secondary)',
              font: 'var(--type-label)',
              fontSize: size === 'dense' ? 'var(--text-xs)' : 'var(--text-sm)',
              cursor: inert ? 'not-allowed' : 'pointer',
              opacity: inert ? 0.55 : 1,
              transform: on ? 'scale(1.04)' : 'none',
              transition: 'all var(--dur-fast) var(--ease-spring)',
              boxSizing: 'border-box',
            }}
          >
            {o.label}
            {o.locked && <Icon name="lock" size={11} />}
          </button>
        );
        return inert ? (
          <Hint key={o.value} persistent content={o.locked ? `Requires ${o.lockedTier || 'a paid plan'}` : o.disabledReason}>
            {chip}
          </Hint>
        ) : (
          chip
        );
      })}
    </div>
  );
}
