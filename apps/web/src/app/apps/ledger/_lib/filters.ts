/**
 * Filters live in the URL (shareable, back-button friendly). These read and
 * write them defensively: anything malformed is dropped rather than sent,
 * because entity routes silently ignore unknown params and analytics routes
 * 400 on them (README, Gotchas 3).
 */
import { isAntelopeAccount } from '@forge/upland-ledger';

export type ParamSource = Pick<URLSearchParams, 'get'>;

export function readText(params: ParamSource, key: string, max = 120): string | undefined {
  const raw = params.get(key)?.trim();
  return raw === undefined || raw === '' ? undefined : raw.slice(0, max);
}

export function readNumber(params: ParamSource, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const n = parseNumberDraft(raw);
  if (n === null || !Number.isFinite(n)) return undefined;
  if (opts.min !== undefined && n < opts.min) return undefined;
  if (opts.max !== undefined && n > opts.max) return undefined;
  return n;
}

export function readEnum<T extends string>(params: ParamSource, key: string, allowed: readonly T[]): T | undefined {
  const raw = params.get(key);
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

export function readFlag(params: ParamSource, key: string): boolean {
  return params.get(key) === '1';
}

/** An Antelope account name, or undefined (the ledger 400s on anything else). */
export function readAccount(params: ParamSource, key: string): string | undefined {
  const raw = readText(params, key, 13)?.toLowerCase();
  return raw !== undefined && isAntelopeAccount(raw) ? raw : undefined;
}

/** A property id: 1–20 digits, kept as a string. */
export function isPropertyId(value: string): boolean {
  return /^\d{1,20}$/.test(value);
}

/** `path?k=v…`, dropping empty values and `false`, writing `true` as `1`. */
export function hrefWith(path: string, values: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

/** How many of `keys` carry a value in `values` (FilterBar's "N filters applied"). */
export function countApplied(values: Record<string, unknown>, keys: readonly string[]): number {
  return keys.filter((k) => {
    const v = values[k];
    return v !== undefined && v !== null && v !== '' && v !== false;
  }).length;
}

/**
 * Validation for a numeric filter draft (Embers NumberField rules): '' is
 * "no bound", thousands separators are fine, anything else must be a number
 * inside [min, max] (min defaults to 0: no ledger filter takes a negative).
 */
export function numberDraftError(draft: string, range: { min?: number; max?: number } = {}): string | null {
  const n = parseNumberDraft(draft);
  if (n === null) return null;
  if (Number.isNaN(n)) return 'Enter a number';
  const min = range.min ?? 0;
  const { max } = range;
  if (n < min || (max !== undefined && n > max)) {
    return max === undefined ? (min === 0 ? 'Must be 0 or more' : `Must be ≥ ${min}`) : `Must be ≥ ${min} and ≤ ${max}`;
  }
  return null;
}

/** '' → null (no bound), '12,500' → 12500, garbage → NaN. */
export function parseNumberDraft(draft: string): number | null {
  const t = draft.trim().replace(/,/g, '');
  if (t === '') return null;
  if (!/^-?\d*\.?\d+$/.test(t)) return Number.NaN;
  return Number(t);
}

/** Validation for an account filter draft. */
export function accountDraftError(draft: string): string | null {
  const v = draft.trim().toLowerCase();
  if (v === '') return null;
  return isAntelopeAccount(v) ? null : 'Not an Upland chain account (a–z, 1–5 and dots, up to 13)';
}
