import { describe, expect, it } from 'vitest';
import { SIGNAL_TYPES, SignalListSchema } from '@forge/upland-ledger';
import type { Signal } from '@forge/upland-ledger';

import { fixture } from './fixtures.test-helper';
import { evidenceItems, explainSignal, signalTypeInfo } from './signals';

const signals = fixture('GET_signals', SignalListSchema);

describe('explainSignal (GET_signals)', () => {
  it('turns a captured regime shift into a sentence from its own evidence', () => {
    const x = explainSignal(signals[0]!);
    expect(x.info.label).toBe('Market shift');
    expect(x.direction).toBe('down');
    expect(x.rule).toBe('trailing 7d vs preceding 28d, city median sale/mint and sale count');
    expect(x.summary).toBe(
      'In Fresno, the median sale-to-mint ratio moved −97.4% (7,994× vs 312,500×), on 13 sales in the last 7 days against 93 in the 28 days before, a daily pace −44.1%.',
    );
    expect(x.edge).toBeNull();
  });

  it('lists every evidence field except the rule, labelled and formatted', () => {
    const items = explainSignal(signals[0]!).items;
    expect(items.map((i) => i.key)).toEqual([
      'recent_sale_to_mint',
      'prior_sale_to_mint',
      'price_change',
      'recent_sales',
      'prior_sales',
      'volume_change',
      'direction',
    ]);
    expect(items.find((i) => i.key === 'volume_change')).toEqual({ key: 'volume_change', label: 'Change in daily sales pace', value: '−44.1%' });
  });

  it('explains every captured signal without throwing', () => {
    for (const s of signals) {
      const x = explainSignal(s);
      expect(x.summary).toMatch(/^In /);
      expect(x.items.length).toBeGreaterThan(0);
    }
  });

  it('shows unknown evidence keys as recorded, numbers formatted, and never invents a sentence', () => {
    const s: Signal = {
      ...signals[0]!,
      signal_type: 'under_comps',
      expected_edge_upx: 1200,
      expected_edge_usd: 0.22,
      horizon_hours: 72,
      evidence: { rule: 'ask below comps', comp_median_upx: '45000', ask_upx: '30000.5', note: 'fresh listing' },
    };
    const x = explainSignal(s);
    expect(x.summary).toBeNull();
    expect(x.direction).toBeNull();
    expect(x.edge).toBe('≈ 1,200 UPX ($0.22) over 3 days');
    expect(x.items).toEqual([
      { key: 'comp_median_upx', label: 'Comp median upx', value: '45,000' },
      { key: 'ask_upx', label: 'Ask upx', value: '30,000.5' },
      { key: 'note', label: 'Note', value: 'fresh listing' },
    ]);
  });

  it('says hours when the horizon is not whole days, and reads a rising direction', () => {
    const x = explainSignal({ ...signals[0]!, expected_edge_upx: 10, expected_edge_usd: 0, horizon_hours: 30, evidence: { direction: 'rising' } });
    expect(x.edge).toBe('≈ 10 UPX ($0.00) over 30 h');
    expect(x.direction).toBe('up');
    expect(x.rule).toBeNull();
  });

  it('falls back to a regime-shift sentence of null when its numbers are missing', () => {
    expect(explainSignal({ ...signals[0]!, evidence: { rule: 'x' } }).summary).toBeNull();
  });
});

describe('signalTypeInfo', () => {
  it('has a label and blurb for every type the ledger can send', () => {
    for (const t of SIGNAL_TYPES) {
      const info = signalTypeInfo(t);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.blurb.length).toBeGreaterThan(0);
    }
  });

  it('humanizes an unknown type rather than hiding it', () => {
    expect(signalTypeInfo('new_rule_type').label).toBe('New rule type');
  });

  it('evidenceItems handles an empty record', () => {
    expect(evidenceItems({})).toEqual([]);
  });
});
