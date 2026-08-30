'use client';

/**
 * The data layer.
 *
 * Every call does the same two things: hit the API, and validate the answer
 * with the shared zod schemas (`packages/shared` is the contract — if the
 * payload does not match it, we did not get an answer). What happens when that
 * fails is the whole point of this module, and it depends on which app is
 * running (`./mode`):
 *
 * - LIVE (the default, and everything we deploy): nothing is ever substituted.
 *   A read that fails throws {@link RequestError} and the page says so; a write
 *   that fails throws and nothing on screen moves. There is no offline queue
 *   and no retry daemon, so a claim that did not reach the server did not
 *   happen and must never be drawn as though it had.
 * - DEMO (`NEXT_PUBLIC_FORGE_DEMO=1`): reads fall back to `./fixtures` and
 *   writes to the simulation in `./offline`, the degraded flag flips, and the
 *   screen carries a banner saying none of it is real.
 *
 * 409 is the same in both: a conflict is a real answer from a healthy server
 * ("someone claimed this one first"), so it is thrown as {@link ConflictError}
 * for the UI to translate, never swallowed into demo data.
 */

import {
  BridgeStatusSchema,
  ClaimResponseSchema,
  ContributorProfileSchema,
  DispatchResultSchema,
  HistoryListSchema,
  TaskCardSchema,
  type BridgeStatus,
  type ClaimResponse,
  type ContributorProfile,
  type DispatchResult,
  type HistoryList,
  type Rail,
  type TaskCard,
} from '@forge/shared';

import {
  HISTORY_FIXTURES,
  findTaskFixture,
  profileFixture,
  taskCardFixtures,
  type TaskFixture,
} from './fixtures';
import { markDegraded } from './degraded';
import { isDemoMode } from './mode';
import { localClaim, localDispatch, localFeedbackPrompt, localStatus } from './offline';

export const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

/** Direct browser download — the CSV story is a link, not a fetch (PRD H.2). */
export const exportUrl = `${apiBase}/api/export`;

const TIMEOUT_MS = 8000;

/** A value plus whether it came from the parachute. Always false when live. */
export interface Loaded<T> {
  data: T;
  degraded: boolean;
}

/** The server said no, on purpose. Carries the API's error code verbatim. */
export class ConflictError extends Error {
  readonly code: string;
  readonly claimedBy?: string;

  constructor(code: string, claimedBy?: string) {
    super(`API conflict: ${code}`);
    this.name = 'ConflictError';
    this.code = code;
    if (claimedBy !== undefined) {
      this.claimedBy = claimedBy;
    }
  }
}

/**
 * No answer we can trust: unreachable, timed out, refused, or a payload the
 * contract rejects. Never a 409 — that is {@link ConflictError}.
 */
export class RequestError extends Error {
  readonly path: string;
  readonly status?: number;

  constructor(path: string, detail: string, status?: number) {
    super(`${path} ${detail}`);
    this.name = 'RequestError';
    this.path = path;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/** Structural stand-in for a zod schema — `zod` is @forge/shared's dependency, not ours. */
interface Parser<T> {
  parse(input: unknown): T;
}

function degradedResult<T>(data: T): Loaded<T> {
  markDegraded();
  return { data, degraded: true };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw new RequestError(path, 'did not answer');
    }
    if (response.status === 409) {
      const body: unknown = await response.json().catch(() => ({}));
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      const code = typeof record.error === 'string' ? record.error : 'conflict';
      const claimedBy = typeof record.claimedBy === 'string' ? record.claimedBy : undefined;
      throw new ConflictError(code, claimedBy);
    }
    if (!response.ok) {
      throw new RequestError(path, `responded with ${response.status}`, response.status);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new RequestError(path, 'answered with something that is not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** One round trip, contract-checked. Throws {@link ConflictError} or {@link RequestError}. */
async function call<T>(path: string, parser: Parser<T>, init?: RequestInit): Promise<T> {
  const payload = await request(path, init);
  try {
    return parser.parse(payload);
  } catch {
    throw new RequestError(path, 'answered with a payload the contract rejects');
  }
}

async function load<T>(path: string, parser: Parser<T>, fallback: () => T): Promise<Loaded<T>> {
  try {
    return { data: await call(path, parser), degraded: false };
  } catch (error) {
    // Live: the caller renders the failure. Nothing here invents a page.
    if (!isDemoMode()) {
      throw error;
    }
    return degradedResult(fallback());
  }
}

async function send<T>(
  path: string,
  body: unknown,
  parser: Parser<T>,
  fallback: () => T,
): Promise<Loaded<T>> {
  try {
    const data = await call(path, parser, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { data, degraded: false };
  } catch (error) {
    // A write that did not land must never come back as a success: no queue
    // exists to replay it, so the only honest answer is the failure itself.
    if (error instanceof ConflictError || !isDemoMode()) {
      throw error;
    }
    return degradedResult(fallback());
  }
}

/* --- history --------------------------------------------------------------- */

export const HISTORY_PAGE_SIZE = 50;

export async function fetchHistory(limit: number, offset: number): Promise<Loaded<HistoryList>> {
  return load(`/api/history?limit=${limit}&offset=${offset}`, HistoryListSchema, () => ({
    items: HISTORY_FIXTURES.slice(offset, offset + limit).map((item) => ({ ...item })),
    total: HISTORY_FIXTURES.length,
  }));
}

/* --- bridge ---------------------------------------------------------------- */

const TaskListParser: Parser<TaskCard[]> = {
  parse(input: unknown): TaskCard[] {
    const tasks = (input as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(tasks)) {
      throw new Error('GET /api/bridge/tasks did not return a task list');
    }
    return tasks.map((task) => TaskCardSchema.parse(task));
  },
};

export async function fetchTasks(): Promise<Loaded<TaskCard[]>> {
  return load('/api/bridge/tasks', TaskListParser, taskCardFixtures);
}

/**
 * Claims made this session, so the demo status simulation knows when the clock
 * started. Demo only — nothing in the live app reads it — and it dies with the
 * tab either way.
 */
const localLeases = new Map<number, { claimedAtMs: number; leaseHours: number }>();

function rememberLease(taskId: number, claim: ClaimResponse): void {
  if (!isDemoMode()) {
    return;
  }
  const endsAtMs = Date.parse(claim.leaseEndsAt);
  const claimedAtMs = Number.isNaN(endsAtMs)
    ? Date.now()
    : endsAtMs - claim.leaseHours * 60 * 60 * 1000;
  localLeases.set(taskId, { claimedAtMs, leaseHours: claim.leaseHours });
}

/**
 * Adopt a lease the server already knows about — e.g. the contributor reloaded
 * the page and the card came back claimed by them. Keeps the demo status
 * simulation honest about when the clock started; a no-op in the live app.
 */
export function noteExistingLease(taskId: number, leaseEndsAt: string, leaseHours: number): void {
  rememberLease(taskId, { taskId, claimedBy: 'you', leaseEndsAt, leaseHours });
}

function requireTask(taskId: number): TaskFixture {
  const task = findTaskFixture(taskId);
  if (task === undefined) {
    throw new Error(`No local copy of task ${taskId}`);
  }
  return task;
}

/**
 * Claim → lease countdown. Throws {@link ConflictError} when someone beat you
 * to it, {@link RequestError} when the claim did not land at all.
 */
export async function claimTask(taskId: number): Promise<Loaded<ClaimResponse>> {
  const result = await send('/api/bridge/claim', { taskId }, ClaimResponseSchema, () =>
    localClaim(requireTask(taskId)),
  );
  rememberLease(taskId, result.data);
  return result;
}

/** Hand the task to the contributor's own agent (BYOA — PRD §4.9 invariant 2). */
export async function dispatchTask(taskId: number, rail: Rail): Promise<Loaded<DispatchResult>> {
  return send('/api/bridge/dispatch', { taskId, rail }, DispatchResultSchema, () =>
    localDispatch(requireTask(taskId), rail),
  );
}

export async function fetchStatus(taskId: number): Promise<Loaded<BridgeStatus>> {
  const lease = localLeases.get(taskId);
  return load(`/api/bridge/status/${taskId}`, BridgeStatusSchema, () =>
    localStatus(taskId, lease?.claimedAtMs ?? Date.now(), lease?.leaseHours ?? 48),
  );
}

export interface FeedbackRelay {
  relayed: boolean;
  prompt: string;
}

const FeedbackParser: Parser<FeedbackRelay> = {
  parse(input: unknown): FeedbackRelay {
    const record = (input ?? {}) as Record<string, unknown>;
    if (typeof record.relayed !== 'boolean' || typeof record.prompt !== 'string') {
      throw new Error('POST /api/bridge/feedback did not return a relay');
    }
    return { relayed: record.relayed, prompt: record.prompt };
  },
};

/** One button: send the checks' notes back to the agent (PRD I.2, Iterate row). */
export async function sendFeedback(taskId: number): Promise<Loaded<FeedbackRelay>> {
  return send(`/api/bridge/feedback/${taskId}`, {}, FeedbackParser, () => ({
    relayed: true,
    prompt: localFeedbackPrompt(requireTask(taskId)),
  }));
}

export async function fetchProfile(): Promise<Loaded<ContributorProfile>> {
  return load('/api/bridge/profile', ContributorProfileSchema, profileFixture);
}
