import { expect, test } from '@playwright/test';

import { NotificationListSchema, PROPOSAL_STATES, ProposalDetailSchema } from '../../packages/shared/dist/index.js';
import type { ProposalCard, ProposalDetail, ProposalList } from '../../packages/shared/dist/index.js';
import { HELLO_TIMEOUT_MS, MEMBERS_HELLO_PATH, sayHello } from '../../apps/web/src/app/auth/callback/members-hello';
import { ApiError, RequestError, mayHaveHappened as contributeMayHaveHappened } from '../../apps/web/src/lib/api';
import { Freshness } from '../../apps/web/src/lib/freshness';
import {
  DisplayDetailSchema,
  DisplayNotificationListSchema,
  ProposalRequestError,
  castVote,
  failureOf,
  mayHaveHappened,
  postComment,
  secondProposal,
} from '../../apps/web/src/lib/proposals';
import {
  FLOOR_SECTIONS,
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
  draftFormOf,
  eventText,
  floorCards,
  floorHasMore,
  foldFloor,
  formatTimeLeft,
  groupBySection,
  isActive,
  isAdminEvent,
  mergeCards,
  mergeComments,
  nextDeadlineRead,
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
  PRACTICE_ME,
  PRACTICE_MEMBERS,
  PRACTICE_REVISION,
  WALKTHROUGH_ID,
  practiceComment,
  practiceComments,
  practiceConsent,
  practiceDetail,
  practiceFloor,
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
 * best-effort members hello.
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
    expect(passed.detail.events.map((entry) => entry.kind).slice(-4)).toEqual(['consented', 'consented', 'passed', 'task_drafted']);
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
