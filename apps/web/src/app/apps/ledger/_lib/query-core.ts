/**
 * The framework-free half of the data hooks: a short-lived response cache,
 * the client-side heavy-query slot, and what a failed read means for the
 * screen. `hooks.ts` wires these into React; everything here is plain
 * functions and classes so it can be tested without a DOM.
 */
import { LedgerError, isLedgerError } from '@forge/upland-ledger';

/* --- cache ------------------------------------------------------------------ */

/**
 * The ledger caches identical GET URLs for 15 s; this mirrors that in the
 * browser so moving between pages (or two widgets asking for the same thing)
 * doesn't spend the shared heavy-query slot twice. Only successful answers
 * are kept, and never longer than `ttlMs`.
 */
export class ResponseCache {
  private readonly entries = new Map<string, { value: unknown; at: number }>();

  constructor(
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 200,
  ) {}

  get<T>(key: string): { value: T; at: number } | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: hit.value as T, at: hit.at };
  }

  set(key: string, value: unknown): number {
    const at = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, at });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return at;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/* --- the heavy-query slot --------------------------------------------------- */

/**
 * Analytics and market reads (`/analytics/*`, `/market/*`, `/signals`) share
 * ONE in-flight slot at the ledger for every user of this app (README,
 * Gotchas 1). So this browser never has more than `concurrency` of them in
 * flight either: the rest wait their turn in order. A waiting task whose
 * signal aborts leaves the queue without ever running.
 */
export class HeavySlot {
  private running = 0;
  private readonly waiting: Array<{ start: () => void; signal: AbortSignal | undefined; reject: (e: unknown) => void }> =
    [];

  constructor(private readonly concurrency = 1) {}

  /** How many tasks are queued (not yet running). */
  get queued(): number {
    return this.waiting.length;
  }

  get active(): number {
    return this.running;
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.running += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running -= 1;
            this.next();
          });
      };
      if (this.running < this.concurrency) {
        start();
        return;
      }
      const entry = { start, signal, reject };
      this.waiting.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) {
            this.waiting.splice(at, 1);
            reject(abortError());
          }
        },
        { once: true },
      );
    });
  }

  private next(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (entry === undefined) return;
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      entry.start();
    }
  }
}

function abortError(): LedgerError {
  return new LedgerError(0, 'aborted', 'The request was cancelled.', 'client', '');
}

/* --- errors ----------------------------------------------------------------- */

/** Anything thrown while reading, as a LedgerError (the client throws nothing else, but be safe). */
export function toLedgerError(err: unknown): LedgerError {
  if (isLedgerError(err)) return err;
  const message = err instanceof Error ? err.message : 'Something went wrong while reading the ledger.';
  return new LedgerError(0, 'unexpected', message, 'client', '');
}

export function isAbort(err: unknown): boolean {
  return isLedgerError(err) && err.code === 'aborted';
}

export type ErrorKind =
  | 'unauthenticated'
  | 'not-found'
  | 'disabled'
  | 'route-blocked'
  | 'invalid-input'
  | 'busy'
  | 'down'
  | 'slow'
  | 'not-configured'
  | 'offline'
  | 'contract'
  | 'other';

export interface ErrorCopy {
  kind: ErrorKind;
  /** One line: what happened. */
  title: string;
  /** One line: what to do, or what it means for the screen. */
  detail: string;
  /** Status and code, for the small print and bug reports. */
  code: string;
  /** Worth offering Retry. */
  retryable: boolean;
}

/**
 * What a failed read means, in words. Every branch says what happened and
 * what to do; nothing here ever suggests the screen will show substitute
 * data, because it won't.
 */
export function describeError(err: LedgerError): ErrorCopy {
  const code = err.status > 0 ? `${err.status} ${err.code}` : err.code;
  const base = { code };
  if (err.isUnauthenticated) {
    return { ...base, kind: 'unauthenticated', title: 'Sign in to read the ledger', detail: 'Your session has ended or this account cannot open the ledger.', retryable: false };
  }
  if (err.isNotFound) {
    return { ...base, kind: 'not-found', title: 'Not in the ledger', detail: 'The ledger has no record with that id.', retryable: false };
  }
  if (err.status === 404 && err.source === 'gateway') {
    if (err.code === 'ledger-disabled') {
      return { ...base, kind: 'disabled', title: 'The ledger is switched off right now', detail: 'The upland_ledger flag is off on the server. Try again later.', retryable: true };
    }
    return { ...base, kind: 'route-blocked', title: 'The gateway refused this request', detail: 'This screen asked for a route the gateway does not allow. Please report it.', retryable: false };
  }
  if (err.status === 400) {
    return { ...base, kind: 'invalid-input', title: 'The ledger rejected these filters', detail: err.message || 'Check the filter values and try again.', retryable: false };
  }
  if (err.status === 429) {
    return { ...base, kind: 'busy', title: 'The ledger is busy with other queries', detail: 'Heavy queries take turns. Try again in a few seconds.', retryable: true };
  }
  if (err.status === 502) {
    return { ...base, kind: 'down', title: 'The ledger is unreachable (502)', detail: 'Nothing is shown rather than stale or made-up numbers. Try again shortly.', retryable: true };
  }
  if (err.status === 504 || err.status === 408 || err.code === 'timeout') {
    return { ...base, kind: 'slow', title: 'The ledger took too long to answer', detail: 'It may be working through other queries. Try again.', retryable: true };
  }
  if (err.status === 503) {
    return { ...base, kind: 'not-configured', title: 'The ledger is not configured on this server (503)', detail: 'This is a deployment setting, not something a retry fixes. Please report it.', retryable: true };
  }
  if (err.code === 'network_error') {
    return { ...base, kind: 'offline', title: 'Could not reach the server', detail: 'Check your connection, then try again.', retryable: true };
  }
  if (err.code === 'schema_mismatch' || err.code === 'invalid_response') {
    return { ...base, kind: 'contract', title: 'The ledger answered in a shape this page does not understand', detail: 'Nothing is shown rather than misread data. Please report it.', retryable: true };
  }
  return { ...base, kind: 'other', title: 'The ledger could not answer', detail: err.message || 'Try again.', retryable: true };
}

/* --- view state ------------------------------------------------------------- */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QuerySnapshot<T> {
  status: QueryStatus;
  data: T | undefined;
  error: LedgerError | undefined;
  /** A request is in flight (first load, refresh or a new page). */
  fetching: boolean;
  /** When the shown data arrived (ms since epoch). */
  updatedAt: number | undefined;
}

/** DataState's vocabulary, plus the two outcomes that replace the region entirely. */
export type ViewState = 'idle' | 'loading' | 'refreshing' | 'ready' | 'empty' | 'error' | 'unauthenticated' | 'not-found';

/**
 * One DataState per region: decides between skeleton, data, empty, error
 * and the sign-in prompt. Data already on screen stays while a refresh runs
 * (`refreshing`) — but an error always wins over old data, so a failed
 * retry is never hidden behind what was there before.
 */
export function viewState<T>(snap: QuerySnapshot<T>, isEmpty: (data: T) => boolean = defaultIsEmpty): ViewState {
  if (snap.status === 'error' && snap.error !== undefined) {
    if (snap.error.isUnauthenticated) return 'unauthenticated';
    if (snap.error.isNotFound) return 'not-found';
    return 'error';
  }
  if (snap.data === undefined) return snap.status === 'idle' && !snap.fetching ? 'idle' : 'loading';
  if (snap.fetching) return 'refreshing';
  return isEmpty(snap.data) ? 'empty' : 'ready';
}

function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (data !== null && typeof data === 'object' && 'data' in data) {
    const rows = (data as { data: unknown }).data;
    return Array.isArray(rows) && rows.length === 0;
  }
  return false;
}

/** A stable cache key for a route plus its params (key order doesn't matter, empty values are dropped). */
export function queryKey(route: string, params?: object): string {
  if (params === undefined) return route;
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? route : `${route}?${JSON.stringify(entries)}`;
}
