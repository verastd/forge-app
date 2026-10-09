'use client';

/**
 * Overview: chain status and data freshness, the UPX/USD rate and the top
 * cities. Reads, in order:
 *   /status                      (cheap, immediately)
 *   /analytics/overview          (heavy slot)
 *   /market/upx-usd?limit=90     (heavy slot, after the one above)
 *   /market/cities?after=…       (heavy slot, only once scrolled near)
 * The heavy slot runs one at a time, so a page load never fires a burst.
 */

import Link from 'next/link';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { CityDay, Overview, Status, UpxUsd } from '@forge/upland-ledger';

import { DataState } from './_components/DataState';
import { DataTable, TableSkeleton } from './_components/DataTable';
import { ChainStatus, LayerNote } from './_components/Freshness';
import { LedgerSignIn } from './_components/LedgerSignIn';
import { RateChart, Sparkline } from './_components/charts';
import { routes } from './_components/links';
import { LiveDot, Skeleton, StatTile } from './_components/primitives';
import { hrefWith } from './_lib/filters';
import {
  formatCompact,
  formatDay,
  formatDuration,
  formatInt,
  formatSignedPercent,
  formatUpx,
  formatUsd,
  utcDayOffset,
} from './_lib/format';
import { useInView, useLedgerQuery } from './_lib/hooks';
import { chainFreshness, DATA_LAYERS, rateSeries, rateSummary, rollupCities } from './_lib/market';
import type { CityRollup } from './_lib/market';
import { queryKey } from './_lib/query-core';

const RATE_DAYS = 90;
const CITY_DAYS = 7;
const TOP_CITIES = 10;

const CITY_COLUMNS = [
  { key: 'city', label: 'City' },
  { key: 'sales', label: `Sales (${CITY_DAYS} d)` },
  { key: 'trend', label: 'Daily sales' },
  { key: 'volume', label: 'Volume' },
  { key: 'median', label: 'Median sale' },
  { key: 'ask', label: 'Median ask' },
];

export default function OverviewPage() {
  const status = useLedgerQuery<Status>('/status', (c, signal) => c.status(undefined, { signal }));
  const overview = useLedgerQuery<Overview>('/analytics/overview', (c, signal) => c.analytics.overview(undefined, { signal }), {
    heavy: true,
  });
  const rate = useLedgerQuery<UpxUsd>(
    queryKey('/market/upx-usd', { limit: RATE_DAYS }),
    (c, signal) => c.market.upxUsd({ limit: RATE_DAYS }, { signal }),
    { heavy: true, isEmpty: (d) => d.points.length === 0 },
  );

  const citiesRef = useRef<HTMLElement>(null);
  const citiesVisible = useInView(citiesRef);
  const after = utcDayOffset(CITY_DAYS);
  const cities = useLedgerQuery<CityDay[]>(
    queryKey('/market/cities', { after, limit: 1000 }),
    (c, signal) => c.market.cities({ after, limit: 1000 }, { signal }),
    { heavy: true, enabled: citiesVisible },
  );

  // A signed-out (or practice) viewer gets one prompt for the page, not one per section.
  if (status.view === 'unauthenticated' || overview.view === 'unauthenticated') {
    return (
      <>
        <PageHead />
        <LedgerSignIn onRetry={async () => Promise.all([status.refetch(), overview.refetch()])} />
      </>
    );
  }

  const series = rate.data ? rateSeries(rate.data) : [];
  const summary = rateSummary(series);
  const freshness = status.data ? chainFreshness(status.data) : null;
  const upx24h = overview.data?.transfers_24h_by_symbol.find((t) => t.symbol === 'UPX');
  const tileState = (q: { view: string }): 'loading' | 'error' | 'ready' =>
    q.view === 'loading' ? 'loading' : q.view === 'error' ? 'error' : 'ready';

  return (
    <>
      <PageHead live={freshness ? <LiveDot status={freshness.health === 'degraded' ? 'offline' : freshness.health} /> : status.fetching ? <LiveDot status="checking" /> : null} />

      <section aria-label="Key figures" className="em-stat-grid">
        <StatTile
          label="Ingest lag"
          state={tileState(status)}
          onRetry={status.refetch}
          value={freshness ? formatDuration(freshness.lagSeconds) : null}
          sub={freshness ? `Block ${formatInt(freshness.latestBlock)}` : undefined}
        />
        <StatTile
          label="Actions, 24 h"
          state={tileState(overview)}
          onRetry={overview.refetch}
          value={overview.data ? formatCompact(overview.data.actions_24h) : null}
          sub={overview.data ? `${formatCompact(overview.data.actions_total)} all time` : undefined}
        />
        <StatTile
          label="UPX moved, 24 h"
          state={tileState(overview)}
          onRetry={overview.refetch}
          value={upx24h ? formatCompact(upx24h.amount) : overview.data ? '0' : null}
          unit="UPX"
          sub={upx24h ? `${formatInt(upx24h.transfers)} transfers` : undefined}
        />
        <StatTile
          label="UPX per $1"
          state={rate.view === 'loading' || rate.view === 'idle' ? 'loading' : rate.view === 'error' ? 'error' : 'ready'}
          onRetry={rate.refetch}
          value={summary ? formatInt(summary.upxPerUsd) : '—'}
          trend={
            summary && summary.change !== null
              ? { value: summary.change, text: `${formatSignedPercent(summary.change)} since ${formatDay(summary.firstDay)}` }
              : null
          }
          sub={summary ? `${formatUsd(summary.usdPerUpx)} per UPX · ${formatDay(summary.day)}` : rate.view === 'empty' ? 'No rate published yet' : undefined}
        />
      </section>

      <div className="em-grid-2">
        <section className="em-section" aria-labelledby="chain-h">
          <div className="em-section-head">
            <h2 id="chain-h" className="em-h3">
              Chain status
            </h2>
            <span className="em-caption">/status</span>
          </div>
          <div className="em-card">
            <DataState query={status} label="chain status" skeleton={<Skeleton height={120} />}>
              {(s) => <ChainStatus status={s} />}
            </DataState>
          </div>
        </section>

        <section className="em-section" aria-labelledby="fresh-h">
          <div className="em-section-head">
            <h2 id="fresh-h" className="em-h3">
              Data freshness
            </h2>
            <span className="em-caption">How often each layer is rebuilt</span>
          </div>
          <DataTable
            caption="Ledger data layers and how often they refresh"
            rows={DATA_LAYERS}
            rowKey={(l) => l.id}
            columns={[
              { key: 'layer', label: 'Layer', render: (l) => <strong>{l.label}</strong> },
              { key: 'cadence', label: 'Refreshed', render: (l) => (l.id === 'chain' && freshness ? `Live, ${formatDuration(freshness.lagSeconds)} behind` : l.cadence) },
              { key: 'covers', label: 'Feeds', wrap: true, muted: true, render: (l) => l.covers },
            ]}
            footer={<span>A sale shows in Market within 15 min, but property and account totals count it only after the next 6-hourly build.</span>}
          />
        </section>
      </div>

      <section className="em-section" aria-labelledby="rate-h">
        <div className="em-section-head">
          <h2 id="rate-h" className="em-h3">
            UPX / USD
          </h2>
          <LayerNote layer="market" updatedAt={rate.updatedAt} />
        </div>
        <div className="em-card">
          <DataState query={rate} label="the UPX/USD rate" skeleton={<Skeleton height={260} />} empty="The ledger has no UPX/USD rate yet.">
            {(d) => (
              <div style={{ display: 'grid', gap: 10 }}>
                <p className="em-caption">
                  Method <code>{d.preferred}</code>, last {series.length} days.{' '}
                  {d.notes.length > 0 && <span>{d.notes.join(' ')}</span>}
                </p>
                <RateChart
                  series={series}
                  label={
                    summary
                      ? `UPX per US dollar over ${series.length} days, latest ${formatInt(summary.upxPerUsd)} on ${formatDay(summary.day)}.`
                      : 'UPX per US dollar'
                  }
                />
              </div>
            )}
          </DataState>
        </div>
      </section>

      <section className="em-section" aria-labelledby="cities-h" ref={citiesRef}>
        <div className="em-section-head">
          <h2 id="cities-h" className="em-h3">
            Top cities, last {CITY_DAYS} days
          </h2>
          <LayerNote layer="market" updatedAt={cities.updatedAt} />
        </div>
        {cities.view === 'idle' ? (
          <TableSkeleton columns={CITY_COLUMNS} rows={4} />
        ) : (
          <DataState
            query={cities}
            label="top cities"
            skeleton={<TableSkeleton columns={CITY_COLUMNS} rows={TOP_CITIES} />}
            empty={`No city had market activity in the last ${CITY_DAYS} days.`}
          >
            {(rows) => <CityTable rows={rollupCities(rows).slice(0, TOP_CITIES)} />}
          </DataState>
        )}
      </section>
    </>
  );
}

function PageHead({ live }: { live?: ReactNode }) {
  return (
    <div className="em-page-head">
      <div>
        <h1 className="em-h1">Overview</h1>
        <p className="em-lede">The Upland chain as the ledger sees it: ingest health, the UPX/USD rate and where trading is busiest.</p>
      </div>
      {live}
    </div>
  );
}

function CityTable({ rows }: { rows: CityRollup[] }) {
  return (
    <DataTable
      caption={`Top cities by UPX sales volume, last ${CITY_DAYS} days`}
      rows={rows}
      rowKey={(r) => r.city}
      columns={[
        {
          key: 'city',
          label: 'City',
          render: (r) => <Link href={hrefWith(routes.market, { city: r.city })}>{r.city}</Link>,
        },
        { key: 'sales', label: `Sales (${CITY_DAYS} d)`, num: true, render: (r) => formatInt(r.sales) },
        { key: 'trend', label: 'Daily sales', render: (r) => <Sparkline values={r.daily} /> },
        { key: 'volume', label: 'Volume', num: true, render: (r) => formatUpx(r.volumeUpx, { compact: true }) },
        { key: 'median', label: 'Median sale', num: true, render: (r) => formatUpx(r.medianSaleUpx) },
        { key: 'ask', label: 'Median ask', num: true, render: (r) => formatUpx(r.medianAskUpx) },
      ]}
    />
  );
}
