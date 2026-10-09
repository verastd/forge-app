'use client';

/**
 * Overview: chain status and data freshness, the UPX/USD rate and the top
 * cities, composed like the kit screens (PageHeader with LiveIndicator, a
 * StatTile row, Blocks of Cards and DataTables). Reads, in order:
 *   /status                      (cheap, immediately)
 *   /analytics/overview          (heavy slot)
 *   /market/upx-usd?limit=90     (heavy slot, after the one above)
 *   /market/cities?after=…       (heavy slot, only once scrolled near)
 * The heavy slot runs one at a time, so a page load never fires a burst.
 */
import { Block, Card, DataTable, FactList, LiveIndicator, PageHeader, Skeleton, Sparkline, StatTile, TileRow } from '@forge/ui';
import type { Column, LiveStatus } from '@forge/ui';
import type { CityDay, Overview, Status, UpxUsd } from '@forge/upland-ledger';
import Link from 'next/link';
import { useRef } from 'react';

import { hrefWith } from './_lib/filters';
import { formatClock, formatDay, formatDuration, formatInstant, formatInt, formatRate, formatShortDay, formatUpx, utcDayOffset } from './_lib/format';
import { useInView, useLedgerQuery } from './_lib/hooks';
import { DATA_LAYERS, chainFreshness, rateSeries, rateSummary, rollupCities } from './_lib/market';
import type { CityRollup, DataLayer } from './_lib/market';
import { queryKey } from './_lib/query-core';
import { RateFigure } from './_ui/RateFigure';
import { Region } from './_ui/Region';
import { SignInPrompt } from './_ui/SignIn';
import { routes } from './_ui/links';

const RATE_DAYS = 90;
const CITY_DAYS = 7;
const TOP_CITIES = 10;

export default function OverviewPage() {
  const status = useLedgerQuery<Status>('/status', (c, signal) => c.status(undefined, { signal }));
  const overview = useLedgerQuery<Overview>('/analytics/overview', (c, signal) => c.analytics.overview(undefined, { signal }), { heavy: true });
  const rate = useLedgerQuery<UpxUsd>(queryKey('/market/upx-usd', { limit: RATE_DAYS }), (c, signal) => c.market.upxUsd({ limit: RATE_DAYS }, { signal }), {
    heavy: true,
    isEmpty: (d) => d.points.length === 0,
  });
  const citiesRef = useRef<HTMLDivElement>(null);
  const citiesVisible = useInView(citiesRef);
  const after = utcDayOffset(CITY_DAYS);
  const cities = useLedgerQuery<CityDay[]>(queryKey('/market/cities', { after, limit: 1000 }), (c, signal) => c.market.cities({ after, limit: 1000 }, { signal }), {
    heavy: true,
    enabled: citiesVisible,
  });

  // A signed-out (or practice) viewer gets one prompt for the page, not one per region.
  if (status.view === 'unauthenticated' || overview.view === 'unauthenticated') {
    return (
      <>
        <PageHeader title="Overview" />
        <SignInPrompt onRetry={() => Promise.all([status.refetch(), overview.refetch()])} />
      </>
    );
  }

  const fresh = status.data ? chainFreshness(status.data) : null;
  const behindMinutes = fresh && (fresh.health === 'lagging' || fresh.health === 'stalled') && fresh.lagSeconds !== null ? Math.ceil(fresh.lagSeconds / 60) : null;
  const series = rate.data ? rateSeries(rate.data) : [];
  const summary = rateSummary(series);
  const upx24h = overview.data?.transfers_24h_by_symbol.find((t) => t.symbol === 'UPX');
  const tileState = (v: string): 'loading' | 'error' | 'ready' => (v === 'loading' || v === 'idle' ? 'loading' : v === 'error' ? 'error' : 'ready');

  const indicator: { status: LiveStatus; reason?: string } | null = !fresh
    ? status.view === 'error'
      ? { status: 'error', reason: 'Status unavailable' }
      : { status: 'connecting' }
    : fresh.health === 'live'
      ? { status: 'live' }
      : fresh.health === 'degraded'
        ? { status: 'offline' }
        : fresh.health === 'unknown'
          ? { status: 'connecting' }
          : null; // lagging/stalled: the stale banner says how far behind

  return (
    <>
      <PageHeader
        title="Overview"
        lede="The Upland chain as the ledger sees it: ingest health, the UPX/USD rate and where trading is busiest."
        aside={
          indicator && (
            <LiveIndicator
              status={indicator.status}
              reason={indicator.reason}
              updatedAt={fresh?.latest ? formatClock(fresh.latest) : undefined}
              onRetry={() => void status.refetch()}
            />
          )
        }
      />

      <TileRow>
        <StatTile
          label="Ingest lag"
          state={tileState(status.view)}
          onRetry={status.refetch}
          value={fresh ? formatDuration(fresh.lagSeconds) : undefined}
          hint="How far the ledger's copy of the chain is behind the chain itself"
        />
        <StatTile
          label="Actions, 24 h"
          state={tileState(overview.view)}
          onRetry={overview.refetch}
          value={overview.data?.actions_24h}
          format={{ notation: 'compact', maximumFractionDigits: 1 }}
          animate
        />
        <StatTile
          label="UPX moved, 24 h"
          state={tileState(overview.view)}
          onRetry={overview.refetch}
          value={upx24h?.amount ?? (overview.data ? 0 : undefined)}
          format={{ notation: 'compact', maximumFractionDigits: 1 }}
          unit="UPX"
        />
        <StatTile
          label="UPX per $1"
          state={rate.view === 'empty' ? 'ready' : tileState(rate.view)}
          onRetry={rate.refetch}
          value={summary ? formatRate(summary.upxPerUsd) : '—'}
          delta={summary && summary.change !== null ? Number((summary.change * 100).toFixed(1)) : undefined}
          deltaLabel={summary ? `since ${formatShortDay(summary.firstDay)}` : undefined}
        />
      </TileRow>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
        <Block id="chain" title="Chain status" note={status.updatedAt ? `Checked ${formatClock(new Date(status.updatedAt))} UTC` : '/status'}>
          <Region query={status} skeleton={<FactSkeleton />} emptyMessage="No status." staleMinutes={behindMinutes}>
            {(s) => (
              <Card>
                <FactList
                  items={[
                    { term: 'Ingest lag', value: formatDuration(s.ingestion.lagSeconds), mono: true },
                    { term: 'Latest action', value: formatInstant(s.ingestion.latestTimestamp), mono: true },
                    { term: 'Latest block', value: formatInt(s.ingestion.latestBlock), mono: true },
                    {
                      term: 'History',
                      value: `${s.history.backfillComplete ? 'Complete' : 'Backfilling'} from ${formatDay(s.history.earliestStoredTimestamp)}${s.history.pendingWindows + s.history.failedWindows > 0 ? ` · ${formatInt(s.history.pendingWindows)} windows pending, ${formatInt(s.history.failedWindows)} failed` : ''}`,
                    },
                    { term: 'Upstream', value: s.upstream.connected ? 'Connected' : 'Disconnected' },
                    { term: 'Database', value: s.clickhouse.connected ? 'Connected' : 'Disconnected' },
                  ]}
                />
                {fresh?.reason && <p style={{ margin: 0, font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{fresh.reason}</p>}
              </Card>
            )}
          </Region>
        </Block>

        <Block id="freshness" title="Data freshness" note="How often each ledger layer is rebuilt">
          <DataTable<DataLayer>
            rows={[...DATA_LAYERS]}
            rowKey={(l) => l.id}
            columns={FRESHNESS_COLUMNS(fresh?.lagSeconds ?? null)}
            footer={<span>A sale shows in Market within 15 min; property and account totals count it after the next 6-hourly build.</span>}
          />
        </Block>
      </div>

      <Block id="rate" title="UPX / USD" note="Market layer · rebuilt every 6 h at :17">
        <Region
          query={rate}
          skeleton={
            <Card>
              <Skeleton width="70%" />
              <Skeleton height={260} />
            </Card>
          }
          emptyMessage="The ledger has no UPX/USD rate yet."
        >
          {(d) => (
            <Card>
              <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
                Method <code>{d.preferred}</code> · last {series.length} days · {d.notes.join(' ')}
              </span>
              <RateFigure series={series} />
            </Card>
          )}
        </Region>
      </Block>

      <div ref={citiesRef}>
        <Block id="cities" title={`Top cities, last ${CITY_DAYS} days`} note="By UPX sales volume · market layer">
          <Region
            query={cities}
            skeleton={<DataTable<CityRollup> columns={CITY_COLUMNS} rows={[]} loading skeletonRows={TOP_CITIES} />}
            emptyMessage={`No city had market activity in the last ${CITY_DAYS} days.`}
          >
            {(rows) => <DataTable<CityRollup> columns={CITY_COLUMNS} rows={rollupCities(rows).slice(0, TOP_CITIES)} rowKey={(r) => r.city} />}
          </Region>
        </Block>
      </div>
    </>
  );
}

function FactSkeleton() {
  return (
    <Card>
      {[60, 75, 50, 80, 45, 55].map((w, i) => (
        <Skeleton key={i} width={`${w}%`} />
      ))}
    </Card>
  );
}

const FRESHNESS_COLUMNS = (lag: number | null): Column<DataLayer>[] => [
  { key: 'layer', label: 'Layer', render: (l) => <strong>{l.label}</strong> },
  { key: 'cadence', label: 'Refreshed', render: (l) => (l.id === 'chain' && lag !== null ? `Live, ${formatDuration(lag)} behind` : l.cadence) },
  { key: 'covers', label: 'Feeds', muted: true, render: (l) => <span style={{ whiteSpace: 'normal' }}>{l.covers}</span> },
];

const CITY_COLUMNS: Column<CityRollup>[] = [
  { key: 'city', label: 'City', render: (r) => <Link href={hrefWith(routes.market, { city: r.city })}>{r.city}</Link> },
  { key: 'sales', label: `Sales (${CITY_DAYS} d)`, num: true, render: (r) => formatInt(r.sales) },
  { key: 'trend', label: 'Daily sales', render: (r) => (r.daily.length > 1 ? <Sparkline values={r.daily.map((d) => d.sales)} width={96} height={24} /> : '—') },
  { key: 'volume', label: 'Volume', num: true, render: (r) => formatUpx(r.volumeUpx, { compact: true }) },
  { key: 'median', label: 'Median sale', num: true, render: (r) => formatUpx(r.medianSaleUpx) },
  { key: 'ask', label: 'Median ask', num: true, render: (r) => formatUpx(r.medianAskUpx) },
];
