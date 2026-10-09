'use client';

/**
 * How fresh a screen's data is. `LayerNote` sits under any section built on
 * a derived layer (market every 6 h, decoded events every 15 min) so nobody
 * reads a 6-hour-old count as live. `ChainStatus` reads `/status`.
 */

import type { Status } from '@forge/upland-ledger';

import { formatDuration, formatInstant, formatInt, formatRelative } from '../_lib/format';
import { chainFreshness, dataLayer } from '../_lib/market';
import type { ChainHealth, DataLayer } from '../_lib/market';
import { Icon, LiveDot } from './primitives';
import type { LiveStatus } from './primitives';

const HEALTH_TO_LIVE: Record<ChainHealth, LiveStatus> = {
  live: 'live',
  lagging: 'lagging',
  stalled: 'stalled',
  degraded: 'offline',
  unknown: 'unknown',
};

export function LayerNote({ layer, updatedAt }: { layer: DataLayer['id']; updatedAt?: number }) {
  const l = dataLayer(layer);
  return (
    <span className="em-caption" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <Icon name="clock" size={12} />
      {l.label}: refreshed {l.cadence.toLowerCase()}
      {updatedAt !== undefined && <> · fetched {formatRelative(new Date(updatedAt).toISOString())}</>}
    </span>
  );
}

export function ChainStatus({ status }: { status: Status }) {
  const f = chainFreshness(status);
  const h = status.history;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="em-row" style={{ justifyContent: 'space-between' }}>
        <LiveDot status={HEALTH_TO_LIVE[f.health]} />
        <span className="em-caption em-num">Checked {formatInstant(status.upstream.checkedAt)}</span>
      </div>
      {f.reason && (
        <p className="em-caption" role="status">
          {f.reason}
        </p>
      )}
      <dl className="em-dl">
        <dt>Ingest lag</dt>
        <dd className="em-num">{formatDuration(f.lagSeconds)}</dd>
        <dt>Latest action</dt>
        <dd className="em-num">{formatInstant(f.latest)}</dd>
        <dt>Latest block</dt>
        <dd className="em-num">{formatInt(f.latestBlock)}</dd>
        <dt>History</dt>
        <dd>
          {h.backfillComplete ? 'Complete' : 'Backfilling'} from {formatInstant(h.earliestStoredTimestamp)}
          {h.pendingWindows + h.failedWindows > 0 && (
            <span className="em-muted">
              {' '}
              · {formatInt(h.pendingWindows)} windows pending, {formatInt(h.failedWindows)} failed
            </span>
          )}
        </dd>
        <dt>Upstream</dt>
        <dd>{status.upstream.connected ? 'Connected' : 'Disconnected'}</dd>
        <dt>Database</dt>
        <dd>{status.clickhouse.connected ? 'Connected' : 'Disconnected'}</dd>
      </dl>
    </div>
  );
}
