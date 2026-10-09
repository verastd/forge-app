'use client';

/**
 * React data hooks over the ledger client, on TanStack Query (COMPONENT_MAP
 * §3: "Server state lives in TanStack Query. Components receive typed view
 * models"). Every read goes through `useLedgerQuery`, which:
 * - aborts its request when the component unmounts or the key changes
 *   (Query passes its AbortSignal to the client);
 * - keeps answers fresh for 15 s, the ledger's own response-cache window;
 * - queues `heavy` reads (analytics, market, signals) behind one in-flight
 *   slot for the whole tab, because the ledger gives the whole app only one;
 * - never retries on its own (Retry is always a visible word) and never
 *   substitutes data: a failure is a status, with the LedgerError.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { LedgerClient, LedgerError } from '@forge/upland-ledger';

import { ledgerClient } from './client';
import { HeavySlot, toLedgerError, viewState } from './query-core';
import type { QuerySnapshot, ViewState } from './query-core';

const heavySlot = new HeavySlot(1);

/** Defaults for the ledger UI's QueryClient (see `LedgerQueryProvider`). */
export const LEDGER_QUERY_DEFAULTS = {
  queries: {
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  },
} as const;

export type Fetcher<T> = (client: LedgerClient, signal: AbortSignal) => Promise<T>;

export interface QueryOptions<T> {
  /** Goes through the shared heavy-query slot (analytics, market, signals). */
  heavy?: boolean;
  /** false: don't fetch (yet). */
  enabled?: boolean;
  /** Keep the previous key's data on screen while the new key loads (paging, filters). */
  keepPrevious?: boolean;
  /** What counts as "nothing to show" for this region. */
  isEmpty?: (data: T) => boolean;
}

export interface QueryResult<T> extends QuerySnapshot<T> {
  view: ViewState;
  /** Re-reads from the ledger. Resolves when the read settles (never rejects). */
  refetch: () => Promise<void>;
}

function runRead<T>(fetcher: Fetcher<T>, heavy: boolean, signal: AbortSignal): Promise<T> {
  const client = ledgerClient();
  const read = (): Promise<T> => fetcher(client, signal);
  return (heavy ? heavySlot.run(read, signal) : read()).catch((err: unknown) => {
    throw toLedgerError(err);
  });
}

export function useLedgerQuery<T>(key: string | null, fetcher: Fetcher<T>, options: QueryOptions<T> = {}): QueryResult<T> {
  const { heavy = false, enabled = true, keepPrevious = false, isEmpty } = options;
  const q = useQuery<T, LedgerError>({
    queryKey: ['ledger', key],
    queryFn: ({ signal }) => runRead(fetcher, heavy, signal),
    enabled: enabled && key !== null,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
  const { refetch: queryRefetch } = q;
  const refetch = useCallback(async (): Promise<void> => {
    await queryRefetch();
  }, [queryRefetch]);

  const snap: QuerySnapshot<T> = {
    status: q.isError ? 'error' : q.data !== undefined ? 'success' : enabled && key !== null ? 'loading' : 'idle',
    data: q.data,
    error: q.isError ? q.error : undefined,
    fetching: q.isFetching,
    updatedAt: q.dataUpdatedAt > 0 ? q.dataUpdatedAt : undefined,
  };
  return { ...snap, view: viewState(snap, isEmpty), refetch };
}

/* --- offset pages ---------------------------------------------------------- */

export interface OffsetPage<T> {
  data: T[];
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface OffsetPagesResult<T> extends QueryResult<OffsetPage<T>> {
  rows: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  hasPrevious: boolean;
  /** Which way the user just paged, while that page loads. */
  paging: 'next' | 'previous' | null;
  next: () => void;
  previous: () => void;
}

/**
 * Offset paging for entity lists (`has_more` drives Next). `baseKey` must
 * change whenever the filters do; that resets to the first page. The rows
 * of the page you're leaving stay visible (dimmed) until the next arrives.
 */
export function useOffsetPages<T>(
  baseKey: string | null,
  fetchPage: (page: { limit: number; offset: number }, client: LedgerClient, signal: AbortSignal) => Promise<OffsetPage<T>>,
  options: { pageSize?: number; enabled?: boolean; heavy?: boolean } = {},
): OffsetPagesResult<T> {
  const pageSize = options.pageSize ?? 25;
  const [state, setState] = useState<{ base: string | null; offset: number; paging: 'next' | 'previous' | null }>({
    base: baseKey,
    offset: 0,
    paging: null,
  });
  const offset = state.base === baseKey ? state.offset : 0;
  if (state.base !== baseKey) setState({ base: baseKey, offset: 0, paging: null });

  const key = baseKey === null ? null : `${baseKey}#${pageSize}@${offset}`;
  const query = useLedgerQuery<OffsetPage<T>>(key, (client, signal) => fetchPage({ limit: pageSize, offset }, client, signal), {
    keepPrevious: true,
    enabled: options.enabled,
    heavy: options.heavy,
  });

  const showingOffset = query.data?.offset ?? offset;
  const paging = query.fetching ? state.paging : null;
  const hasMore = query.data?.has_more ?? false;

  const next = useCallback(() => {
    if (query.fetching || !hasMore) return;
    setState({ base: baseKey, offset: showingOffset + pageSize, paging: 'next' });
  }, [baseKey, hasMore, pageSize, query.fetching, showingOffset]);

  const previous = useCallback(() => {
    if (query.fetching || showingOffset === 0) return;
    setState({ base: baseKey, offset: Math.max(0, showingOffset - pageSize), paging: 'previous' });
  }, [baseKey, pageSize, query.fetching, showingOffset]);

  return {
    ...query,
    rows: query.data?.data ?? [],
    page: Math.floor(showingOffset / pageSize) + 1,
    pageSize,
    hasMore,
    hasPrevious: showingOffset > 0,
    paging,
    next,
    previous,
  };
}

/* --- cursor feeds ------------------------------------------------------------ */

export interface CursorFeedResult<T> extends QueryResult<{ data: T[]; next_cursor: string | null }> {
  items: T[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: LedgerError | undefined;
  loadMore: () => Promise<void>;
}

/**
 * Cursor feeds (`next_cursor`) on useInfiniteQuery: "Load more" appends. A
 * failed "Load more" keeps what's loaded and reports its own error, so the
 * list never disappears under it.
 */
export function useCursorFeed<T>(
  key: string | null,
  fetchPage: (cursor: string | undefined, client: LedgerClient, signal: AbortSignal) => Promise<{ data: T[]; next_cursor: string | null }>,
): CursorFeedResult<T> {
  const q = useInfiniteQuery<{ data: T[]; next_cursor: string | null }, LedgerError>({
    queryKey: ['ledger', 'feed', key],
    queryFn: ({ pageParam, signal }) => runRead((client, s) => fetchPage(pageParam as string | undefined, client, s), false, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key !== null,
  });
  const { refetch: queryRefetch, fetchNextPage } = q;
  const refetch = useCallback(async (): Promise<void> => {
    await queryRefetch();
  }, [queryRefetch]);
  const loadMore = useCallback(async (): Promise<void> => {
    await fetchNextPage();
  }, [fetchNextPage]);

  const first = q.data?.pages[0];
  const firstFailed = q.isError && q.data === undefined;
  const snap: QuerySnapshot<{ data: T[]; next_cursor: string | null }> = {
    status: firstFailed ? 'error' : first !== undefined ? 'success' : key !== null ? 'loading' : 'idle',
    data: first,
    error: firstFailed ? q.error : undefined,
    fetching: q.isFetching && !q.isFetchingNextPage,
    updatedAt: q.dataUpdatedAt > 0 ? q.dataUpdatedAt : undefined,
  };
  return {
    ...snap,
    view: viewState(snap),
    refetch,
    items: q.data?.pages.flatMap((p) => p.data) ?? [],
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMoreError: q.isFetchNextPageError ? q.error : undefined,
    loadMore,
  };
}

/* --- offset feeds (append) ----------------------------------------------------- */

export interface OffsetFeedResult<T> extends QueryResult<OffsetPage<T>> {
  items: T[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: LedgerError | undefined;
  loadMore: () => Promise<void>;
}

/**
 * An offset route read as an append-only feed ("Load older"), for timelines.
 * Same failure rule as cursor feeds: a failed page keeps what's loaded.
 */
export function useOffsetFeed<T>(
  key: string | null,
  fetchPage: (page: { limit: number; offset: number }, client: LedgerClient, signal: AbortSignal) => Promise<OffsetPage<T>>,
  pageSize = 20,
): OffsetFeedResult<T> {
  const q = useInfiniteQuery<OffsetPage<T>, LedgerError>({
    queryKey: ['ledger', 'offset-feed', key, pageSize],
    queryFn: ({ pageParam, signal }) => runRead((client, s) => fetchPage({ limit: pageSize, offset: pageParam as number }, client, s), false, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.offset + last.data.length : undefined),
    enabled: key !== null,
  });
  const { refetch: queryRefetch, fetchNextPage } = q;
  const refetch = useCallback(async (): Promise<void> => {
    await queryRefetch();
  }, [queryRefetch]);
  const loadMore = useCallback(async (): Promise<void> => {
    await fetchNextPage();
  }, [fetchNextPage]);
  const first = q.data?.pages[0];
  const firstFailed = q.isError && q.data === undefined;
  const snap: QuerySnapshot<OffsetPage<T>> = {
    status: firstFailed ? 'error' : first !== undefined ? 'success' : key !== null ? 'loading' : 'idle',
    data: first,
    error: firstFailed ? q.error : undefined,
    fetching: q.isFetching && !q.isFetchingNextPage,
    updatedAt: q.dataUpdatedAt > 0 ? q.dataUpdatedAt : undefined,
  };
  return {
    ...snap,
    view: viewState(snap),
    refetch,
    items: q.data?.pages.flatMap((p) => p.data) ?? [],
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMoreError: q.isFetchNextPageError ? q.error : undefined,
    loadMore,
  };
}

/* --- small helpers ------------------------------------------------------------ */

/** `value`, settled for `ms` (search boxes: never one query per keystroke). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** True once `ref` has scrolled near the viewport: lazy-loads heavy sections. Stays true. */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return undefined;
    const el = ref.current;
    if (el === null) return undefined;
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      setSeen(true);
      return undefined;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}
