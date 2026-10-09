'use client';

/**
 * Every fetched region goes through the Embers DataState (SKILL.md
 * non-negotiable). This maps a ledger query onto it: skeleton while loading,
 * the data dimmed under "Updating" while refreshing, empty with a way out,
 * one-line error with code and Retry, stale and capped banners. A 401
 * replaces the region with the sign-in prompt, never data.
 */
import { DataState } from '@forge/ui';
import type { ReactNode } from 'react';

import type { QueryResult } from '../_lib/hooks';
import { describeError } from '../_lib/query-core';
import { SignInPrompt } from './SignIn';

export interface RegionProps<T> {
  query: QueryResult<T>;
  children: (data: T) => ReactNode;
  /** Layout-matching placeholder (a DataTable in `loading`, a chart frame…). */
  skeleton?: ReactNode;
  emptyMessage: string;
  /** "Reset filters" and similar ways out of an empty result. */
  emptyAction?: { label: string; onClick: () => void };
  notFoundMessage?: string;
  /** Minutes the data is behind, when that matters for this region (stale banner with Refresh). */
  staleMinutes?: number | null;
  /** The list was cut at this many rows (capped banner). */
  cappedCount?: number | null;
}

export function Region<T>({ query, children, skeleton, emptyMessage, emptyAction, notFoundMessage, staleMinutes, cappedCount }: RegionProps<T>) {
  switch (query.view) {
    case 'idle':
    case 'loading':
      return <DataState state="loading" skeleton={skeleton} />;
    case 'unauthenticated':
      return <SignInPrompt onRetry={query.refetch} />;
    case 'not-found':
      return <DataState state="empty" emptyMessage={notFoundMessage ?? 'Not in the ledger.'} />;
    case 'error': {
      const copy = query.error ? describeError(query.error) : null;
      return (
        <DataState
          state="error"
          error={{ message: copy ? `${copy.title}. ${copy.detail}` : 'The ledger could not answer. Try again.', code: copy?.code }}
          onRetry={copy?.retryable === false ? undefined : query.refetch}
        />
      );
    }
    case 'empty':
      return <DataState state="empty" emptyMessage={emptyMessage} emptyAction={emptyAction?.label} onEmptyAction={emptyAction?.onClick} />;
    case 'refreshing':
    case 'ready': {
      const state = query.view === 'refreshing' ? 'refreshing' : staleMinutes ? 'stale' : cappedCount ? 'capped' : 'ready';
      return (
        <DataState state={state} staleMinutes={staleMinutes ?? undefined} onRefresh={query.refetch} cappedCount={cappedCount ?? undefined}>
          {query.data !== undefined && children(query.data)}
        </DataState>
      );
    }
  }
}
