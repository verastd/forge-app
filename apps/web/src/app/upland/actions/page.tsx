'use client';

/**
 * The actions explorer: every decoded `playuplandme` chain action, filterable
 * by category and account, one page at a time. Filters come from the data
 * itself (the overview's category counts), so the chips never advertise a
 * category the data set does not hold.
 */

import { useCallback, useEffect, useState } from 'react';

import { Chip, FilterChip } from '../../../components/Chip';
import type { ChipTone } from '../../../components/Chip';
import { DataTable } from '../../../components/DataTable';
import type { Column } from '../../../components/DataTable';
import { Pagination } from '../../../components/Pagination';
import { formatChainTimestamp, formatUpx } from '../../../lib/format';
import { fetchActions, fetchStatsOverview } from '../../../lib/upland-api';
import type { UplandAction } from '../../../lib/upland-api';

const PAGE_SIZE = 50;

/** Category → chip tone; anything unmapped reads neutral. */
const CATEGORY_TONE: Record<string, ChipTone> = {
  market: 'accent',
  mint: 'ok',
  earnings: 'info',
  spark: 'info',
};

function categoryTone(category: string | null): ChipTone {
  return category === null ? 'neutral' : (CATEGORY_TONE[category] ?? 'neutral');
}

const COLUMNS: ReadonlyArray<Column<UplandAction>> = [
  {
    key: 'ts',
    header: 'When',
    className: 'num',
    render: (row) => formatChainTimestamp(row.ts),
  },
  {
    key: 'action',
    header: 'Action',
    render: (row) => (
      <Chip tone={categoryTone(row.category)} title={row.actionName}>
        {row.actionMeaning ?? row.actionName}
      </Chip>
    ),
  },
  {
    key: 'actor',
    header: 'Who',
    render: (row) => row.actor ?? <span className="faint">—</span>,
  },
  {
    key: 'property',
    header: 'Property',
    className: 'num',
    render: (row) => row.propertyId ?? <span className="faint">—</span>,
  },
  {
    key: 'price',
    header: 'Price',
    className: 'num',
    render: (row) => (row.priceUpx === null ? <span className="faint">—</span> : formatUpx(row.priceUpx)),
  },
];

export default function UplandActionsPage() {
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [actorInput, setActorInput] = useState('');
  const [actor, setActor] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(0);

  const [categories, setCategories] = useState<string[]>([]);
  const [items, setItems] = useState<UplandAction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The filter chips: one fetch, and a fetch that fails just means no chips —
  // the table below carries its own error state.
  useEffect(() => {
    let cancelled = false;
    void fetchStatsOverview()
      .then((overview) => {
        if (!cancelled) {
          setCategories(Object.keys(overview.byCategory).sort());
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchActions({ category, actor, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setItems([]);
        setTotal(0);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, actor, page, attempt]);

  const pickCategory = useCallback((next: string | undefined) => {
    setCategory(next);
    setPage(0);
  }, []);

  const applyActor = useCallback(() => {
    const trimmed = actorInput.trim();
    setActor(trimmed === '' ? undefined : trimmed);
    setPage(0);
  }, [actorInput]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="page stack-lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Actions</h1>
          <p className="lede">Every decoded chain action in the data set, newest first.</p>
        </div>
      </div>

      <div className="stack">
        <div className="row" role="group" aria-label="Filter by category">
          <FilterChip active={category === undefined} onClick={() => pickCategory(undefined)}>
            All
          </FilterChip>
          {categories.map((name) => (
            <FilterChip
              key={name}
              active={category === name}
              onClick={() => pickCategory(name)}
            >
              {name}
            </FilterChip>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            applyActor();
          }}
        >
          <input
            className="text-input"
            type="search"
            placeholder="Filter by account…"
            aria-label="Filter by account"
            value={actorInput}
            onChange={(event) => {
              setActorInput(event.target.value);
            }}
          />
          <button type="submit" className="btn btn-sm">
            Apply
          </button>
          {actor !== undefined && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setActorInput('');
                setActor(undefined);
                setPage(0);
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {loading ? (
        <div className="table-wrap" aria-busy="true">
          <div className="empty">
            <span className="spinner" aria-hidden="true" /> Loading actions…
          </div>
        </div>
      ) : failed ? (
        <div className="card stack" role="alert">
          <h2 className="section-title">We can&apos;t show the actions just now</h2>
          <p className="muted">The list would not load, and we will not show you a made-up one.</p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            rows={items}
            rowKey={(row) => String(row.globalSequence)}
            empty="Nothing matches these filters."
          />
          <Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
        </>
      )}
    </main>
  );
}
