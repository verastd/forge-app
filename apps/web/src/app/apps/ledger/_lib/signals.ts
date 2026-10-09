/**
 * Turns a signal's `evidence` (string key/values, whatever the rule recorded)
 * into words. The ledger's own rule text (`evidence.rule`) is always shown
 * verbatim; the sentences here only restate the numbers next to it.
 *
 * Only `regime_shift` has a captured example (examples/GET_signals.json), so
 * it is the only type with a tailored sentence. Every other type lists its
 * evidence fields as recorded, labelled, with numbers formatted — never
 * guessed at — until the ledger documents their keys (see the PR notes).
 */
import type { Signal } from '@forge/upland-ledger';

import { formatInt, formatMultiple, formatSignedPercent, formatUpx, formatUsd, humanize } from './format';

export interface SignalTypeInfo {
  label: string;
  /** One line on what kind of opportunity this is. */
  blurb: string;
}

export const SIGNAL_TYPE_INFO: Record<string, SignalTypeInfo> = {
  cross_book_arb: {
    label: 'Cross-book gap',
    blurb: 'The UPX book and the USD book price comparable property differently once converted at the day’s rate.',
  },
  under_comps: {
    label: 'Below comparable sales',
    blurb: 'An ask sits under what comparable properties recently sold for.',
  },
  regime_shift: {
    label: 'Market shift',
    blurb: 'A city’s recent prices or trading pace moved sharply against the weeks before.',
  },
  yield_value: {
    label: 'Yield value',
    blurb: 'Income from yield looks high for the asking price.',
  },
  sub_mint_arb: {
    label: 'Below mint',
    blurb: 'Listed for less than the property’s mint price.',
  },
};

export function signalTypeInfo(type: string): SignalTypeInfo {
  return SIGNAL_TYPE_INFO[type] ?? { label: humanize(type), blurb: 'A rule-based observation from the ledger’s market layer.' };
}

export interface EvidenceItem {
  key: string;
  label: string;
  value: string;
}

export interface SignalExplanation {
  info: SignalTypeInfo;
  /** A sentence built from the evidence, when the type's keys are known. */
  summary: string | null;
  /** The rule as the ledger recorded it. */
  rule: string | null;
  /** 'up' / 'down' when the evidence says which way things moved. */
  direction: 'up' | 'down' | null;
  /** Every evidence field (except the rule), labelled and formatted. */
  items: EvidenceItem[];
  /** "≈ 1,200 UPX ($0.22) over 14 days", or null when the rule records no edge. */
  edge: string | null;
}

const num = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Labels and formatting for evidence keys seen in captured data or named in the spec. */
const KNOWN_KEYS: Record<string, { label: string; format: (raw: string) => string }> = {
  recent_sale_to_mint: { label: 'Median sale ÷ mint, last 7 days', format: (r) => formatMultiple(num(r)) },
  prior_sale_to_mint: { label: 'Median sale ÷ mint, 28 days before', format: (r) => formatMultiple(num(r)) },
  price_change: { label: 'Change in sale ÷ mint', format: (r) => formatSignedPercent(num(r)) },
  recent_sales: { label: 'Sales, last 7 days', format: (r) => formatInt(num(r)) },
  prior_sales: { label: 'Sales, 28 days before', format: (r) => formatInt(num(r)) },
  volume_change: { label: 'Change in daily sales pace', format: (r) => formatSignedPercent(num(r)) },
  direction: { label: 'Direction', format: (r) => humanize(r) },
};

export function evidenceItems(evidence: Record<string, string>): EvidenceItem[] {
  return Object.entries(evidence)
    .filter(([key]) => key !== 'rule')
    .map(([key, raw]) => {
      const known = KNOWN_KEYS[key];
      if (known) return { key, label: known.label, value: known.format(raw) };
      const n = num(raw);
      const value = n === null ? raw : Number.isInteger(n) ? formatInt(n) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(n);
      return { key, label: humanize(key), value };
    });
}

function regimeShiftSummary(signal: Signal): string | null {
  const e = signal.evidence;
  const recent = num(e.recent_sales);
  const prior = num(e.prior_sales);
  const priceChange = num(e.price_change);
  const pace = num(e.volume_change);
  if (recent === null || prior === null || priceChange === null) return null;
  const place = signal.city || signal.entity_id;
  const ratio = `the median sale-to-mint ratio moved ${formatSignedPercent(priceChange)} (${formatMultiple(num(e.recent_sale_to_mint))} vs ${formatMultiple(num(e.prior_sale_to_mint))})`;
  const volume = `${formatInt(recent)} sales in the last 7 days against ${formatInt(prior)} in the 28 days before${pace === null ? '' : `, a daily pace ${formatSignedPercent(pace)}`}`;
  return `In ${place}, ${ratio}, on ${volume}.`;
}

function directionOf(signal: Signal): 'up' | 'down' | null {
  const d = signal.evidence.direction?.toLowerCase();
  if (d === 'falling' || d === 'down') return 'down';
  if (d === 'rising' || d === 'up') return 'up';
  return null;
}

function edgeOf(signal: Signal): string | null {
  if (signal.expected_edge_upx === 0 && signal.expected_edge_usd === 0) return null;
  const days = signal.horizon_hours / 24;
  const horizon = Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${signal.horizon_hours} h`;
  return `≈ ${formatUpx(signal.expected_edge_upx)} (${formatUsd(signal.expected_edge_usd)}) over ${horizon}`;
}

export function explainSignal(signal: Signal): SignalExplanation {
  return {
    info: signalTypeInfo(signal.signal_type),
    summary: signal.signal_type === 'regime_shift' ? regimeShiftSummary(signal) : null,
    rule: signal.evidence.rule ?? null,
    direction: directionOf(signal),
    items: evidenceItems(signal.evidence),
    edge: edgeOf(signal),
  };
}
