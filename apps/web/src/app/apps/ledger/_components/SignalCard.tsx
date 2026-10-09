'use client';

/**
 * One signal: what kind, about what, how strong, how long it holds, and
 * the evidence behind it in words, with the ledger's own rule text beside
 * the numbers it recorded.
 */

import Link from 'next/link';
import type { Signal } from '@forge/upland-ledger';

import { hrefWith, isPropertyId } from '../_lib/filters';
import { formatInstant, formatPercent, formatRelative } from '../_lib/format';
import { explainSignal } from '../_lib/signals';
import { AccountLink, PropertyLink, routes } from './links';
import { Badge, Icon } from './primitives';

function Subject({ signal }: { signal: Signal }) {
  if (signal.entity_type === 'property' && isPropertyId(signal.entity_id)) {
    return <PropertyLink id={signal.entity_id} label={`Property #${signal.entity_id}`} />;
  }
  if (signal.entity_type === 'account') return <AccountLink account={signal.entity_id} />;
  if (signal.entity_type === 'city') return <Link href={hrefWith(routes.market, { city: signal.entity_id })}>{signal.entity_id}</Link>;
  return (
    <span>
      {signal.entity_type} <span className="em-mono">{signal.entity_id}</span>
    </span>
  );
}

export function SignalCard({ signal, now }: { signal: Signal; now: number }) {
  const x = explainSignal(signal);
  const expired = Date.parse(signal.expires_at) < now;
  return (
    <article className="em-card em-signal" aria-label={`${x.info.label}: ${signal.entity_id}`}>
      <div className="em-signal-head">
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <span className="em-eyebrow">{x.info.label}</span>
          <h3 className="em-signal-title">
            <Subject signal={signal} />
            {signal.city && signal.entity_type !== 'city' && <span className="em-muted"> · {signal.city}</span>}
          </h3>
        </div>
        {x.direction && (
          <Badge tone={x.direction === 'up' ? 'success' : 'error'}>
            <Icon name={x.direction === 'up' ? 'trending-up' : 'trending-down'} size={11} /> {x.direction === 'up' ? 'Rising' : 'Falling'}
          </Badge>
        )}
      </div>

      <div className="em-score">
        <div className="em-row" style={{ justifyContent: 'space-between' }}>
          <span className="em-caption">Score (comparable within this type)</span>
          <span className="em-num">{formatPercent(signal.score)}</span>
        </div>
        <div
          className="em-score-track"
          role="meter"
          aria-label="Signal score"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={signal.score}
          aria-valuetext={formatPercent(signal.score)}
        >
          <div className="em-score-fill" style={{ width: `${Math.max(0, Math.min(1, signal.score)) * 100}%` }} />
        </div>
      </div>

      {x.edge && (
        <p>
          <strong>Expected edge:</strong> <span className="em-num">{x.edge}</span>
        </p>
      )}

      <div className="em-evidence">
        <strong>Why this signal</strong>
        <span className="em-muted">{x.info.blurb}</span>
        {x.summary && <p>{x.summary}</p>}
        {x.items.length > 0 && (
          <ul>
            {x.items.map((item) => (
              <li key={item.key}>
                {item.label}: <span className="em-num">{item.value}</span>
              </li>
            ))}
          </ul>
        )}
        {x.rule && (
          <span className="em-caption">
            Rule (v{signal.rule_version}): <q>{x.rule}</q>
          </span>
        )}
      </div>

      <div className="em-row em-caption" style={{ justifyContent: 'space-between' }}>
        <span title={formatInstant(signal.observed_at)}>Observed {formatRelative(signal.observed_at, now)}</span>
        <span title={formatInstant(signal.expires_at)}>
          {expired ? <Badge tone="warning">Expired</Badge> : <>Holds until {formatInstant(signal.expires_at)}</>}
        </span>
      </div>
    </article>
  );
}
