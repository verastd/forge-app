/**
 * ECharts option builders for Embers charts (charts per PRD 6.1 are ECharts;
 * DESIGN_SYSTEM.md supplies the `--chart-series-*`, `--chart-grid` and text
 * tokens). Pure: colors come in already resolved, so these are testable
 * without a DOM. Animation is always off — DESIGN_SYSTEM.md: money and
 * rates never tween through intermediate values.
 */
import type { EChartsCoreOption } from 'echarts/core';

export interface ChartPalette {
  series: readonly string[];
  grid: string;
  text: string;
  muted: string;
  surface: string;
  border: string;
  fontSans: string;
  fontMono: string;
}

export interface TimeSeriesLine {
  name: string;
  values: ReadonlyArray<number | null>;
  /** 1-based index into --chart-series-1..8. */
  tone: number;
  width?: number;
}

export interface TimeSeriesBand {
  name: string;
  lower: ReadonlyArray<number | null>;
  upper: ReadonlyArray<number | null>;
  tone: number;
}

export interface TimeSeriesSpec {
  categories: readonly string[];
  lines: readonly TimeSeriesLine[];
  band?: TimeSeriesBand;
  formatAxis?: (category: string) => string;
  formatValue?: (value: number) => string;
}

const tone = (palette: ChartPalette, n: number): string => palette.series[(n - 1) % palette.series.length] ?? palette.text;

export function buildTimeSeriesOption(spec: TimeSeriesSpec, palette: ChartPalette): EChartsCoreOption {
  const fmtValue = spec.formatValue ?? ((v: number) => String(v));
  const series: Record<string, unknown>[] = [];
  if (spec.band) {
    const band = spec.band;
    // Stacked pair: an invisible lower line and the (upper − lower) area on top of it.
    series.push({
      name: `${band.name} (lower)`,
      type: 'line',
      data: [...band.lower],
      stack: 'band',
      symbol: 'none',
      lineStyle: { opacity: 0 },
      tooltip: { show: false },
      silent: true,
    });
    series.push({
      name: band.name,
      type: 'line',
      data: band.upper.map((u, i) => {
        const l = band.lower[i];
        return u === null || l === null || l === undefined ? null : u - l;
      }),
      stack: 'band',
      symbol: 'none',
      lineStyle: { opacity: 0 },
      areaStyle: { color: tone(palette, band.tone), opacity: 0.16 },
      silent: true,
    });
  }
  for (const line of spec.lines) {
    series.push({
      name: line.name,
      type: 'line',
      data: [...line.values],
      symbol: 'none',
      connectNulls: false,
      lineStyle: { color: tone(palette, line.tone), width: line.width ?? 2 },
      itemStyle: { color: tone(palette, line.tone) },
    });
  }
  const axisLabel = { color: palette.muted, fontFamily: palette.fontMono, fontSize: 11 };
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
    textStyle: { fontFamily: palette.fontSans, color: palette.text },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.surface,
      borderColor: palette.border,
      textStyle: { color: palette.text, fontFamily: palette.fontMono, fontSize: 12 },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtValue(v) : '—'),
    },
    xAxis: {
      type: 'category',
      data: [...spec.categories],
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, formatter: spec.formatAxis ?? ((c: string) => c), hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: palette.grid } },
      axisLabel: { ...axisLabel, formatter: (v: number) => fmtValue(v) },
    },
    series,
  };
}

export function buildSparklineOption(values: readonly number[], palette: ChartPalette, toneIndex = 1): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        data: [...values],
        symbol: 'none',
        silent: true,
        lineStyle: { color: tone(palette, toneIndex), width: 1.5 },
      },
    ],
  };
}

/** Resolve the Embers chart tokens from an element inside `.em-root`. */
export function readPalette(el: Element): ChartPalette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => v(`--chart-series-${n}`, '#888888')),
    grid: v('--chart-grid', '#dedede'),
    text: v('--text-primary', '#101010'),
    muted: v('--text-muted', '#6f6f6f'),
    surface: v('--surface-popover', '#ffffff'),
    border: v('--border-subtle', '#dedede'),
    fontSans: v('--font-sans', 'system-ui'),
    fontMono: v('--font-mono', 'monospace'),
  };
}
