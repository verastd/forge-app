/**
 * Pure helpers for the Propose screens (Phase 5 contract §4): which floor
 * section each state belongs to, the words for states, deadlines, consent,
 * turnout and the tally, the plain sentence for every API error code, the
 * checks on what a member sends before it goes, and the guard on the links
 * the bell shows.
 *
 * No React, no fetch: everything here is unit-tested on its own
 * (tests/e2e/propose-helpers.spec.ts).
 */
import { ELIGIBLE_ACTIVITY_DAYS, PROPOSAL_LIMITS, slugify, textLength } from '@forge/shared';
import type {
  ConsentChoice,
  DraftTask,
  DraftTaskRequest,
  NewProposal,
  ProposalCard,
  ProposalComment,
  ProposalDetail,
  ProposalEvent,
  ProposalEventKind,
  ProposalList,
  ProposalState,
  ProposalTally,
  ProposalYou,
  RewardClass,
  Size,
  TierFloor,
  VoteChoice,
} from '@forge/shared';

import type { ChipTone } from '../components/Chip';

/* --- states and the floor's sections --------------------------------------------- */

/** The floor's four sections, in the order the page shows them. */
export const FLOOR_SECTIONS = ['needs_second', 'debate', 'voting', 'decided'] as const;
export type FloorSection = (typeof FLOOR_SECTIONS)[number];

export const SECTION_TITLE: Readonly<Record<FloorSection, string>> = {
  needs_second: 'Needs a second',
  debate: 'In debate',
  voting: 'Voting',
  decided: 'Decided',
};

export const SECTION_EMPTY: Readonly<Record<FloorSection, string>> = {
  needs_second: 'Nothing is waiting for a second right now.',
  debate: 'Nothing is in debate right now.',
  voting: 'Nothing is being voted on right now.',
  decided: 'Nothing has been decided yet.',
};

const SECTION_OF: Readonly<Record<ProposalState, FloorSection>> = {
  submitted: 'needs_second',
  debate: 'debate',
  voting: 'voting',
  passed: 'decided',
  failed: 'decided',
  building: 'decided',
  shipped: 'decided',
  lapsed: 'decided',
  withdrawn: 'decided',
};

/** The floor section a proposal in `state` is listed under. */
export function sectionOf(state: ProposalState): FloorSection {
  return SECTION_OF[state];
}

/** The cards in each section, in the order they came (the API lists newest first). */
export function groupBySection(cards: readonly ProposalCard[]): Record<FloorSection, ProposalCard[]> {
  const groups: Record<FloorSection, ProposalCard[]> = { needs_second: [], debate: [], voting: [], decided: [] };
  for (const card of cards) {
    groups[sectionOf(card.state)].push(card);
  }
  return groups;
}

/** A state, said the way the floor says it. */
export const STATE_LABEL: Readonly<Record<ProposalState, string>> = {
  submitted: 'Needs a second',
  debate: 'In debate',
  voting: 'Voting',
  passed: 'Passed',
  failed: 'Failed',
  building: 'Being built',
  shipped: 'Shipped',
  lapsed: 'Lapsed',
  withdrawn: 'Withdrawn',
};

/** Live states wear spark cyan (globals.css: "anything live"), outcomes green or red; gold is for value. */
export const STATE_TONE: Readonly<Record<ProposalState, ChipTone>> = {
  submitted: 'info',
  debate: 'info',
  voting: 'info',
  passed: 'ok',
  failed: 'danger',
  building: 'ok',
  shipped: 'ok',
  lapsed: 'neutral',
  withdrawn: 'neutral',
};

/** States with a deadline running: the floor's first three sections. */
export function isActive(state: ProposalState): boolean {
  return state === 'submitted' || state === 'debate' || state === 'voting';
}

/* --- deadlines --------------------------------------------------------------------- */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Time left on a deadline, ticking: "3d 04h", "4h 12m", "4m 09s". Two units,
 * the larger first, so a pilot's days and a test's minutes both read well.
 */
export function formatTimeLeft(msRemaining: number): string {
  if (!(msRemaining > 0)) {
    return '0m 00s';
  }
  const totalSeconds = Math.floor(msRemaining / SECOND_MS);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${pad(hours)}h`;
  }
  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m`;
  }
  return `${minutes}m ${pad(seconds)}s`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The same time, coarse enough to announce (`aria-live`): it changes once a
 * day, once an hour, or once a minute, never every second.
 */
export function spokenTimeLeft(msRemaining: number): string {
  if (msRemaining < MINUTE_MS) {
    return 'less than a minute';
  }
  if (msRemaining < HOUR_MS) {
    return plural(Math.floor(msRemaining / MINUTE_MS), 'minute');
  }
  if (msRemaining < DAY_MS) {
    return plural(Math.floor(msRemaining / HOUR_MS), 'hour');
  }
  return plural(Math.floor(msRemaining / DAY_MS), 'day');
}

const DEADLINE_WORDS: Partial<Record<ProposalState, { running: string; over: string }>> = {
  submitted: { running: 'Needs a second within', over: 'The time to second it is up' },
  debate: { running: 'Debate ends in', over: 'Debate time is up' },
  voting: { running: 'Voting closes in', over: 'Voting time is up' },
};

/**
 * While the floor is paused (members can't act: sign-in or proposals is off),
 * no deadline runs: the API moves each one later by the time it was paused.
 */
const PAUSED_WORDS: Partial<Record<ProposalState, string>> = {
  submitted: 'The time to second it is paused',
  debate: 'Debate time is paused',
  voting: 'Voting time is paused',
};

/** What a paused active proposal's deadline says instead of counting down; null for any other state. */
export function pausedLabel(state: ProposalState): string | null {
  return PAUSED_WORDS[state] ?? null;
}

/** Milliseconds until `deadline`, or null when there is none to count down to. */
export function msUntil(deadline: string | undefined, nowMs: number): number | null {
  if (deadline === undefined) return null;
  const end = Date.parse(deadline);
  return Number.isNaN(end) ? null : end - nowMs;
}

/**
 * Which deadline the page should read again after, and when: the API moves a
 * proposal on at its deadline (on its next read). The earliest of `deadlines`
 * still to come, or that passed less than `withinMs` ago and hasn't been read
 * for yet (`done`); `waitMs` is how long until it, 0 once it has passed.
 * Null when there is none.
 */
export function nextDeadlineRead(
  deadlines: readonly (string | undefined)[],
  nowMs: number,
  done: ReadonlySet<string>,
  withinMs: number,
): { deadline: string; waitMs: number } | null {
  let best: { deadline: string; at: number } | null = null;
  for (const deadline of deadlines) {
    if (deadline === undefined) continue;
    const at = Date.parse(deadline);
    if (Number.isNaN(at)) continue;
    const passed = at <= nowMs;
    if (passed && (done.has(deadline) || nowMs - at > withinMs)) continue;
    if (best === null || at < best.at) best = { deadline, at };
  }
  return best === null ? null : { deadline: best.deadline, waitMs: Math.max(0, best.at - nowMs) };
}

/**
 * "Debate ends in 2d 04h" (`ticking`) or "Debate ends in 2 days" (spoken),
 * for a proposal in an active state with a deadline; null otherwise. Past
 * the deadline it says the time is up: the API applies the transition on
 * its next read.
 */
export function deadlineLabel(
  state: ProposalState,
  deadline: string | undefined,
  nowMs: number,
  style: 'ticking' | 'spoken' = 'ticking',
): string | null {
  const words = DEADLINE_WORDS[state];
  const left = msUntil(deadline, nowMs);
  if (words === undefined || left === null) return null;
  if (left <= 0) return words.over;
  return `${words.running} ${style === 'spoken' ? spokenTimeLeft(left) : formatTimeLeft(left)}`;
}

/* --- consent, turnout, tally and outcome ------------------------------------------ */

/**
 * During debate: "4 of 6 have consented" until the first objection, then
 * "Objected: this goes to a vote after debate." Null outside debate, or
 * before the API has counted.
 */
export function consentLine(
  detail: Pick<ProposalDetail, 'proposal' | 'consentCount' | 'eligibleCount'>,
): string | null {
  if (detail.proposal.state !== 'debate') return null;
  if (detail.proposal.objectionCount > 0) return 'Objected: this goes to a vote after debate.';
  if (detail.consentCount === undefined || detail.eligibleCount === undefined) return null;
  return `${detail.consentCount} of ${detail.eligibleCount} ${detail.consentCount === 1 ? 'has' : 'have'} consented.`;
}

/**
 * Where you stand on consent (`ProposalYou.consent`), in the tense the
 * proposal is in: what it means during debate, a plain record afterwards.
 * The mover counts as consenting from the second, which needs saying only
 * while it matters.
 */
export function yourConsentLine(
  consent: ConsentChoice | undefined,
  state: ProposalState,
  mover: boolean,
): string | null {
  if (consent === undefined) return null;
  if (state === 'debate') {
    if (consent === 'objected') return 'You objected, so it goes to a vote after debate.';
    return mover ? 'You brought it, so you count as consenting.' : 'You consented.';
  }
  if (consent === 'objected') return 'You objected during debate.';
  return mover ? null : 'You consented during debate.';
}

/** During voting: "3 of 5 have voted." (Only turnout: the totals stay hidden until the close.) */
export function turnoutLine(detail: Pick<ProposalDetail, 'proposal' | 'turnout' | 'eligibleCount'>): string | null {
  if (detail.proposal.state !== 'voting' || detail.turnout === undefined || detail.eligibleCount === undefined) {
    return null;
  }
  return `${detail.turnout} of ${detail.eligibleCount} ${detail.turnout === 1 ? 'has' : 'have'} voted.`;
}

/** The ballots quorum needs: a majority of the eligible set. */
export function quorumNeeded(eligible: number): number {
  return Math.floor(eligible / 2) + 1;
}

/**
 * Who quorum counts, for the vote panel: the members active in the last
 * ELIGIBLE_ACTIVITY_DAYS days when it was seconded (plus its mover and
 * seconder), and how many ballots that takes.
 */
export function quorumLine(eligibleCount: number | undefined): string {
  const who = `the members active in the last ${ELIGIBLE_ACTIVITY_DAYS} days when it was seconded, with its mover and seconder`;
  if (eligibleCount === undefined) return `Quorum counts ${who}.`;
  return `Quorum counts ${who}: ${eligibleCount} of them, so it needs ${quorumNeeded(eligibleCount)} ${quorumNeeded(eligibleCount) === 1 ? 'ballot' : 'ballots'} (Abstain counts).`;
}

/** The tally after the close, in three plain lines. */
export function tallyLines(tally: ProposalTally): { counts: string; quorum: string; result: string } {
  const cast = tally.yes + tally.no + tally.abstain;
  const counts = `Yes ${tally.yes} · No ${tally.no} · Abstain ${tally.abstain}`;
  const quorum = tally.quorumMet
    ? `Quorum met: ${cast} of ${tally.eligible} voted.`
    : `No quorum: ${cast} of ${tally.eligible} voted, and it needed ${quorumNeeded(tally.eligible)}.`;
  let result: string;
  if (!tally.quorumMet) {
    result = 'Without quorum, it failed.';
  } else if (tally.yes > tally.no) {
    result = 'More Yes than No, so it passed.';
  } else if (tally.yes === tally.no) {
    result = 'A tie, so it failed.';
  } else {
    result = 'More No than Yes, so it failed.';
  }
  return { counts, quorum, result };
}

/** Where a proposal stands, in one sentence. */
export function standingLine(detail: Pick<ProposalDetail, 'proposal' | 'tally' | 'taskId'>): string {
  switch (detail.proposal.state) {
    case 'submitted':
      return 'It needs another member to second it before debate can open.';
    case 'debate':
      return 'It is being debated. Every member counted at the second can consent or object.';
    case 'voting':
      return 'Someone objected, so the members counted at the second are voting on it.';
    case 'passed':
      return detail.tally === undefined
        ? 'It passed without a vote: nobody objected. An admin is writing it up as a task for the Contribute board.'
        : 'It passed the vote. An admin is writing it up as a task for the Contribute board.';
    case 'failed':
      return detail.tally === undefined
        ? 'It failed. Its full record stays here.'
        : 'It failed the vote. Its full record, the tally included, stays here.';
    case 'building':
      return 'It passed, and it is now a task on the Contribute board.';
    case 'shipped':
      return 'It shipped. Its panel in the lobby is still added by hand for now, so it may take a little while to show up there.';
    case 'lapsed':
      return 'Nobody seconded it in time, so it lapsed.';
    case 'withdrawn':
      return 'The member who brought it withdrew it.';
  }
}

export const VOTE_LABEL: Readonly<Record<VoteChoice, string>> = { yes: 'Yes', no: 'No', abstain: 'Abstain' };

/* --- the timeline -------------------------------------------------------------------- */

const ADMIN_EVENTS: ReadonlySet<string> = new Set<ProposalEventKind>([
  'admin_ended_debate',
  'admin_closed_vote',
  'test_timers_on',
  'test_timers_off',
]);

/**
 * Timeline lines an admin caused, which the page marks as such. Any string:
 * a kind this build doesn't know yet (the API grew one first) is a plain line.
 */
export function isAdminEvent(kind: string): boolean {
  return ADMIN_EVENTS.has(kind);
}

/**
 * A timeline line as text: the API's own sentence, plus who did it when the
 * sentence doesn't already name them ("Debate ended early (by octo-admin)").
 */
export function eventText(event: Pick<ProposalEvent, 'message' | 'actor'>): string {
  const { message, actor } = event;
  if (actor === undefined || actor === '' || message.toLowerCase().includes(actor.toLowerCase())) return message;
  return `${message} (by ${actor})`;
}

/* --- errors -------------------------------------------------------------------------- */

/** What the person was doing when it failed: the same code can mean different things. */
export type ProposalAction =
  | 'load'
  | 'create'
  | 'edit'
  | 'withdraw'
  | 'second'
  | 'consent'
  | 'object'
  | 'comment'
  | 'vote'
  | 'end_debate'
  | 'close_vote'
  | 'save_draft'
  | 'publish'
  | 'settings'
  | 'notifications';

/** A refusal as the page sees it: the API's code and what came with it. */
export interface ProposalFailure {
  code: string;
  /** `Retry-After` (or the body's `retryAfter`), in seconds. */
  retryAfterSeconds?: number;
  /** `one_active_proposal`'s proposal. */
  proposalId?: number;
  /** `wrong_state`'s current state. */
  state?: string;
  /** `invalid_request`'s fields. */
  fields?: readonly string[];
  /** `proposal_changed`'s current revision. */
  revision?: number;
  /** `rate_limited`'s and `edit_limit`'s limit. */
  limit?: number;
}

/** Every code the Propose screens put in words (contract §3, plus the BFF's own). */
export const PROPOSAL_ERROR_CODES = [
  'proposal_not_found',
  'wrong_state',
  'one_active_proposal',
  'already_seconded',
  'already_decided_consent',
  'not_eligible',
  'not_mover',
  'own_proposal',
  'rate_limited',
  'invalid_request',
  'proposals-disabled',
  'admin_only',
  'unauthenticated',
  'practice_session',
  'bad_origin',
  'too_large',
  'service_unreachable',
  'not_configured',
  'upstream_timeout',
  'proposal_changed',
  'test_mode_off',
  'edit_limit',
  'tier_not_open',
  'task_title_needs_letters',
] as const;

function retryWords(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return 'Wait a little, then try again.';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes <= 90) return `Try again in about ${plural(minutes, 'minute')}.`;
  return `Try again in about ${plural(Math.ceil(seconds / 3600), 'hour')}.`;
}

/** What each field a member sends is called on screen, and its limit. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  title: `the title (1 to ${PROPOSAL_LIMITS.title} characters)`,
  pitch: `the pitch (1 to ${PROPOSAL_LIMITS.pitch} characters)`,
  text: `the comment (1 to ${PROPOSAL_LIMITS.comment} characters)`,
  civilianSummary: `the plain summary (1 to ${PROPOSAL_LIMITS.summary} characters)`,
  acceptanceCriteria: `what done means (1 to ${PROPOSAL_LIMITS.criteria} lines of up to ${PROPOSAL_LIMITS.criterion} characters)`,
  size: 'the size',
  tierFloor: 'the tier floor',
  rewardClass: 'the reward',
  choice: 'your vote',
  consent: 'your answer',
  testTimers: 'the switch',
};

/** "the title (...) and the pitch (...)", from `invalid_request`'s fields (or schema paths ending in one). */
function fieldWords(fields: readonly string[] | undefined): string | null {
  if (fields === undefined) return null;
  const words: string[] = [];
  for (const field of fields) {
    const name = field.split(/[./]/).find((part) => Object.hasOwn(FIELD_WORDS, part));
    const word = name === undefined ? undefined : FIELD_WORDS[name];
    if (word !== undefined && !words.includes(word)) words.push(word);
  }
  if (words.length === 0) return null;
  return words.length === 1 ? (words[0] ?? null) : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/** Where a proposal is now, as `wrong_state` says it. */
const STATE_NOW: Readonly<Record<ProposalState, string>> = {
  submitted: 'it is waiting for a second',
  debate: 'it is in debate',
  voting: 'it is in a vote',
  passed: 'it has passed',
  failed: 'it has failed',
  building: 'it is being built',
  shipped: 'it has shipped',
  lapsed: 'it has lapsed',
  withdrawn: 'it was withdrawn',
};

/** `wrong_state`: the proposal moved on before this reached it. A state the web doesn't know is left out. */
function wrongState(action: ProposalAction, state: string | undefined): string {
  const where = state !== undefined && Object.hasOwn(STATE_NOW, state) ? ` (${STATE_NOW[state as ProposalState]})` : '';
  switch (action) {
    case 'edit':
      return `It can't be edited any more${where}: a proposal can only be edited until it is seconded. Nothing changed.`;
    case 'withdraw':
      return `It can't be withdrawn any more${where}: it has been decided. Nothing changed.`;
    case 'second':
      return `It doesn't need a second any more${where}. Nothing changed.`;
    case 'consent':
    case 'object':
      return `Consenting and objecting are closed${where}: they run from the second until debate ends. Nothing changed.`;
    case 'vote':
      return `Voting isn't open on it${where}, so your vote didn't count. Nothing changed.`;
    case 'comment':
      return `Comments are closed${where}: they run from the second until the vote closes.`;
    case 'end_debate':
      return `It isn't in debate any more${where}. Nothing changed.`;
    case 'close_vote':
      return `Its vote isn't open any more${where}. Nothing changed.`;
    case 'save_draft':
    case 'publish':
      return `Its draft task can't change any more${where}. Nothing changed.`;
    default:
      return `It has moved on${where}, so nothing changed. The page shows where it stands now.`;
  }
}

/** Writes one member may make in an hour across the floor (second, consent, object, vote, edit, withdraw). */
const WRITE_LIMIT = 60;

/**
 * Which limit was hit, in the words of that limit. The API names the limit
 * (`limit`): a day's proposals (3), an hour's comments on one proposal (10),
 * an hour's edits to one proposal (10), or an hour's moves on the floor (60).
 */
function rateLimited(action: ProposalAction, retryAfterSeconds: number | undefined, limit: number | undefined): string {
  const wait = retryWords(retryAfterSeconds);
  switch (action) {
    case 'create':
      return `You've brought as many proposals as FORGE allows in a day (${limit ?? 3}). ${wait}`;
    case 'comment':
      return `You've commented on this proposal as often as FORGE allows in an hour (${limit ?? 10}). ${wait}`;
    case 'edit':
      if (limit !== undefined && limit < WRITE_LIMIT) {
        return `You've edited this proposal as often as FORGE allows in an hour (${limit}). ${wait}`;
      }
      break;
    case 'second':
    case 'consent':
    case 'object':
    case 'vote':
    case 'withdraw':
      break;
    default:
      return `You've done that as often as FORGE allows just now. ${wait}`;
  }
  return `You've made as many moves on the floor as FORGE allows in an hour (${limit ?? WRITE_LIMIT}): seconds, consents, objections, votes, edits and withdrawals all count. ${wait}`;
}

/** The sentence for any failure on the Propose screens. Every code in {@link PROPOSAL_ERROR_CODES} has its own. */
export function describeProposalError(failure: string | ProposalFailure, action: ProposalAction = 'load'): string {
  const { code, retryAfterSeconds, state, fields, limit } = typeof failure === 'string' ? { code: failure } : failure;
  switch (code) {
    case 'proposal_not_found':
      return "That proposal isn't there. The link may have a typo in it.";
    case 'wrong_state':
      return wrongState(action, state);
    case 'one_active_proposal':
      return "You already have a proposal on the floor. Once it's decided, you can bring another.";
    case 'already_seconded':
      return "Someone seconded it first, so it's in debate now.";
    case 'already_decided_consent':
      return "You've already consented or objected on this one, and that can't change.";
    case 'not_eligible':
      return 'Only the members counted when it was seconded can consent, object or vote on it, so nothing changed.';
    case 'not_mover':
      return 'Only the member who brought this proposal can do that.';
    case 'own_proposal':
      return "You can't second your own proposal: another member has to.";
    case 'rate_limited':
      return rateLimited(action, retryAfterSeconds, limit);
    case 'proposal_changed':
      return 'The proposal changed since you opened it. Read it again, then second it.';
    case 'test_mode_off':
      return "End debate now and Close the vote now work only while Test timers are on, and they're off. Nothing changed.";
    case 'edit_limit':
      return `A proposal can be edited at most ${limit ?? 20} times, and this one has been. Withdraw it and bring a new one if it needs more. Nothing changed.`;
    case 'tier_not_open':
      return "Tiers above T0 aren't open yet, so publish it as T0. Nothing changed.";
    case 'task_title_needs_letters':
      return 'Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch on GitHub is named after it. Nothing was published.';
    case 'invalid_request': {
      const words = fieldWords(fields);
      if (action === 'publish') {
        return words === null
          ? "The draft task isn't finished, so it wasn't published. Fill in every part, save it, then publish."
          : `The draft task isn't finished, so it wasn't published. Check ${words}, save it, then publish.`;
      }
      return words === null
        ? "FORGE couldn't take that as it was, so nothing was saved. Check what you wrote and try again."
        : `Check ${words}. Nothing was saved.`;
    }
    case 'proposals-disabled':
      return 'Proposals are switched off right now, so nothing changed.';
    case 'admin_only':
      return "Only FORGE's admins can do that.";
    case 'unauthenticated':
      return 'Your sign-in has ended. Sign in again, then try once more.';
    case 'practice_session':
      return "Practice accounts can't do that. Sign in with GitHub to take part.";
    case 'bad_origin':
      return "FORGE refused that because it didn't come from this page. Reload the page and try again.";
    case 'too_large':
    case 'body_too_large':
      return "That's too long to send. Shorten it and try again.";
    case 'service_unreachable':
    case 'not_configured':
      return action === 'load' || action === 'notifications'
        ? "FORGE couldn't reach its service just now. Try again in a minute."
        : "FORGE couldn't reach its service just now, so nothing changed. Try again in a minute.";
    case 'upstream_timeout':
      return "FORGE didn't hear back in time, so it may have gone through. The page now shows where things stand.";
    default:
      return action === 'load' || action === 'notifications'
        ? "That didn't load. Please try again."
        : "That didn't work, so nothing changed. Please try again.";
  }
}

/* --- what members send ----------------------------------------------------------------- */

/** "12 / 100": a counter in the same characters the API counts (`textLength`). */
export function counterText(value: string, max: number): string {
  return `${textLength(value)} / ${max}`;
}

export function overLimit(value: string, max: number): boolean {
  return textLength(value) > max;
}

export type Checked<T, F extends string> = { ok: true; value: T } | { ok: false; errors: Partial<Record<F, string>> };

function lengthProblem(value: string, max: number, what: string, missing: string): string | null {
  const length = textLength(value);
  if (length === 0) return missing;
  return length > max ? `Keep ${what} to ${max} characters (it has ${length}).` : null;
}

/** A new proposal (or an edit) as it will be sent, or what to fix first. */
export function checkProposal(input: { title: string; pitch: string }): Checked<NewProposal, 'title' | 'pitch'> {
  const title = input.title.trim();
  const pitch = input.pitch.trim();
  const errors: Partial<Record<'title' | 'pitch', string>> = {};
  const titleProblem = lengthProblem(title, PROPOSAL_LIMITS.title, 'the title', 'Give it a title.');
  const pitchProblem = lengthProblem(
    pitch,
    PROPOSAL_LIMITS.pitch,
    'the pitch',
    'Say what FORGE should build and why it matters.',
  );
  if (titleProblem !== null) errors.title = titleProblem;
  if (pitchProblem !== null) errors.pitch = pitchProblem;
  return titleProblem === null && pitchProblem === null ? { ok: true, value: { title, pitch } } : { ok: false, errors };
}

/** A comment (or an objection's reason) as it will be sent, or why not. */
export function checkComment(text: string, missing = 'Write something first.'): Checked<string, 'text'> {
  const value = text.trim();
  const problem = lengthProblem(value, PROPOSAL_LIMITS.comment, 'it', missing);
  return problem === null ? { ok: true, value } : { ok: false, errors: { text: problem } };
}

/** The admin's draft-task form: what done means is one line per criterion. */
export interface DraftForm {
  title: string;
  civilianSummary: string;
  criteria: string;
  size: Size;
  tierFloor: TierFloor;
  rewardClass: RewardClass;
}

export type DraftField = 'title' | 'civilianSummary' | 'acceptanceCriteria';

/**
 * The only tier floor a task can be published with for now: every
 * contributor is T0 until the ledger ranks them, so a T1 or T2 task could
 * never be claimed (the API answers `tier_not_open`).
 */
export const OPEN_TIER_FLOOR: TierFloor = 'T0';

export function draftFormOf(draft: DraftTask): DraftForm {
  return {
    title: draft.title,
    civilianSummary: draft.civilianSummary,
    criteria: draft.acceptanceCriteria.join('\n'),
    size: draft.size,
    tierFloor: OPEN_TIER_FLOOR,
    rewardClass: draft.rewardClass,
  };
}

/** The criteria lines that count: each trimmed, blank ones dropped. */
export function criteriaLines(criteria: string): string[] {
  return criteria
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The draft as it will be sent (`DraftTaskRequest`), or what to fix first. */
export function checkDraft(form: DraftForm): Checked<DraftTaskRequest, DraftField> {
  const errors: Partial<Record<DraftField, string>> = {};
  const title = form.title.trim();
  const civilianSummary = form.civilianSummary.trim();
  const lines = criteriaLines(form.criteria);
  const titleProblem = lengthProblem(title, PROPOSAL_LIMITS.title, 'the title', 'Give the task a title.');
  const summaryProblem = lengthProblem(
    civilianSummary,
    PROPOSAL_LIMITS.summary,
    'the summary',
    'Say in plain words what the task is.',
  );
  if (titleProblem !== null) errors.title = titleProblem;
  if (summaryProblem !== null) errors.civilianSummary = summaryProblem;
  const long = lines.findIndex((line) => textLength(line) > PROPOSAL_LIMITS.criterion);
  if (lines.length === 0) {
    errors.acceptanceCriteria = 'Write at least one line saying what done means.';
  } else if (lines.length > PROPOSAL_LIMITS.criteria) {
    errors.acceptanceCriteria = `Keep it to ${PROPOSAL_LIMITS.criteria} lines (it has ${lines.length}).`;
  } else if (long !== -1) {
    errors.acceptanceCriteria = `Line ${long + 1} is too long: keep each line to ${PROPOSAL_LIMITS.criterion} characters.`;
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      title,
      civilianSummary,
      acceptanceCriteria: lines,
      size: form.size,
      tierFloor: OPEN_TIER_FLOOR,
      rewardClass: form.rewardClass,
    },
  };
}

/**
 * Before publishing: the task's branch is named after its title
 * (`task/<id>-<slug>`), so the title needs a letter or digit from A to Z or
 * 0 to 9 (the API's `task_title_needs_letters`). Saving a draft doesn't.
 */
export function publishTitleProblem(title: string): string | null {
  return slugify(title.trim()) === ''
    ? 'Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch on GitHub is named after it.'
    : null;
}

/* --- links ----------------------------------------------------------------------------- */

/** Whitespace, backslashes and control characters: none belongs in a link FORGE shows. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const UNSAFE_PATH = /[\s\\\u0000-\u001F\u007F-\u009F]/;

/**
 * `href` when it is a path on this site ("/propose/12"): one leading slash
 * (never `//host`, which leaves the site), no backslash (a browser reads it
 * as a slash), no whitespace or control characters. Null otherwise, and the
 * bell then shows the item without a link.
 */
export function sitePath(href: string): string | null {
  if (href.length === 0 || href.length > 512 || UNSAFE_PATH.test(href)) return null;
  return /^\/(?!\/)/.test(href) ? href : null;
}

/** "/signin?next=%2Fpropose%2F7": sign in, then come back to `path`. */
export function signInHref(path: string): string {
  return `/signin?${new URLSearchParams({ next: path }).toString()}`;
}

/* --- pages: earlier comments and decided proposals ------------------------------------ */

/**
 * Comments from any number of pages as one thread: each comment once (the
 * later list's copy wins), oldest first. A comment never changes once posted,
 * so whatever has been read stays readable.
 */
export function mergeComments(
  earlier: readonly ProposalComment[],
  later: readonly ProposalComment[],
): ProposalComment[] {
  const byId = new Map<number, ProposalComment>();
  for (const comment of [...earlier, ...later]) byId.set(comment.id, comment);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Cards from the floor's first page and the earlier pages of decided ones:
 * each proposal once (the `fresher` list's copy wins, since its state is the
 * newest), newest first as the API lists them.
 */
export function mergeCards(fresher: readonly ProposalCard[], older: readonly ProposalCard[]): ProposalCard[] {
  const byId = new Map<number, ProposalCard>();
  for (const card of older) byId.set(card.id, card);
  for (const card of fresher) byId.set(card.id, card);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** What the floor shows: the latest first page, and the decided cards from the pages before it. */
export interface FloorList {
  first: ProposalList;
  /** Decided cards beyond the first page, once "Show earlier" has been used. */
  older: readonly ProposalCard[];
  /** Whether even older decided proposals exist; null until an earlier page has been opened. */
  olderMore: boolean | null;
}

/** A new first page (the floor read again), or a page of earlier decided proposals. */
export type FloorChange = { kind: 'first'; list: ProposalList } | { kind: 'older'; page: ProposalList };

/**
 * The floor after `change`. Until earlier pages are opened it is just the
 * first page; once they are, every decided card already shown stays (the
 * newest copy of each), however far the first page moves on.
 */
export function foldFloor(floor: FloorList | null, change: FloorChange): FloorList | null {
  if (change.kind === 'first') {
    if (floor === null || floor.olderMore === null) return { first: change.list, older: [], olderMore: null };
    const previous = floor.first.proposals.filter((card) => !isActive(card.state));
    return { ...floor, first: change.list, older: mergeCards(previous, floor.older) };
  }
  if (floor === null) return floor;
  return { ...floor, older: mergeCards(change.page.proposals, floor.older), olderMore: change.page.moreDecided ?? false };
}

/** The cards the floor shows, each once, newest first. */
export function floorCards(floor: FloorList): ProposalCard[] {
  return mergeCards(floor.first.proposals, floor.older);
}

/** Whether older decided proposals than those shown exist. */
export function floorHasMore(floor: FloorList): boolean {
  return floor.olderMore ?? floor.first.moreDecided ?? false;
}

/** The cursor for the next page of decided proposals: the lowest decided one shown. */
export function decidedCursor(cards: readonly ProposalCard[]): number | null {
  let lowest: number | null = null;
  for (const card of cards) {
    if (!isActive(card.state) && (lowest === null || card.id < lowest)) lowest = card.id;
  }
  return lowest;
}

/* --- did it go through? ---------------------------------------------------------------- */

/** A write, as the page meant it: what it should look like once it went through. */
export type Intent =
  | { action: 'second' | 'consent' | 'object' | 'withdraw' | 'end_debate' | 'close_vote' | 'publish' }
  | { action: 'vote'; choice: VoteChoice }
  | { action: 'comment'; text: string; postedBefore: number }
  | { action: 'edit'; title: string; pitch: string }
  | { action: 'save_draft'; draft: DraftTaskRequest };

/** What a proposal read back after a write says about it (enough of a ProposalDetail). */
export interface ReadBack {
  proposal: Pick<ProposalCard, 'state' | 'title' | 'seconder'>;
  pitch: string;
  comments: readonly Pick<ProposalComment, 'author' | 'text'>[];
  you?: Pick<ProposalYou, 'consent' | 'vote'> | undefined;
  taskId?: number | undefined;
  draft?: (Omit<DraftTask, 'taskId'> & { taskId?: number | undefined }) | undefined;
}

/** How many comments `login` has in `comments` with exactly `text`: a comment went through if this grew. */
export function commentsBy(comments: ReadBack['comments'], login: string | null, text: string): number {
  if (login === null) return 0;
  const who = login.toLowerCase();
  return comments.filter((comment) => comment.author.toLowerCase() === who && comment.text === text).length;
}

function sameDraft(a: Omit<DraftTask, 'taskId'>, b: DraftTaskRequest): boolean {
  return (
    a.title === b.title &&
    a.civilianSummary === b.civilianSummary &&
    a.size === b.size &&
    a.tierFloor === b.tierFloor &&
    a.rewardClass === b.rewardClass &&
    a.acceptanceCriteria.length === b.acceptanceCriteria.length &&
    a.acceptanceCriteria.every((line, index) => line === b.acceptanceCriteria[index])
  );
}

/**
 * After a write whose answer was lost (or refused as already done), the
 * proposal read back says whether it went through: true or false, or null
 * when the read can't tell (it came back without your part, say).
 */
export function wentThrough(intent: Intent, after: ReadBack, login: string | null): boolean | null {
  switch (intent.action) {
    case 'second':
      if (login === null) return null;
      return after.proposal.seconder?.toLowerCase() === login.toLowerCase();
    case 'consent':
      return after.you === undefined ? null : after.you.consent === 'consented';
    case 'object':
      return after.you === undefined ? null : after.you.consent === 'objected';
    case 'vote':
      return after.you === undefined ? null : after.you.vote === intent.choice;
    case 'comment':
      return login === null ? null : commentsBy(after.comments, login, intent.text) > intent.postedBefore;
    case 'edit':
      return after.proposal.title === intent.title && after.pitch === intent.pitch;
    case 'withdraw':
      return after.proposal.state === 'withdrawn';
    case 'end_debate':
      return after.proposal.state !== 'debate';
    case 'close_vote':
      return after.proposal.state !== 'voting';
    case 'save_draft':
      return after.draft === undefined ? null : sameDraft(after.draft, intent.draft);
    case 'publish':
      return after.taskId !== undefined || after.draft?.taskId !== undefined;
  }
}

/** After a lost answer, when the proposal read back says the write didn't go through. */
export function didNotGoThrough(action: ProposalAction): string {
  return action === 'comment'
    ? "It didn't go through: your comment wasn't posted. It's still in the box, so you can send it again."
    : "It didn't go through, so nothing changed. Please try again.";
}
