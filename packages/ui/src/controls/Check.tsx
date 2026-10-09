/**
 * Check (handoff controls/Check.jsx, adapted SpringCheck SEL-13). checked:
 * boolean | 'indeterminate'. No strike-through, full-opacity label, compact
 * 32 px rows (44 on touch). Disabled via aria-disabled + reason; locked shows tier.
 */
import type { CSSProperties, ReactNode } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';

export interface CheckProps {
  checked?: boolean | 'indeterminate';
  onChange?: (v: boolean) => void;
  label?: ReactNode;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
  size?: 'compact' | 'touch';
  style?: CSSProperties;
}

export function Check({ checked = false, onChange, label, disabledReason, locked, lockedTier, size = 'compact', style }: CheckProps) {
  const mixed = checked === 'indeterminate';
  const inert = !!disabledReason || !!locked;
  const box = (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : !!checked}
      aria-disabled={inert || undefined}
      onClick={() => {
        if (inert) return;
        onChange?.(mixed ? true : !checked);
      }}
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: size === 'touch' ? 44 : 32,
        cursor: inert ? 'not-allowed' : 'pointer',
        color: 'var(--text-primary)',
        font: 'var(--type-body-sm)',
        opacity: inert ? 0.6 : 1,
        borderRadius: 4,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          flex: 'none',
          borderRadius: 'var(--radius-xs)',
          border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: checked ? 'var(--accent)' : 'var(--surface-card)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--on-accent)',
          transition: 'all var(--dur-fast) var(--ease-spring)',
          boxSizing: 'border-box',
        }}
      >
        {mixed ? <span style={{ width: 8, height: 2, background: 'currentColor', borderRadius: 1 }} /> : checked ? <Icon name="check" size={12} /> : null}
      </span>
      {label && <span>{label}</span>}
      {locked && <Icon name="lock" size={12} style={{ color: 'var(--text-muted)' }} />}
    </button>
  );
  return inert ? (
    <Hint persistent content={locked ? `Requires ${lockedTier || 'a paid plan'}` : disabledReason}>
      {box}
    </Hint>
  ) : (
    box
  );
}
