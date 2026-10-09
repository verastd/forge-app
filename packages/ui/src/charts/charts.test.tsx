import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSparklineOption, buildTimeSeriesOption, readPalette } from './options';
import type { ChartPalette } from './options';

const setOption = vi.fn();
const dispose = vi.fn();
const resize = vi.fn();
vi.mock('echarts/core', () => ({
  init: vi.fn(() => ({ setOption, dispose, resize })),
  use: vi.fn(),
}));

const palette: ChartPalette = {
  series: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
  grid: 'grid',
  text: 'text',
  muted: 'muted',
  surface: 'surface',
  border: 'border',
  fontSans: 'sans',
  fontMono: 'mono',
};

type Opt = { animation: boolean; series: Array<Record<string, unknown>>; tooltip: { valueFormatter: (v: unknown) => string }; xAxis: { axisLabel: { formatter: (c: string) => string } }; yAxis: { axisLabel: { formatter: (v: number) => string } } };

describe('buildTimeSeriesOption', () => {
  it('stacks a band under the lines, colors from tokens, never animates', () => {
    const opt = buildTimeSeriesOption(
      {
        categories: ['2026-10-06', '2026-10-07'],
        lines: [{ name: 'Smoothed', values: [5566.5, 5588.7], tone: 1 }, { name: 'Daily', values: [5566.5, null], tone: 2, width: 1 }],
        band: { name: 'Middle half', lower: [4337, null], upper: [6342, 6294], tone: 1 },
        formatValue: (v) => `${v.toFixed(0)} UPX`,
        formatAxis: (c) => c.slice(5),
      },
      palette,
    ) as unknown as Opt;
    expect(opt.animation).toBe(false);
    expect(opt.series.map((s) => s.name)).toEqual(['Middle half (lower)', 'Middle half', 'Smoothed', 'Daily']);
    expect(opt.series[1]!.data).toEqual([2005, null]);
    expect((opt.series[2]!.lineStyle as { color: string }).color).toBe('s1');
    expect((opt.series[3]!.lineStyle as { color: string; width: number }).width).toBe(1);
    expect(opt.tooltip.valueFormatter(12.4)).toBe('12 UPX');
    expect(opt.tooltip.valueFormatter('x')).toBe('—');
    expect(opt.xAxis.axisLabel.formatter('2026-10-06')).toBe('10-06');
    expect(opt.yAxis.axisLabel.formatter(3)).toBe('3 UPX');
  });

  it('works without a band or formatters, and wraps tone indexes', () => {
    const opt = buildTimeSeriesOption({ categories: ['a'], lines: [{ name: 'x', values: [1], tone: 9 }] }, palette) as unknown as Opt;
    expect(opt.series).toHaveLength(1);
    expect((opt.series[0]!.lineStyle as { color: string }).color).toBe('s1');
    expect(opt.yAxis.axisLabel.formatter(2)).toBe('2');
    expect(opt.xAxis.axisLabel.formatter('a')).toBe('a');
    const empty = buildTimeSeriesOption({ categories: [], lines: [{ name: 'x', values: [], tone: 1 }] }, { ...palette, series: [] }) as unknown as Opt;
    expect((empty.series[0]!.lineStyle as { color: string }).color).toBe('text');
  });
});

describe('buildSparklineOption', () => {
  it('draws one quiet line from zero', () => {
    const opt = buildSparklineOption([1, 3, 2], palette, 3) as unknown as Opt;
    expect(opt.series[0]!.data).toEqual([1, 3, 2]);
    expect((opt.series[0]!.lineStyle as { color: string }).color).toBe('s3');
    expect((buildSparklineOption([1], palette) as unknown as Opt).series[0]!.data).toEqual([1]);
  });
});

describe('readPalette', () => {
  it('reads tokens and falls back when they are unset', () => {
    const el = document.createElement('div');
    el.style.setProperty('--chart-series-1', 'red');
    el.style.setProperty('--chart-grid', 'blue');
    document.body.appendChild(el);
    const p = readPalette(el);
    expect(p.series[0]).toBe('red');
    expect(p.series[1]).toBe('#888888');
    expect(p.grid).toBe('blue');
    expect(p.text).toBe('#101010');
  });
});

describe('TimeSeriesChart and Sparkline', () => {
  beforeEach(() => {
    setOption.mockClear();
    dispose.mockClear();
  });

  it('labels the figure, draws, redraws on data and theme change, and disposes', async () => {
    const { TimeSeriesChart } = await import('./Chart');
    const spec = { categories: ['a', 'b'], lines: [{ name: 'Rate', values: [1, 2], tone: 1 }] };
    const { rerender, unmount } = render(<TimeSeriesChart label="UPX per dollar" {...spec} />);
    expect(screen.getByRole('img', { name: 'UPX per dollar' })).toBeTruthy();
    expect(setOption).toHaveBeenCalled();
    const before = setOption.mock.calls.length;
    rerender(<TimeSeriesChart label="UPX per dollar" {...spec} lines={[{ name: 'Rate', values: [1, 3], tone: 1 }]} height={120} />);
    expect(setOption.mock.calls.length).toBeGreaterThan(before);
    const beforeTheme = setOption.mock.calls.length;
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(setOption.mock.calls.length).toBeGreaterThan(beforeTheme);
    unmount();
    expect(dispose).toHaveBeenCalled();
  });

  it('draws nothing under two points', async () => {
    const { Sparkline } = await import('./Chart');
    const { container, rerender } = render(<Sparkline values={[1]} />);
    expect(container.firstChild).toBeNull();
    rerender(<Sparkline values={[1, 2, 3]} tone={2} width={80} height={20} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});
