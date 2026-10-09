/**
 * SearchableSelect (handoff controls/SearchableSelect.jsx, CM-09 original
 * combobox). Async or local search with a minimum-character hint, in-field
 * spinner, no results, error + Retry, grouped options, single or `multi`.
 * `status` is controlled by the caller: idle | loading | results | empty |
 * error. Keyboard: ArrowUp/Down move the active option (exposed through
 * aria-activedescendant), Enter picks, Escape/Tab close, Backspace on an
 * empty query removes the last pick in `multi`.
 */
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';

export interface SSOption<T extends string = string> {
  value: T;
  label: string;
  meta?: string;
  flag?: string;
}

export interface SSGroup<T extends string = string> {
  label: string;
  options: ReadonlyArray<SSOption<T>>;
}

export type SearchableSelectStatus = 'idle' | 'loading' | 'results' | 'empty' | 'error';

interface SearchableSelectBaseProps<T extends string> {
  query?: string;
  onQueryChange?: (q: string) => void;
  options?: ReadonlyArray<SSOption<T>>;
  groups?: ReadonlyArray<SSGroup<T>>;
  status?: SearchableSelectStatus;
  minChars?: number;
  placeholder?: string;
  label?: string;
  error?: string;
  onRetry?: () => void;
  width?: number | string;
  size?: 'dense' | 'standard' | 'comfortable';
  style?: CSSProperties;
}

export interface SearchableSelectSingleProps<T extends string = string> extends SearchableSelectBaseProps<T> {
  multi?: false;
  value?: SSOption<T> | null;
  onChange?: (v: SSOption<T> | null) => void;
}

export interface SearchableSelectMultiProps<T extends string = string> extends SearchableSelectBaseProps<T> {
  multi: true;
  value?: ReadonlyArray<SSOption<T>> | null;
  onChange?: (v: Array<SSOption<T>>) => void;
}

export type SearchableSelectProps<T extends string = string> = SearchableSelectSingleProps<T> | SearchableSelectMultiProps<T>;

const HEIGHTS = { dense: 'var(--control-dense)', standard: 'var(--control-standard)', comfortable: 'var(--control-comfortable)' } as const;

/** A row: the caller's own option object (passed back untouched) + its group. */
type Item<T extends string> = { o: SSOption<T>; group?: string };

export function SearchableSelect<T extends string = string>(props: SearchableSelectProps<T>) {
  const {
    query = '',
    onQueryChange,
    options = [],
    groups,
    status = 'idle',
    minChars = 3,
    placeholder = 'Search…',
    label,
    error,
    onRetry,
    width = 260,
    size = 'standard',
    style,
  } = props;
  const multi = !!props.multi;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const off = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  const h = HEIGHTS[size];
  const single = props.multi ? null : (props.value ?? null);
  const selected: ReadonlyArray<SSOption<T>> = props.multi ? (props.value ?? []) : single ? [single] : [];
  const isSel = (o: SSOption<T>): boolean => selected.some((s) => s.value === o.value);
  const pick = (o: SSOption<T>): void => {
    if (props.multi) {
      props.onChange?.(isSel(o) ? selected.filter((s) => s.value !== o.value) : [...selected, o]);
    } else {
      props.onChange?.(o);
      setOpen(false);
      onQueryChange?.('');
    }
  };
  // The source spread `group` into the option, so onChange handed back a
  // different object (with an extra key) than the caller passed in.
  const list: ReadonlyArray<Item<T>> = groups ? groups.flatMap((g) => g.options.map((o) => ({ o, group: g.label }))) : options.map((o) => ({ o }));
  const remaining = minChars - query.length;
  const mode =
    query.length < minChars && status !== 'results'
      ? 'hint'
      : status === 'loading'
        ? 'loading'
        : status === 'error'
          ? 'error'
          : status === 'empty' || (status === 'results' && list.length === 0)
            ? 'empty'
            : 'list';
  // Options are only pickable while they are on screen: the source let Enter
  // pick a stale, hidden option during the hint / loading / error states.
  const navigable = mode === 'list' && list.length > 0;
  const act = Math.max(0, Math.min(active, list.length - 1));
  const activeItem = open && navigable ? list[act] : undefined;
  const optId = (i: number): string => `${id}-opt-${i}`;

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.max(0, Math.min(list.length - 1, act + d)));
      return;
    }
    if (e.key === 'Enter') {
      if (!activeItem) return;
      e.preventDefault();
      pick(activeItem.o);
      return;
    }
    if (e.key === 'Backspace' && multi && query === '') {
      const last = selected[selected.length - 1];
      if (last) pick(last);
    }
  };

  let body: ReactNode;
  if (mode === 'hint') {
    body = (
      <Row muted>
        Type {remaining} more character{remaining === 1 ? '' : 's'}
      </Row>
    );
  } else if (mode === 'loading') {
    body = (
      <Row muted>
        <Spinner size={12} label="" /> Searching…
      </Row>
    );
  } else if (mode === 'error') {
    body = (
      <Row>
        <span role="alert" style={{ color: 'var(--state-error)' }}>
          {error || 'Search failed'}
        </span>
        <button
          type="button"
          onClick={onRetry}
          style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-link)', textDecoration: 'underline', marginLeft: 8 }}
        >
          Retry
        </button>
      </Row>
    );
  } else if (mode === 'empty') {
    body = <Row muted>No results for “{query}”</Row>;
  } else {
    body = list.map(({ o, group }, i) => (
      <Fragment key={`${group ?? ''}:${o.value}`}>
        {groups && (i === 0 || list[i - 1]?.group !== group) && (
          <li
            role="presentation"
            style={{
              padding: '6px 8px 2px',
              font: 'var(--type-eyebrow)',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 'var(--tracking-wide)',
            }}
          >
            {group}
          </li>
        )}
        <li
          id={optId(i)}
          role="option"
          aria-selected={isSel(o)}
          onPointerEnter={() => setActive(i)}
          onClick={() => pick(o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 8px',
            height: 32,
            borderRadius: 4,
            background: i === act ? 'var(--surface-hover)' : 'transparent',
            color: 'var(--text-primary)',
            font: 'var(--type-body-sm)',
            cursor: 'pointer',
          }}
        >
          {o.flag && <span aria-hidden="true">{o.flag}</span>}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
          {o.meta && (
            <span className="em-num" style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
              {o.meta}
            </span>
          )}
          {isSel(o) && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
        </li>
      </Fragment>
    ));
  }

  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-block', width, ...style }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: h,
          boxSizing: 'border-box',
          padding: '0 8px 0 10px',
          border: `1px solid ${open ? 'var(--border-focus)' : 'var(--border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-card)',
        }}
      >
        <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
        {multi &&
          selected.slice(0, 2).map((s) => (
            <span
              key={s.value}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: '0 6px',
                height: 20,
                borderRadius: 4,
                background: 'var(--surface-sunken)',
                font: 'var(--type-caption)',
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
              }}
            >
              {s.label}
              <button type="button" aria-label={`Remove ${s.label}`} onClick={() => pick(s)} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex' }}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        {multi && selected.length > 2 && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>+{selected.length - 2}</span>}
        <input
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={activeItem ? optId(act) : undefined}
          aria-busy={status === 'loading' || undefined}
          aria-label={label}
          value={query}
          placeholder={single ? single.label : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onQueryChange?.(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKey}
          style={{ all: 'unset', flex: 1, minWidth: 40, font: 'var(--type-body-sm)', color: 'var(--text-primary)' }}
        />
        {status === 'loading' ? (
          <Spinner size={12} label="" />
        ) : query || single ? (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => {
              onQueryChange?.('');
              if (!props.multi) props.onChange?.(null);
            }}
            style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}
          >
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multi || undefined}
          // Keep focus in the input while clicking an option (multi stays open).
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: 300,
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
          {body}
        </ul>
      )}
    </div>
  );
}

function Row({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <li
      role="presentation"
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px', font: 'var(--type-body-sm)', color: muted ? 'var(--text-muted)' : 'var(--text-primary)' }}
    >
      {children}
    </li>
  );
}
