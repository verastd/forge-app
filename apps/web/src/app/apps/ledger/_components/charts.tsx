'use client';

/**
 * Charts (recharts). Colors are the Embers chart tokens, so they follow the
 * theme. Every chart has a text alternative: a summary in its label and the
 * numbers behind it in a "Show the data" table.
 */

import { Area, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatDay, formatInt, formatShortDay, formatUpxPerUsd } from '../_lib/format';
import type { RateDatum } from '../_lib/market';
import { DataTable } from './DataTable';

const AXIS_TICK = { fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' };

interface TooltipPayload {
  payload?: RateDatum;
}

function RateTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  const d = active ? payload?.[0]?.payload : undefined;
  if (!d) return null;
  return (
    <div className="em-chart-tooltip">
      <strong>{formatDay(d.day)}</strong>
      <span className="em-num">Rate {formatUpxPerUsd(d.rate)}</span>
      <span className="em-num">Smoothed {formatUpxPerUsd(d.smooth)}</span>
      <span className="em-num">
        Middle half {formatInt(d.band[0])}–{formatInt(d.band[1])}
      </span>
      <span className="em-num">{formatInt(d.samples)} samples</span>
    </div>
  );
}

export function RateChart({ series, label }: { series: RateDatum[]; label: string }) {
  return (
    <figure style={{ margin: 0, display: 'grid', gap: 8, minWidth: 0 }}>
      <div className="em-chart" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="day" tickFormatter={formatShortDay} tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={56}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => formatInt(v)}
            />
            <Tooltip content={<RateTooltip />} />
            <Area
              type="monotone"
              dataKey="band"
              stroke="none"
              fill="var(--chart-series-1)"
              fillOpacity={0.14}
              isAnimationActive={false}
              name="Middle half of samples"
            />
            <Line type="monotone" dataKey="rate" stroke="var(--chart-series-2)" strokeWidth={1} dot={false} isAnimationActive={false} name="Daily rate" />
            <Line type="monotone" dataKey="smooth" stroke="var(--chart-series-1)" strokeWidth={2} dot={false} isAnimationActive={false} name="Smoothed" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="em-row em-caption">
        <Legend color="var(--chart-series-1)" text="Smoothed rate" />
        <Legend color="var(--chart-series-2)" text="Daily rate" />
        <Legend color="var(--chart-series-1)" text="Middle half of samples (p25–p75)" band />
      </figcaption>
      <details>
        <summary className="em-caption" style={{ cursor: 'pointer' }}>
          Show the data
        </summary>
        <div style={{ marginTop: 8 }}>
          <DataTable
            caption="UPX per US dollar by day"
            rows={[...series].reverse()}
            rowKey={(d) => d.day}
            columns={[
              { key: 'day', label: 'Day', render: (d) => formatDay(d.day) },
              { key: 'rate', label: 'UPX per $1', num: true, render: (d) => formatInt(d.rate) },
              { key: 'smooth', label: 'Smoothed', num: true, render: (d) => formatInt(d.smooth) },
              { key: 'band', label: 'p25–p75', num: true, render: (d) => `${formatInt(d.band[0])}–${formatInt(d.band[1])}` },
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
      <span
        aria-hidden="true"
        style={{ width: 14, height: band ? 8 : 2, background: color, opacity: band ? 0.3 : 1, borderRadius: 1 }}
      />
      {text}
    </span>
  );
}

/** A tiny line of daily values (sales per day), decorative: the table cell beside it carries the numbers. */
export function Sparkline({ values }: { values: Array<{ day: string; sales: number }> }) {
  if (values.length < 2) return null;
  return (
    <span className="em-chart em-chart--small" aria-hidden="true" style={{ display: 'inline-block' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={values} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
          <YAxis hide domain={[0, 'dataMax']} />
          <Line type="monotone" dataKey="sales" stroke="var(--chart-series-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </span>
  );
}
