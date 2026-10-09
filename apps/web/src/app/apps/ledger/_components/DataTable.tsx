'use client';

/**
 * Embers DataTable + Pager. Sticky header, numeric columns in mono and
 * right-aligned, skeleton rows while loading. Below 640px every row becomes
 * a card: each cell shows its column label beside the value (embers.css).
 */

import type { ReactNode } from 'react';

import { AsyncButton, Button, Icon, Skeleton, Spinner } from './primitives';

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  num?: boolean;
  mono?: boolean;
  muted?: boolean;
  wrap?: boolean;
  /** The ledger's sort field for this column, when the route can sort by it. */
  sortKey?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  footer,
  sort,
  onSort,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  /** Visually hidden table caption (what the table lists). */
  caption: string;
  footer?: ReactNode;
  /** The applied sort; headers with a `sortKey` become buttons that change it. */
  sort?: SortState;
  onSort?: (sort: SortState) => void;
}) {
  return (
    <div className="em-table-wrap">
      <div className="em-table-scroll">
        <table className="em-table">
          <caption className="em-sr">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = c.sortKey !== undefined && onSort !== undefined;
                const active = sortable && sort?.key === c.sortKey;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ textAlign: c.num ? 'right' : 'left' }}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="em-sort"
                        aria-pressed={active}
                        title={`Sort by ${c.label.toLowerCase()}`}
                        onClick={() => onSort!({ key: c.sortKey!, dir: active && sort!.dir === 'desc' ? 'asc' : 'desc' })}
                      >
                        {c.label}
                        <Icon name={active ? (sort!.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down'} size={11} />
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.label} className={cellClass(c)}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="em-table-foot">{footer}</div>}
    </div>
  );
}

function cellClass<T>(c: Column<T>): string | undefined {
  const parts = [c.num ? 'em-col-num' : '', c.mono ? 'em-col-mono' : '', c.muted ? 'em-col-muted' : '', c.wrap ? 'em-col-wrap' : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

/** The DataTable layout with skeleton cells, for DataState's loading slot. */
export function TableSkeleton({ columns, rows = 8 }: { columns: ReadonlyArray<{ key: string; label: string }>; rows?: number }) {
  return (
    <div className="em-table-wrap" aria-hidden="true">
      <div className="em-table-scroll">
        <table className="em-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.label}>
                    <Skeleton height={12} width={`${45 + ((i * 17 + c.key.length * 7) % 45)}%`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Previous / Next for offset pages. The ledger doesn't return a total, so
 * this says "Page N" and which rows are showing; the button you pressed
 * spins until its page arrives, and both are inert meanwhile.
 */
export function Pager({
  page,
  pageSize,
  shown,
  hasPrevious,
  hasMore,
  paging,
  onPrevious,
  onNext,
}: {
  page: number;
  pageSize: number;
  shown: number;
  hasPrevious: boolean;
  hasMore: boolean;
  paging: 'next' | 'previous' | null;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const first = (page - 1) * pageSize + 1;
  const busy = paging !== null;
  return (
    <>
      <span className="em-num" role="status" aria-live="polite">
        {busy ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Spinner size={12} label="" /> Loading page {paging === 'next' ? page + 1 : Math.max(1, page - 1)}…
          </span>
        ) : shown === 0 ? (
          `Page ${page}`
        ) : (
          `Page ${page} · rows ${first.toLocaleString('en-US')}–${(first + shown - 1).toLocaleString('en-US')}`
        )}
      </span>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <Button
          variant="ghost"
          size="dense"
          icon={paging === 'previous' ? undefined : 'chevron-left'}
          aria-label="Previous page"
          disabledReason={!hasPrevious ? 'This is the first page' : busy ? 'Loading a page' : undefined}
          aria-busy={paging === 'previous' ? 'true' : undefined}
          onClick={onPrevious}
        >
          {paging === 'previous' ? <Spinner size={12} label="" /> : null}
        </Button>
        <Button
          variant="ghost"
          size="dense"
          icon={paging === 'next' ? undefined : 'chevron-right'}
          aria-label="Next page"
          disabledReason={!hasMore ? 'No more rows' : busy ? 'Loading a page' : undefined}
          aria-busy={paging === 'next' ? 'true' : undefined}
          onClick={onNext}
        >
          {paging === 'next' ? <Spinner size={12} label="" /> : null}
        </Button>
      </span>
    </>
  );
}

/** What `ListPager` needs from `useOffsetPages`. */
export interface PagedList {
  page: number;
  pageSize: number;
  rows: readonly unknown[];
  hasPrevious: boolean;
  hasMore: boolean;
  paging: 'next' | 'previous' | null;
  previous: () => void;
  next: () => void;
}

export function ListPager({ list }: { list: PagedList }) {
  return (
    <Pager
      page={list.page}
      pageSize={list.pageSize}
      shown={list.rows.length}
      hasPrevious={list.hasPrevious}
      hasMore={list.hasMore}
      paging={list.paging}
      onPrevious={list.previous}
      onNext={list.next}
    />
  );
}

/** "Load more" for cursor feeds, with its own pending and error states. */
export function LoadMore({
  count,
  hasMore,
  onLoadMore,
  noun = 'rows',
}: {
  count: number;
  hasMore: boolean;
  onLoadMore: () => Promise<unknown>;
  noun?: string;
}) {
  return (
    <>
      <span className="em-num">
        {count.toLocaleString('en-US')} {noun}
        {hasMore ? '' : ' · end of the list'}
      </span>
      {hasMore && <AsyncButton size="dense" variant="secondary" label="Load more" pendingLabel="Loading more…" onAction={onLoadMore} />}
    </>
  );
}
