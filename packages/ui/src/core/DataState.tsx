/**
 * DataState (handoff core/DataState.jsx, PRD 5.3). state: loading | refreshing
 * | loading-more | empty | empty-initial | error | partial | stale | capped |
 * ready. Wraps any fetched region. `skeleton` renders the layout-matching
 * placeholder (defaults to 10 text rows). Actions may return Promises: the
 * error Retry and the banner actions then show their pending state.
 */
import type { CSSProperties, ReactNode } from 'react';

import { AsyncButton } from './AsyncButton';
import { Button } from './Button';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
import { StatusBanner } from './StatusBanner';

export type DataStateState =
  | 'loading'
  | 'refreshing'
  | 'loading-more'
  | 'empty'
  | 'empty-initial'
  | 'error'
  | 'partial'
  | 'stale'
  | 'capped'
  | 'ready';

export interface DataStateError {
  message?: string;
  code?: string;
}

export interface DataStateProps {
  state?: DataStateState;
  skeleton?: ReactNode;
  emptyMessage?: string;
  emptyAction?: string;
  onEmptyAction?: () => void;
  error?: DataStateError;
  requestId?: string;
  /** May return a Promise: the Retry button shows pending / error until it settles. */
  onRetry?: () => unknown;
  onReport?: () => void;
  partialMessage?: ReactNode;
  onRetryPartial?: () => unknown;
  staleMinutes?: number;
  onRefresh?: () => unknown;
  cappedCount?: number;
  onUpgrade?: () => unknown;
  children?: ReactNode;
  style?: CSSProperties;
}

export function DataState({
  state = 'ready',
  skeleton,
  children,
  emptyMessage = 'Nothing to show.',
  emptyAction,
  onEmptyAction,
  error,
  requestId,
  onRetry,
  onReport,
  partialMessage,
  onRetryPartial,
  staleMinutes,
  onRefresh,
  cappedCount,
  onUpgrade,
  style,
}: DataStateProps) {
  if (state === 'loading')
    return (
      <div aria-busy="true" style={style}>
        {/* Skeletons are aria-hidden; this is what assistive tech hears. */}
        <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
          Loading…
        </span>
        {skeleton || (
          <div style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} height={14} width={`${70 + ((i * 13) % 30)}%`} />
            ))}
          </div>
        )}
      </div>
    );
  if (state === 'empty' || state === 'empty-initial')
    return (
      <div
        style={{
          padding: '40px 16px',
          textAlign: 'center',
          display: 'grid',
          gap: 10,
          justifyItems: 'center',
          color: 'var(--text-secondary)',
          font: 'var(--type-body)',
          ...style,
        }}
      >
        <span>{state === 'empty-initial' ? 'Set filters and press Search' : emptyMessage}</span>
        {emptyAction && (
          <Button variant="secondary" size="dense" onClick={onEmptyAction}>
            {emptyAction}
          </Button>
        )}
      </div>
    );
  if (state === 'error')
    return (
      <div role="alert" style={{ padding: '32px 16px', textAlign: 'center', display: 'grid', gap: 8, justifyItems: 'center', ...style }}>
        <span style={{ font: 'var(--type-title)', color: 'var(--text-primary)' }}>{error?.message || 'Request failed'}</span>
        {error?.code && <span style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>{error.code}</span>}
        {requestId && (
          <span className="em-mono" style={{ font: 'var(--type-code)', color: 'var(--text-muted)' }}>
            request {requestId}
          </span>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <AsyncButton
            label="Retry"
            pendingLabel="Retrying…"
            onAction={
              onRetry
                ? async () => {
                    await onRetry();
                  }
                : undefined
            }
          />
          {/* Bug fix: the handoff drew Report even with no handler, a button that does nothing. */}
          {onReport && (
            <Button variant="link" onClick={onReport}>
              Report
            </Button>
          )}
        </div>
      </div>
    );
  const banner =
    state === 'partial' ? (
      <StatusBanner kind="partial" actionLabel="Retry" onAction={onRetryPartial}>
        {partialMessage}
      </StatusBanner>
    ) : state === 'stale' ? (
      <StatusBanner kind="stale" actionLabel="Refresh" onAction={onRefresh}>
        Data is {staleMinutes} min old
      </StatusBanner>
    ) : state === 'capped' ? (
      <StatusBanner kind="capped" actionLabel={onUpgrade ? 'Upgrade' : undefined} onAction={onUpgrade}>
        Showing first {cappedCount?.toLocaleString() ?? cappedCount}. Upgrade or narrow filters.
      </StatusBanner>
    ) : null;
  return (
    <div style={{ position: 'relative', display: 'grid', gap: 10, ...style }} aria-busy={state === 'refreshing' ? 'true' : undefined}>
      {state === 'refreshing' && (
        <>
          <div
            aria-hidden="true"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, overflow: 'hidden', background: 'var(--track)', borderRadius: 2, zIndex: 2 }}
          >
            <div
              className="em-motion"
              style={{ position: 'absolute', top: 0, width: '40%', height: '100%', background: 'var(--accent)', animation: 'em-progress-indeterminate 1.2s var(--ease-in-out) infinite' }}
            />
          </div>
          <span
            role="status"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'inline-flex',
              gap: 6,
              alignItems: 'center',
              font: 'var(--type-caption)',
              color: 'var(--text-secondary)',
              zIndex: 2,
            }}
          >
            <Spinner size={12} label="" /> Updating
          </span>
        </>
      )}
      {banner}
      <div style={{ opacity: state === 'refreshing' ? 0.6 : 1, transition: 'opacity var(--dur-base)' }}>{children}</div>
      {state === 'loading-more' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={14} />
          ))}
        </div>
      )}
    </div>
  );
}
