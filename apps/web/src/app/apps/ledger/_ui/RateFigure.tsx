'use client';

/** The UPX/USD chart (ECharts, Embers chart tokens) with its legend and the numbers behind it. */
import { DataTable, TimeSeriesChart } from '@forge/ui';

import { formatDay, formatInt, formatRate, formatShortDay, formatUsd } from '../_lib/format';
import { rateSummary } from '../_lib/market';
import type { RateDatum } from '../_lib/market';

export function RateFigure({ series, method }: { series: RateDatum[]; method?: string }) {
  const summary = rateSummary(series);
  return (
    <figure style={{ margin: 0, display: 'grid', gap: 8, minWidth: 0 }}>
      <TimeSeriesChart
        label={
          summary
            ? `UPX per US dollar${method ? ` by ${method}` : ''} over ${series.length} days, latest ${formatRate(summary.upxPerUsd)} on ${formatDay(summary.day)} (${formatUsd(summary.usdPerUpx)} per UPX).`
            : 'UPX per US dollar'
        }
        categories={series.map((d) => d.day)}
        formatAxis={formatShortDay}
        formatValue={(v) => formatInt(v)}
        band={{ name: 'Middle half of samples (p25–p75)', lower: series.map((d) => d.band[0]), upper: series.map((d) => d.band[1]), tone: 1 }}
        lines={[
          { name: 'Smoothed', values: series.map((d) => d.smooth), tone: 1 },
          { name: 'Daily', values: series.map((d) => d.rate), tone: 2, width: 1 },
        ]}
      />
      <figcaption style={{ display: 'flex', gap: 14, flexWrap: 'wrap', font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
        <Legend color="var(--chart-series-1)" text="Smoothed rate" />
        <Legend color="var(--chart-series-2)" text="Daily rate" />
        <Legend color="var(--chart-series-1)" text="Middle half of samples (p25–p75)" band />
      </figcaption>
      <details>
        <summary style={{ cursor: 'pointer', font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>Show the data</summary>
        <div style={{ marginTop: 8 }}>
          <DataTable<RateDatum>
            rows={[...series].reverse()}
            rowKey={(d) => d.day}
            columns={[
              { key: 'day', label: 'Day', render: (d) => formatDay(d.day) },
              { key: 'rate', label: 'UPX per $1', num: true, render: (d) => formatRate(d.rate) },
              { key: 'smooth', label: 'Smoothed', num: true, render: (d) => formatRate(d.smooth) },
              { key: 'band', label: 'p25–p75', num: true, render: (d) => `${formatRate(d.band[0])}–${formatRate(d.band[1])}` },
              { key: 'samples', label: 'Samples', num: true, render: (d) => formatInt(d.samples) },
            ]}
          />
        </div>
      </details>
    </figure>
  );
}

function Legend({ color, text, band }: { color: string; text: string; band?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span aria-hidden="true" style={{ width: 14, height: band ? 8 : 2, background: color, opacity: band ? 0.3 : 1, borderRadius: 1 }} />
      {text}
    </span>
  );
}
