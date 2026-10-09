/**
 * Embers charts on ECharts (SVG renderer, tree-shaken). The chart reads the
 * Embers tokens from its own element, so it follows light/dark, and redraws
 * when <html data-theme> changes. Every chart carries a text alternative:
 * `label` on the figure (role="img") plus an optional data table the caller
 * renders (DESIGN_SYSTEM.md: color is never the only carrier).
 */
import { LineChart as ELine } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

import { buildSparklineOption, buildTimeSeriesOption, readPalette } from './options';
import type { ChartPalette, TimeSeriesSpec } from './options';

use([ELine, GridComponent, TooltipComponent, SVGRenderer]);

function useEChart(build: (palette: ChartPalette) => EChartsCoreOption, deps: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const instance = init(el, undefined, { renderer: 'svg' });
    chart.current = instance;
    const draw = (): void => instance.setOption(buildRef.current(readPalette(el)), true);
    draw();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => instance.resize());
    resize?.observe(el);
    const themeWatch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(draw);
    themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      resize?.disconnect();
      themeWatch?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    // `deps` are the caller's serialized data; redraw when they change.
    if (el !== null && chart.current !== null) chart.current.setOption(buildRef.current(readPalette(el)), true);
  }, deps);

  return ref;
}

export interface TimeSeriesChartProps extends TimeSeriesSpec {
  /** Text alternative for the whole chart. */
  label: string;
  height?: number;
  style?: CSSProperties;
}

export function TimeSeriesChart({ label, height = 260, style, ...spec }: TimeSeriesChartProps) {
  const ref = useEChart((palette) => buildTimeSeriesOption(spec, palette), [JSON.stringify(spec.categories), JSON.stringify(spec.lines), JSON.stringify(spec.band)]);
  return <div ref={ref} role="img" aria-label={label} style={{ width: '100%', height, minWidth: 0, ...style }} />;
}

export interface SparklineProps {
  values: readonly number[];
  tone?: number;
  width?: number;
  height?: number;
}

/** A tiny trend line; decorative (the cell beside it carries the numbers). Nothing to draw under two points. */
export function Sparkline(props: SparklineProps) {
  return props.values.length < 2 ? null : <SparklineCanvas {...props} />;
}

function SparklineCanvas({ values, tone = 1, width = 120, height = 32 }: SparklineProps) {
  const ref = useEChart((palette) => buildSparklineOption(values, palette, tone), [JSON.stringify(values), tone]);
  return <div ref={ref} aria-hidden="true" style={{ width, height, display: 'inline-block' }} />;
}
