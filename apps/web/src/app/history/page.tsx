'use client';

/**
 * The demo product page: the activity table, and the CSV-export story that
 * issue #1's acceptance test is written against (PRD Appendix H.2).
 *
 * Fetches on mount so `next build` never needs the API up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
// Client components import the `/react` subpath only: `@forge/flags` itself is
// the server entry (it owns `loadFlags`, and with it node's filesystem APIs).
import { useFlag } from '@forge/flags/react';
import { EXPORT_COLUMNS } from '@forge/shared';
import type { HistoryItem } from '@forge/shared';

import { Chip } from '../../components/Chip';
import type { ChipTone } from '../../components/Chip';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { DemoBanner } from '../../components/DemoBanner';
import { Pagination } from '../../components/Pagination';
import { HISTORY_PAGE_SIZE, exportUrl, fetchHistory } from '../../lib/api';
import { demoFlagFallback } from '../../lib/flags';
import { amountClass, formatAmount, formatTimestamp } from '../../lib/format';

const TYPE_TONE: Record<HistoryItem['type'], ChipTone> = {
  earn: 'ok',
  spend: 'danger',
  transfer: 'info',
};

const TYPE_LABEL: Record<HistoryItem['type'], string> = {
  earn: 'earned',
  spend: 'spent',
  transfer: 'moved',
};

const COLUMNS: ReadonlyArray<Column<HistoryItem>> = [
  { key: 'ts', header: 'When', className: 'num', render: (row) => formatTimestamp(row.ts) },
  {
    key: 'type',
    header: 'What',
    render: (row) => <Chip tone={TYPE_TONE[row.type]}>{TYPE_LABEL[row.type]}</Chip>,
  },
  {
    key: 'amount',
    header: 'Amount',
    className: 'num',
    render: (row) => <span className={amountClass(row.type)}>{formatAmount(row)}</span>,
  },
  {
    key: 'memo',
    header: 'Note',
    render: (row) => row.memo ?? <span className="faint">—</span>,
  },
];

export default function HistoryPage() {
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The fallback is the demo app's, and only the demo app's: live keeps the
  // flag client's fail-closed default, so a flag service we cannot reach hides
  // the export exactly as a switched-off flag would.
  const csvExport = useFlag('csv_export', demoFlagFallback());

  // The export is a plain download link by design (PRD H.2), so the browser
  // owns the transfer. What we can say truthfully is that the click landed and
  // the file was handed to the browser; the button says exactly that.
  const [exportSent, setExportSent] = useState(false);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (exportTimer.current !== null) {
        clearTimeout(exportTimer.current);
      }
    },
    [],
  );
  const onExportClick = useCallback(() => {
    setExportSent(true);
    if (exportTimer.current !== null) {
      clearTimeout(exportTimer.current);
    }
    exportTimer.current = setTimeout(() => {
      setExportSent(false);
    }, 3500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchHistory(HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setItems(result.data.items);
        setTotal(result.data.total);
        setDegraded(result.degraded);
        setLoading(false);
      })
      .catch(() => {
        // Live: this table is somebody's money. An empty one with an error
        // beats a plausible one made of fixtures.
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
  }, [page, attempt]);

  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const onPageChange = useCallback((next: number) => {
    setPage(next);
  }, []);
  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return (
    <main className="page stack-lg">
      <DemoBanner />
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">History</h1>
            <p className="lede">Everything that has moved in your account, newest first.</p>
          </div>
          {csvExport && (
            <a
              className="btn btn-primary"
              href={exportUrl}
              download
              title={`Columns: ${EXPORT_COLUMNS.join(', ')}`}
              onClick={onExportClick}
            >
              Export CSV
            </a>
          )}
        </div>
        {exportSent && (
          <p className="faint note-ok" role="status" style={{ marginTop: 10 }}>
            ✓ Sent to your browser. Check your downloads for the CSV.
          </p>
        )}
        {degraded && (
          <p className="faint" style={{ marginTop: 10 }}>
            Showing a local demo copy — we could not reach the FORGE service.
          </p>
        )}
      </div>

      {loading ? (
        <div className="table-wrap" aria-busy="true">
          <div className="skeleton-row">
            <p className="loading-line">
              <span className="spinner" aria-hidden="true" />
              Loading your history…
            </p>
          </div>
          {[62, 48, 70, 54, 66].map((width) => (
            <div key={width} className="skeleton-row">
              <div className="skeleton" style={{ width: '18%' }} />
              <div className="skeleton" style={{ width: '10%' }} />
              <div className="skeleton" style={{ width: '12%' }} />
              <div className="skeleton" style={{ width: `${width - 30}%` }} />
            </div>
          ))}
        </div>
      ) : failed ? (
        <div className="card stack" role="alert">
          <h2 className="section-title">We can&apos;t show your history just now</h2>
          <p className="muted">
            Your history would not load, and we will not show you a made-up one. Nothing in your
            account has changed.
          </p>
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
            rowKey={(row) => row.id}
            empty="No activity yet. Once you start using the app, it shows up here."
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            onPageChange={onPageChange}
          />
        </>
      )}
    </main>
  );
}
