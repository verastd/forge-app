/**
 * Shapes ledger market and status payloads into what the screens draw:
 * the UPX/USD series with its interquartile band, a per-city roll-up, and
 * how fresh each data layer is. Pure; tested against the captured examples.
 */
import type { CityDay, RatePoint, Status, UpxUsd } from '@forge/upland-ledger';

/* --- UPX/USD ------------------------------------------------------------------ */

export interface RateDatum {
  day: string;
  /** UPX per $1 that day. */
  rate: number;
  /** Trailing median the ledger computed (`smooth` days). */
  smooth: number;
  /** [p25, p75] — the middle half of that day's samples. */
  band: [number, number];
  samples: number;
}

/** The points for one method (default: the ledger's `preferred`), oldest first. */
export function rateSeries(payload: UpxUsd, method: string = payload.preferred): RateDatum[] {
  return payload.points
    .filter((p: RatePoint) => p.method === method)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((p) => ({ day: p.day, rate: p.upx_per_usd, smooth: p.upx_per_usd_smooth, band: [p.p25, p.p75], samples: p.samples }));
}

export interface RateSummary {
  day: string;
  upxPerUsd: number;
  usdPerUpx: number;
  /** Change of the smoothed rate against the first point in the series (fraction), null with one point. */
  change: number | null;
  firstDay: string;
  samples: number;
}

export function rateSummary(series: RateDatum[]): RateSummary | null {
  const last = series.at(-1);
  const first = series[0];
  if (last === undefined || first === undefined) return null;
  return {
    day: last.day,
    upxPerUsd: last.rate,
    usdPerUpx: last.rate === 0 ? 0 : 1 / last.rate,
    change: series.length > 1 && first.smooth !== 0 ? last.smooth / first.smooth - 1 : null,
    firstDay: first.day,
    samples: last.samples,
  };
}

/* --- cities ------------------------------------------------------------------- */

export interface CityRollup {
  city: string;
  sales: number;
  volumeUpx: number;
  /** Most recent day's median sale with a value (null when none in the window). */
  medianSaleUpx: number | null;
  medianAskUpx: number | null;
  listingsNew: number;
  buyers: number;
  /** Daily sales, oldest first, for a sparkline. */
  daily: Array<{ day: string; sales: number }>;
  days: number;
}

/** Sum each city's days in the window and rank by UPX volume (then sales, then name). */
export function rollupCities(rows: CityDay[]): CityRollup[] {
  const byCity = new Map<string, CityDay[]>();
  for (const row of rows) {
    const list = byCity.get(row.city);
    if (list) list.push(row);
    else byCity.set(row.city, [row]);
  }
  const out: CityRollup[] = [];
  for (const [city, days] of byCity) {
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const latest = <K extends 'median_sale_upx' | 'median_ask_upx'>(key: K): number | null => {
      for (let i = days.length - 1; i >= 0; i--) {
        const v = days[i]![key];
        if (v !== null) return v;
      }
      return null;
    };
    out.push({
      city,
      sales: days.reduce((s, d) => s + d.sales, 0),
      volumeUpx: days.reduce((s, d) => s + d.volume_upx, 0),
      medianSaleUpx: latest('median_sale_upx'),
      medianAskUpx: latest('median_ask_upx'),
      listingsNew: days.reduce((s, d) => s + d.listings_new, 0),
      buyers: days.reduce((s, d) => s + d.distinct_buyers, 0),
      daily: days.map((d) => ({ day: d.day, sales: d.sales })),
      days: days.length,
    });
  }
  return out.sort((a, b) => b.volumeUpx - a.volumeUpx || b.sales - a.sales || a.city.localeCompare(b.city));
}

/* --- freshness ------------------------------------------------------------------ */

export type ChainHealth = 'live' | 'lagging' | 'stalled' | 'degraded' | 'unknown';

export interface ChainFreshness {
  health: ChainHealth;
  lagSeconds: number | null;
  latest: string | null;
  latestBlock: number | null;
  /** Which part is unhealthy, in words, when `health` isn't live. */
  reason: string | null;
}

/** Live within a minute, lagging within 15 minutes, stalled beyond; any disconnected part is "degraded". */
export function chainFreshness(status: Status): ChainFreshness {
  const lag = status.ingestion.lagSeconds;
  const base = { lagSeconds: lag, latest: status.ingestion.latestTimestamp, latestBlock: status.ingestion.latestBlock };
  if (!status.clickhouse.connected) return { ...base, health: 'degraded', reason: 'The ledger database is not connected.' };
  if (!status.upstream.connected) return { ...base, health: 'degraded', reason: 'The ledger cannot reach the Upland chain right now; new actions are not arriving.' };
  if (lag === null) return { ...base, health: 'unknown', reason: 'The ledger has not reported an ingest lag.' };
  if (lag <= 60) return { ...base, health: 'live', reason: null };
  if (lag <= 900) return { ...base, health: 'lagging', reason: 'Ingest is behind the chain by more than a minute.' };
  return { ...base, health: 'stalled', reason: 'Ingest is more than 15 minutes behind the chain.' };
}

export interface DataLayer {
  id: 'chain' | 'decoded' | 'market' | 'reference';
  label: string;
  cadence: string;
  covers: string;
}

/** The ledger's refresh cadence per layer (README, "Freshness"). */
export const DATA_LAYERS: readonly DataLayer[] = [
  { id: 'chain', label: 'Chain', cadence: 'Streamed live from the chain', covers: 'Actions, transfers, contracts, analytics' },
  { id: 'decoded', label: 'Decoded events', cadence: 'Every 15 min', covers: 'Sales, listings, property history' },
  { id: 'market', label: 'Market layer', cadence: 'Every 6 h, at :17', covers: 'Properties, accounts, offers, rates, cities, signals' },
  { id: 'reference', label: 'Reference data', cadence: 'Daily at 04:43 UTC', covers: 'Neighborhoods, collections, Upland API details' },
];

export function dataLayer(id: DataLayer['id']): DataLayer {
  return DATA_LAYERS.find((l) => l.id === id)!;
}
