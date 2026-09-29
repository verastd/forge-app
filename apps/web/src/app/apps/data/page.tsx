'use client';

/**
 * The Data app's overview tab: one summary of what the scraped Upland data
 * set holds (total actions, date range, categories), fetched on mount so
 * `next build` never needs the API up. The `upland_data` gate lives in
 * `./layout.tsx`; by the time this renders, the flag is on. A 401 from the
 * BFF shows `./SignInRequired` instead of data.
 */

import { useFlag } from '@forge/flags/react';
import { useCallback, useEffect, useState } from 'react';

import { Chip } from '../../../components/Chip';
import { DataTable } from '../../../components/DataTable';
import type { Column } from '../../../components/DataTable';
import { demoFlagFallback } from '../../../lib/flags';
import { formatDate } from '../../../lib/format';
import { fetchStatsOverview, uplandExportUrl } from '../../../lib/upland-api';
import type { UplandStatsOverview } from '../../../lib/upland-api';
import { isUnauthorized, SignInRequired } from './SignInRequired';

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

export default function DataOverviewPage() {
  const [overview, setOverview] = useState<UplandStatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const canExport = useFlag('csv_export', demoFlagFallback());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setUnauthorized(false);
    void fetchStatsOverview()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setOverview(result);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setOverview(null);
        setLoading(false);
        setUnauthorized(isUnauthorized(error));
        setFailed(!isUnauthorized(error));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
          <h1 className="page-title">Data — Private Beta</h1>
          <p className="lede">What the Upland blockchain data set holds right now.</p>
        </div>
        {/* Export only beside a summary that loaded: while it loads, fails or asks for a
            sign-in, the download could only fail. */}
        {canExport && !loading && !failed && !unauthorized && (
          <a className="btn btn-primary" href={uplandExportUrl('actions')} download>
            Export CSV
          </a>
        )}
      </div>

      {loading ? (
        <div className="table-wrap">
          <div className="empty">Loading the data summary…</div>
        </div>
      ) : unauthorized ? (
        <SignInRequired onRetry={retry} />
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
