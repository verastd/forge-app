'use client';

/**
 * Upland Data — Private Beta. A stub: one summary of what the scraped data set
 * holds (total actions, date range, categories), fetched on mount so
 * `next build` never needs the API up.
 */

import { useCallback, useEffect, useState } from 'react';
import { useFlag } from '@forge/flags/react';

import { Chip } from '../../components/Chip';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { demoFlagFallback } from '../../lib/flags';
import { formatDate } from '../../lib/format';
import { fetchStatsOverview, uplandExportUrl } from '../../lib/upland-api';
import type { UplandStatsOverview } from '../../lib/upland-api';

interface CategoryRow {
  category: string;
  count: number;
}

const COLUMNS: ReadonlyArray<Column<CategoryRow>> = [
  { key: 'category', header: 'Category', render: (row) => <Chip tone="info">{row.category}</Chip> },
  {
    key: 'count',
    header: 'Actions',
    className: 'num',
    render: (row) => row.count.toLocaleString(),
  },
];

function dateRangeLabel(range: UplandStatsOverview['dateRange']): string {
  if (range.min === null || range.max === null) {
    return '—';
  }
  return `${formatDate(range.min)} – ${formatDate(range.max)}`;
}

export default function UplandPage() {
  const [overview, setOverview] = useState<UplandStatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const enabled = useFlag('upland_data', demoFlagFallback());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchStatsOverview()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setOverview(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOverview(null);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const categories: CategoryRow[] = overview
    ? Object.entries(overview.byCategory).map(([category, count]) => ({ category, count }))
    : [];

  return (
    <main className="page stack-lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Upland Data — Private Beta</h1>
          <p className="lede">What the Upland blockchain data set holds right now.</p>
        </div>
        {enabled && (
          <a className="btn btn-primary" href={uplandExportUrl('actions')} download>
            Export CSV
          </a>
        )}
      </div>

      {!enabled ? (
        <div className="card stack">
          <h2 className="section-title">Not switched on</h2>
          <p className="muted">Upland Data is in private beta and is not enabled for you yet.</p>
        </div>
      ) : loading ? (
        <div className="table-wrap">
          <div className="empty">Loading the data summary…</div>
        </div>
      ) : failed || overview === null ? (
        <div className="card stack" role="alert">
          <h2 className="section-title">We can&apos;t show the data summary just now</h2>
          <p className="muted">
            The summary would not load, and we will not show you a made-up one.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">{overview.totalActions.toLocaleString()}</div>
              <div className="stat-label">Total actions</div>
            </div>
            <div className="stat">
              <div className="stat-value">{overview.totalProperties.toLocaleString()}</div>
              <div className="stat-label">Properties</div>
            </div>
            <div className="stat">
              <div className="stat-value">{dateRangeLabel(overview.dateRange)}</div>
              <div className="stat-label">Date range</div>
            </div>
            <div className="stat">
              <div className="stat-value">{categories.length}</div>
              <div className="stat-label">Categories</div>
            </div>
          </div>
          <DataTable
            columns={COLUMNS}
            rows={categories}
            rowKey={(row) => row.category}
            empty="No data yet. Once a scrape has run, it shows up here."
          />
        </>
      )}
    </main>
  );
}
