import { describe, expect, it } from 'vitest';
import { CityDayListSchema, StatusSchema, UpxUsdSchema } from '@forge/upland-ledger';

import { fixture } from './fixtures.test-helper';
import { DATA_LAYERS, chainFreshness, dataLayer, rateSeries, rateSummary, rollupCities } from './market';

const upx = fixture('GET_market_upx-usd', UpxUsdSchema);
const cities = fixture('GET_market_cities', CityDayListSchema);
const status = fixture('GET_status', StatusSchema);

describe('rateSeries / rateSummary (GET_market_upx-usd)', () => {
  it('uses the preferred method, oldest first, with the p25–p75 band', () => {
    const series = rateSeries(upx);
    expect(series.map((d) => d.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(series[0]).toMatchObject({ rate: 5566.519023644128, band: [4337.374008767731, 6342.4148976523975], samples: 76 });
    expect(series.every((d) => d.band[0] <= d.rate && d.rate <= d.band[1])).toBe(true);
  });

  it('sorts a shuffled payload and filters by method', () => {
    const shuffled = { ...upx, points: [...upx.points].reverse() };
    expect(rateSeries(shuffled).map((d) => d.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(rateSeries(upx, 'global_comps')).toEqual([]);
  });

  it('summarizes the latest day and the change of the smoothed rate', () => {
    const summary = rateSummary(rateSeries(upx));
    expect(summary).not.toBeNull();
    expect(summary!.day).toBe('2026-10-08');
    expect(summary!.firstDay).toBe('2026-10-06');
    expect(summary!.usdPerUpx).toBeCloseTo(1 / summary!.upxPerUsd);
    expect(summary!.change).not.toBeNull();
  });

  it('has nothing to say about an empty or one-point series', () => {
    expect(rateSummary([])).toBeNull();
    const one = rateSeries(upx).slice(0, 1);
    expect(rateSummary(one)!.change).toBeNull();
  });
});

describe('rollupCities (GET_market_cities)', () => {
  it('ranks cities by UPX volume', () => {
    const rows = rollupCities(cities);
    expect(rows.map((r) => r.city)).toEqual(['Las Vegas', 'Los Angeles', 'Rome']);
    expect(rows[0]).toMatchObject({ sales: 17, volumeUpx: 1013455, medianSaleUpx: 32000, days: 1 });
  });

  it('sums days per city and takes the latest non-null median', () => {
    const base = cities[0]!;
    const rows = rollupCities([
      { ...base, city: 'X', day: '2026-10-07', sales: 2, volume_upx: 10, median_sale_upx: 5 },
      { ...base, city: 'X', day: '2026-10-08', sales: 3, volume_upx: 20, median_sale_upx: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sales: 5, volumeUpx: 30, medianSaleUpx: 5 });
    expect(rows[0]!.daily).toEqual([
      { day: '2026-10-07', sales: 2 },
      { day: '2026-10-08', sales: 3 },
    ]);
  });

  it('reports null medians when the window has none', () => {
    const base = cities[0]!;
    const [row] = rollupCities([{ ...base, median_sale_upx: null, median_ask_upx: null }]);
    expect(row!.medianSaleUpx).toBeNull();
    expect(row!.medianAskUpx).toBeNull();
  });
});

describe('chainFreshness (GET_status)', () => {
  it('reads the captured status as live', () => {
    expect(chainFreshness(status)).toMatchObject({ health: 'live', lagSeconds: 1, latestBlock: 91625496, reason: null });
  });

  it.each([
    [{ ingestion: { ...status.ingestion, lagSeconds: 120 } }, 'lagging'],
    [{ ingestion: { ...status.ingestion, lagSeconds: 3600 } }, 'stalled'],
    [{ ingestion: { ...status.ingestion, lagSeconds: null } }, 'unknown'],
    [{ upstream: { ...status.upstream, connected: false } }, 'degraded'],
    [{ clickhouse: { ...status.clickhouse, connected: false } }, 'degraded'],
  ] as const)('%# → %s', (patch, health) => {
    const f = chainFreshness({ ...status, ...patch });
    expect(f.health).toBe(health);
    expect(f.reason).not.toBeNull();
  });

  it('lists the four layers with their cadence', () => {
    expect(DATA_LAYERS.map((l) => l.id)).toEqual(['chain', 'decoded', 'market', 'reference']);
    expect(dataLayer('market').cadence).toBe('Every 6 h, at :17');
  });
});
