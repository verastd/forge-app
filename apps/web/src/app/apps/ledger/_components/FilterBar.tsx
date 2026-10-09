'use client';

/**
 * Embers FilterBar: a draft of filters that only reaches the ledger when you
 * press Apply (or Enter), never per keystroke. It shows clean / dirty (accent
 * border, unsaved dot) / applying (Apply spins while the new results load) /
 * applied ("N filters applied").
 */

import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useId, useRef } from 'react';

import { numberDraftError, parseNumberDraft } from '../_lib/filters';

import { AsyncButton, Button, Segment, Toggle } from './primitives';

export function FilterBar({
  label,
  dirty,
  applying,
  invalid,
  appliedCount,
  onApply,
  onReset,
  notes,
  children,
}: {
  label: string;
  dirty: boolean;
  /** Results for the applied filters are loading. */
  applying: boolean;
  /** A draft value is invalid; Apply says why instead of sending it. */
  invalid?: string | null;
  appliedCount: number;
  onApply: () => void;
  onReset: () => void;
  /** One-line notes under the bar (filters the ledger can't apply, and why). */
  notes?: readonly string[];
  children: ReactNode;
}) {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (dirty && !invalid) onApply();
  };
  const state = applying ? 'applying' : dirty ? 'dirty' : appliedCount > 0 ? 'applied' : 'clean';
  return (
    <form role="search" aria-label={label} className="em-filterbar" data-state={state} onSubmit={submit}>
      {children}
      <span className="em-filterbar-spacer" />
      {appliedCount > 0 && state !== 'dirty' && !applying && (
        <span className="em-filterbar-applied">
          {appliedCount} filter{appliedCount === 1 ? '' : 's'} applied
        </span>
      )}
      <Button variant="ghost" size="dense" onClick={onReset} disabledReason={applying ? 'Wait for the results to load' : appliedCount === 0 && !dirty ? 'No filters to reset' : undefined}>
        Reset
      </Button>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <AsyncButton
          size="dense"
          variant={dirty ? 'primary' : 'secondary'}
          label="Apply"
          pendingLabel="Applying…"
          busy={applying}
          disabledReason={invalid ?? (dirty ? undefined : 'No changes to apply')}
          onAction={async () => onApply()}
        />
        {dirty && !applying && <span aria-label="Unsaved changes" role="img" className="em-dirty-dot" />}
      </span>
      {notes && notes.length > 0 && (
        <div className="em-filterbar-notes">
          {notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      )}
    </form>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  width,
  error,
  inputMode,
  maxLength = 120,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number | string;
  error?: string | null;
  inputMode?: 'text' | 'numeric' | 'decimal';
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="em-field" style={{ width }}>
      <label className="em-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={inputMode === 'decimal' || inputMode === 'numeric' ? 'em-input em-input--num' : 'em-input'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {error && (
        <span id={`${id}-err`} className="em-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  const id = useId();
  return (
    <div className="em-field">
      <label className="em-field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="em-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A yes/no filter: the Embers Toggle. */
export function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <Toggle label={label} checked={checked} onChange={onChange} />;
}

/**
 * Embers NumberField for filters: empty means "Any" (no bound), prefix or
 * suffix units, right-aligned mono digits, inline range errors, ↑/↓ nudge by
 * `step` (Shift ×10), Esc puts back the value from when you focused it. It
 * edits the FilterBar's draft; nothing is sent until Apply.
 */
export function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  max,
  step = 1,
  width = 140,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number | string;
}) {
  const id = useId();
  const atFocus = useRef(value);
  const error = numberDraftError(value, { min, max });
  const nudge = (delta: number): void => {
    const n = parseNumberDraft(value);
    let next = (n === null || Number.isNaN(n) ? (min ?? 0) : n) + delta;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(String(+next.toFixed(6)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudge((e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Escape') {
      onChange(atFocus.current);
    }
  };
  const parsed = parseNumberDraft(value);
  return (
    <div className="em-field" style={{ width }}>
      <label className="em-field-label" htmlFor={id}>
        {label}
      </label>
      <span className="em-numfield-box" data-invalid={error ? 'true' : undefined}>
        {prefix && <span className="em-numfield-affix">{prefix}</span>}
        <input
          id={id}
          className="em-numfield-input"
          role="spinbutton"
          inputMode="decimal"
          value={value}
          placeholder="Any"
          maxLength={24}
          aria-invalid={error ? true : undefined}
          aria-valuenow={parsed !== null && !Number.isNaN(parsed) ? parsed : undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-describedby={error ? `${id}-err` : undefined}
          autoComplete="off"
          onFocus={() => {
            atFocus.current = value;
          }}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {suffix && <span className="em-numfield-affix">{suffix}</span>}
      </span>
      {error && (
        <span id={`${id}-err`} role="alert" className="em-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** A filter the ledger can't apply yet: shown, inert, and saying why (tooltip, screen readers, and the bar's `notes`). */
export function UnavailableField({ label, reason }: { label: string; reason: string }) {
  const id = useId();
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1);
  return (
    <div className="em-field">
      <label className="em-field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="em-input" disabled placeholder="Not available yet" title={sentence} aria-describedby={`${id}-why`} />
      <span id={`${id}-why`} className="em-sr">
        {sentence}
      </span>
    </div>
  );
}

/** Sort field plus direction, as the kit's Properties screen lays them out (Select + ↑/↓ Segment). */
export function SortFields<T extends string>({
  value,
  onChange,
  options,
  dir,
  onDir,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  dir: 'asc' | 'desc';
  onDir: (dir: 'asc' | 'desc') => void;
}) {
  return (
    <>
      <SelectField label="Sort" value={value} onChange={onChange} options={options} />
      <div className="em-field">
        <span className="em-field-label">Dir</span>
        <Segment
          label="Sort direction"
          value={dir}
          onChange={onDir}
          options={[
            { value: 'asc', label: '↑', ariaLabel: 'Ascending' },
            { value: 'desc', label: '↓', ariaLabel: 'Descending' },
          ]}
        />
      </div>
    </>
  );
}
