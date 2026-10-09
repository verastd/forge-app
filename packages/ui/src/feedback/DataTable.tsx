/**
 * DataTable (handoff feedback/DataTable.jsx, F-105, CM-10). Cosmetic table
 * primitive: sticky header, sort indicators, header hints, optional row
 * selection with mixed select-all, dense (36) or standard (44) rows, new-row
 * highlight (`row.__new`), skeleton rows when `loading`. Virtualization and
 * persistence are product code.
 *
 * Port notes: the sortable header is a real <button> (the .jsx used a
 * <span onClick>, which the keyboard could not reach). Below 640 px rows
 * become cards (README "Responsive"): every <td> carries `data-label` and
 * DataTable.css lays them out. Also exports Pager.
 */
import { isValidElement } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { Check } from '../controls/Check';
import { Button } from '../core/Button';
import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import { Skeleton } from '../core/Skeleton';
import { Spinner } from '../core/Spinner';
import './DataTable.css';

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface Column<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  hint?: string;
  num?: boolean;
  mono?: boolean;
  muted?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  render?: (row: Row) => ReactNode;
}

export interface DataTableProps<Row extends object> {
  columns: Column<Row>[];
  rows: Row[];
  /** Defaults to `row.id`. */
  rowKey?: (row: Row) => string;
  sort?: SortState;
  onSort?: (sort: SortState) => void;
  selectable?: boolean;
  selected?: string[];
  onSelect?: (keys: string[]) => void;
  density?: 'dense' | 'standard';
  loading?: boolean;
  skeletonRows?: number;
  onRowClick?: (row: Row) => void;
  footer?: ReactNode;
  maxHeight?: number | string;
  style?: CSSProperties;
}

const defaultRowKey = (r: object): string => {
  const id: unknown = (r as { id?: unknown }).id;
  return id == null ? '' : String(id);
};

const cellValue = (r: object, key: string): ReactNode => {
  const v: unknown = (r as Record<string, unknown>)[key];
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' || typeof v === 'number' || isValidElement(v)) return v;
  return String(v);
};

export function DataTable<Row extends object>({
  columns = [],
  rows = [],
  rowKey = defaultRowKey,
  sort,
  onSort,
  selectable,
  selected = [],
  onSelect,
  density = 'dense',
  loading,
  skeletonRows = 8,
  onRowClick,
  footer,
  maxHeight,
  style,
}: DataTableProps<Row>) {
  const rh = density === 'dense' ? 'var(--row-dense)' : 'var(--row-standard)';
  const keys = rows.map(rowKey);
  // Bug fix: the .jsx compared selected.length to rows.length, so keys kept from another page
  // could show "all selected" while no visible row was. Count only the visible rows.
  const selCount = keys.filter((k) => selected.includes(k)).length;
  const allSel = rows.length > 0 && selCount === rows.length;
  const someSel = selCount > 0 && !allSel;
  const th: CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: 'var(--surface-card)',
    textAlign: 'left',
    padding: '0 12px',
    height: 36,
    font: 'var(--type-eyebrow)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-wide)',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border-subtle)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface-card)',
        overflow: 'hidden',
        display: 'grid',
        ...style,
      }}
    >
      <div style={{ overflow: 'auto', maxHeight }}>
        <table
          className="em-datatable"
          style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, font: 'var(--type-body-sm)', color: 'var(--text-primary)' }}
        >
          <thead>
            <tr>
              {selectable && (
                <th style={{ ...th, width: 36, padding: '0 8px' }}>
                  <Check
                    checked={allSel ? true : someSel ? 'indeterminate' : false}
                    label={<span className="em-sr">Select all rows</span>}
                    onChange={(v) =>
                      onSelect?.(v ? [...selected, ...keys.filter((k) => !selected.includes(k))] : selected.filter((k) => !keys.includes(k)))
                    }
                    style={{ gap: 0 }}
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const dir = active ? sort.dir : undefined;
                const look: CSSProperties = {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: c.sortable ? 'pointer' : 'default',
                  color: active ? 'var(--text-primary)' : undefined,
                };
                const inner = (
                  <>
                    {c.label}
                    {c.hint && <Icon name="info" size={11} />}
                    {c.sortable && (
                      <Icon name={dir ? (dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down'} size={11} style={{ opacity: active ? 1 : 0.5 }} />
                    )}
                  </>
                );
                const head = c.sortable ? (
                  <button
                    type="button"
                    onClick={() => onSort?.({ key: c.key, dir: dir === 'asc' ? 'desc' : 'asc' })}
                    style={{ all: 'unset', ...look, font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', color: look.color ?? 'inherit' }}
                  >
                    {inner}
                  </button>
                ) : (
                  // A hinted, non-sortable header is focusable so keyboard users can open the hint.
                  <span tabIndex={c.hint ? 0 : undefined} style={look}>
                    {inner}
                  </span>
                );
                return (
                  <th
                    key={c.key}
                    aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    style={{ ...th, textAlign: c.align || 'left', width: c.width }}
                  >
                    {c.hint ? <Hint content={c.hint}>{head}</Hint> : head}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={i}>
                    {selectable && <td style={{ padding: '0 8px', height: rh }} />}
                    {columns.map((c) => (
                      <td key={c.key} data-label={c.label} style={{ padding: '0 12px', height: rh, borderBottom: '1px solid var(--border-subtle)' }}>
                        <Skeleton height={12} width={`${45 + ((i * 17 + c.key.length * 7) % 45)}%`} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((r, idx) => {
                  const k = keys[idx] ?? '';
                  const sel = selected.includes(k);
                  const fresh = !!(r as { __new?: unknown }).__new;
                  return (
                    <tr
                      key={k}
                      onClick={onRowClick ? () => onRowClick(r) : undefined}
                      className={fresh ? 'em-motion' : undefined}
                      style={{
                        background: sel ? 'var(--accent-soft)' : 'transparent',
                        cursor: onRowClick ? 'pointer' : 'default',
                        animation: fresh ? 'em-row-in var(--dur-highlight) var(--ease-out)' : 'none',
                      }}
                    >
                      {selectable && (
                        <td style={{ padding: '0 8px', height: rh, borderBottom: '1px solid var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
                          <Check
                            checked={sel}
                            label={<span className="em-sr">Select row</span>}
                            onChange={(v) => onSelect?.(v ? [...selected, k] : selected.filter((x) => x !== k))}
                            style={{ gap: 0 }}
                          />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          data-label={c.label}
                          className={c.mono || c.num ? 'em-num' : undefined}
                          style={{
                            padding: '0 12px',
                            height: rh,
                            borderBottom: '1px solid var(--border-subtle)',
                            textAlign: c.align || (c.num ? 'right' : 'left'),
                            whiteSpace: 'nowrap',
                            font: c.mono ? 'var(--type-code)' : c.num ? 'var(--type-num)' : undefined,
                            color: c.muted ? 'var(--text-secondary)' : undefined,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {c.render ? c.render(r) : cellValue(r, c.key)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {footer && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 12px',
            borderTop: '1px solid var(--border-subtle)',
            font: 'var(--type-caption)',
            color: 'var(--text-muted)',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

export interface PagerProps {
  page?: number;
  /** Total page count; leave undefined when the total is unknown (shows "Page N", Next follows `hasMore`). */
  pages?: number;
  onPage?: (page: number) => void;
  total?: number;
  loadMore?: boolean;
  onLoadMore?: () => void;
  /** With unknown `pages`: whether a next page exists. */
  hasMore?: boolean;
  /** The request in flight; that button shows a Spinner and both ignore presses. `next` also covers Load more. */
  busy?: 'next' | 'previous' | null;
}

/** Pager: Load-more or page controls for DataTable footers. */
export function Pager({ page = 1, pages, onPage, total, loadMore, onLoadMore, hasMore, busy = null }: PagerProps) {
  if (loadMore) {
    return (
      <>
        <span>{total != null ? `${total.toLocaleString()} rows` : null}</span>
        <Button
          variant="secondary"
          size="dense"
          aria-busy={busy === 'next' ? 'true' : undefined}
          onClick={() => {
            if (busy !== 'next') onLoadMore?.();
          }}
        >
          {busy === 'next' && <Spinner size={14} label="" />}
          Load more
        </Button>
      </>
    );
  }
  const canPrev = page > 1;
  const canNext = pages != null ? page < pages : !!hasMore;
  const nav = (which: 'previous' | 'next', can: boolean, reason: string) => {
    const pressed = busy === which;
    const blocked = !can || busy != null;
    const btn = (
      <Button
        variant="ghost"
        size="dense"
        icon={pressed ? undefined : which === 'previous' ? 'chevron-left' : 'chevron-right'}
        aria-label={which === 'previous' ? 'Previous page' : 'Next page'}
        aria-disabled={blocked || undefined}
        aria-busy={pressed ? 'true' : undefined}
        onClick={() => {
          if (!blocked) onPage?.(which === 'previous' ? page - 1 : page + 1);
        }}
        style={{ height: 26, width: 26, padding: 0 }}
      >
        {pressed ? <Spinner size={14} label="" /> : undefined}
      </Button>
    );
    return blocked ? (
      <Hint persistent content={busy != null ? 'Loading page…' : reason}>
        {btn}
      </Hint>
    ) : (
      btn
    );
  };
  return (
    <>
      <span className="em-num">
        Page {page}
        {pages != null && ` of ${pages}`}
        {total != null && ` · ${total.toLocaleString()} rows`}
      </span>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        {nav('previous', canPrev, 'Already on the first page')}
        {nav('next', canNext, 'No more pages')}
      </span>
    </>
  );
}
