'use client';

/**
 * React data hooks over the ledger client. Every read goes through
 * `useLedgerQuery`, which:
 * - aborts its request when the component unmounts or the key changes;
 * - serves a 15 s browser cache (the ledger's own cache window);
 * - queues `heavy` reads (analytics, market, signals) behind one in-flight
 *   slot for the whole tab, because the ledger gives the whole app only one;
 * - keeps what's on screen while a refresh or the next page loads, and
 *   reports `fetching` so the UI can say so;
 * - never substitutes data: a failure is a status, with the LedgerError.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LedgerClient } from '@forge/upland-ledger';

import { ledgerClient } from './client';
import { HeavySlot, ResponseCache, isAbort, toLedgerError, viewState } from './query-core';
import type { QuerySnapshot, ViewState } from './query-core';

const cache = new ResponseCache();
const heavySlot = new HeavySlot(1);

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
  /** Re-reads from the ledger, skipping the cache. Resolves when the read settles. */
  refetch: () => Promise<void>;
}

const IDLE = { status: 'idle', data: undefined, error: undefined, fetching: false, updatedAt: undefined } as const;

export function useLedgerQuery<T>(key: string | null, fetcher: Fetcher<T>, options: QueryOptions<T> = {}): QueryResult<T> {
  const { heavy = false, enabled = true, keepPrevious = false, isEmpty } = options;
  const active = enabled && key !== null;

  const [snap, setSnap] = useState<QuerySnapshot<T>>(() => {
    const hit = key === null ? undefined : cache.get<T>(key);
    return hit
      ? { status: 'success', data: hit.value, error: undefined, fetching: false, updatedAt: hit.at }
      : { ...IDLE, status: active ? 'loading' : 'idle', fetching: active };
  });

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const run = useCallback(
    (force: boolean): Promise<void> => {
      if (key === null) return Promise.resolve();
      controllerRef.current?.abort();
      const request = ++requestRef.current;

      const hit = force ? undefined : cache.get<T>(key);
      if (hit) {
        setSnap({ status: 'success', data: hit.value, error: undefined, fetching: false, updatedAt: hit.at });
        return Promise.resolve();
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      setSnap((prev) => {
        const keep = (keepPrevious || force) && prev.data !== undefined;
        return {
          status: keep ? 'success' : 'loading',
          data: keep ? prev.data : undefined,
          error: undefined,
          fetching: true,
          updatedAt: keep ? prev.updatedAt : undefined,
        };
      });

      const client = ledgerClient();
      const read = (): Promise<T> => fetcherRef.current(client, controller.signal);
      const pending = heavy ? heavySlot.run(read, controller.signal) : read();

      return pending.then(
        (data) => {
          if (request !== requestRef.current) return;
          const at = cache.set(key, data);
          setSnap({ status: 'success', data, error: undefined, fetching: false, updatedAt: at });
        },
        (err: unknown) => {
          if (request !== requestRef.current || isAbort(err)) return;
          setSnap((prev) => ({ ...prev, status: 'error', error: toLedgerError(err), fetching: false }));
        },
      );
    },
    [key, heavy, keepPrevious],
  );

  useEffect(() => {
    if (!active) {
      setSnap((prev) => (prev.fetching ? { ...prev, fetching: false } : prev));
      return undefined;
    }
    void run(false);
    return () => {
      controllerRef.current?.abort();
    };
  }, [active, run]);

  const refetch = useCallback(() => run(true), [run]);
  const view = viewState(snap, isEmpty);
  return { ...snap, view, refetch };
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
  const query = useLedgerQuery<OffsetPage<T>>(
    key,
    (client, signal) => fetchPage({ limit: pageSize, offset }, client, signal),
    { keepPrevious: true, enabled: options.enabled, heavy: options.heavy },
  );

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
  loadMoreError: ReturnType<typeof toLedgerError> | undefined;
  loadMore: () => Promise<void>;
}

/**
 * Cursor feeds (`next_cursor`): the first page through `useLedgerQuery`,
 * then "Load more" appends. A failed "Load more" keeps what's loaded and
 * reports its own error, so the list never disappears under it.
 */
export function useCursorFeed<T>(
  key: string | null,
  fetchPage: (cursor: string | undefined, client: LedgerClient, signal: AbortSignal) => Promise<{ data: T[]; next_cursor: string | null }>,
): CursorFeedResult<T> {
  const first = useLedgerQuery(key, (client, signal) => fetchPage(undefined, client, signal));
  const [more, setMore] = useState<{ key: string | null; items: T[]; cursor: string | null | undefined }>({
    key,
    items: [],
    cursor: undefined,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<ReturnType<typeof toLedgerError> | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);

  const extra = more.key === key && first.data !== undefined ? more : { key, items: [] as T[], cursor: undefined };
  const cursor = extra.cursor === undefined ? first.data?.next_cursor ?? null : extra.cursor;

  useEffect(() => {
    // A new key (or a refresh of page one) starts the feed over.
    controllerRef.current?.abort();
    setMore({ key, items: [], cursor: undefined });
    setLoadMoreError(undefined);
    setLoadingMore(false);
  }, [key, first.updatedAt]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (cursor === null || loadingMore) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const page = await fetchPage(cursor, ledgerClient(), controller.signal);
      setMore((prev) => ({ key, items: [...(prev.key === key ? prev.items : []), ...page.data], cursor: page.next_cursor }));
    } catch (err) {
      if (!isAbort(err)) setLoadMoreError(toLedgerError(err));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [cursor, fetchPage, key, loadingMore]);

  const items = useMemo(() => [...(first.data?.data ?? []), ...extra.items], [first.data, extra.items]);
  return { ...first, items, hasMore: cursor !== null && first.data !== undefined, loadingMore, loadMoreError, loadMore };
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
