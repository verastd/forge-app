import { expect, test } from '@playwright/test';

import {
  HOUSE_FAILURE_REASONS,
  HOUSE_OFF_REASONS,
  HOUSE_STATUSES,
  HOUSE_VERDICTS,
  HouseDraftSchema,
  NotificationListSchema,
  PROPOSAL_EVENT_KINDS,
  PROPOSAL_STATES,
  ProposalDetailSchema,
} from '../../packages/shared/dist/index.js';
import type { HouseDraft, HouseSpec, ProposalCard, ProposalDetail, ProposalList } from '../../packages/shared/dist/index.js';
import { HELLO_TIMEOUT_MS, MEMBERS_HELLO_PATH, sayHello } from '../../apps/web/src/app/auth/callback/members-hello';
import { ApiError, RequestError, mayHaveHappened as contributeMayHaveHappened } from '../../apps/web/src/lib/api';
import { formatDate } from '../../apps/web/src/lib/format';
import { Freshness } from '../../apps/web/src/lib/freshness';
import {
  DisplayDetailSchema,
  DisplayNotificationListSchema,
  ProposalRequestError,
  castVote,
  failureOf,
  mayHaveHappened,
  postComment,
  requestHouseDraft,
  secondProposal,
} from '../../apps/web/src/lib/proposals';
import {
  FLOOR_SECTIONS,
  HOUSE_DRAFTS_PER_PROPOSAL,
  HOUSE_FORM_LINE,
  HOUSE_MODEL_SHOWN,
  HOUSE_VERDICT_LABEL,
  HOUSE_VERDICT_TONE,
  OPEN_TIER_FLOOR,
  PROPOSAL_ERROR_CODES,
  checkComment,
  checkDraft,
  checkProposal,
  commentsBy,
  consentLine,
  counterText,
  criteriaLines,
  deadlineLabel,
  decidedCursor,
  describeProposalError,
  didNotGoThrough,
  draftFormKey,
  draftFormOf,
  eventLabel,
  eventText,
  floorCards,
  floorHasMore,
  foldFloor,
  formatTimeLeft,
  groupBySection,
  houseDraftAsked,
  houseDraftedLine,
  houseFormOf,
  houseFormWords,
  housePlace,
  houseStatusLine,
  isActive,
  isAdminEvent,
  isHouseWorking,
  mergeCards,
  mergeComments,
  nextDeadlineRead,
  notReadBack,
  pausedLabel,
  publishTitleProblem,
  quorumLine,
  quorumNeeded,
  sectionOf,
  signInHref,
  sitePath,
  spokenTimeLeft,
  standingLine,
  tallyLines,
  turnoutLine,
  wentThrough,
  yourConsentLine,
} from '../../apps/web/src/lib/proposals-format';
import type { FloorList, ProposalAction, ReadBack } from '../../apps/web/src/lib/proposals-format';
import {
  HOUSE_DRAFTED_MESSAGE,
  PRACTICE_HOUSE_MODEL,
  PRACTICE_ME,
  PRACTICE_MEMBERS,
  PRACTICE_REVISION,
  WALKTHROUGH_ID,
  practiceComment,
  practiceComments,
  practiceConsent,
  practiceDetail,
  practiceFloor,
  practiceHouse,
  practiceList,
  practiceSecond,
  practiceVote,
} from '../../apps/web/src/lib/proposals-offline';
import type { PracticeFloor, PracticeResult } from '../../apps/web/src/lib/proposals-offline';
import { ServerClock } from '../../apps/web/src/lib/server-clock';
import { TICK_MS, subscribeTicker, tickerNow, tickerState } from '../../apps/web/src/lib/ticker';

/**
 * Web unit tests for the Propose screens' pure helpers (Phase 5), run without
 * a browser (project `chromium-demo`), as launch.spec.ts does for the
 * Contribute hand-off: the floor's sections, the countdown, the plain
 * sentence for every error code, the checks on what members send, the bell's
 * link guard, the practice floor's rules, and the sign-in callback's
 * best-effort members hello. Phase 6 adds the house model's words, its
 * lenient reading, "Draft it again" and the practice floor's house draft.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function card(state: (typeof PROPOSAL_STATES)[number], id = 1) {
  return { id, title: `Proposal ${id}`, state, mover: 'maya', movedAt: '2026-10-01T00:00:00Z', commentCount: 0, objectionCount: 0 };
}

test.describe('the floor’s sections', () => {
  test('every state has exactly one section, and the active states are the first three', () => {
    expect(PROPOSAL_STATES.map((state) => sectionOf(state))).toEqual([
      'needs_second',
      'debate',
      'voting',
      'decided',
      'decided',
      'decided',
      'decided',
      'decided',
      'decided',
    ]);
    expect(FLOOR_SECTIONS).toEqual(['needs_second', 'debate', 'voting', 'decided']);
    expect(PROPOSAL_STATES.filter(isActive)).toEqual(['submitted', 'debate', 'voting']);
  });

  test('groupBySection keeps the API’s order inside each section', () => {
    const groups = groupBySection([card('shipped', 9), card('debate', 8), card('submitted', 7), card('failed', 6), card('debate', 5)]);
    expect(groups.needs_second.map((entry) => entry.id)).toEqual([7]);
    expect(groups.debate.map((entry) => entry.id)).toEqual([8, 5]);
    expect(groups.voting).toEqual([]);
    expect(groups.decided.map((entry) => entry.id)).toEqual([9, 6]);
  });
});

test.describe('the countdown', () => {
  test('two units, the larger first, so days and test minutes both read well', () => {
    expect(formatTimeLeft(3 * DAY + 4 * HOUR + 59 * MINUTE)).toBe('3d 04h');
    expect(formatTimeLeft(DAY)).toBe('1d 00h');
    expect(formatTimeLeft(4 * HOUR + 12 * MINUTE + 30 * SECOND)).toBe('4h 12m');
    expect(formatTimeLeft(4 * MINUTE + 9 * SECOND + 900)).toBe('4m 09s');
    expect(formatTimeLeft(999)).toBe('0m 00s');
    expect(formatTimeLeft(0)).toBe('0m 00s');
    expect(formatTimeLeft(-5 * SECOND)).toBe('0m 00s');
    expect(formatTimeLeft(Number.NaN)).toBe('0m 00s');
  });

  test('the spoken copy changes once a day, an hour or a minute, never every second', () => {
    expect(spokenTimeLeft(2 * DAY + 23 * HOUR)).toBe('2 days');
    expect(spokenTimeLeft(DAY + 1)).toBe('1 day');
    expect(spokenTimeLeft(5 * HOUR + 59 * MINUTE)).toBe('5 hours');
    expect(spokenTimeLeft(HOUR)).toBe('1 hour');
    expect(spokenTimeLeft(4 * MINUTE + 59 * SECOND)).toBe('4 minutes');
    expect(spokenTimeLeft(MINUTE)).toBe('1 minute');
    expect(spokenTimeLeft(59 * SECOND)).toBe('less than a minute');
  });

  test('each active state says what its deadline is for, and when it has passed', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const inTwoDays = new Date(now + 2 * DAY + 4 * HOUR).toISOString();
    expect(deadlineLabel('submitted', inTwoDays, now)).toBe('Needs a second within 2d 04h');
    expect(deadlineLabel('debate', inTwoDays, now)).toBe('Debate ends in 2d 04h');
    expect(deadlineLabel('voting', inTwoDays, now)).toBe('Voting closes in 2d 04h');
    expect(deadlineLabel('debate', inTwoDays, now, 'spoken')).toBe('Debate ends in 2 days');
    const past = new Date(now - SECOND).toISOString();
    expect(deadlineLabel('submitted', past, now)).toBe('The time to second it is up');
    expect(deadlineLabel('debate', past, now)).toBe('Debate time is up');
    expect(deadlineLabel('voting', past, now)).toBe('Voting time is up');
    // Nothing to count down: decided states, no deadline, or one that isn't a date.
    expect(deadlineLabel('passed', inTwoDays, now)).toBeNull();
    expect(deadlineLabel('debate', undefined, now)).toBeNull();
    expect(deadlineLabel('debate', 'soon', now)).toBeNull();
  });
});

test.describe('consent, turnout, tally and where it stands', () => {
  const debate = (consentCount: number, eligibleCount: number, objectionCount = 0) => ({
    proposal: { ...card('debate'), objectionCount },
    consentCount,
    eligibleCount,
  });

  test('consent progress until the first objection, then the vote to come', () => {
    expect(consentLine(debate(4, 6))).toBe('4 of 6 have consented.');
    expect(consentLine(debate(1, 6))).toBe('1 of 6 has consented.');
    expect(consentLine(debate(4, 6, 1))).toBe('Objected: this goes to a vote after debate.');
    expect(consentLine({ proposal: card('debate') })).toBeNull();
    expect(consentLine({ ...debate(4, 6), proposal: card('voting') })).toBeNull();
  });

  test('where you stand on consent: what it means during debate, a record afterwards', () => {
    expect(yourConsentLine(undefined, 'debate', false)).toBeNull();
    expect(yourConsentLine('consented', 'debate', false)).toBe('You consented.');
    expect(yourConsentLine('consented', 'debate', true)).toBe('You brought it, so you count as consenting.');
    expect(yourConsentLine('objected', 'debate', false)).toBe('You objected, so it goes to a vote after debate.');
    expect(yourConsentLine('consented', 'voting', false)).toBe('You consented during debate.');
    expect(yourConsentLine('objected', 'passed', false)).toBe('You objected during debate.');
    // The mover's automatic consent needs no saying once debate is over.
    expect(yourConsentLine('consented', 'voting', true)).toBeNull();
  });

  test('turnout during voting only', () => {
    expect(turnoutLine({ proposal: card('voting'), turnout: 3, eligibleCount: 5 })).toBe('3 of 5 have voted.');
    expect(turnoutLine({ proposal: card('voting'), turnout: 1, eligibleCount: 5 })).toBe('1 of 5 has voted.');
    expect(turnoutLine({ proposal: card('passed'), turnout: 3, eligibleCount: 5 })).toBeNull();
  });

  test('the tally: quorum is a majority of the eligible set, Yes must beat No, a tie fails', () => {
    expect(quorumNeeded(5)).toBe(3);
    expect(quorumNeeded(6)).toBe(4);
    expect(tallyLines({ yes: 3, no: 1, abstain: 1, eligible: 6, quorumMet: true })).toEqual({
      counts: 'Yes 3 · No 1 · Abstain 1',
      quorum: 'Quorum met: 5 of 6 voted.',
      result: 'More Yes than No, so it passed.',
    });
    expect(tallyLines({ yes: 2, no: 2, abstain: 0, eligible: 4, quorumMet: true }).result).toBe('A tie, so it failed.');
    expect(tallyLines({ yes: 1, no: 2, abstain: 0, eligible: 4, quorumMet: true }).result).toBe('More No than Yes, so it failed.');
    const short = tallyLines({ yes: 2, no: 0, abstain: 0, eligible: 6, quorumMet: false });
    expect(short.quorum).toBe('No quorum: 2 of 6 voted, and it needed 4.');
    expect(short.result).toBe('Without quorum, it failed.');
  });

  test('every state has a sentence, and a shipped one says its lobby panel is still added by hand', () => {
    for (const state of PROPOSAL_STATES) {
      expect(standingLine({ proposal: card(state) }).length, state).toBeGreaterThan(10);
    }
    expect(standingLine({ proposal: card('shipped') })).toContain('panel in the lobby is still added by hand');
    expect(standingLine({ proposal: card('passed') })).toContain('without a vote');
    expect(standingLine({ proposal: card('passed'), tally: { yes: 2, no: 1, abstain: 0, eligible: 3, quorumMet: true } })).toContain(
      'passed the vote',
    );
  });
});

test.describe('the error map', () => {
  const ACTIONS: ProposalAction[] = [
    'load',
    'create',
    'edit',
    'withdraw',
    'second',
    'consent',
    'object',
    'comment',
    'vote',
    'end_debate',
    'close_vote',
    'save_draft',
    'publish',
    'house_draft',
    'settings',
    'notifications',
  ];

  test('every code the contract names has its own sentence, never the generic one', () => {
    const generic = new Set([describeProposalError('something_new', 'second'), describeProposalError('something_new', 'load')]);
    for (const code of PROPOSAL_ERROR_CODES) {
      for (const action of ACTIONS) {
        const sentence = describeProposalError(code, action);
        expect(generic.has(sentence), `${code} on ${action}`).toBe(false);
        expect(sentence, `${code} on ${action}`).toMatch(/^[A-Z].*[.!]$/);
      }
    }
  });

  test('the sentences the floor relies on', () => {
    expect(describeProposalError('own_proposal', 'second')).toBe("You can't second your own proposal: another member has to.");
    expect(describeProposalError('already_seconded', 'second')).toBe("Someone seconded it first, so it's in debate now.");
    expect(describeProposalError('one_active_proposal', 'create')).toBe(
      "You already have a proposal on the floor. Once it's decided, you can bring another.",
    );
    expect(describeProposalError('not_mover', 'edit')).toBe('Only the member who brought this proposal can do that.');
    expect(describeProposalError('already_decided_consent', 'consent')).toBe(
      "You've already consented or objected on this one, and that can't change.",
    );
    expect(describeProposalError('practice_session', 'create')).toBe("Practice accounts can't do that. Sign in with GitHub to take part.");
    expect(describeProposalError('admin_only', 'end_debate')).toBe("Only FORGE's admins can do that.");
    expect(describeProposalError('proposals-disabled', 'vote')).toBe('Proposals are switched off right now, so nothing changed.');
  });

  test('wrong_state says what the action ran into, and the state when the API names it', () => {
    expect(describeProposalError({ code: 'wrong_state', state: 'debate' }, 'edit')).toBe(
      "It can't be edited any more (it is in debate): a proposal can only be edited until it is seconded. Nothing changed.",
    );
    expect(describeProposalError({ code: 'wrong_state', state: 'passed' }, 'vote')).toBe(
      "Voting isn't open on it (it has passed), so your vote didn't count. Nothing changed.",
    );
    expect(describeProposalError({ code: 'wrong_state', state: 'voting' }, 'consent')).toBe(
      'Consenting and objecting are closed (it is in a vote): they run from the second until debate ends. Nothing changed.',
    );
    expect(describeProposalError({ code: 'wrong_state' }, 'withdraw')).toBe(
      "It can't be withdrawn any more: it has been decided. Nothing changed.",
    );
    // A state the web doesn't know is left out rather than shown.
    expect(describeProposalError({ code: 'wrong_state', state: '<b>new</b>' }, 'second')).toBe(
      "It doesn't need a second any more. Nothing changed.",
    );
  });

  test('rate limits say how long to wait, in the words of the limit that was hit', () => {
    expect(describeProposalError({ code: 'rate_limited', retryAfterSeconds: 3 * 3600 }, 'create')).toBe(
      "You've brought as many proposals as FORGE allows in a day (3). Try again in about 3 hours.",
    );
    expect(describeProposalError({ code: 'rate_limited', retryAfterSeconds: 61 }, 'comment')).toBe(
      "You've commented on this proposal as often as FORGE allows in an hour (10). Try again in about 2 minutes.",
    );
    expect(describeProposalError({ code: 'rate_limited' }, 'edit')).toBe(
      "You've made as many moves on the floor as FORGE allows in an hour (60): seconds, consents, objections, votes, edits and withdrawals all count. Wait a little, then try again.",
    );
    // The API names the limit it hit: an hour's edits to one proposal, or an hour's moves on the floor.
    expect(describeProposalError({ code: 'rate_limited', limit: 10, retryAfterSeconds: 300 }, 'edit')).toBe(
      "You've edited this proposal as often as FORGE allows in an hour (10). Try again in about 5 minutes.",
    );
    for (const action of ['second', 'consent', 'object', 'vote', 'withdraw', 'edit'] as const) {
      expect(describeProposalError({ code: 'rate_limited', limit: 60, retryAfterSeconds: 3600 }, action), action).toBe(
        "You've made as many moves on the floor as FORGE allows in an hour (60): seconds, consents, objections, votes, edits and withdrawals all count. Try again in about 60 minutes.",
      );
    }
    expect(describeProposalError({ code: 'rate_limited' }, 'end_debate')).toBe(
      "You've done that as often as FORGE allows just now. Wait a little, then try again.",
    );
  });

  test('the codes F5a added each say what happened, in the page’s own words', () => {
    expect(describeProposalError({ code: 'proposal_changed', revision: 2 }, 'second')).toBe(
      'The proposal changed since you opened it. Read it again, then second it.',
    );
    expect(describeProposalError('test_mode_off', 'end_debate')).toBe(
      "End debate now and Close the vote now work only while Test timers are on, and they're off. Nothing changed.",
    );
    expect(describeProposalError({ code: 'edit_limit', limit: 20 }, 'edit')).toBe(
      'A proposal can be edited at most 20 times, and this one has been. Withdraw it and bring a new one if it needs more. Nothing changed.',
    );
    expect(describeProposalError('tier_not_open', 'publish')).toBe("Tiers above T0 aren't open yet, so publish it as T0. Nothing changed.");
    expect(describeProposalError('task_title_needs_letters', 'publish')).toBe(
      'Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch on GitHub is named after it. Nothing was published.',
    );
  });

  test('invalid_request names the fields it knows, with their limits', () => {
    expect(describeProposalError({ code: 'invalid_request', fields: ['title', 'pitch'] }, 'create')).toBe(
      'Check the title (1 to 100 characters) and the pitch (1 to 4000 characters). Nothing was saved.',
    );
    expect(describeProposalError({ code: 'invalid_request', fields: ['body.text'] }, 'comment')).toBe(
      'Check the comment (1 to 2000 characters). Nothing was saved.',
    );
    expect(describeProposalError({ code: 'invalid_request', fields: ['acceptanceCriteria'] }, 'publish')).toBe(
      "The draft task isn't finished, so it wasn't published. Check what done means (1 to 10 lines of up to 300 characters), save it, then publish.",
    );
    expect(describeProposalError({ code: 'invalid_request', fields: ['constructor', 'mystery'] }, 'create')).toBe(
      "FORGE couldn't take that as it was, so nothing was saved. Check what you wrote and try again.",
    );
  });

  test('no answer is not a "no"; an unreachable service is', () => {
    expect(describeProposalError('upstream_timeout', 'second')).toContain('it may have gone through');
    expect(describeProposalError('service_unreachable', 'second')).toContain('so nothing changed');
    expect(describeProposalError('service_unreachable', 'load')).not.toContain('nothing changed');
  });
});

test.describe('what members send', () => {
  test('a proposal: trimmed, and counted in characters the way the API counts them', () => {
    expect(checkProposal({ title: '  A map view  ', pitch: '\nPins on a map.\n\n' })).toEqual({
      ok: true,
      value: { title: 'A map view', pitch: 'Pins on a map.' },
    });
    expect(checkProposal({ title: '   ', pitch: '' })).toEqual({
      ok: false,
      errors: { title: 'Give it a title.', pitch: 'Say what FORGE should build and why it matters.' },
    });
    // 100 astral characters are 200 UTF-16 units, and still within the limit.
    expect(checkProposal({ title: '🏛'.repeat(100), pitch: 'x' }).ok).toBe(true);
    expect(checkProposal({ title: '🏛'.repeat(101), pitch: 'x' })).toEqual({
      ok: false,
      errors: { title: 'Keep the title to 100 characters (it has 101).' },
    });
    expect(checkProposal({ title: 'A', pitch: 'y'.repeat(4001) })).toEqual({
      ok: false,
      errors: { pitch: 'Keep the pitch to 4000 characters (it has 4001).' },
    });
    expect(counterText('🏛🏛 ok', 100)).toBe('5 / 100');
  });

  test('a comment, and an objection’s reason', () => {
    expect(checkComment('  fair point  ')).toEqual({ ok: true, value: 'fair point' });
    expect(checkComment(' ')).toEqual({ ok: false, errors: { text: 'Write something first.' } });
    expect(checkComment('', 'Say why.')).toEqual({ ok: false, errors: { text: 'Say why.' } });
    expect(checkComment('z'.repeat(2001))).toEqual({ ok: false, errors: { text: 'Keep it to 2000 characters (it has 2001).' } });
  });

  test('the draft task: what done means is one line per criterion, 1 to 10 of them', () => {
    const form = draftFormOf({
      title: 'Map view',
      civilianSummary: 'Pins on a map',
      acceptanceCriteria: ['Pins show', 'Filters work'],
      size: 'S',
      tierFloor: 'T0',
      rewardClass: 'none',
    });
    expect(form.criteria).toBe('Pins show\nFilters work');
    expect(criteriaLines(' a \n\n b\r\n  ')).toEqual(['a', 'b']);
    expect(checkDraft(form)).toEqual({
      ok: true,
      value: {
        title: 'Map view',
        civilianSummary: 'Pins on a map',
        acceptanceCriteria: ['Pins show', 'Filters work'],
        size: 'S',
        tierFloor: 'T0',
        rewardClass: 'none',
      },
    });
    expect(checkDraft({ ...form, criteria: '  \n ' })).toEqual({
      ok: false,
      errors: { acceptanceCriteria: 'Write at least one line saying what done means.' },
    });
    expect(checkDraft({ ...form, criteria: Array.from({ length: 11 }, (_, index) => `line ${index}`).join('\n') })).toEqual({
      ok: false,
      errors: { acceptanceCriteria: 'Keep it to 10 lines (it has 11).' },
    });
    expect(checkDraft({ ...form, criteria: `ok\n${'c'.repeat(301)}` })).toEqual({
      ok: false,
      errors: { acceptanceCriteria: 'Line 2 is too long: keep each line to 300 characters.' },
    });
    // Tiers above T0 aren't open: a draft stored as T1 is sent as T0.
    expect(OPEN_TIER_FLOOR).toBe('T0');
    const stored = draftFormOf({ title: 'Map view', civilianSummary: 'Pins', acceptanceCriteria: ['Pins show'], size: 'M', tierFloor: 'T2', rewardClass: 'R1' });
    expect(stored.tierFloor).toBe('T0');
    expect(checkDraft({ ...stored, tierFloor: 'T1' })).toMatchObject({ ok: true, value: { tierFloor: 'T0' } });
    // A task's branch is named after its title, so publishing needs a letter or digit from A to Z or 0 to 9.
    expect(publishTitleProblem('ダークモード')).toBe(
      'Give the task a title with a letter or a digit from A to Z or 0 to 9: its branch on GitHub is named after it.',
    );
    expect(publishTitleProblem('  🌙  ')).not.toBeNull();
    expect(publishTitleProblem('ダークモード: dark mode')).toBeNull();
    // The pitch starts as the summary, so a long one has to be cut down before it can be published.
    expect(checkDraft({ ...form, title: '', civilianSummary: 's'.repeat(4000) })).toEqual({
      ok: false,
      errors: {
        title: 'Give the task a title.',
        civilianSummary: 'Keep the summary to 500 characters (it has 4000).',
      },
    });
  });
});

test.describe('links and the timeline', () => {
  test('the bell links only to paths on this site', () => {
    expect(sitePath('/propose/12')).toBe('/propose/12');
    expect(sitePath('/propose/12#debate-title')).toBe('/propose/12#debate-title');
    for (const href of [
      '',
      'propose/12',
      '//evil.example/propose',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '/propose/12 ',
      '/propose/\n12',
      `/${'a'.repeat(600)}`,
    ]) {
      expect(sitePath(href), JSON.stringify(href)).toBeNull();
    }
  });

  test('sign-in links come back to where they were', () => {
    expect(signInHref('/propose/new')).toBe('/signin?next=%2Fpropose%2Fnew');
  });

  test('a timeline line names who did it only when the API’s sentence doesn’t', () => {
    expect(eventText({ message: 'maya seconded it, so debate is open.', actor: 'maya' })).toBe('maya seconded it, so debate is open.');
    expect(eventText({ message: 'Debate ended.', actor: 'octo-admin' })).toBe('Debate ended. (by octo-admin)');
    expect(eventText({ message: 'The vote closed.' })).toBe('The vote closed.');
    expect(isAdminEvent('admin_ended_debate')).toBe(true);
    expect(isAdminEvent('test_timers_on')).toBe(true);
    expect(isAdminEvent('seconded')).toBe(false);
    // The pause lines are nobody's doing, and a kind this build doesn't know is a plain line.
    expect(isAdminEvent('floor_paused')).toBe(false);
    expect(isAdminEvent('floor_resumed')).toBe(false);
    expect(isAdminEvent('proposal_archived')).toBe(false);
  });
});

test.describe('the practice floor', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z');

  function settled(result: PracticeResult): { floor: PracticeFloor; detail: ProposalDetail } {
    if (!result.ok) throw new Error(`practice refused: ${result.code}`);
    return result;
  }

  test('three samples, newest first: one needs a second, one is in debate, one passed by a vote', () => {
    const floor = practiceFloor(NOW);
    const list = practiceList(floor);
    expect(list.testTimers).toBe(false);
    expect(list.proposals.map((entry) => [entry.id, entry.state])).toEqual([
      [3, 'submitted'],
      [2, 'debate'],
      [1, 'passed'],
    ]);
    expect(Date.parse(list.proposals[0]?.deadline ?? '')).toBeGreaterThan(NOW);
    expect(practiceDetail(floor, 1, true)?.tally).toEqual({ yes: 2, no: 1, abstain: 0, eligible: 3, quorumMet: true });
    // `you` only for the signed-in practice account, as the API gives it only to identified callers.
    expect(practiceDetail(floor, 2, false)?.you).toBeUndefined();
    expect(practiceDetail(floor, 2, true)?.you).toMatchObject({ canConsent: true, canComment: true, isAdmin: false });
    expect(practiceDetail(floor, 404, true)).toBeNull();
  });

  test('the walk-through: second it, consent, and it passes, as the rules say', () => {
    let floor = practiceFloor(NOW);
    expect(practiceDetail(floor, WALKTHROUGH_ID, true)?.you).toMatchObject({ canSecond: true, canConsent: false });

    expect(practiceDetail(floor, WALKTHROUGH_ID, true)?.revision).toBe(PRACTICE_REVISION);
    // A second names the text it read: any other revision is refused, as the API refuses it.
    expect(practiceSecond(floor, WALKTHROUGH_ID, PRACTICE_REVISION + 1, NOW)).toEqual({
      ok: false,
      status: 409,
      code: 'proposal_changed',
      revision: PRACTICE_REVISION,
    });
    const seconded = settled(practiceSecond(floor, WALKTHROUGH_ID, PRACTICE_REVISION, NOW + MINUTE));
    floor = seconded.floor;
    expect(seconded.detail.proposal).toMatchObject({ state: 'debate', seconder: PRACTICE_ME });
    expect(Date.parse(seconded.detail.proposal.deadline ?? '') - (NOW + MINUTE)).toBe(3 * DAY);
    // The eligible set is every member the practice floor knows, frozen at the second.
    expect(seconded.detail.eligibleCount).toBe(PRACTICE_MEMBERS.length);
    expect(seconded.detail.consentCount).toBe(3);
    expect(consentLine(seconded.detail)).toBe('3 of 4 have consented.');
    expect(seconded.detail.you).toMatchObject({ canSecond: false, canConsent: true });

    const passed = settled(practiceConsent(floor, WALKTHROUGH_ID, true, NOW + 2 * MINUTE));
    expect(passed.detail.proposal.state).toBe('passed');
    expect(passed.detail.proposal.deadline).toBeUndefined();
    expect(passed.detail.you).toMatchObject({ consent: 'consented', canConsent: false, canComment: false });
    expect(passed.detail.events.map((entry) => entry.kind).slice(-5)).toEqual([
      'consented',
      'consented',
      'passed',
      'task_drafted',
      'house_drafted',
    ]);
  });

  test('objecting is final and sends it to a vote after debate; the rules refuse the rest', () => {
    const floor = practiceFloor(NOW);
    const objected = settled(practiceConsent(floor, 2, false, NOW));
    expect(objected.detail.proposal).toMatchObject({ state: 'debate', objectionCount: 1 });
    expect(consentLine(objected.detail)).toBe('Objected: this goes to a vote after debate.');
    expect(practiceConsent(objected.floor, 2, true, NOW)).toEqual({ ok: false, status: 409, code: 'already_decided_consent' });

    expect(practiceSecond(floor, 2, PRACTICE_REVISION, NOW)).toEqual({ ok: false, status: 409, code: 'already_seconded' });
    expect(practiceSecond(floor, 1, PRACTICE_REVISION, NOW)).toEqual({ ok: false, status: 409, code: 'already_seconded' });
    expect(practiceConsent(floor, 1, true, NOW)).toEqual({ ok: false, status: 409, code: 'wrong_state', state: 'passed' });
    expect(practiceConsent(floor, WALKTHROUGH_ID, true, NOW)).toEqual({
      ok: false,
      status: 409,
      code: 'wrong_state',
      state: 'submitted',
    });
    expect(practiceVote(floor, 2, 'yes', NOW)).toEqual({ ok: false, status: 409, code: 'wrong_state', state: 'debate' });
    expect(practiceSecond(floor, 99, PRACTICE_REVISION, NOW)).toEqual({ ok: false, status: 404, code: 'proposal_not_found' });
  });

  test('the practice floor pages like the API: decided proposals below a cursor, comments before one', () => {
    const floor = practiceFloor(NOW);
    expect(practiceList(floor, 3).proposals.map((entry) => entry.id)).toEqual([1]);
    expect(practiceList(floor, 1).proposals).toEqual([]);
    expect(practiceComments(floor, 2, 4)).toEqual({ comments: [practiceDetail(floor, 2, false)?.comments[0]], moreComments: false });
    expect(practiceComments(floor, 2, 3)).toEqual({ comments: [], moreComments: false });
    expect(practiceComments(floor, 99, 3)).toBeNull();
  });

  test('comments run from the second until the vote closes', () => {
    const floor = practiceFloor(NOW);
    const commented = settled(practiceComment(floor, 2, 'A practice comment.', NOW));
    expect(commented.detail.comments.at(-1)).toMatchObject({ author: PRACTICE_ME, text: 'A practice comment.' });
    expect(commented.floor.nextCommentId).toBe(floor.nextCommentId + 1);
    expect(practiceComment(floor, WALKTHROUGH_ID, 'Too early.', NOW)).toMatchObject({ ok: false, code: 'wrong_state' });
    expect(practiceComment(floor, 1, 'Too late.', NOW)).toMatchObject({ ok: false, code: 'wrong_state' });
  });
});

test.describe('the sign-in callback’s members hello', () => {
  const MEMBER = { sub: '5100001', login: 'octo-member' };

  test('one try, to /api/members/hello, as the member, within 3 seconds', async () => {
    const calls: Array<[string, unknown, number]> = [];
    const outcome = await sayHello(MEMBER, async (path, member, timeoutMs) => {
      calls.push([path, member, timeoutMs]);
      return { ok: true };
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual([[MEMBERS_HELLO_PATH, MEMBER, HELLO_TIMEOUT_MS]]);
    expect(MEMBERS_HELLO_PATH).toBe('/api/members/hello');
    expect(HELLO_TIMEOUT_MS).toBe(3000);
  });

  test('a failure is only an outcome to log: never a retry, never a throw', async () => {
    let tries = 0;
    expect(
      await sayHello(MEMBER, async () => {
        tries += 1;
        return { ok: false, code: 'upstream_timeout' };
      }),
    ).toEqual({ ok: false, code: 'upstream_timeout' });
    expect(
      await sayHello(MEMBER, async () => {
        tries += 1;
        throw new Error('boom');
      }),
    ).toEqual({ ok: false, code: 'unexpected' });
    expect(tries).toBe(2);
  });
});

/* --- F5b: the fixes for the Phase 5 reviews ----------------------------------------------- */

/** A stand-in for `fetch` while `run` goes: each call is answered by `answer`, and recorded. */
async function withFetch<T>(
  answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  run: (calls: Array<{ url: string; init: RequestInit | undefined }>) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  const demo = process.env.NEXT_PUBLIC_FORGE_DEMO;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  delete process.env.NEXT_PUBLIC_FORGE_DEMO;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
    if (demo === undefined) delete process.env.NEXT_PUBLIC_FORGE_DEMO;
    else process.env.NEXT_PUBLIC_FORGE_DEMO = demo;
  }
}

async function failureFrom(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (error) {
    return error;
  }
  throw new Error('the write went through');
}

const DETAIL: ProposalDetail = {
  proposal: { id: 7, title: 'Map', state: 'submitted', mover: 'maya', movedAt: '2026-10-01T00:00:00Z', commentCount: 0, objectionCount: 0 },
  pitch: 'Pins.',
  comments: [],
  events: [{ at: '2026-10-01T00:00:00Z', kind: 'moved', actor: 'maya', message: 'maya brought this proposal.' }],
  revision: 3,
};

test.describe('L3 (pages) · a kind the web doesn’t know yet never takes a page down', () => {
  test('the timeline and the bell read any kind; everything else stays the contract', () => {
    const withNewKind = { ...DETAIL, events: [...DETAIL.events, { at: '2026-10-02T00:00:00Z', kind: 'proposal_archived', message: 'It was archived.' }] };
    // The contract itself stays strict: the API must not send it…
    expect(ProposalDetailSchema.safeParse(withNewKind).success).toBe(false);
    // …but the page shows it, as the plain line it is.
    const shown = DisplayDetailSchema.safeParse(withNewKind);
    expect(shown.success && shown.data.events.map((entry) => [entry.kind, eventText(entry)])).toEqual([
      ['moved', 'maya brought this proposal.'],
      ['proposal_archived', 'It was archived.'],
    ]);
    // F5a's two new kinds are in the contract now, and a state is still checked strictly.
    for (const kind of ['floor_paused', 'floor_resumed']) {
      expect(ProposalDetailSchema.safeParse({ ...DETAIL, events: [{ at: DETAIL.events[0]?.at, kind, message: 'x' }] }).success, kind).toBe(true);
    }
    expect(DisplayDetailSchema.safeParse({ ...DETAIL, proposal: { ...DETAIL.proposal, state: 'archived' } }).success).toBe(false);

    const bell = {
      notifications: [
        { id: 9, kind: 'proposal_withdrawn', message: '“Map” was withdrawn.', href: '/propose/7', at: '2026-10-02T00:00:00Z', read: false },
        { id: 8, kind: 'vote_opened', message: 'Voting is open on “Map”.', href: '/propose/7', at: '2026-10-01T00:00:00Z', read: false },
      ],
      unread: 2,
    };
    expect(NotificationListSchema.safeParse(bell).success).toBe(false);
    expect(DisplayNotificationListSchema.safeParse(bell).success).toBe(true);
  });

  test('a page whose timeline has a new kind loads; a write answered with one is shown, not read again', async () => {
    const withNewKind = { ...DETAIL, events: [...DETAIL.events, { at: '2026-10-02T00:00:00Z', kind: 'proposal_archived', message: 'x' }] };
    const after = await withFetch(
      () => Response.json(withNewKind),
      () => postComment(7, 'hi'),
    );
    expect(after?.events.at(-1)?.kind).toBe('proposal_archived');
  });
});

test.describe('L1 (pages) · a 5xx without an error code may have gone through', () => {
  test('the host’s error page is "may have happened"; a refusal that names its code is not', async () => {
    const cases: Array<[string, () => Response, boolean, string]> = [
      ['a 504 timeout page (text/plain)', () => new Response('FUNCTION_INVOCATION_TIMEOUT', { status: 504, headers: { 'content-type': 'text/plain' } }), true, 'http_504'],
      ['a 502 HTML page', () => new Response('<h1>502 Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }), true, 'http_502'],
      ['a 500 crash with JSON but no code', () => Response.json({ detail: 'Internal Server Error' }, { status: 500 }), true, 'http_500'],
      ['the BFF’s 504 upstream_timeout', () => Response.json({ error: 'upstream_timeout' }, { status: 504 }), true, 'upstream_timeout'],
      ['the BFF’s 502 service_unreachable', () => Response.json({ error: 'service_unreachable' }, { status: 502 }), false, 'service_unreachable'],
      ['the BFF’s 503 not_configured', () => Response.json({ error: 'not_configured' }, { status: 503 }), false, 'not_configured'],
      ['a 404 page with no code', () => new Response('<h1>Not found</h1>', { status: 404 }), false, 'http_404'],
      ['a 409 refusal', () => Response.json({ error: 'wrong_state', state: 'debate' }, { status: 409 }), false, 'wrong_state'],
    ];
    for (const [name, answer, may, code] of cases) {
      const error = await withFetch(answer, () => failureFrom(() => postComment(7, 'Pins should cluster.')));
      expect(mayHaveHappened(error), name).toBe(may);
      expect(failureOf(error).code, name).toBe(code);
    }
    expect(mayHaveHappened(new ProposalRequestError('x', undefined, { code: 'service_unreachable' }))).toBe(true);
    expect(mayHaveHappened(new Error('not ours'))).toBe(false);
  });

  test('Contribute’s writes classify a codeless 5xx the same way (one shared helper)', () => {
    expect(contributeMayHaveHappened(new RequestError('/bff/bridge/claim', 'responded with 502', 502))).toBe(true);
    expect(contributeMayHaveHappened(new RequestError('/bff/bridge/claim', 'responded with 500', 500))).toBe(true);
    expect(contributeMayHaveHappened(new RequestError('/bff/bridge/claim', 'did not answer'))).toBe(true);
    expect(contributeMayHaveHappened(new RequestError('/bff/bridge/claim', 'responded with 404', 404))).toBe(false);
    expect(contributeMayHaveHappened(new ApiError('/bff/bridge/claim', 502, 'service_unreachable'))).toBe(false);
    expect(contributeMayHaveHappened(new ApiError('/bff/bridge/claim', 504, 'upstream_timeout'))).toBe(true);
  });

  test('after a lost answer, the proposal read back says whether it went through', () => {
    const back = (overrides: Partial<ReadBack> = {}): ReadBack => ({
      proposal: { state: 'debate', title: 'Map', seconder: 'octo-member' },
      pitch: 'Pins.',
      comments: [{ author: 'jo', text: 'Fine.' }],
      ...overrides,
    });
    // P14b: the 502 came after the API took the second; the read shows who seconded it.
    expect(wentThrough({ action: 'second' }, back(), 'Octo-Member')).toBe(true);
    expect(wentThrough({ action: 'second' }, back({ proposal: { state: 'debate', title: 'Map', seconder: 'jo' } }), 'octo-member')).toBe(false);
    // P14a: a comment went through if there is one more of yours with that text than before.
    const posted = back({ comments: [{ author: 'jo', text: 'Fine.' }, { author: 'octo-member', text: 'Cluster the pins.' }] });
    expect(commentsBy(posted.comments, 'octo-member', 'Cluster the pins.')).toBe(1);
    expect(wentThrough({ action: 'comment', text: 'Cluster the pins.', postedBefore: 0 }, posted, 'octo-member')).toBe(true);
    expect(wentThrough({ action: 'comment', text: 'Cluster the pins.', postedBefore: 1 }, posted, 'octo-member')).toBe(false);
    // Without your part, consent and votes can't be told: the page says it may have gone through.
    expect(wentThrough({ action: 'consent' }, back(), 'octo-member')).toBeNull();
    expect(wentThrough({ action: 'consent' }, back({ you: { consent: 'consented' } }), 'octo-member')).toBe(true);
    expect(wentThrough({ action: 'object' }, back({ you: { consent: 'consented' } }), 'octo-member')).toBe(false);
    expect(wentThrough({ action: 'vote', choice: 'no' }, back({ you: { vote: 'no' } }), 'octo-member')).toBe(true);
    expect(wentThrough({ action: 'edit', title: 'Map', pitch: 'Pins.' }, back(), 'octo-member')).toBe(true);
    expect(wentThrough({ action: 'withdraw' }, back(), 'octo-member')).toBe(false);
    expect(wentThrough({ action: 'end_debate' }, back({ proposal: { state: 'voting', title: 'Map' } }), 'x')).toBe(true);
    expect(wentThrough({ action: 'close_vote' }, back({ proposal: { state: 'voting', title: 'Map' } }), 'x')).toBe(false);
    expect(wentThrough({ action: 'publish' }, back({ taskId: 10001 }), 'x')).toBe(true);
    const draft = { title: 'Map', civilianSummary: 'Pins.', acceptanceCriteria: ['Pins show'], size: 'S' as const, tierFloor: 'T0' as const, rewardClass: 'none' as const };
    expect(wentThrough({ action: 'save_draft', draft }, back({ draft }), 'x')).toBe(true);
    expect(wentThrough({ action: 'save_draft', draft }, back({ draft: { ...draft, acceptanceCriteria: [] } }), 'x')).toBe(false);
    expect(didNotGoThrough('comment')).toContain("It's still in the box");
    expect(didNotGoThrough('second')).toBe("It didn't go through, so nothing changed. Please try again.");
  });
});

test.describe('L3 (rules) · a second is tied to the text it read', () => {
  test('Second sends the revision on screen, and proposal_changed is said and read again', async () => {
    const sent = await withFetch(
      () => Response.json(DETAIL),
      async (calls) => {
        await secondProposal(7, 3);
        return calls.map((call) => [call.url, call.init?.method, call.init?.body]);
      },
    );
    expect(sent).toEqual([['/bff/proposals/7/second', 'POST', JSON.stringify({ revision: 3 })]]);
    const changed = await withFetch(
      () => Response.json({ error: 'proposal_changed', message: 'The API’s own words.', revision: 4 }, { status: 409 }),
      () => failureFrom(() => secondProposal(7, 3)),
    );
    expect(failureOf(changed)).toEqual({ code: 'proposal_changed', revision: 4 });
    expect(describeProposalError(failureOf(changed), 'second')).toBe('The proposal changed since you opened it. Read it again, then second it.');
  });

  test('a refusal’s limit is kept, so the page can name the limit that was hit', async () => {
    const error = await withFetch(
      () => Response.json({ error: 'rate_limited', retryAfter: 1200, limit: 60 }, { status: 429, headers: { 'retry-after': '1200' } }),
      () => failureFrom(() => castVote(7, 'yes')),
    );
    expect(failureOf(error)).toEqual({ code: 'rate_limited', retryAfterSeconds: 1200, limit: 60 });
  });
});

test.describe('L5 (pages) · countdowns run on the server’s clock', () => {
  const SERVER = Date.parse('2026-10-04T12:00:00Z');
  const date = (ms: number): string => new Date(ms).toUTCString();

  test('a visitor clock 2 minutes slow is corrected to within a second', () => {
    const clock = new ServerClock();
    expect(clock.offset()).toBe(0);
    const local = SERVER - 120_000;
    // Sent at local, answered 200 ms later; the server stamped its Date in between.
    clock.note(date(SERVER + 100), local, local + 200);
    expect(Math.abs(clock.offset() - 120_000)).toBeLessThanOrEqual(1000);
    expect(Math.abs(clock.now(local) - SERVER)).toBeLessThanOrEqual(1000);
  });

  test('a clock that agrees with the server is left alone, so no countdown jitters', () => {
    const clock = new ServerClock();
    clock.note(date(SERVER), SERVER + 300, SERVER + 400);
    clock.note(date(SERVER + 5000), SERVER + 5100, SERVER + 5150);
    expect(clock.offset()).toBe(0);
  });

  test('answers tighten the estimate, and a clock that jumps starts it again', () => {
    const clock = new ServerClock();
    const skew = -90_000;
    clock.note(date(SERVER), SERVER + skew - 2000, SERVER + skew + 2000);
    const wide = clock.known();
    clock.note(date(SERVER + 10_000), SERVER + skew + 10_000 - 50, SERVER + skew + 10_000 + 50);
    const narrow = clock.known();
    expect(wide !== null && narrow !== null && narrow.hi - narrow.lo < wide.hi - wide.lo).toBe(true);
    expect(Math.abs(clock.offset() - 90_000)).toBeLessThanOrEqual(1000);
    // The visitor sets their clock right: the next answer no longer overlaps, so it is believed on its own.
    clock.note(date(SERVER + 20_000), SERVER + 20_000, SERVER + 20_100);
    expect(clock.offset()).toBe(0);
    // Nothing usable changes nothing.
    clock.note(null, 0, 1);
    clock.note('not a date', 0, 1);
    clock.note(date(SERVER), 10, 5);
    expect(clock.offset()).toBe(0);
  });

  test('reads after a deadline: the next one to come, or one just passed and not yet read for', () => {
    const now = SERVER;
    const iso = (ms: number): string => new Date(ms).toISOString();
    expect(nextDeadlineRead([iso(now + 5000), iso(now + 2000), undefined], now, new Set(), 60_000)).toEqual({ deadline: iso(now + 2000), waitMs: 2000 });
    expect(nextDeadlineRead([iso(now - 1000)], now, new Set(), 60_000)).toEqual({ deadline: iso(now - 1000), waitMs: 0 });
    // Already read for once it passed: the poll covers it from then on, and a later one is next.
    expect(nextDeadlineRead([iso(now - 1000), iso(now + 9000)], now, new Set([iso(now - 1000)]), 60_000)).toEqual({ deadline: iso(now + 9000), waitMs: 9000 });
    expect(nextDeadlineRead([iso(now - 120_000), 'soon'], now, new Set(), 60_000)).toBeNull();
  });
});

test.describe('L4 (pages) · one clock for every countdown on the page', () => {
  test('any number of countdowns share one one-second interval, which stops with the last', () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let started = 0;
    let stopped = 0;
    globalThis.setInterval = ((handler: () => void, ms?: number) => {
      started += 1;
      expect(ms).toBe(TICK_MS);
      return realSet(handler, ms);
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      stopped += 1;
      realClear(id);
    }) as typeof clearInterval;
    try {
      expect(tickerState()).toEqual({ listeners: 0, running: false });
      const leave = Array.from({ length: 500 }, () => subscribeTicker(() => undefined));
      expect(tickerState()).toEqual({ listeners: 500, running: true });
      expect(started).toBe(1);
      for (const unsubscribe of leave) unsubscribe();
      expect(tickerState()).toEqual({ listeners: 0, running: false });
      expect(stopped).toBe(1);
      // With nothing listening, two reads in a row agree (useSyncExternalStore requires it).
      expect(tickerNow()).toBe(tickerNow());
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});

test.describe('L2 (pages) · an older read never overwrites a newer state', () => {
  test('P5: a read that left before a write and lands after it is dropped', () => {
    const order = new Freshness();
    const slowRead = order.read(); // the tab came back: a read leaves
    order.writeStarted(); // Second is pressed
    expect(order.accept(slowRead)).toBe(false); // the read lands while the write is out
    const second = order.writeEnded();
    expect(order.acceptWrite(second)).toBe(true); // "In debate" is on screen
    expect(order.accept(slowRead)).toBe(false); // …and the slow read can't put "Needs a second" back
    const fresh = order.read();
    expect(order.accept(fresh)).toBe(true); // a read that left after the write is shown
  });

  test('reads land in any order, and only the newest is shown', () => {
    const order = new Freshness();
    const first = order.read();
    const second = order.read();
    expect(order.accept(second)).toBe(true);
    expect(order.accept(first)).toBe(false);
    // A read that left while a write was out may predate it, even if it lands after.
    order.writeStarted();
    const during = order.read();
    const ended = order.writeEnded();
    expect(order.accept(during)).toBe(false);
    expect(order.acceptWrite(ended)).toBe(true);
    expect(order.acceptWrite(ended)).toBe(false);
  });
});

test.describe('M2 and L8 (rules) · earlier comments and earlier decided proposals', () => {
  const comment = (id: number) => ({ id, author: 'jo', text: `c${id}`, at: '2026-10-01T00:00:00Z' });

  test('pages of comments make one thread: each once, oldest first', () => {
    expect(mergeComments([comment(3), comment(1)], [comment(2), comment(3)]).map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(mergeComments([], [])).toEqual([]);
  });

  const cardOf = (id: number, state: ProposalCard['state']): ProposalCard => ({ ...card(state, id) });
  const list = (cards: ProposalCard[], moreDecided?: boolean): ProposalList => ({
    proposals: cards,
    testTimers: false,
    ...(moreDecided === undefined ? {} : { moreDecided }),
  });

  test('the floor pages back through decided proposals, and keeps them across re-reads', () => {
    let floor: FloorList | null = foldFloor(null, { kind: 'first', list: list([cardOf(9, 'debate'), cardOf(8, 'passed'), cardOf(7, 'failed')], true) });
    expect(floor && floorHasMore(floor)).toBe(true);
    expect(floor && decidedCursor(floorCards(floor))).toBe(7);
    floor = foldFloor(floor, { kind: 'older', page: list([cardOf(6, 'lapsed'), cardOf(5, 'shipped')], false) });
    expect(floor && floorCards(floor).map((entry) => entry.id)).toEqual([9, 8, 7, 6, 5]);
    expect(floor && floorHasMore(floor)).toBe(false);
    // Re-read: 9 was decided and 10 is new, so 7 falls off the first page; it stays on screen.
    floor = foldFloor(floor, { kind: 'first', list: list([cardOf(10, 'submitted'), cardOf(9, 'passed'), cardOf(8, 'building')], true) });
    expect(floor && floorCards(floor).map((entry) => [entry.id, entry.state])).toEqual([
      [10, 'submitted'],
      [9, 'passed'],
      [8, 'building'],
      [7, 'failed'],
      [6, 'lapsed'],
      [5, 'shipped'],
    ]);
    // Until "Show earlier" is used, a re-read is just the new first page.
    const fresh = foldFloor(null, { kind: 'first', list: list([cardOf(4, 'passed')]) });
    expect(fresh && foldFloor(fresh, { kind: 'first', list: list([cardOf(5, 'passed')]) })?.first.proposals.map((entry) => entry.id)).toEqual([5]);
    expect(foldFloor(null, { kind: 'older', page: list([]) })).toBeNull();
    expect(mergeCards([cardOf(2, 'passed')], [cardOf(2, 'debate'), cardOf(3, 'failed')]).map((entry) => [entry.id, entry.state])).toEqual([
      [3, 'failed'],
      [2, 'passed'],
    ]);
    expect(decidedCursor([cardOf(4, 'debate')])).toBeNull();
  });
});

test.describe('M1 and M3 (rules) · the pause and the 30-day quorum, in words', () => {
  test('a paused deadline says so instead of counting down', () => {
    expect(pausedLabel('submitted')).toBe('The time to second it is paused');
    expect(pausedLabel('debate')).toBe('Debate time is paused');
    expect(pausedLabel('voting')).toBe('Voting time is paused');
    expect(pausedLabel('passed')).toBeNull();
  });

  test('the vote panel says quorum counts the members active in the last 30 days', () => {
    expect(quorumLine(5)).toBe(
      'Quorum counts the members active in the last 30 days when it was seconded, with its mover and seconder: 5 of them, so it needs 3 ballots (Abstain counts).',
    );
    expect(quorumLine(1)).toContain('so it needs 1 ballot (Abstain counts).');
    expect(quorumLine(undefined)).toBe('Quorum counts the members active in the last 30 days when it was seconded, with its mover and seconder.');
  });
});

/* --- Phase 6: the house model's draft (contract §10) ------------------------------------------ */

const SPEC: HouseSpec = {
  title: 'Show my properties on a map',
  civilianSummary: 'A map view in the Data app.',
  acceptanceCriteria: ['One pin per property', "A pin shows its property's row"],
  size: 'M',
  tierFloor: 'T1',
  scopeIn: ['apps/web/src/app/apps/data/**'],
  scopeOut: ['apps/api/**'],
  risks: [],
  questions: ['Should a pin show the address?'],
  verdict: 'ready',
  verdictReason: 'Clear, and small enough for one task.',
};

test.describe('Phase 6 · the house model in words', () => {
  test('every status and reason has its sentence; done has none, the draft says the rest', () => {
    expect(houseStatusLine({ status: 'off', reason: 'not_configured' })).toBe(
      "The house model is off: FORGE's server has no key for it yet. Write the draft yourself.",
    );
    expect(houseStatusLine({ status: 'off', reason: 'switched_off' })).toBe(
      "The house model is off: it is switched off on FORGE's server. Write the draft yourself.",
    );
    expect(houseStatusLine({ status: 'off' })).toBe('The house model is off. Write the draft yourself.');
    // The schema doesn't pair reasons with statuses: one that doesn't go with `off` is left out.
    expect(houseStatusLine({ status: 'off', reason: 'refused' })).toBe('The house model is off. Write the draft yourself.');
    // Queued may be a wait to try again after a failure (review L8a): it isn't drafting yet.
    expect(houseStatusLine({ status: 'queued' })).toBe('The house model will draft this task shortly…');
    expect(houseStatusLine({ status: 'running' })).toBe('The house model is drafting this task…');
    // The daily limit counts a UTC day (review L8c).
    expect(houseStatusLine({ status: 'failed', reason: 'daily_limit' })).toBe(
      'The house model reached its daily limit before it got to this task. Draft it again after midnight UTC, or write it yourself.',
    );
    expect(houseStatusLine({ status: 'done' })).toBeNull();
    const failed = new Set<string>();
    for (const reason of HOUSE_FAILURE_REASONS) {
      const line = houseStatusLine({ status: 'failed', reason }) ?? '';
      expect(line, reason).toMatch(/^[A-Z].*\.$/);
      failed.add(line);
    }
    expect(failed.size).toBe(HOUSE_FAILURE_REASONS.length);
    const unknown = "The house model hasn't drafted this task yet. Ask for a draft with Draft it again, or write it yourself.";
    expect(houseStatusLine({ status: 'failed' })).toBe(unknown);
    expect(failed.has(unknown)).toBe(false);
    expect(houseStatusLine({ status: 'failed', reason: 'not_configured' })).toBe(unknown);
    for (const reason of HOUSE_OFF_REASONS) expect(houseStatusLine({ status: 'off', reason }), reason).toContain(': ');
    for (const status of HOUSE_STATUSES) expect(isHouseWorking(status), status).toBe(status === 'queued' || status === 'running');
  });

  test('every verdict has its chip, and who drafted it says when', () => {
    expect(HOUSE_VERDICTS.map((verdict) => HOUSE_VERDICT_LABEL[verdict])).toEqual(['Ready', 'Needs answers from the mover', 'Not feasible']);
    expect(HOUSE_VERDICTS.map((verdict) => HOUSE_VERDICT_TONE[verdict])).toEqual(['ok', 'warn', 'danger']);
    expect(houseDraftedLine({ model: 'claude-opus-5-5', draftedAt: '2026-10-03T12:00:00Z' })).toBe(
      `Drafted by claude-opus-5-5 on ${formatDate('2026-10-03T12:00:00Z')}.`,
    );
    expect(formatDate('2026-10-03T12:00:00Z')).toContain('2026');
    expect(houseDraftedLine({ model: 'claude-opus-5-5' })).toBe('Drafted by claude-opus-5-5.');
    expect(houseDraftedLine({ draftedAt: '2026-10-03T12:00:00Z' })).toBe(`Drafted by the house model on ${formatDate('2026-10-03T12:00:00Z')}.`);
    expect(houseDraftedLine({ model: ' ' })).toBeNull();
    expect(houseDraftedLine({})).toBeNull();
    // Review L9: the API doesn't limit either, so a model name is cut short, and a date that isn't one is left out.
    expect(HOUSE_MODEL_SHOWN).toBe(100);
    expect(houseDraftedLine({ model: `m${'x'.repeat(10_000)}`, draftedAt: '2026-10-03T12:00:00Z' })).toBe(
      `Drafted by m${'x'.repeat(98)}… on ${formatDate('2026-10-03T12:00:00Z')}.`,
    );
    expect(houseDraftedLine({ model: 'x'.repeat(100) })).toBe(`Drafted by ${'x'.repeat(100)}.`);
    // Cut by characters, never inside one.
    expect(houseDraftedLine({ model: '🚀'.repeat(150) })).toBe(`Drafted by ${'🚀'.repeat(99)}….`);
    expect(houseDraftedLine({ model: 'claude-opus-5-5', draftedAt: `not-a-date-${'d'.repeat(500)}` })).toBe('Drafted by claude-opus-5-5.');
    // With neither a model nor a date, there is nothing to say.
    expect(houseDraftedLine({ draftedAt: 'yesterday' })).toBeNull();
  });

  test('"Use the house draft" takes the title, summary, criteria and size; the form key ignores spaces and blank lines', () => {
    expect(houseFormOf(SPEC)).toEqual({
      title: SPEC.title,
      civilianSummary: SPEC.civilianSummary,
      criteria: 'One pin per property\nA pin shows its property\'s row',
      size: 'M',
    });
    const form = { ...draftFormOf({ ...SPEC, rewardClass: 'R2', tierFloor: 'T0' }), ...houseFormOf(SPEC) };
    expect(form.rewardClass).toBe('R2');
    expect(form.tierFloor).toBe(OPEN_TIER_FLOOR);
    const messy = { ...form, title: `  ${form.title} `, criteria: `\n${form.criteria}\n\n  ` };
    expect(draftFormKey(messy)).toBe(draftFormKey(form));
    expect(draftFormKey({ ...form, rewardClass: 'R3' })).not.toBe(draftFormKey(form));
    expect(draftFormKey({ ...form, size: 'XS' })).not.toBe(draftFormKey(form));
  });

  test('where its draft is comes from the texts, never from appliedToDraft; each place has its line (review M1–M3)', () => {
    const own = { title: 'Map view', civilianSummary: 'Pins.', acceptanceCriteria: ['A pin each'], size: 'S' as const, tierFloor: 'T0' as const, rewardClass: 'R1' as const };
    const filled = { ...own, title: SPEC.title, civilianSummary: SPEC.civilianSummary, acceptanceCriteria: SPEC.acceptanceCriteria, size: SPEC.size };
    const houseForm = { ...draftFormOf(own), ...houseFormOf(SPEC) };
    // The reward is the admin's, and spaces or blank lines don't count.
    expect(housePlace(SPEC, houseForm, filled)).toEqual({ inForm: true, inSaved: true });
    expect(housePlace(SPEC, { ...houseForm, rewardClass: 'R4', title: ` ${SPEC.title} `, criteria: `${houseForm.criteria}\n\n` }, filled)).toEqual({
      inForm: true,
      inSaved: true,
    });
    expect(housePlace(SPEC, houseForm, own)).toEqual({ inForm: true, inSaved: false });
    expect(housePlace(SPEC, draftFormOf(filled), own)).toEqual({ inForm: true, inSaved: false });
    expect(housePlace(SPEC, draftFormOf(own), filled)).toEqual({ inForm: false, inSaved: true });
    expect(housePlace(SPEC, { ...houseForm, size: 'XS' }, own)).toEqual({ inForm: false, inSaved: false });

    const use = (words: { offerUse: boolean }) => words.offerUse;
    // In the form and saved: check it. In the form only: the status line says so, unsaved. Nothing to use either way.
    expect(houseFormWords({ inForm: true, inSaved: true }, false, true)).toEqual({ line: HOUSE_FORM_LINE.inBoth, status: '', offerUse: false });
    expect(houseFormWords({ inForm: true, inSaved: false }, true, false)).toEqual({ line: null, status: HOUSE_FORM_LINE.inFormOnly, offerUse: false });
    // Not in the form: say what the form holds, and always offer "Use the house draft".
    expect(houseFormWords({ inForm: false, inSaved: true }, true, true)).toEqual({ line: HOUSE_FORM_LINE.savedOverEdits, status: '', offerUse: true });
    expect(houseFormWords({ inForm: false, inSaved: true }, true, false)).toEqual({ line: HOUSE_FORM_LINE.savedOverEarlier, status: '', offerUse: true });
    expect(houseFormWords({ inForm: false, inSaved: false }, true, false)).toEqual({ line: HOUSE_FORM_LINE.changedSince, status: '', offerUse: true });
    expect(houseFormWords({ inForm: false, inSaved: false }, false, true)).toEqual({ line: HOUSE_FORM_LINE.notReplaced, status: '', offerUse: true });
    for (const inSaved of [false, true]) {
      for (const applied of [false, true]) {
        for (const edited of [false, true]) {
          expect(use(houseFormWords({ inForm: false, inSaved }, applied, edited)), `${inSaved} ${applied} ${edited}`).toBe(true);
          expect(use(houseFormWords({ inForm: true, inSaved }, applied, edited)), `${inSaved} ${applied} ${edited}`).toBe(false);
        }
      }
    }
    expect(HOUSE_FORM_LINE).toEqual({
      inBoth: 'Its draft is in the form below. Check every line before you publish.',
      inFormOnly: 'The house draft is in the form below. Nothing is saved until you save or publish.',
      savedOverEdits: 'Its draft is saved, but the form below still has the changes you were making.',
      savedOverEarlier: 'Its draft is saved, but the form below still has the earlier draft.',
      changedSince: 'Its draft filled the draft task, but changes have been saved since.',
      notReplaced: "You had already saved the draft, so it wasn't replaced.",
    });
  });

  test('"Draft it again": each refusal in its own words', () => {
    expect(describeProposalError('house_busy', 'house_draft')).toBe(
      "The house model is already drafting this task, so nothing changed. Its new draft shows here when it's ready.",
    );
    expect(describeProposalError({ code: 'house_off', reason: 'not_configured' }, 'house_draft')).toBe(
      "The house model is off (FORGE's server has no key for it yet), so nothing changed. Write the draft yourself.",
    );
    expect(describeProposalError({ code: 'house_off', reason: 'switched_off' }, 'house_draft')).toBe(
      "The house model is off (it is switched off on FORGE's server), so nothing changed. Write the draft yourself.",
    );
    expect(describeProposalError({ code: 'house_off', reason: '<b>new</b>' }, 'house_draft')).toBe(
      'The house model is off, so nothing changed. Write the draft yourself.',
    );
    expect(describeProposalError({ code: 'wrong_state', state: 'building' }, 'house_draft')).toBe(
      "It can't be drafted again (it is being built): the house model drafts a task only after it passes and before it is published. Nothing changed.",
    );
    expect(HOUSE_DRAFTS_PER_PROPOSAL).toBe(5);
    expect(describeProposalError({ code: 'rate_limited', limit: 5, retryAfterSeconds: 3 * 3600 }, 'house_draft')).toBe(
      'The house model has drafted this proposal as often as FORGE allows in a day (5). Try again in about 3 hours.',
    );
    expect(describeProposalError({ code: 'rate_limited', limit: 30, retryAfterSeconds: 300 }, 'house_draft')).toBe(
      'The house model has made as many drafts today as FORGE allows across the floor (30). Try again in about 5 minutes.',
    );
    expect(describeProposalError({ code: 'rate_limited' }, 'house_draft')).toBe(
      'The house model has drafted as often as FORGE allows just now. Wait a little, then try again.',
    );
    // Review L8(d): the API names the limit it hit (`scope`), so a daily limit set to 5 reads as the daily one.
    expect(describeProposalError({ code: 'rate_limited', limit: 5, scope: 'daily', retryAfterSeconds: 300 }, 'house_draft')).toBe(
      'The house model has made as many drafts today as FORGE allows across the floor (5). Try again in about 5 minutes.',
    );
    expect(describeProposalError({ code: 'rate_limited', limit: 5, scope: 'proposal', retryAfterSeconds: 300 }, 'house_draft')).toBe(
      'The house model has drafted this proposal as often as FORGE allows in a day (5). Try again in about 5 minutes.',
    );
    expect(describeProposalError({ code: 'rate_limited', scope: 'daily' }, 'house_draft')).toBe(
      'The house model has made as many drafts today as FORGE allows across the floor. Wait a little, then try again.',
    );
    expect(describeProposalError({ code: 'rate_limited', scope: 'proposal' }, 'house_draft')).toBe(
      'The house model has drafted this proposal as often as FORGE allows in a day. Wait a little, then try again.',
    );
    // Other actions never read it.
    expect(describeProposalError({ code: 'rate_limited', limit: 10, scope: 'daily' }, 'comment')).toBe(
      "You've commented on this proposal as often as FORGE allows in an hour (10). Wait a little, then try again.",
    );
    expect(describeProposalError('admin_only', 'house_draft')).toBe("Only FORGE's admins can do that.");
    expect(didNotGoThrough('house_draft')).toBe("It didn't go through, so nothing changed. Please try again.");
  });

  test('"Draft it again" went through: drafting, "again" only after a draft, or finished already (review L8b, L4)', () => {
    expect(houseDraftAsked(true, { status: 'queued' })).toBe("The house model is drafting it again. Its new draft shows below when it's ready.");
    expect(houseDraftAsked(true, undefined)).toBe("The house model is drafting it again. Its new draft shows below when it's ready.");
    expect(houseDraftAsked(false, { status: 'running' })).toBe("The house model is drafting this task. Its draft shows below when it's ready.");
    for (const status of ['done', 'failed', 'off'] as const) {
      expect(houseDraftAsked(true, { status }), status).toBe(
        'It went through, and the house model has already finished. The house draft below shows how it went.',
      );
    }
    // A lost answer whose read back failed too: the page can't say yet.
    expect(notReadBack()).toBe("FORGE didn't hear back in time, so it may have gone through. The page couldn't check just now; it tries again shortly.");
  });

  test('after a lost answer, the read back says whether "Draft it again" went through: any change in the house (review L4)', () => {
    type House = Pick<HouseDraft, 'status' | 'reason' | 'draftedAt'>;
    const back = (house?: House): ReadBack => ({
      proposal: { state: 'passed', title: 'Map' },
      pitch: 'Pins.',
      comments: [],
      ...(house === undefined ? {} : { house }),
    });
    const when = '2026-10-03T09:30:00Z';
    const asked = (before?: House) => ({ action: 'house_draft' as const, before });
    const done = { status: 'done' as const, draftedAt: when };
    // Can't tell without the house, before or after.
    expect(wentThrough(asked(done), back(), 'x')).toBeNull();
    expect(wentThrough(asked(undefined), back(done), 'x')).toBeNull();
    // Drafting now.
    expect(wentThrough(asked(done), back({ status: 'queued', draftedAt: when }), 'x')).toBe(true);
    expect(wentThrough(asked(done), back({ status: 'running' }), 'x')).toBe(true);
    // Just as it was: it didn't happen.
    expect(wentThrough(asked(done), back(done), 'x')).toBe(false);
    expect(wentThrough(asked({ status: 'failed' }), back({ status: 'failed' }), 'x')).toBe(false);
    expect(wentThrough(asked({ status: 'failed', reason: 'refused', draftedAt: when }), back({ status: 'failed', reason: 'refused', draftedAt: when }), 'x')).toBe(false);
    // So quick that a newer draft has landed already, or the new job has failed already (P15).
    expect(wentThrough(asked(done), back({ status: 'done', draftedAt: '2026-10-04T08:00:00Z' }), 'x')).toBe(true);
    expect(wentThrough(asked(done), back({ status: 'failed', reason: 'refused', draftedAt: when }), 'x')).toBe(true);
    expect(wentThrough(asked({ status: 'failed', reason: 'unavailable' }), back({ status: 'failed', reason: 'refused' }), 'x')).toBe(true);
    expect(wentThrough(asked({ status: 'failed' }), back({ status: 'failed', reason: 'daily_limit' }), 'x')).toBe(true);
  });

  test('the timeline: every kind in the contract has a label, an admin’s are "Admin", and house_drafted is a plain line', () => {
    for (const kind of PROPOSAL_EVENT_KINDS) {
      expect(eventLabel(kind), kind).toBe(kind.startsWith('admin_') || kind.startsWith('test_timers_') ? 'Admin' : null);
    }
    expect(eventLabel('house_drafted')).toBeNull();
    expect(isAdminEvent('house_drafted')).toBe(false);
    expect(eventLabel('proposal_archived')).toBeNull();
    expect(eventLabel('__proto__')).toBeNull();
    expect(eventLabel('constructor')).toBeNull();
  });
});

test.describe('Phase 6 · a house draft that breaks the contract is dropped, and the proposal still shows', () => {
  const HOUSE = { status: 'done', spec: SPEC, model: 'claude-opus-5-5', draftedAt: '2026-10-03T09:30:00Z', appliedToDraft: true };

  test('a good one is kept; a bad one is dropped from what the page shows, while the contract itself stays strict', () => {
    const good = DisplayDetailSchema.safeParse({ ...DETAIL, house: HOUSE });
    expect(good.success && good.data.house).toEqual(HOUSE);
    const none = DisplayDetailSchema.safeParse(DETAIL);
    expect(none.success && none.data.house).toBeUndefined();
    for (const [name, house] of [
      ['an unknown status', { status: 'thinking' }],
      ['null', null],
      ['a number', 7],
      ['too many criteria', { ...HOUSE, spec: { ...SPEC, acceptanceCriteria: Array.from({ length: 11 }, (_, index) => `C${index}`) } }],
      ['no criteria', { ...HOUSE, spec: { ...SPEC, acceptanceCriteria: [] } }],
      ['a title past 100 characters', { ...HOUSE, spec: { ...SPEC, title: 't'.repeat(101) } }],
      ['an unknown reason', { status: 'failed', reason: 'exploded' }],
      ['appliedToDraft as 1', { ...HOUSE, appliedToDraft: 1 }],
    ] as const) {
      expect(ProposalDetailSchema.safeParse({ ...DETAIL, house }).success, name).toBe(false);
      const shown = DisplayDetailSchema.safeParse({ ...DETAIL, house });
      expect(shown.success, name).toBe(true);
      expect(shown.success && shown.data.house, name).toBeUndefined();
      expect(shown.success && shown.data.proposal.title, name).toBe('Map');
    }
    // Review L5: `done` with no spec has nothing to show, so it reads as a task the house hasn't drafted yet.
    const empty = DisplayDetailSchema.safeParse({ ...DETAIL, house: { status: 'done', model: 'claude-opus-5-5', appliedToDraft: true } });
    expect(empty.success && empty.data.house).toEqual({ status: 'failed' });
    expect(houseStatusLine({ status: 'failed' })).toBe(
      "The house model hasn't drafted this task yet. Ask for a draft with Draft it again, or write it yourself.",
    );
  });

  test('"Draft it again" posts with no body, and reads the answer as the house’s new state', async () => {
    const sent = await withFetch(
      () => Response.json({ status: 'queued' }, { status: 202 }),
      async (calls) => {
        const house = await requestHouseDraft(7);
        expect(house).toEqual({ status: 'queued' });
        return calls.map((call) => [call.url, call.init?.method, call.init?.body, call.init?.headers]);
      },
    );
    expect(sent).toEqual([['/bff/proposals/7/admin/house-draft', 'POST', undefined, undefined]]);
    // Anything else is no answer to show: the page reads the proposal again.
    expect(await withFetch(() => Response.json({ status: 'pondering' }, { status: 202 }), () => requestHouseDraft(7))).toBeNull();
    expect(await withFetch(() => new Response('', { status: 202 }), () => requestHouseDraft(7))).toBeNull();
    // A refusal keeps its reason, so the page can say why the house is off.
    const off = await withFetch(
      () => Response.json({ error: 'house_off', reason: 'switched_off', message: 'Off.' }, { status: 503 }),
      () => failureFrom(() => requestHouseDraft(7)),
    );
    expect(failureOf(off)).toEqual({ code: 'house_off', reason: 'switched_off' });
    expect(mayHaveHappened(off)).toBe(false);
    const odd = await withFetch(
      () => Response.json({ error: 'house_off', reason: 'Not <a> code' }, { status: 503 }),
      () => failureFrom(() => requestHouseDraft(7)),
    );
    expect(failureOf(odd)).toEqual({ code: 'house_off' });
    // A rate limit keeps which limit it was (review L8d); anything but the two scopes is dropped.
    for (const [scope, kept] of [
      ['daily', { scope: 'daily' }],
      ['proposal', { scope: 'proposal' }],
      ['weekly', {}],
      [7, {}],
    ] as const) {
      const limited = await withFetch(
        () =>
          Response.json({ error: 'rate_limited', retryAfter: 600, limit: 5, scope, message: 'Later.' }, { status: 429, headers: { 'retry-after': '600' } }),
        () => failureFrom(() => requestHouseDraft(7)),
      );
      expect(failureOf(limited), String(scope)).toEqual({ code: 'rate_limited', retryAfterSeconds: 600, limit: 5, ...kept });
    }
  });
});

test.describe('Phase 6 · the practice floor’s house draft', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z');

  test('the passed sample has a finished house draft that keeps the contract, and its timeline says so', () => {
    const floor = practiceFloor(NOW);
    for (const signedIn of [false, true]) {
      const passed = practiceDetail(floor, 1, signedIn);
      expect(HouseDraftSchema.safeParse(passed?.house).success, `signed in: ${signedIn}`).toBe(true);
      expect(passed?.house).toMatchObject({ status: 'done', model: PRACTICE_HOUSE_MODEL, appliedToDraft: true, spec: { verdict: 'ready' } });
      expect(passed?.events.at(-1)).toMatchObject({ kind: 'house_drafted', message: HOUSE_DRAFTED_MESSAGE });
      expect(passed?.events.at(-1)?.actor).toBeUndefined();
    }
    expect(Date.parse(practiceDetail(floor, 1, false)?.house?.draftedAt ?? '')).toBeLessThan(NOW);
    // Nothing else has passed, so nothing else has one.
    expect(practiceDetail(floor, 2, true)?.house).toBeUndefined();
    expect(practiceDetail(floor, WALKTHROUGH_ID, true)?.house).toBeUndefined();
  });

  test('the walk-through: the house drafts its task the moment it passes', () => {
    let floor = practiceFloor(NOW);
    const seconded = practiceSecond(floor, WALKTHROUGH_ID, PRACTICE_REVISION, NOW + MINUTE);
    if (!seconded.ok) throw new Error(seconded.code);
    floor = seconded.floor;
    expect(seconded.detail.house).toBeUndefined();
    const passed = practiceConsent(floor, WALKTHROUGH_ID, true, NOW + 2 * MINUTE);
    if (!passed.ok) throw new Error(passed.code);
    const house = passed.detail.house;
    expect(HouseDraftSchema.safeParse(house).success).toBe(true);
    expect(house).toMatchObject({ status: 'done', appliedToDraft: true, spec: { verdict: 'needs_clarification', size: 'S', tierFloor: 'T0' } });
    expect(house?.draftedAt).toBe('2026-10-04T12:02:00Z');
    expect(house?.spec?.questions).toHaveLength(1);
    expect(passed.detail.events.at(-1)).toMatchObject({ kind: 'house_drafted', message: HOUSE_DRAFTED_MESSAGE });
    // And the floor remembers it.
    expect(practiceDetail(passed.floor, WALKTHROUGH_ID, false)?.house).toEqual(house);
  });

  test('a sample with no canned draft gets a plain one that still keeps the contract', () => {
    const house = practiceHouse({ id: 99, title: 'T'.repeat(120), pitch: `${'p'.repeat(600)}\n\nMore.` }, NOW);
    expect(HouseDraftSchema.safeParse(house).success).toBe(true);
    expect(house.spec?.title).toHaveLength(100);
    expect(house.spec?.civilianSummary).toHaveLength(500);
    expect(house.spec?.verdict).toBe('needs_clarification');
  });
});
