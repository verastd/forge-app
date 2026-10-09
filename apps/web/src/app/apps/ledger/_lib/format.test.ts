import { describe, expect, it } from 'vitest';
import { SaleSchema, offsetPage } from '@forge/upland-ledger';

import { fixture } from './fixtures.test-helper';
import {
  NONE,
  formatClock,
  formatClockUtc,
  formatCompact,
  formatDay,
  formatDuration,
  formatInstant,
  formatInt,
  formatMultiple,
  formatPercent,
  formatRate,
  formatRelative,
  formatShortDay,
  formatSignedPercent,
  formatUpx,
  formatUpxPerUsd,
  formatUsd,
  humanize,
  placeLabel,
  shortHash,
  utcDayOffset,
} from './format';

const sales = fixture('GET_sales', offsetPage(SaleSchema));

describe('numbers', () => {
  it('formats integers and compact magnitudes', () => {
    expect(formatInt(91625496)).toBe('91,625,496');
    expect(formatCompact(266336428)).toBe('266.3M');
    expect(formatCompact(503550)).toBe('503.6K');
  });

  it('shows the placeholder only for missing or non-finite values, never for zero', () => {
    expect(formatInt(null)).toBe(NONE);
    expect(formatInt(undefined)).toBe(NONE);
    expect(formatInt(Number.NaN)).toBe(NONE);
    expect(formatInt(0)).toBe('0');
    expect(formatUpx(null)).toBe(NONE);
  });

  it('formats UPX amounts from captured sales', () => {
    const [first] = sales.data;
    expect(formatUpx(first!.price_upx)).toBe('29,999 UPX');
    expect(formatUpx(first!.buyer_paid_upx)).toBe('31,499 UPX');
    expect(formatUpx(12.5)).toBe('13 UPX');
    expect(formatUpx(930858, { compact: true })).toBe('930.9K UPX');
    expect(formatUpx(500, { unit: false })).toBe('500');
  });

  it('formats USD, including sub-cent values', () => {
    expect(formatUsd(7.99)).toBe('$7.99');
    expect(formatUsd(0.00017964548324589196)).toBe('$0.00018');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUpxPerUsd(5566.519)).toBe('5,566.52 UPX / $1');
    expect(formatRate(4722.441503971466)).toBe('4,722.44');
    expect(formatRate(null)).toBe(NONE);
    expect(formatUpxPerUsd(undefined)).toBe(NONE);
  });

  it('treats a zero ratio as unknown (no mint price), and scales digits', () => {
    expect(formatMultiple(0)).toBe(NONE);
    expect(formatMultiple(1.1311068439892846)).toBe('1.13×');
    expect(formatMultiple(25.81)).toBe('25.8×');
    expect(formatMultiple(312500)).toBe('312,500×');
  });

  it('formats signed and plain percents', () => {
    expect(formatSignedPercent(-0.9744192)).toBe('−97.4%');
    expect(formatSignedPercent(0.06976744186046502)).toBe('+7.0%');
    expect(formatSignedPercent(0)).toBe('0.0%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(0.5, 0)).toBe('50%');
    expect(formatPercent(null)).toBe(NONE);
  });
});

describe('time (always UTC)', () => {
  it('formats instants and days', () => {
    expect(formatInstant('2026-10-09T00:12:28.000Z')).toBe('Oct 9, 2026 00:12:28 UTC');
    expect(formatClockUtc('2026-10-09T14:02:11.000Z')).toBe('14:02:11 UTC');
    expect(formatClockUtc(new Date(Date.UTC(2026, 0, 1, 1, 2, 3)))).toBe('01:02:03 UTC');
    expect(formatClockUtc(null)).toBe(NONE);
    expect(formatClock('2026-10-09T14:02:11.000Z')).toBe('14:02:11');
    expect(formatInstant(null)).toBe(NONE);
    expect(formatInstant('not a date')).toBe(NONE);
    expect(formatDay('2026-10-08')).toBe('Oct 8, 2026');
    expect(formatDay('2026-10-08T23:59:59.000Z')).toBe('Oct 8, 2026');
    expect(formatShortDay('2026-10-06')).toBe('Oct 6');
  });

  it('formats durations', () => {
    expect(formatDuration(1)).toBe('1 s');
    expect(formatDuration(240)).toBe('4 min');
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(formatDuration(336 * 3600)).toBe('14 d');
    expect(formatDuration(-1)).toBe(NONE);
  });

  it('formats relative times against a fixed clock', () => {
    const now = Date.parse('2026-10-09T01:00:00Z');
    expect(formatRelative('2026-10-09T00:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-10-09T00:55:00Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-10-08T00:00:00Z', now)).toBe('25 h ago');
    expect(formatRelative('2026-10-05T00:00:00Z', now)).toBe('4 d ago');
    expect(formatRelative('2026-10-09T05:00:00Z', now)).toBe('in 4 h');
  });

  it('computes UTC day offsets', () => {
    expect(utcDayOffset(7, Date.parse('2026-10-09T00:21:04Z'))).toBe('2026-10-02');
  });
});

describe('ids and labels', () => {
  it('shortens transaction ids', () => {
    const trx = sales.data[0]!.trx_id;
    expect(shortHash(trx)).toBe('3ff8415d…dda65d');
    expect(shortHash('abc')).toBe('abc');
  });

  it('humanizes identifiers and joins places', () => {
    expect(humanize('property_sale')).toBe('Property sale');
    expect(humanize('')).toBe('');
    expect(placeLabel('2506 SEARSDALE AVE', 'Cleveland')).toBe('2506 SEARSDALE AVE, Cleveland');
    expect(placeLabel('', '')).toBe(NONE);
  });
});
