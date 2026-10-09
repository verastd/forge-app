/**
 * FilterBar (handoff feedback/FilterBar.jsx, PRD 5.7, CM-08). Shell that hosts
 * controls and owns the clean | dirty | applying | applied state. Apply
 * highlights when dirty with an unsaved dot; Reset is ghost. `appliedCount`
 * shows the applied filter count; `extra` (saved filters) renders at the right.
 *
 * Port note: the children sit in a <form role="search"> (the .jsx used a
 * <div role="search">), so Enter in a field — or any submit — presses Apply
 * through the same AsyncButton path a click takes. Also exports FilterField.
 */
import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { AsyncButton } from '../core/AsyncButton';
import { Button } from '../core/Button';
import { Hint } from '../core/Hint';

export type FilterBarState = 'clean' | 'dirty' | 'applying' | 'applied';

export interface FilterBarProps {
  state?: FilterBarState;
  onApply?: () => Promise<unknown>;
  onReset?: () => void;
  appliedCount?: number;
  extra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}

export function FilterBar({ state = 'clean', children, onApply, onReset, appliedCount, extra, style }: FilterBarProps) {
  const dirty = state === 'dirty';
  const applying = state === 'applying';
  const applyRef = useRef<HTMLSpanElement>(null);
  // Pressing the real Apply button keeps one path: AsyncButton's guard (clean/applied/applying) and its state machine.
  const pressApply = (): void => {
    applyRef.current?.querySelector('button')?.click();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type)) return;
    e.preventDefault();
    pressApply();
  };
  const reset = (
    <Button
      variant="ghost"
      size="dense"
      // Bug fix: the .jsx marked Reset aria-disabled while applying but still called onReset.
      onClick={() => {
        if (!applying) onReset?.();
      }}
      aria-disabled={applying || undefined}
    >
      Reset
    </Button>
  );
  return (
    <form
      role="search"
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        pressApply();
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: 'var(--filterbar-gap)',
        padding: '10px 12px',
        background: 'var(--surface-card)',
        border: `1px solid ${dirty ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-lg)',
        position: 'sticky',
        top: 0,
        zIndex: 'var(--z-sticky)',
        transition: 'border-color var(--dur-fast)',
        margin: 0,
        ...style,
      }}
    >
      {children}
      <span style={{ flex: 1 }} />
      {extra}
      {(appliedCount ?? 0) > 0 && state !== 'dirty' && (
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)', alignSelf: 'center' }}>
          {appliedCount} filter{appliedCount === 1 ? '' : 's'} applied
        </span>
      )}
      {applying ? (
        <Hint persistent content="Filters are being applied">
          {reset}
        </Hint>
      ) : (
        reset
      )}
      <span ref={applyRef} style={{ position: 'relative', display: 'inline-flex' }}>
        <AsyncButton
          size="dense"
          variant={dirty ? 'primary' : 'secondary'}
          label="Apply"
          pendingLabel="Applying…"
          state={applying ? 'pending' : undefined}
          onAction={onApply}
          disabledReason={state === 'clean' || state === 'applied' ? 'No changes to apply' : undefined}
        />
        {dirty && (
          <span
            role="img"
            aria-label="Unsaved changes"
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--state-warning)',
              border: '2px solid var(--surface-card)',
            }}
          />
        )}
      </span>
    </form>
  );
}

export interface FilterFieldProps {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
}

/** Labeled control wrapper used inside FilterBar to keep every control the same height. */
export function FilterField({ label, children, style }: FilterFieldProps) {
  return (
    <label style={{ display: 'grid', gap: 4, ...style }}>
      <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  );
}
