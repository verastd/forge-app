/**
 * Toggle (handoff controls/Toggle.jsx, adapted SquishSwitch SEL-14). Fully
 * controlled 36×20 switch; commits on pointer-up (click) only. pending |
 * error | locked props. Disabled stays focusable via aria-disabled + reason.
 */
import type { CSSProperties, ReactNode } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export interface ToggleProps {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: ReactNode;
  pending?: boolean;
  error?: string;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
  style?: CSSProperties;
}

export function Toggle({ checked = false, onChange, label, pending, error, disabledReason, locked, lockedTier, style }: ToggleProps) {
  const inert = !!pending || !!disabledReason || !!locked;
  const el = (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        cursor: inert ? 'not-allowed' : 'pointer',
        font: 'var(--type-body-sm)',
        color: 'var(--text-primary)',
        opacity: disabledReason || locked ? 0.6 : 1,
        ...style,
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        aria-disabled={inert || undefined}
        aria-busy={pending || undefined}
        onClick={() => {
          if (!inert) onChange?.(!checked);
        }}
        style={{
          all: 'unset',
          position: 'relative',
          width: 36,
          height: 20,
          flex: 'none',
          borderRadius: 'var(--radius-pill)',
          background: error ? 'var(--state-error)' : checked ? 'var(--accent)' : 'var(--track)',
          transition: 'background var(--dur-base) var(--ease-out)',
          boxSizing: 'border-box',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--surface-card)',
            boxShadow: 'var(--elevation-1)',
            transition: 'left var(--dur-base) var(--ease-spring)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {pending && <Spinner size={10} label="" color="var(--text-muted)" />}
        </span>
      </button>
      {label && <span>{label}</span>}
      {locked && <Icon name="lock" size={12} style={{ color: 'var(--text-muted)' }} />}
      {error && (
        <span role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error}
        </span>
      )}
    </label>
  );
  return disabledReason || locked ? (
    <Hint persistent content={locked ? `Requires ${lockedTier || 'a paid plan'}` : disabledReason}>
      {el}
    </Hint>
  ) : (
    el
  );
}
