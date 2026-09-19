'use client';

/**
 * The sales tab: the latest priced sales (secondary buys, offer accepts,
 * mints), and the daily volume the market moved. Both load independently —
 * one failing does not blank the other.
 */

import { useCallback, useEffect, useState } from 'react';

import { Chip } from '../../../components/Chip';
import { DataTable } from '../../../components/DataTable';
import type { Column } from '../../../components/DataTable';
import { formatChainTimestamp, formatUpx } from '../../../lib/format';
import { fetchRecentSales, fetchSalesVolume, uplandExportUrl } from '../../../lib/upland-api';
import type { SalesVolumeDay, UplandAction } from '../../../lib/upland-api';

const RECENT_LIMIT = 50;
const VOLUME_DAYS = 30;

const SALE_COLUMNS: ReadonlyArray<Column<UplandAction>> = [
  {
    key: 'ts',
    header: 'When',
    className: 'num',
    render: (row) => formatChainTimestamp(row.ts),
  },
  {
    key: 'action',
    header: 'Sale',
    render: (row) => (
      <Chip tone="accent" title={row.actionName}>
        {row.actionMeaning ?? row.actionName}
      </Chip>
    ),
  },
  {
    key: 'property',
    header: 'Property',
    className: 'num',
    render: (row) => row.propertyId ?? <span className="faint">—</span>,
  },
  {
    key: 'from',
    header: 'From',
    render: (row) => row.fromAccount ?? <span className="faint">—</span>,
  },
  {
    key: 'to',
    header: 'To',
    render: (row) => row.toAccount ?? <span className="faint">—</span>,
  },
  {
    key: 'price',
    header: 'Price',
    className: 'num',
    render: (row) => (row.priceUpx === null ? <span className="faint">—</span> : formatUpx(row.priceUpx)),
  },
];

const VOLUME_COLUMNS: ReadonlyArray<Column<SalesVolumeDay>> = [
  // The day key is rendered verbatim: parsing "YYYY-MM-DD" through Date()
  // reads it as UTC midnight and shifts it a day west of Greenwich.
  { key: 'date', header: 'Day', className: 'num', render: (row) => row.date },
  { key: 'count', header: 'Sales', className: 'num', render: (row) => row.count.toLocaleString() },
  { key: 'volume', header: 'Volume', className: 'num', render: (row) => formatUpx(row.volumeUpx) },
  { key: 'avg', header: 'Average', className: 'num', render: (row) => formatUpx(row.avgPrice) },
  { key: 'min', header: 'Lowest', className: 'num', render: (row) => formatUpx(row.minPrice) },
  { key: 'max', header: 'Highest', className: 'num', render: (row) => formatUpx(row.maxPrice) },
];

interface Section<T> {
  rows: T[];
  loading: boolean;
  failed: boolean;
}

const PENDING: Section<never> = { rows: [], loading: true, failed: false };

export default function UplandSalesPage() {
  const [sales, setSales] = useState<Section<UplandAction>>(PENDING);
  const [volume, setVolume] = useState<Section<SalesVolumeDay>>(PENDING);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSales(PENDING);
    setVolume(PENDING);
    void fetchRecentSales(RECENT_LIMIT)
      .then((rows) => {
        if (!cancelled) {
          setSales({ rows, loading: false, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSales({ rows: [], loading: false, failed: true });
        }
      });
    void fetchSalesVolume(VOLUME_DAYS)
      .then((rows) => {
        if (!cancelled) {
          // Newest day first, same direction as the sales feed above it.
          setVolume({ rows: [...rows].reverse(), loading: false, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVolume({ rows: [], loading: false, failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  function section<T>(
    state: Section<T>,
    columns: ReadonlyArray<Column<T>>,
    rowKey: (row: T, index: number) => string,
    emptyText: string,
    failedTitle: string,
  ) {
    if (state.loading) {
      return (
        <div className="table-wrap" aria-busy="true">
          <div className="empty">
            <span className="spinner" aria-hidden="true" /> Loading…
          </div>
        </div>
      );
    }
    if (state.failed) {
      return (
        <div className="card stack" role="alert">
          <h3 className="section-title">{failedTitle}</h3>
          <p className="muted">It would not load, and we will not show you a made-up one.</p>
          <div className="row">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <DataTable columns={columns} rows={state.rows} rowKey={rowKey} empty={emptyText} />;
  }

  return (
    <main className="page stack-lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Sales</h1>
          <p className="lede">What the market is trading, and what it moves per day.</p>
        </div>
        <a className="btn btn-primary" href={uplandExportUrl('sales')} download>
          Export sales CSV
        </a>
      </div>

      <section className="stack">
        <h2 className="section-title">Latest sales</h2>
        {section(
          sales,
          SALE_COLUMNS,
          (row) => String(row.globalSequence),
          'No sales in the data set yet.',
          "We can't show the latest sales just now",
        )}
      </section>

      <section className="stack">
        <h2 className="section-title">Daily volume — last {VOLUME_DAYS} days</h2>
        {section(
          volume,
          VOLUME_COLUMNS,
          (row) => row.date,
          'No sales volume in the data set yet.',
          "We can't show the daily volume just now",
        )}
      </section>
    </main>
  );
}
