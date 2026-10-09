'use client';

/**
 * Opportunities: `/signals` (heavy slot), ranked by score then expected USD
 * edge, each with its evidence explained. Advisory only — the page says so.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import type { Signal, SignalsParams } from '@forge/upland-ledger';
import { SIGNAL_TYPES } from '@forge/upland-ledger';

import { DataState } from '../_components/DataState';
import { FilterBar, SelectField, TextField, ToggleField } from '../_components/FilterBar';
import { LayerNote } from '../_components/Freshness';
import { SignalCard } from '../_components/SignalCard';
import { Skeleton, SkeletonRows, StatusBanner } from '../_components/primitives';
import { countApplied, readEnum, readNumber, readText } from '../_lib/filters';
import { formatInt } from '../_lib/format';
import { useLedgerQuery } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';
import { SIGNAL_TYPE_INFO, signalTypeInfo } from '../_lib/signals';
import { useFilters } from '../_lib/useFilters';

const FILTER_KEYS = ['type', 'city', 'min_score', 'all'] as const;
const LIMIT = 100;
const SCORES = [
  { value: '', label: 'Any score' },
  { value: '0.25', label: '25% or more' },
  { value: '0.5', label: '50% or more' },
  { value: '0.75', label: '75% or more' },
] as const;

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Opportunities />
    </Suspense>
  );
}

function Opportunities() {
  const params = useSearchParams() ?? new URLSearchParams();
  const filters = useFilters(FILTER_KEYS);
  const request = useMemo<SignalsParams>(
    () => ({
      type: readEnum(params, 'type', SIGNAL_TYPES),
      city: readText(params, 'city', 64),
      min_score: readNumber(params, 'min_score', { min: 0, max: 1 }),
      active_only: params.get('all') === '1' ? false : undefined,
      limit: LIMIT,
    }),
    [params],
  );
  const signals = useLedgerQuery<Signal[]>(queryKey('/signals', request), (c, signal) => c.signals.list(request, { signal }), { heavy: true });
  // Expiry is judged against when the list arrived, not a ticking clock.
  const [now] = useState(() => Date.now());
  const d = filters.draft;

  return (
    <>
      <div className="em-page-head">
        <div>
          <h1 className="em-h1">Opportunities</h1>
          <p className="em-lede">Rule-based signals from the market layer, each with the evidence that produced it.</p>
        </div>
        <LayerNote layer="market" updatedAt={signals.updatedAt} />
      </div>

      <StatusBanner kind="info">
        Signals are advisory: a rule noticed a pattern in recent trades. They are not price quotes or advice, and the market layer behind them is up to
        6 hours old.
      </StatusBanner>

      <details className="em-card">
        <summary style={{ cursor: 'pointer', font: 'var(--type-label)' }}>What each signal type means</summary>
        <dl className="em-dl" style={{ marginTop: 12 }}>
          {Object.entries(SIGNAL_TYPE_INFO).map(([type, info]) => (
            <div key={type} style={{ display: 'contents' }}>
              <dt>{info.label}</dt>
              <dd>{info.blurb}</dd>
            </div>
          ))}
        </dl>
      </details>

      <FilterBar
        label="Filter signals"
        dirty={filters.dirty}
        applying={signals.fetching && signals.data !== undefined}
        appliedCount={countApplied({ ...request, limit: undefined, active_only: request.active_only === false ? 'all' : undefined } as Record<string, unknown>, ['type', 'city', 'min_score', 'active_only'])}
        onApply={filters.apply}
        onReset={filters.reset}
      >
        <SelectField
          label="Type"
          value={SIGNAL_TYPES.find((t) => t === d.type) ?? 'any'}
          onChange={(v) => filters.set('type', v === 'any' ? '' : v)}
          options={[{ value: 'any', label: 'All types' }, ...SIGNAL_TYPES.map((t) => ({ value: t, label: signalTypeInfo(t).label }))]}
        />
        <TextField label="City" value={d.city} onChange={(v) => filters.set('city', v)} placeholder="e.g. Fresno" maxLength={64} />
        <SelectField
          label="Score"
          value={SCORES.find((s) => s.value === d.min_score)?.value ?? ''}
          onChange={(v) => filters.set('min_score', v)}
          options={SCORES}
        />
        <ToggleField label="Include expired" checked={d.all === '1'} onChange={(on) => filters.set('all', on ? '1' : '')} />
      </FilterBar>

      <DataState
        query={signals}
        label="signals"
        skeleton={
          <div className="em-signal-grid">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={220} />
            ))}
          </div>
        }
        empty="No signals match these filters right now."
        emptyAction={filters.dirty || params.toString() !== '' ? { label: 'Reset filters', onClick: filters.reset } : undefined}
      >
        {(list) => (
          <div style={{ display: 'grid', gap: 10 }}>
            {list.length === LIMIT ? (
              <StatusBanner kind="info" icon="list-filter">
                Showing the first {LIMIT}, strongest first. Narrow the filters to see others.
              </StatusBanner>
            ) : (
              <p className="em-caption">
                {formatInt(list.length)} signal{list.length === 1 ? '' : 's'}, strongest first.
              </p>
            )}
            <div className="em-signal-grid">
              {list.map((s, i) => (
                <SignalCard key={`${s.signal_type}:${s.entity_type}:${s.entity_id}:${s.observed_at}:${i}`} signal={s} now={now} />
              ))}
            </div>
          </div>
        )}
      </DataState>
    </>
  );
}
