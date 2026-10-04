'use client';

/**
 * The Propose screens' data layer (Phase 5 contract §3 and §4), on the same
 * model as `./api`:
 *
 * - Public reads (the floor's list and its earlier pages, one proposal, the
 *   earlier pages of its comments) go straight to `NEXT_PUBLIC_API_URL`.
 *   A signed-in member's page also reads the proposal through this origin's
 *   BFF (`/bff/proposals/*`), which vouches for them, so it comes back with
 *   `you` (and, for admins, the draft task). The public read never depends on
 *   the BFF: if the BFF can't answer, the proposal still shows, read-only.
 * - Everything that needs to know who is asking goes through the BFF:
 *   `/bff/proposals/*` and `/bff/notifications/*`. The browser never holds
 *   anything the API accepts.
 * - Every answer is checked against the shared zod schemas (`@forge/shared`):
 *   a payload the contract rejects is not an answer. Timeline and bell
 *   `kind`s are the one exception, read leniently ({@link DisplayDetailSchema},
 *   {@link DisplayNotificationListSchema}): the page never branches on them,
 *   so a kind the API added before this build knows it reads as its message
 *   rather than taking the page down.
 * - Every answer with a readable `Date` header sets the page's server clock
 *   (`./server-clock`), which the countdowns run on.
 *
 * LIVE (everything we deploy): nothing is substituted. A read that fails
 * throws and the page says so; a write that fails throws and nothing on
 * screen moves. A write that got no usable answer (no response, the BFF's
 * 504 `upstream_timeout`, a 5xx with no error code, which is the host's own
 * error page, or a body that isn't the contract) may still have happened:
 * {@link mayHaveHappened} says so, and the page reads the proposal again
 * rather than saying that nothing changed.
 *
 * DEMO (`NEXT_PUBLIC_FORGE_DEMO=1`): the practice floor (`./proposals-offline`)
 * answers everything, and nothing ever leaves the tab: the practice account
 * is nobody on GitHub, and the BFF refuses it anyway.
 */

import {
  NotificationListSchema,
  NotificationSchema,
  ProposalCardSchema,
  ProposalCommentPageSchema,
  ProposalDetailSchema,
  ProposalEventSchema,
  ProposalListSchema,
  ProposalMeSchema,
} from '@forge/shared';
import type {
  DraftTaskRequest,
  NewProposal,
  ProposalCommentPage,
  ProposalList,
  ProposalMe,
  VoteChoice,
} from '@forge/shared';

import { isDemoMode } from './mode';
import type { ProposalFailure } from './proposals-format';
import {
  practiceComment,
  practiceComments,
  practiceConsent,
  practiceDetail,
  practiceFloor,
  practiceList,
  practiceSecond,
  practiceVote,
} from './proposals-offline';
import type { PracticeFloor, PracticeResult } from './proposals-offline';
import { serverClock } from './server-clock';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/+$/, '');

/** Same origin, so the session cookie goes along and no CORS is involved. */
const BFF_PROPOSALS = '/bff/proposals';
const BFF_NOTIFICATIONS = '/bff/notifications';

const READ_TIMEOUT_MS = 8000;
/** Longer than the BFF's own 25 s, so the page hears its 504 `upstream_timeout` rather than giving up first. */
const WRITE_TIMEOUT_MS = 30_000;

/* --- what the pages show: the contract, with any kind of timeline line or bell item ---- */

/** Any string: what a kind is when this build may not know it yet. */
const AnyKind = ProposalEventSchema.shape.message;

/** A timeline line whose `kind` may be one this build doesn't know: it shows as its message. */
export const DisplayEventSchema = ProposalEventSchema.extend({ kind: AnyKind });
/** ProposalDetail, read leniently: only the timeline's kinds are open. */
export const DisplayDetailSchema = ProposalDetailSchema.extend({ events: DisplayEventSchema.array() });
export type DisplayDetail = ReturnType<typeof DisplayDetailSchema.parse>;
export type DisplayEvent = ReturnType<typeof DisplayEventSchema.parse>;

/** A bell item whose `kind` may be one this build doesn't know (the page never branches on it). */
export const DisplayNotificationSchema = NotificationSchema.extend({ kind: AnyKind });
export const DisplayNotificationListSchema = NotificationListSchema.extend({
  notifications: DisplayNotificationSchema.array(),
});
export type DisplayNotification = ReturnType<typeof DisplayNotificationSchema.parse>;
export type DisplayNotificationList = ReturnType<typeof DisplayNotificationListSchema.parse>;

/** A value, and whether it came from the practice floor. Always false when live. */
export interface Loaded<T> {
  data: T;
  practice: boolean;
}

/**
 * A request that failed. `status` is the HTTP status of a refusal, and
 * undefined when no answer we can use came back (nothing answered, it timed
 * out, or the payload broke the contract). `coded` says whether the refusal
 * named its reason (`{"error": code}`): a 5xx that didn't is the host's own
 * error page or a crash, not the API or the BFF saying no.
 */
export class ProposalRequestError extends Error {
  readonly status: number | undefined;
  readonly failure: ProposalFailure;
  readonly coded: boolean;

  constructor(where: string, status: number | undefined, failure: ProposalFailure, coded = true) {
    super(`${where} ${status === undefined ? 'gave no answer we can use' : `refused with ${failure.code}`}`);
    this.name = 'ProposalRequestError';
    this.status = status;
    this.failure = failure;
    this.coded = coded;
  }
}

/** The failure behind `error`, for `describeProposalError` (`./proposals-format`). */
export function failureOf(error: unknown): ProposalFailure {
  return error instanceof ProposalRequestError ? error.failure : { code: 'unknown' };
}

/**
 * Whether a write that failed may still have happened: no usable answer came
 * back, the BFF stopped waiting on the API (504 `upstream_timeout`), or a 5xx
 * came back without an error code (the host's timeout or crash page, which
 * can follow a write the API has already stored).
 */
export function mayHaveHappened(error: unknown): boolean {
  if (!(error instanceof ProposalRequestError)) return false;
  if (error.status === undefined || error.failure.code === 'upstream_timeout') return true;
  return !error.coded && error.status >= 500 && error.status <= 599;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/** A refusal body's code and extras, keeping only well-formed values. */
function failureFrom(body: Record<string, unknown>, retryAfter: string | null, status: number): ProposalFailure {
  const code = typeof body.error === 'string' && CODE.test(body.error) ? body.error : `http_${status}`;
  const header = retryAfter !== null && /^[0-9]{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : undefined;
  const retry = header ?? whole(body.retryAfter);
  const proposalId = whole(body.proposalId);
  const revision = whole(body.revision);
  const limit = whole(body.limit);
  const fields =
    typeof body.field === 'string'
      ? [body.field]
      : Array.isArray(body.fields)
        ? body.fields.filter((item): item is string => typeof item === 'string').slice(0, 10)
        : [];
  return {
    code,
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
    ...(proposalId === undefined || proposalId === 0 ? {} : { proposalId }),
    ...(typeof body.state === 'string' ? { state: body.state } : {}),
    ...(fields.length === 0 ? {} : { fields }),
    ...(revision === undefined || revision === 0 ? {} : { revision }),
    ...(limit === undefined || limit === 0 ? {} : { limit }),
  };
}

/** One round trip. The parsed JSON, or undefined for an empty answer (204). */
async function send(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    const sent = Date.now();
    try {
      response = await fetch(url, { ...init, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    } catch {
      throw new ProposalRequestError(url, undefined, { code: 'service_unreachable' });
    }
    serverClock.note(response.headers.get('date'), sent, Date.now());
    if (!response.ok) {
      const body = record(await response.json().catch(() => null));
      const failure = failureFrom(body, response.headers.get('retry-after'), response.status);
      const coded = typeof body.error === 'string' && CODE.test(body.error);
      throw new ProposalRequestError(url, response.status, failure, coded);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ProposalRequestError(url, undefined, { code: 'bad_answer' });
    }
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProposalRequestError(url, undefined, { code: 'bad_answer' });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Structural stand-in for a zod schema. */
interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

async function read<T>(url: string, parser: Parser<T>): Promise<T> {
  const parsed = parser.safeParse(await send(url, {}, READ_TIMEOUT_MS));
  if (!parsed.success) throw new ProposalRequestError(url, undefined, { code: 'bad_answer' });
  return parsed.data;
}

function write(url: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown): Promise<unknown> {
  return send(
    url,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    WRITE_TIMEOUT_MS,
  );
}

/** The proposal, when the API answered a write with it; null means "read it again". */
function detailFrom(answer: unknown): DisplayDetail | null {
  const parsed = DisplayDetailSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}

/* --- practice (demo builds) ------------------------------------------------------- */

/** The practice floor, for the life of the tab. Never read in a live build. */
let practice: PracticeFloor | null = null;

function practiceState(): PracticeFloor {
  practice ??= practiceFloor(Date.now());
  return practice;
}

function settle(where: string, result: PracticeResult): DisplayDetail {
  if (!result.ok) {
    throw new ProposalRequestError(where, result.status, {
      code: result.code,
      ...(result.state === undefined ? {} : { state: result.state }),
      ...(result.revision === undefined ? {} : { revision: result.revision }),
    });
  }
  practice = result.floor;
  return result.detail;
}

/** What the practice account may not do at all: bring, edit or withdraw a proposal, or anything an admin does. */
function practiceRefusal(where: string): ProposalRequestError {
  return new ProposalRequestError(where, 403, { code: 'practice_session' });
}

/* --- reads ---------------------------------------------------------------------------- */

/**
 * The floor: every active proposal and the newest decided ones, newest
 * first, with whether test timers are on and whether the floor is paused.
 * `decidedBefore` asks for the next page of decided proposals instead.
 */
export async function loadProposals(decidedBefore?: number): Promise<Loaded<ProposalList>> {
  if (isDemoMode()) return { data: practiceList(practiceState(), decidedBefore), practice: true };
  const query = decidedBefore === undefined ? '' : `?decidedBefore=${decidedBefore}`;
  return { data: await read(`${API_BASE}/api/proposals${query}`, ProposalListSchema), practice: false };
}

/**
 * One proposal, read in public (the API itself, never the BFF): what anyone
 * may see. `signedIn` gives the practice account its `you` in the practice app.
 */
export async function loadProposal(id: number, signedIn = false): Promise<Loaded<DisplayDetail>> {
  if (isDemoMode()) {
    const detail = practiceDetail(practiceState(), id, signedIn);
    if (detail === null) throw new ProposalRequestError(`practice proposal ${id}`, 404, { code: 'proposal_not_found' });
    return { data: detail, practice: true };
  }
  return { data: await read(`${API_BASE}/api/proposals/${id}`, DisplayDetailSchema), practice: false };
}

/**
 * One proposal as a signed-in GitHub member sees it: through the BFF, with
 * `you` (and the draft task, for an admin). Live builds only.
 */
export async function loadProposalAsMember(id: number): Promise<DisplayDetail> {
  return read(`${BFF_PROPOSALS}/${id}`, DisplayDetailSchema);
}

/** Up to 100 comments older than comment `before`, oldest first, and whether older ones exist. */
export async function loadEarlierComments(id: number, before: number): Promise<ProposalCommentPage> {
  if (isDemoMode()) {
    const page = practiceComments(practiceState(), id, before);
    if (page === null) throw new ProposalRequestError(`practice proposal ${id}`, 404, { code: 'proposal_not_found' });
    return page;
  }
  return read(`${API_BASE}/api/proposals/${id}/comments?before=${before}`, ProposalCommentPageSchema);
}

/** Who you are to the floor: admin or not, your proposal on the floor, and the test-timers switch. */
export async function loadMe(): Promise<ProposalMe> {
  if (isDemoMode()) return { isAdmin: false, testTimers: false };
  return read(`${BFF_PROPOSALS}/me`, ProposalMeSchema);
}

/* --- a member's writes ----------------------------------------------------------------- */

/** The new proposal's id, from whichever shape the API answered with. */
function idFrom(answer: unknown): number | null {
  const detail = DisplayDetailSchema.safeParse(answer);
  if (detail.success) return detail.data.proposal.id;
  const card = ProposalCardSchema.safeParse(answer);
  if (card.success) return card.data.id;
  const id = whole(record(answer).id);
  return id === undefined || id === 0 ? null : id;
}

/** Bring a proposal: its id, to open its page. */
export async function createProposal(proposal: NewProposal): Promise<number> {
  if (isDemoMode()) throw practiceRefusal(BFF_PROPOSALS);
  const id = idFrom(await write(BFF_PROPOSALS, 'POST', proposal));
  if (id !== null) return id;
  // The API took it without saying which one it is: yours on the floor is the one.
  const me = await loadMe();
  if (me.activeProposalId !== undefined) return me.activeProposalId;
  throw new ProposalRequestError(BFF_PROPOSALS, undefined, { code: 'bad_answer' });
}

/** The mover's edit, until it is seconded. */
export async function editProposal(id: number, proposal: NewProposal): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}`, 'PATCH', proposal));
}

/** The mover withdraws it, until it is decided. */
export async function withdrawProposal(id: number): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/withdraw`, 'POST', {}));
}

/**
 * Second the text you read: `revision` is the one on screen. If the mover
 * edited it since, the API refuses (409 `proposal_changed`).
 */
export async function secondProposal(id: number, revision: number): Promise<DisplayDetail | null> {
  if (isDemoMode()) {
    return settle(`practice proposal ${id}`, practiceSecond(practiceState(), id, revision, Date.now()));
  }
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/second`, 'POST', { revision }));
}

/** `true` consents, `false` objects. Either is final. */
export async function answerConsent(id: number, consent: boolean): Promise<DisplayDetail | null> {
  if (isDemoMode()) return settle(`practice proposal ${id}`, practiceConsent(practiceState(), id, consent, Date.now()));
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/consent`, 'POST', { consent }));
}

export async function postComment(id: number, text: string): Promise<DisplayDetail | null> {
  if (isDemoMode()) return settle(`practice proposal ${id}`, practiceComment(practiceState(), id, text, Date.now()));
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/comments`, 'POST', { text }));
}

export async function castVote(id: number, choice: VoteChoice): Promise<DisplayDetail | null> {
  if (isDemoMode()) return settle(`practice proposal ${id}`, practiceVote(practiceState(), id, choice, Date.now()));
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/vote`, 'POST', { choice }));
}

/* --- an admin's writes (the API checks FORGE_ADMIN_IDS; the page only hides the buttons) --- */

/** The Test timers switch: its new value, when the API's answer says it. */
export async function switchTestTimers(on: boolean): Promise<boolean | null> {
  if (isDemoMode()) throw practiceRefusal(`${BFF_PROPOSALS}/settings`);
  const answer = record(await write(`${BFF_PROPOSALS}/settings`, 'PUT', { testTimers: on }));
  return typeof answer.testTimers === 'boolean' ? answer.testTimers : null;
}

/** A test tool: the API refuses it (409 `test_mode_off`) unless Test timers are on. */
export async function endDebateNow(id: number): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/admin/end-debate`, 'POST', {}));
}

/** A test tool: the API refuses it (409 `test_mode_off`) unless Test timers are on. */
export async function closeVoteNow(id: number): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/admin/close-vote`, 'POST', {}));
}

export async function saveDraftTask(id: number, draft: DraftTaskRequest): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/admin/draft-task`, 'PUT', draft));
}

/** Publish the saved draft to the Contribute board: the proposal moves to `building`. */
export async function publishDraftTask(id: number): Promise<DisplayDetail | null> {
  if (isDemoMode()) throw practiceRefusal(`practice proposal ${id}`);
  return detailFrom(await write(`${BFF_PROPOSALS}/${id}/admin/publish-task`, 'POST', {}));
}

/* --- the bell ---------------------------------------------------------------------------- */

export async function loadNotifications(): Promise<DisplayNotificationList> {
  if (isDemoMode()) throw practiceRefusal(BFF_NOTIFICATIONS);
  return read(BFF_NOTIFICATIONS, DisplayNotificationListSchema);
}

/** Marks `ids` read, or every one when `ids` is left out. The new list, when the API answered with it. */
export async function markNotificationsRead(ids?: readonly number[]): Promise<DisplayNotificationList | null> {
  if (isDemoMode()) throw practiceRefusal(`${BFF_NOTIFICATIONS}/read`);
  const answer = await write(`${BFF_NOTIFICATIONS}/read`, 'POST', ids === undefined ? {} : { ids: [...ids] });
  const parsed = DisplayNotificationListSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}
