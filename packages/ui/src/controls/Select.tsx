/**
 * Select (handoff controls/Select.jsx, adapted GlideSelect SEL-17). Finite
 * lists. Click + keyboard (arrows, Home/End, typeahead, Esc), scrollable menu
 * (max 280), per-option disabledReason / locked, unknown value shows the
 * placeholder. The field itself supports disabledReason. Keyboard movement
 * skips inert options, so the active option is always one Enter can select.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabledReason?: string;
  locked?: boolean;
  lockedTier?: string;
}

export interface SelectProps<T extends string = string> {
  options: ReadonlyArray<SelectOption<T>>;
  value?: T;
  onChange?: (v: T) => void;
  placeholder?: string;
  label?: string;
  size?: 'dense' | 'standard' | 'comfortable';
  width?: number | string;
  disabledReason?: string;
  style?: CSSProperties;
}

const HEIGHTS = { dense: 'var(--control-dense)', standard: 'var(--control-standard)', comfortable: 'var(--control-comfortable)' } as const;

export function Select<T extends string = string>({
  options = [],
  value,
  onChange,
  placeholder = 'Select…',
  label,
  size = 'standard',
  width = 180,
  disabledReason,
  style,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const idx = options.findIndex((o) => o.value === value);
  // A field disabled while open closes (the source kept the menu up).
  const isOpen = open && !disabledReason;
  const h = HEIGHTS[size];
  useEffect(() => {
    if (!open) return undefined;
    const off = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);

  const enabled = (i: number): boolean => {
    const o = options[i];
    return !!o && !o.disabledReason && !o.locked;
  };
  /** First enabled index walking from `from` in `dir`, or -1. */
  const seek = (from: number, dir: 1 | -1): number => {
    for (let i = from; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return -1;
  };
  const pick = (i: number): void => {
    const o = options[i];
    if (!o || o.disabledReason || o.locked) return;
    onChange?.(o.value);
    setOpen(false);
  };
  const show = (): void => {
    setOpen(true);
    setActive(idx);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabledReason) return;
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) pick(active);
      else show();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        show();
        return;
      }
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = seek(active + dir, dir);
      if (next >= 0) setActive(next);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      // The source jumped to index 0 / n-1 even when that option was locked.
      e.preventDefault();
      const next = e.key === 'Home' ? seek(0, 1) : seek(options.length - 1, -1);
      if (next >= 0) setActive(next);
      return;
    }
    if (e.key.length === 1) {
      // Typeahead: next enabled option (after the active one, wrapping) whose
      // label starts with the key; closed, it selects directly.
      const k = e.key.toLowerCase();
      const n = options.length;
      for (let s = 1; s <= n; s++) {
        const j = (((active < 0 ? -1 : active) + s) % n + n) % n;
        if (enabled(j) && options[j]?.label.toLowerCase().startsWith(k)) {
          setActive(j);
          if (!open) pick(j);
          return;
        }
      }
    }
  };
  const current = options[idx];
  const activeOpt = isOpen && active >= 0 ? options[active] : undefined;
  const btn = (
    <button
      ref={trigger}
      type="button"
      role="combobox"
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      aria-controls={isOpen ? `${id}-list` : undefined}
      aria-activedescendant={activeOpt ? `${id}-${active}` : undefined}
      aria-label={label}
      aria-disabled={disabledReason ? true : undefined}
      onClick={() => {
        if (disabledReason) return;
        if (open) setOpen(false);
        else show();
      }}
      onKeyDown={onKey}
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width,
        height: h,
        padding: '0 8px 0 var(--control-padding-x)',
        boxSizing: 'border-box',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${isOpen ? 'var(--border-focus)' : 'var(--border-strong)'}`,
        background: 'var(--surface-card)',
        color: current ? 'var(--text-primary)' : 'var(--text-muted)',
        font: 'var(--type-label)',
        fontSize: size === 'dense' ? 'var(--text-xs)' : 'var(--text-sm)',
        cursor: disabledReason ? 'not-allowed' : 'pointer',
        opacity: disabledReason ? 0.55 : 1,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current ? current.label : placeholder}</span>
      <Icon
        name="chevron-down"
        size={14}
        style={{ color: 'var(--text-muted)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-fast)' }}
      />
    </button>
  );
  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-block', ...style }}>
      {disabledReason ? (
        <Hint persistent content={disabledReason}>
          {btn}
        </Hint>
      ) : (
        btn
      )}
      {isOpen && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '100%',
            maxHeight: 280,
            overflowY: 'auto',
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: 'var(--surface-popover)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--elevation-2)',
            zIndex: 'var(--z-popover)' as unknown as number,
          }}
        >
          {options.map((o, i) => {
            const inert = !!o.disabledReason || !!o.locked;
            return (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === idx}
                aria-disabled={inert || undefined}
                title={o.disabledReason}
                onPointerEnter={() => setActive(i)}
                onClick={() => {
                  if (inert) return;
                  pick(i);
                  trigger.current?.focus();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '0 8px',
                  height: 30,
                  borderRadius: 4,
                  background: i === active ? 'var(--surface-hover)' : 'transparent',
                  color: inert ? 'var(--text-muted)' : 'var(--text-primary)',
                  font: 'var(--type-body-sm)',
                  cursor: inert ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{o.label}</span>
                {i === idx ? (
                  <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />
                ) : o.locked ? (
                  <span style={{ font: 'var(--type-eyebrow)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{o.lockedTier || 'Locked'}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
