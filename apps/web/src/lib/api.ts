'use client';

/**
 * The data layer.
 *
 * Every call does the same two things: reach the API, and validate the answer
 * with the shared zod schemas (`packages/shared` is the contract — if the
 * payload does not match it, we did not get an answer). Two routes in:
 *
 * - Public reads (`/tasks`, `/tasks/<id>`, `/rails`, `/status/<id>`,
 *   `/checks/<id>`) go straight to `NEXT_PUBLIC_API_URL` while nobody is
 *   signed in.
 * - Everything that needs to know who is asking — claiming, starting or
 *   opening an agent, the notes, releasing, saved keys, connected agents, and
 *   the personalized versions of the reads above — goes through this
 *   origin's BFF (`/bff/bridge/*`, `/bff/oauth/grants*`), which checks the
 *   session cookie and vouches for it to the API. The browser never holds
 *   anything the API accepts.
 *
 * What happens when that fails depends on which app is running (`./mode`):
 *
 * - LIVE (the default, and everything we deploy): nothing is ever substituted.
 *   A read that fails throws and the page says so; a write that fails throws
 *   and nothing on screen moves.
 * - DEMO (`NEXT_PUBLIC_FORGE_DEMO=1`): public reads fall back to `./fixtures`,
 *   and everything that needs an identity is simulated by `./offline` without
 *   ever leaving the tab (the practice account is nobody on GitHub, and the
 *   BFF refuses it). The degraded flag flips and the screen says it's practice.
 *
 * 409 is the same in both: a conflict is a real answer from a healthy server
 * ("someone claimed this one first"), thrown as {@link ConflictError}. Any
 * other refusal that names a code (`{"error": "credential_rejected"}`, ...) is
 * an {@link ApiError}, for the UI to put in plain words (`./handoff`).
 */

import {
  BridgeStatusSchema,
  CheckResultsSchema,
  ClaimResponseSchema,
  ConnectedAgentListSchema,
  ContributorProfileSchema,
  DispatchResultSchema,
  FeedbackResponseSchema,
  RailListSchema,
  SavedCredentialListSchema,
  TaskDetailSchema,
  TaskListSchema,
  type BridgeStatus,
  type CheckResults,
  type ClaimResponse,
  type ConnectedAgentList,
  type ContributorProfile,
  type CopyResult,
  type Credential,
  type DispatchResult,
  type FeedbackResponse,
  type OpenRail,
  type Rail,
  type RailList,
  type SavedCredentialList,
  type StartRail,
  type TaskCard,
  type TaskDetail,
} from '@forge/shared';

import { markDegraded } from './degraded';
import { findTaskFixture, profileFixture, taskCardFixtures, type TaskFixture } from './fixtures';
import { isDemoMode } from './mode';
import {
  localChecks,
  localClaim,
  localCopy,
  localDispatch,
  localFeedback,
  localRails,
  localRelease,
  localReview,
  localStatus,
  localTaskDetail,
  type PracticeTask,
} from './offline';

export const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/+$/, '');

/** Same origin, so the session cookie goes along and no CORS is involved. */
const BFF_BRIDGE = '/bff/bridge';
const BFF_GRANTS = '/bff/oauth/grants';

const TIMEOUT_MS = 8000;
/**
 * Starting an agent, or sending it the notes, waits on the vendor's own API.
 * Longer than the BFF's own 45 s (`START_TIMEOUT_MS` in ./bff-forward), so
 * the page hears the BFF's answer, a 504 `upstream_timeout` included, rather
 * than giving up first.
 */
export const START_TIMEOUT_MS = 60_000;
/**
 * Claiming, releasing and handing in a pull request wait on GitHub behind the
 * API. Longer than the BFF's own 25 s (`READ_TIMEOUT_MS` in ./bff-forward),
 * so here too the page hears the BFF's 504 `upstream_timeout` rather than
 * giving up first.
 */
export const WRITE_TIMEOUT_MS = 30_000;
/** A practice start pauses this long, so it reads as a start rather than a no-op. */
const PRACTICE_START_MS = 700;

/** A value plus whether it came from the practice app's stand-ins. Always false when live. */
export interface Loaded<T> {
  data: T;
  degraded: boolean;
}

/**
 * The server said no, on purpose (409). Carries the API's error code
 * verbatim, and what came with it (`claim_cooldown`'s wait, `already_started`'s
 * session link).
 */
export class ConflictError extends Error {
  readonly code: string;
  readonly claimedBy?: string;
  readonly extra: ApiErrorExtra;

  constructor(code: string, claimedBy?: string, extra: ApiErrorExtra = {}) {
    super(`API conflict: ${code}`);
    this.name = 'ConflictError';
    this.code = code;
    this.extra = extra;
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

/** What an {@link ApiError} carries beyond its code, when the API sent it. */
export interface ApiErrorExtra {
  /** `rail_setup_needed`'s `message`: the API's own sentence. */
  detail?: string;
  /** `rail_failed`'s `status`: what the vendor answered. */
  upstreamStatus?: number;
  /** `credential_invalid`'s `field`, or `fields` from a schema check. */
  fields?: readonly string[];
  /** `dispatch_limit`'s `limit`: starts allowed an hour. */
  limit?: number;
  /** The `Retry-After` header, or the body's `retryAfter`, in seconds. */
  retryAfterSeconds?: number;
  /** `already_started`'s `sessionUrl`, unchecked: the UI shows it only through `sessionLink`. */
  sessionUrl?: string;
}

/** A refusal with a code the API (or the BFF) named: `{"error": "<code>", ...}`. */
export class ApiError extends RequestError {
  readonly code: string;
  readonly extra: ApiErrorExtra;

  constructor(path: string, status: number, code: string, extra: ApiErrorExtra = {}) {
    super(path, `refused with ${code}`, status);
    this.name = 'ApiError';
    this.code = code;
    this.extra = extra;
  }

  get detail(): string | undefined {
    return this.extra.detail;
  }

  get upstreamStatus(): number | undefined {
    return this.extra.upstreamStatus;
  }
}

/** The extras of a refusal body (and its Retry-After), keeping only well-formed values. */
function errorExtra(body: Record<string, unknown>, retryAfter: string | null): ApiErrorExtra {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 10) : [];
  const fields = typeof body.field === 'string' ? [body.field] : strings(body.fields);
  const whole = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const upstreamStatus = whole(body.status);
  const limit = whole(body.limit);
  const header = retryAfter !== null && /^[0-9]{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : undefined;
  const retry = header ?? whole(body.retryAfter);
  return {
    ...(typeof body.message === 'string' ? { detail: body.message } : {}),
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    ...(fields.length === 0 ? {} : { fields }),
    ...(limit === undefined ? {} : { limit }),
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
    ...(typeof body.sessionUrl === 'string' ? { sessionUrl: body.sessionUrl } : {}),
  };
}

/** The failure behind `error`, for `describeStartError` and friends (`./handoff`). */
export function failureOf(error: unknown): { code: string } & ApiErrorExtra {
  return error instanceof ApiError || error instanceof ConflictError
    ? { code: error.code, ...error.extra }
    : { code: errorCode(error) };
}

/**
 * Whether a write that failed (a claim, a start, a relay, a release, a pull
 * request handed in) may still have happened: no answer reached the page (it
 * gave up waiting, the network dropped, or what came back wasn't the answer
 * it expects), the BFF stopped waiting on the API (504 `upstream_timeout`),
 * or a 5xx came back without an error code: the host's own timeout or crash
 * page, which can follow a write the API has already stored. Either way the
 * API may have it, so the page must read the task again rather than say that
 * nothing changed.
 */
export function mayHaveHappened(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'upstream_timeout';
  if (!(error instanceof RequestError)) return false;
  return error.status === undefined || (error.status >= 500 && error.status <= 599);
}

/**
 * The error code behind `error`, for the UI's sentences (`./handoff`):
 * the API's own code, `service_unreachable` when nothing answered at all, and
 * `unknown` for anything else.
 */
export function errorCode(error: unknown): string {
  if (error instanceof ConflictError || error instanceof ApiError) {
    return error.code;
  }
  if (error instanceof RequestError && error.status === undefined) {
    return 'service_unreachable';
  }
  return 'unknown';
}

/** Structural stand-in for a zod schema — `zod` is @forge/shared's dependency, not ours. */
interface Parser<T> {
  parse(input: unknown): T;
}

function degradedResult<T>(data: T): Loaded<T> {
  markDegraded();
  return { data, degraded: true };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function request(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch {
      throw new RequestError(url, 'did not answer');
    }
    if (!response.ok) {
      const body = record(await response.json().catch(() => null));
      const code = typeof body.error === 'string' ? body.error : null;
      const extra = errorExtra(body, response.headers.get('retry-after'));
      if (response.status === 409) {
        throw new ConflictError(code ?? 'conflict', typeof body.claimedBy === 'string' ? body.claimedBy : undefined, extra);
      }
      if (code !== null) {
        throw new ApiError(url, response.status, code, extra);
      }
      throw new RequestError(url, `responded with ${response.status}`, response.status);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new RequestError(url, 'answered with something that is not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** One round trip, contract-checked. Throws {@link ConflictError}, {@link ApiError} or {@link RequestError}. */
async function call<T>(url: string, parser: Parser<T>, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const payload = await request(url, init, timeoutMs);
  try {
    return parser.parse(payload);
  } catch {
    throw new RequestError(url, 'answered with a payload the contract rejects');
  }
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** A public read: through the BFF when signed in (personalized), straight to the API otherwise. */
function readUrl(path: string, identified: boolean): string {
  return identified ? `${BFF_BRIDGE}${path}` : `${apiBase}/api/bridge${path}`;
}

/** Live: the answer or the failure. Demo: the answer, or the practice stand-in. */
async function load<T>(url: string, parser: Parser<T>, fallback: () => T): Promise<Loaded<T>> {
  try {
    return { data: await call(url, parser), degraded: false };
  } catch (error) {
    // Live: the caller renders the failure. Nothing here invents a page.
    if (!isDemoMode()) {
      throw error;
    }
    return degradedResult(fallback());
  }
}

/* --- practice (demo builds) -------------------------------------------------- */

/** What the practice app holds, for the life of the tab. Never read in a live build. */
const practiceTasks = new Map<number, PracticeTask>();

function requireTask(taskId: number): TaskFixture {
  const task = findTaskFixture(taskId);
  if (task === undefined) {
    throw new RequestError(`practice task ${taskId}`, 'has no local copy');
  }
  return task;
}

function requirePractice(taskId: number): PracticeTask {
  const practice = practiceTasks.get(taskId);
  if (practice === undefined) {
    throw new ApiError(`practice task ${taskId}`, 403, 'not_holder');
  }
  return practice;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* --- reads --------------------------------------------------------------------- */

export async function fetchTasks(): Promise<Loaded<TaskCard[]>> {
  const result = await load(`${apiBase}/api/bridge/tasks`, TaskListSchema, () => ({ tasks: taskCardFixtures() }));
  return { data: result.data.tasks, degraded: result.degraded };
}

/**
 * The task, its criteria and its brief (personalized when `identified`), and
 * for the holder their copy and whether "Send for review" has anything to send.
 */
export async function fetchTaskDetail(taskId: number, identified: boolean): Promise<Loaded<TaskDetail>> {
  if (isDemoMode()) {
    return load(`${apiBase}/api/bridge/tasks/${taskId}`, TaskDetailSchema, () =>
      localTaskDetail(requireTask(taskId), practiceTasks.get(taskId)),
    );
  }
  return { data: await call(readUrl(`/tasks/${taskId}`, identified), TaskDetailSchema), degraded: false };
}

/** Which agents FORGE can start or open (and, when `identified`, which keys it has saved). */
export async function fetchRails(identified: boolean): Promise<Loaded<RailList>> {
  if (isDemoMode()) {
    // Every rail, switched on: the practice account has no keys and no
    // server-side allowlist, and the practice app shows the whole flow.
    return degradedResult(localRails());
  }
  return { data: await call(readUrl('/rails', identified), RailListSchema), degraded: false };
}

export async function fetchStatus(taskId: number, identified: boolean): Promise<Loaded<BridgeStatus>> {
  if (isDemoMode()) {
    return degradedResult(localStatus(taskId, practiceTasks.get(taskId)));
  }
  return { data: await call(readUrl(`/status/${taskId}`, identified), BridgeStatusSchema), degraded: false };
}

export async function fetchChecks(taskId: number, identified: boolean): Promise<Loaded<CheckResults>> {
  if (isDemoMode()) {
    return degradedResult(localChecks(requireTask(taskId), practiceTasks.get(taskId)));
  }
  return { data: await call(readUrl(`/checks/${taskId}`, identified), CheckResultsSchema), degraded: false };
}

export async function fetchProfile(): Promise<Loaded<ContributorProfile>> {
  if (isDemoMode()) {
    return degradedResult(profileFixture());
  }
  return { data: await call(`${BFF_BRIDGE}/profile`, ContributorProfileSchema), degraded: false };
}

/* --- writes (identity required) ------------------------------------------------ */

/**
 * Claim → lease countdown. Throws {@link ConflictError} when someone beat you
 * to it (or you hold too many), anything else when the claim did not land.
 */
export async function claimTask(taskId: number): Promise<Loaded<ClaimResponse>> {
  if (isDemoMode()) {
    const task = requireTask(taskId);
    // As the API answers: every account is T0 for now.
    if (task.tierFloor !== 'T0') throw new ApiError(`practice task ${taskId}`, 403, 'tier_too_low');
    const { claim, practice } = localClaim(task);
    practiceTasks.set(taskId, practice);
    return degradedResult(claim);
  }
  return {
    data: await call(`${BFF_BRIDGE}/claim`, ClaimResponseSchema, postJson({ taskId }), WRITE_TIMEOUT_MS),
    degraded: false,
  };
}

/** Hand the task back. */
export async function releaseTask(taskId: number): Promise<Loaded<BridgeStatus>> {
  if (isDemoMode()) {
    const released = localRelease(taskId, practiceTasks.get(taskId));
    practiceTasks.delete(taskId);
    return degradedResult(released);
  }
  return {
    data: await call(`${BFF_BRIDGE}/release/${taskId}`, BridgeStatusSchema, postJson({}), WRITE_TIMEOUT_MS),
    degraded: false,
  };
}

export interface StartRequest {
  taskId: number;
  rail: StartRail;
  /** Omitted to use the key FORGE saved. Never stored here: the caller drops it after this call. */
  credential?: Credential;
  saveCredential?: boolean;
}

/** "Start it for me": FORGE starts the agent through the vendor's API, on the contributor's own account. */
export async function startAgent(start: StartRequest): Promise<Loaded<DispatchResult>> {
  if (isDemoMode()) {
    await pause(PRACTICE_START_MS);
    const { result, practice } = localDispatch(requireTask(start.taskId), requirePractice(start.taskId), start);
    practiceTasks.set(start.taskId, practice);
    return degradedResult(result);
  }
  const body = {
    taskId: start.taskId,
    rail: start.rail,
    ...(start.credential === undefined ? {} : { credential: start.credential }),
    ...(start.saveCredential === true ? { saveCredential: true } : {}),
  };
  return { data: await call(`${BFF_BRIDGE}/dispatch`, DispatchResultSchema, postJson(body), START_TIMEOUT_MS), degraded: false };
}

/**
 * "Open my agent": note the hand-off, fire and forget. The link itself is
 * what opens the agent, so nothing here may hold it up or fail it: no await,
 * and `keepalive` lets the request outlive a page that is navigating away.
 */
export function recordOpen(taskId: number, rail: OpenRail): void {
  if (isDemoMode()) {
    const practice = practiceTasks.get(taskId);
    const task = findTaskFixture(taskId);
    if (practice !== undefined && task !== undefined) {
      practiceTasks.set(taskId, localDispatch(task, practice, { rail }).practice);
    }
    return;
  }
  try {
    void fetch(`${BFF_BRIDGE}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, rail }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // No fetch, or the keepalive budget is spent: the agent still opens.
  }
}

/** Send the checks' notes to the agent FORGE started, when its vendor takes follow-ups. */
export async function sendNotes(taskId: number): Promise<Loaded<FeedbackResponse>> {
  if (isDemoMode()) {
    const { result, practice } = localFeedback(requireTask(taskId), requirePractice(taskId));
    practiceTasks.set(taskId, practice);
    return degradedResult(result);
  }
  return {
    data: await call(`${BFF_BRIDGE}/feedback/${taskId}`, FeedbackResponseSchema, postJson({}), START_TIMEOUT_MS),
    degraded: false,
  };
}

/**
 * Hand in a pull request FORGE couldn't find by itself (one on another
 * branch, say): the API checks it is this task's, from the caller's fork.
 * The practice account has no fork, so it has nothing to hand in.
 */
export async function submitPullRequest(taskId: number, prUrl: string): Promise<Loaded<BridgeStatus>> {
  if (isDemoMode()) {
    throw new ApiError(`practice task ${taskId}`, 403, 'practice_session');
  }
  return {
    data: await call(`${BFF_BRIDGE}/submit/${taskId}`, BridgeStatusSchema, postJson({ prUrl }), WRITE_TIMEOUT_MS),
    degraded: false,
  };
}

/*
 * "Your copy" and "Send for review" go through GitHub (`/auth/github/repo`, a
 * form post: GitHub's approval page has to be a top-level navigation), never
 * through these. Only the practice app, which has nobody on GitHub, does them
 * here, in the tab.
 */

/** "Get started" or "Refresh your copy" in the practice app: a pretend copy, with nothing sent. */
export async function practiceCopy(taskId: number): Promise<Loaded<CopyResult>> {
  if (!isDemoMode()) {
    throw new ApiError(`practice task ${taskId}`, 400, 'not_practice');
  }
  await pause(PRACTICE_START_MS);
  const { result, practice } = localCopy(requireTask(taskId), requirePractice(taskId));
  practiceTasks.set(taskId, practice);
  return degradedResult(result);
}

/** "Send for review" in the practice app: the pretend work goes on to its checks, with nothing sent. */
export async function practiceReview(taskId: number): Promise<Loaded<{ sent: true }>> {
  if (!isDemoMode()) {
    throw new ApiError(`practice task ${taskId}`, 400, 'not_practice');
  }
  await pause(PRACTICE_START_MS);
  const reviewed = localReview(requirePractice(taskId));
  if ('refused' in reviewed) {
    throw new ConflictError(reviewed.refused);
  }
  practiceTasks.set(taskId, reviewed.practice);
  return degradedResult({ sent: true });
}

/* --- your agent keys and connected agents (/me) ------------------------------------ */

export async function fetchSavedKeys(): Promise<SavedCredentialList> {
  return call(`${BFF_BRIDGE}/me/keys`, SavedCredentialListSchema);
}

export async function removeSavedKey(rail: Rail): Promise<SavedCredentialList> {
  return call(`${BFF_BRIDGE}/me/keys/${encodeURIComponent(rail)}`, SavedCredentialListSchema, { method: 'DELETE' });
}

export async function fetchConnectedAgents(): Promise<ConnectedAgentList> {
  return call(BFF_GRANTS, ConnectedAgentListSchema);
}

export async function disconnectAgent(id: string): Promise<ConnectedAgentList> {
  return call(`${BFF_GRANTS}/${encodeURIComponent(id)}`, ConnectedAgentListSchema, { method: 'DELETE' });
}
