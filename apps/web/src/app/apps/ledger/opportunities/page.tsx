'use client';

/**
 * Opportunities: `/signals` (heavy slot), ranked by score then expected USD
 * edge, each card explaining its evidence. Advisory only — the page says so.
 * `/signals` has no offset, so the list is capped at 100 and says when it is.
 */
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Badge, Block, Card, Chips, FactList, FilterBar, FilterField, PageHeader, Skeleton, StatusBanner, Toggle } from '@forge/ui';
import type { Signal, SignalsParams } from '@forge/upland-ledger';
import { SIGNAL_TYPES } from '@forge/upland-ledger';
import { Suspense, useMemo, useState } from 'react';

import { countApplied, hrefWith, readEnum, readNumber, readText } from '../_lib/filters';
import { formatInstant, formatInt, formatPercent, formatRelative } from '../_lib/format';
import { useLedgerQuery } from '../_lib/hooks';
import { queryKey } from '../_lib/query-core';
import { SIGNAL_TYPE_INFO, explainSignal, signalTypeInfo } from '../_lib/signals';
import { useFilters } from '../_lib/useFilters';
import { Region } from '../_ui/Region';
import { SearchFilterField } from '../_ui/fields';
import { filterBarState } from '../_ui/filterbar';
import { PropertyLink, routes } from '../_ui/links';

const FILTER_KEYS = ['type', 'city', 'min_score', 'all'] as const;
const LIMIT = 100;
const SCORES = [
  { value: 'any', label: 'Any score' },
  { value: '0.25', label: '25%+' },
  { value: '0.5', label: '50%+' },
  { value: '0.75', label: '75%+' },
] as const;
type ScoreChoice = (typeof SCORES)[number]['value'];

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<Skeleton height={240} />}>
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
  const applied = countApplied({ ...request, limit: undefined, active_only: request.active_only === false ? 'all' : undefined } as Record<string, unknown>, [
    'type',
    'city',
    'min_score',
    'active_only',
  ]);

  return (
    <>
      <PageHeader title="Opportunities" lede="Rule-based signals from the market layer, each with the evidence that produced it." />

      <StatusBanner kind="info">
        Signals are advisory: a rule noticed a pattern in recent trades. They are not price quotes or advice, and the market layer behind them is up to 6 hours old.
      </StatusBanner>

      <Block id="signal-types" title="Signal types">
        <Card>
          <FactList items={Object.values(SIGNAL_TYPE_INFO).map((info) => ({ term: info.label, value: info.blurb }))} />
        </Card>
      </Block>

      <FilterBar state={filterBarState(filters.dirty, signals.fetching && signals.data !== undefined, applied)} appliedCount={applied} onApply={async () => filters.apply()} onReset={filters.reset}>
        <FilterField label="Type">
          <Chips<string>
            size="dense"
            label="Signal type"
            value={SIGNAL_TYPES.find((t) => t === d.type) ?? 'any'}
            onChange={(v) => filters.set('type', v === 'any' ? '' : v)}
            options={[{ value: 'any', label: 'All' }, ...SIGNAL_TYPES.map((t) => ({ value: t, label: signalTypeInfo(t).label }))]}
          />
        </FilterField>
        <FilterField label="City">
          <SearchFilterField kind="city" label="City" value={d.city} onChange={(v) => filters.set('city', v)} width={180} />
        </FilterField>
        <FilterField label="Score">
          <Chips<ScoreChoice>
            size="dense"
            label="Minimum score"
            value={SCORES.find((s) => s.value === d.min_score)?.value ?? 'any'}
            onChange={(v) => filters.set('min_score', v === 'any' ? '' : v)}
            options={SCORES}
          />
        </FilterField>
        <Toggle label="Include expired" checked={d.all === '1'} onChange={(on) => filters.set('all', on ? '1' : '')} style={{ alignSelf: 'center', marginTop: 12 }} />
      </FilterBar>

      <Block id="signals" title="Signals" note="Strongest first · market layer, rebuilt every 6 h at :17">
        <Region
          query={signals}
          skeleton={
            <div style={GRID}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={220} />
              ))}
            </div>
          }
          emptyMessage="No signals match these filters right now."
          emptyAction={applied > 0 ? { label: 'Reset filters', onClick: filters.reset } : undefined}
          cappedCount={signals.data?.length === LIMIT ? LIMIT : null}
        >
          {(list) => (
            <div style={{ display: 'grid', gap: 10 }}>
              {list.length < LIMIT && (
                <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
                  {formatInt(list.length)} signal{list.length === 1 ? '' : 's'}, strongest first.
                </span>
              )}
              <div style={GRID}>
                {list.map((s, i) => (
                  <SignalCard key={`${s.signal_type}:${s.entity_type}:${s.entity_id}:${s.observed_at}:${i}`} signal={s} now={now} />
                ))}
              </div>
            </div>
          )}
        </Region>
      </Block>
    </>
  );
}

const GRID = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' } as const;

function Subject({ signal }: { signal: Signal }) {
  if (signal.entity_type === 'property') return <PropertyLink id={signal.entity_id} label={`Property #${signal.entity_id}`} />;
  if (signal.entity_type === 'city') return <Link href={hrefWith(routes.market, { city: signal.entity_id })}>{signal.entity_id}</Link>;
  return (
    <span>
      {signal.entity_type} <span className="em-mono">{signal.entity_id}</span>
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(1, score));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        role="meter"
        aria-label="Score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        aria-valuetext={formatPercent(pct)}
        style={{ flex: 1, height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--surface-sunken)', overflow: 'hidden' }}
      >
        <div style={{ width: `${pct * 100}%`, height: '100%', background: 'var(--accent)' }} />
      </div>
      <span className="em-mono" style={{ font: 'var(--type-label)' }}>
        {formatPercent(pct)}
      </span>
    </div>
  );
}

function SignalCard({ signal, now }: { signal: Signal; now: number }) {
  const x = explainSignal(signal);
  const expired = Date.parse(signal.expires_at) < now;
  return (
    <Card style={{ gap: 10, alignContent: 'start', opacity: expired ? 0.75 : 1 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone="new">{x.info.label}</Badge>
        {x.direction && (
          <Badge tone={x.direction === 'up' ? 'success' : 'warning'} icon={x.direction === 'up' ? 'arrow-up' : 'arrow-down'}>
            {x.direction === 'up' ? 'Rising' : 'Falling'}
          </Badge>
        )}
        {expired ? <Badge tone="lock">Expired</Badge> : <Badge tone="neutral">Expires {formatRelative(signal.expires_at, now)}</Badge>}
      </div>
      <strong style={{ font: 'var(--type-title)' }}>
        <Subject signal={signal} />
        {signal.city && signal.entity_type !== 'city' ? <span style={{ color: 'var(--text-muted)', font: 'var(--type-body-sm)' }}> · {signal.city}</span> : null}
      </strong>
      <ScoreBar score={signal.score} />
      <p style={{ margin: 0, font: 'var(--type-body-sm)' }}>{x.summary ?? x.info.blurb}</p>
      {x.edge && (
        <p style={{ margin: 0, font: 'var(--type-body-sm)' }}>
          Expected edge <strong>{x.edge}</strong>
        </p>
      )}
      {x.items.length > 0 && <FactList items={x.items.map((it) => ({ term: it.label, value: it.value, mono: true }))} />}
      {x.rule && (
        <p style={{ margin: 0, font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
          Rule v{signal.rule_version}: {x.rule}
        </p>
      )}
      <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>Observed {formatInstant(signal.observed_at)}</span>
    </Card>
  );
}
