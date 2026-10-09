/**
 * Number, money, time and id formatting for the ledger UI. Pure functions,
 * locale fixed to en-US so screens, tests and screenshots agree. Times on
 * the wire are UTC and are shown in UTC (the ledger's day boundaries are
 * UTC, so a local-time view would put sales on the wrong day).
 */

const LOCALE = 'en-US';
const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

/** Placeholder for a value the ledger says it doesn't have (null), never for a missing number. */
export const NONE = '—';

export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? NONE : intFmt.format(n);
}

/** 1.2M, 34.5K — for KPI tiles where magnitude matters more than the last digit. */
export function formatCompact(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? NONE : compactFmt.format(n);
}

/** UPX amounts: whole UPX, or two decimals when under 100 and fractional. */
export function formatUpx(n: number | null | undefined, opts: { compact?: boolean; unit?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE;
  const unit = opts.unit === false ? '' : ' UPX';
  if (opts.compact && Math.abs(n) >= 10_000) return `${compactFmt.format(n)}${unit}`;
  const fractional = Math.abs(n) < 100 && !Number.isInteger(n);
  const body = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: fractional ? 2 : 0,
  }).format(n);
  return `${body}${unit}`;
}

/** USD with cents; tiny values (a single UPX in USD) keep 2 significant digits. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE;
  if (n !== 0 && Math.abs(n) < 0.01) {
    return `$${new Intl.NumberFormat(LOCALE, { maximumSignificantDigits: 2 }).format(n)}`;
  }
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' }).format(n);
}

/** A rate like 5,566 UPX per $1. */
export function formatUpxPerUsd(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? NONE : `${intFmt.format(n)} UPX / $1`;
}

/** A ratio such as price ÷ mint: 1.13×. Zero means "no mint price", so it reads as unknown. */
export function formatMultiple(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return NONE;
  const digits = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n)}×`;
}

/** A fraction as a signed percent: -0.974 → "−97.4%". */
export function formatSignedPercent(fraction: number | null | undefined, digits = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NONE;
  const pct = fraction * 100;
  const body = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Math.abs(pct));
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${body}%`;
}

/** A fraction 0..1 as a plain percent. */
export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NONE;
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(fraction * 100)}%`;
}

/* --- time -------------------------------------------------------------------- */

const pad = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 9, 2026 00:12 UTC" */
export function formatInstant(iso: string | null | undefined): string {
  const d = parse(iso);
  if (d === null) return NONE;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Oct 9, 2026" from an instant or a YYYY-MM-DD day (read as UTC). */
export function formatDay(isoOrDay: string | null | undefined): string {
  const d = parse(isoOrDay && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? `${isoOrDay}T00:00:00Z` : isoOrDay);
  if (d === null) return NONE;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Oct 9" — chart axis ticks. */
export function formatShortDay(day: string): string {
  const d = parse(`${day}T00:00:00Z`);
  return d === null ? day : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A duration in seconds as "1 s", "4 min", "3 h 12 min", "2 d 4 h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return NONE;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const days = Math.floor(h / 24);
  return h % 24 === 0 ? `${days} d` : `${days} d ${h % 24} h`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; "in 4 h" for the future. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const d = parse(iso);
  if (d === null) return NONE;
  const diff = Math.round((now - d.getTime()) / 1000);
  if (Math.abs(diff) < 45) return 'just now';
  const span = formatDuration(Math.abs(diff)).replace(/ \d+ (min|h)$/, '');
  return diff > 0 ? `${span} ago` : `in ${span}`;
}

/** YYYY-MM-DD of `now` minus `days`, in UTC. */
export function utcDayOffset(days: number, now: number = Date.now()): string {
  const d = new Date(now - days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* --- ids --------------------------------------------------------------------- */

/** 3ff8415d…74dda65d — a transaction id short enough for a table cell. */
export function shortHash(hash: string, head = 8, tail = 6): string {
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** Title-case a snake/kebab identifier: "property_sale" → "Property sale". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
}

/** Address, city: "2506 SEARSDALE AVE, Cleveland". Empty parts are skipped. */
export function placeLabel(address: string, city?: string): string {
  return [address.trim(), city?.trim()].filter((part) => part !== undefined && part !== '').join(', ') || NONE;
}
