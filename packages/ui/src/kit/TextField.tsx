/**
 * TextField: the plain text input the Embers handoff leaves to "shadcn/Radix
 * scaffolding styled with Design System tokens" (COMPONENT_MAP §1). Same box
 * as NumberField: caption label above, 1px border-strong, radius-md,
 * dense/standard/comfortable heights, inline error under it, aria-disabled
 * (focusable) with a reason instead of native disabled.
 */
import { useId } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import { Icon } from '../core/Icon';
import type { IconName } from '../core/Icon';

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: IconName;
  error?: string | null;
  disabledReason?: string;
  maxLength?: number;
  width?: number | string;
  size?: 'dense' | 'standard' | 'comfortable';
  /** Monospace input (account names, ids). */
  mono?: boolean;
  onEnter?: () => void;
  style?: CSSProperties;
}

const HEIGHTS = { dense: 'var(--control-dense)', standard: 'var(--control-standard)', comfortable: 'var(--control-comfortable)' } as const;

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  icon,
  error,
  disabledReason,
  maxLength = 120,
  width = 200,
  size = 'dense',
  mono,
  onEnter,
  style,
}: TextFieldProps) {
  const id = useId();
  const errId = `${id}-error`;
  const reasonId = `${id}-reason`;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && onEnter && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <span style={{ display: 'inline-grid', gap: 4, width, minWidth: 0, ...style }}>
      <label htmlFor={id} style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
        {label}
      </label>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          overflow: 'hidden',
          height: HEIGHTS[size],
          boxSizing: 'border-box',
          border: `1px solid ${error ? 'var(--state-error)' : 'var(--border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-card)',
          padding: '0 var(--control-padding-x)',
          gap: 6,
          opacity: disabledReason ? 0.55 : 1,
        }}
      >
        {icon && <Icon name={icon} size={14} style={{ color: 'var(--text-muted)' }} />}
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          readOnly={!!disabledReason}
          aria-disabled={disabledReason ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errId : null, disabledReason ? reasonId : null].filter(Boolean).join(' ') || undefined}
          title={disabledReason}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            if (!disabledReason) onChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          style={{
            all: 'unset',
            flex: '1 1 0',
            width: 0,
            minWidth: 0,
            font: mono ? 'var(--type-num)' : 'var(--type-body-sm)',
            color: 'var(--text-primary)',
            cursor: disabledReason ? 'not-allowed' : 'text',
          }}
        />
      </span>
      {disabledReason && (
        <span id={reasonId} className="em-sr">
          {disabledReason}
        </span>
      )}
      {error && (
        <span id={errId} role="alert" style={{ font: 'var(--type-caption)', color: 'var(--state-error)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
