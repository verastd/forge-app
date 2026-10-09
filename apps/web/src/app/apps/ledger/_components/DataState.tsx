'use client';

/**
 * Embers DataState: wraps every fetched region and renders exactly one of
 * skeleton, the sign-in prompt, not-found, error (what happened, what to
 * do, the code, a visible Retry), empty, or the data — dimmed under an
 * "Updating" bar while a refresh or the next page loads.
 */

import type { ReactNode } from 'react';

import type { QueryResult } from '../_lib/hooks';
import { describeError } from '../_lib/query-core';
import { LedgerSignIn } from './LedgerSignIn';
import { AsyncButton, Button, SkeletonRows, Spinner } from './primitives';

export interface DataStateProps<T> {
  query: QueryResult<T>;
  children: (data: T) => ReactNode;
  /** Layout-matching placeholder; defaults to text rows. */
  skeleton?: ReactNode;
  /** What "nothing here" means for this region. */
  empty?: ReactNode;
  notFound?: ReactNode;
  /** A way out of an empty result (the kit's "Reset filters"). */
  emptyAction?: { label: string; onClick: () => void };
  /** What's loading, for screen readers ("Loading recent sales"). */
  label: string;
}

export function DataState<T>({ query, children, skeleton, empty = 'Nothing to show.', notFound, emptyAction, label }: DataStateProps<T>) {
  switch (query.view) {
    case 'idle':
      return null;
    case 'loading':
      return (
        <div aria-busy="true" aria-label={`Loading ${label}`}>
          {skeleton ?? <SkeletonRows />}
          <span className="em-sr" role="status">
            Loading {label}…
          </span>
        </div>
      );
    case 'unauthenticated':
      return <LedgerSignIn onRetry={query.refetch} />;
    case 'not-found':
      return (
        <div className="em-card em-state" role="status">
          <span className="em-state-title">{notFound ?? 'Not in the ledger'}</span>
        </div>
      );
    case 'error':
      return <ErrorPanel query={query} />;
    case 'empty':
      return (
        <div className="em-card em-state" role="status">
          <span>{empty}</span>
          {emptyAction && (
            <Button variant="secondary" size="dense" onClick={emptyAction.onClick}>
              {emptyAction.label}
            </Button>
          )}
        </div>
      );
    case 'ready':
    case 'refreshing':
      return (
        <div className="em-refreshing" aria-busy={query.view === 'refreshing' ? 'true' : undefined}>
          {query.view === 'refreshing' && (
            <>
              <div aria-hidden="true" className="em-refreshing-bar">
                <span className="em-motion" />
              </div>
              <span role="status" className="em-refreshing-note">
                <Spinner size={12} label="" /> Updating
              </span>
            </>
          )}
          <div className="em-refreshing-body">{query.data !== undefined && children(query.data)}</div>
        </div>
      );
  }
}

export function ErrorPanel<T>({ query }: { query: QueryResult<T> }) {
  if (query.error === undefined) return null;
  const copy = describeError(query.error);
  return (
    <div role="alert" className="em-card em-state em-state--error">
      <span className="em-state-title">{copy.title}</span>
      <span>{copy.detail}</span>
      <span className="em-state-code">{copy.code}</span>
      {copy.retryable && <AsyncButton label="Retry" pendingLabel="Retrying…" icon="refresh-cw" onAction={query.refetch} />}
    </div>
  );
}
