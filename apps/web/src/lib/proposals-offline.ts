/**
 * The Propose floor, simulated for the practice app (demo builds only).
 *
 * The practice account is nobody on GitHub, so nothing it does may reach the
 * API (the BFF refuses it), yet the Propose screens still have to work end to
 * end, and the Playwright demo suite runs with nothing else up. Everything
 * here answers in exactly the shapes the API would (`@forge/shared`, Phase 5
 * contract §2) and follows the rules in contract §1; the screens say it is
 * practice and that nothing is saved.
 *
 * The floor holds three samples: one already passed (by a vote), one in
 * debate, and one that needs a second. The last one is the walk-through:
 * second it and debate opens; the other sample members consent at once, so
 * your consent is the one that passes it. The practice account can't bring
 * or edit a proposal of its own (a proposal needs a GitHub member behind it),
 * and it is never an admin.
 *
 * The house model (Phase 6 contract §10) is simulated too: a sample that has
 * passed carries a finished house draft, written at once with canned content,
 * and its timeline says so, so the practice app shows what the house does.
 * Live, only an admin sees a house draft; here, where nobody is an admin,
 * the page shows it to everyone and says so.
 *
 * Pure: the caller (`./proposals`) keeps one {@link PracticeFloor} for the
 * life of the tab and passes it in; every change returns a new one.
 */
import type {
  HouseDraft,
  HouseSpec,
  ProposalCard,
  ProposalComment,
  ProposalCommentPage,
  ProposalDetail,
  ProposalEvent,
  ProposalEventKind,
  ProposalList,
  ProposalState,
  ProposalTally,
  ProposalYou,
  VoteChoice,
} from '@forge/shared';

import { DEMO_IDENTITY } from './fixtures';

/** Said wherever the practice app pretends to act. */
export const PRACTICE_NOTE = 'Practice: nothing is saved.';

/** The practice account, as the samples name it (the same stand-in the Contribute practice uses). */
export const PRACTICE_ME = DEMO_IDENTITY;

const MAYA = 'maya-builds';
const SAM = 'sam-k';
const JO = 'jo-plays';

/** Every member the practice floor knows, you included: the eligible set at any second. */
export const PRACTICE_MEMBERS: readonly string[] = [MAYA, SAM, JO, PRACTICE_ME];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Pilot timers (contract §1): lapse, debate. */
const LAPSE_MS = 7 * DAY_MS;
const DEBATE_MS = 3 * DAY_MS;

/** The sample you can walk through: it needs a second. */
export const WALKTHROUGH_ID = 3;

/**
 * Every sample's text revision. The practice account can't edit, and nobody
 * else is here, so no sample's text ever changes from the one you read.
 */
export const PRACTICE_REVISION = 1;

/** Comments a page of them holds, as the API pages them. */
const COMMENTS_PAGE = 100;

interface PracticeProposal {
  id: number;
  title: string;
  pitch: string;
  state: ProposalState;
  mover: string;
  movedAtMs: number;
  seconder?: string;
  deadlineMs?: number;
  /** Frozen at the second. Empty until then. */
  eligible: readonly string[];
  /** Members of the eligible set who consented (the mover counts from the second). */
  consented: readonly string[];
  objected: readonly string[];
  votes: Readonly<Record<string, VoteChoice>>;
  tally?: ProposalTally;
  comments: readonly ProposalComment[];
  events: readonly ProposalEvent[];
  /** Members who consent the moment debate opens, so that in practice your consent decides it. */
  quickConsents: readonly string[];
  /** The house model's draft, once it has passed. */
  house?: HouseDraft;
}

/** What the practice floor holds, for the life of the tab. */
export interface PracticeFloor {
  proposals: readonly PracticeProposal[];
  nextCommentId: number;
}

/** A practice change: the new floor and the proposal as the API would now answer, or the API's refusal. */
export type PracticeResult =
  | { ok: true; floor: PracticeFloor; detail: ProposalDetail }
  | { ok: false; status: number; code: string; state?: ProposalState; revision?: number };

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function event(atMs: number, kind: ProposalEventKind, message: string, actor?: string): ProposalEvent {
  return { at: isoOf(atMs), kind, message, ...(actor === undefined ? {} : { actor }) };
}

function comment(id: number, atMs: number, author: string, text: string): ProposalComment {
  return { id, author, text, at: isoOf(atMs) };
}

/* --- the house model, simulated ------------------------------------------------------- */

/** The model the practice floor says wrote its house drafts: the API's default. */
export const PRACTICE_HOUSE_MODEL = 'claude-opus-5-5';

/** The public timeline line the API adds once the house model has drafted the task (Phase 6 contract §1). */
export const HOUSE_DRAFTED_MESSAGE =
  "FORGE's house model drafted the task from this proposal. An admin checks it before it goes on the Contribute board.";

/** The canned house drafts, by sample: what the house model might write for each. */
const HOUSE_SPECS: Readonly<Record<number, HouseSpec>> = {
  1: {
    title: 'Show my Upland properties on a map in the Data app',
    civilianSummary:
      "The Data app gets a map view: a pin for each of your properties, a tap on a pin to see its row, and the same filters the table has. It works on a phone first, as the debate asked.",
    acceptanceCriteria: [
      'The Data app has a Map view beside the table, with one pin for each property in the list.',
      "Tapping or clicking a pin shows that property's row.",
      "The table's filters apply to the map: a property filtered out of the table has no pin.",
      'At 390 px wide, the map, its pins and the filters fit the screen with no sideways scrolling.',
      'An e2e test opens the map, checks that a pin shows its row, and checks one filter.',
    ],
    size: 'M',
    tierFloor: 'T0',
    scopeIn: ['apps/web/src/app/apps/data/**', 'tests/e2e/data-app.spec.ts'],
    scopeOut: ['apps/api/**', '.github/**'],
    risks: [
      'A map library would be a new dependency, and a new dependency needs approval first: draw the map without one if it can be done.',
    ],
    questions: [],
    verdict: 'ready',
    verdictReason:
      "It is clear and fits one task: the map reuses the table's data and filters, and the debate settled the phone question.",
  },
  [WALKTHROUGH_ID]: {
    title: 'Add a dark and light theme switch',
    civilianSummary:
      'FORGE gets a light theme beside the dark one. Dark stays the default; a switch in Settings turns light on, and FORGE remembers the choice on that device.',
    acceptanceCriteria: [
      'Settings has a Theme switch with Dark and Light, and Dark is the default.',
      'Choosing Light changes every page at once, with no reload.',
      'The choice is still there after a reload on the same device.',
      'Text on every page the e2e suite opens meets WCAG AA contrast in both themes.',
    ],
    size: 'S',
    tierFloor: 'T0',
    scopeIn: ['apps/web/src/app/globals.css', 'apps/web/src/app/me/settings/page.tsx', 'tests/e2e/**'],
    scopeOut: ['apps/api/**'],
    risks: [
      'Colours written straight into a page, rather than taken from globals.css, would stay dark: check every page, not only Settings.',
    ],
    questions: ["Should FORGE follow the device's own light or dark setting until someone picks a theme?"],
    verdict: 'needs_clarification',
    verdictReason:
      "It is ready to build once the mover says whether FORGE should follow the device's own setting before anyone picks a theme.",
  },
};

/** What the house model reads of a sample. */
interface HouseInput {
  id: number;
  title: string;
  pitch: string;
}

/** A sample without a canned draft (none passes today): a plain one, from its own title and pitch. */
function plainSpec(proposal: HouseInput): HouseSpec {
  const firstParagraph = proposal.pitch.split(/\n\s*\n/)[0] ?? proposal.pitch;
  return {
    title: [...proposal.title].slice(0, 100).join(''),
    civilianSummary: [...firstParagraph.trim()].slice(0, 500).join(''),
    acceptanceCriteria: ['What the pitch asks for works as it describes, on a phone and on a computer.'],
    size: 'S',
    tierFloor: 'T0',
    scopeIn: [],
    scopeOut: [],
    risks: [],
    questions: ['What has to be true for this to count as done?'],
    verdict: 'needs_clarification',
    verdictReason: 'The pitch says what it wants, but not how to check that it is done.',
  };
}

/**
 * The house draft of a sample that has just passed: done at once, and in the
 * draft task (nobody had saved it), as the API does when the house is on.
 */
export function practiceHouse(proposal: HouseInput, nowMs: number): HouseDraft {
  return {
    status: 'done',
    spec: HOUSE_SPECS[proposal.id] ?? plainSpec(proposal),
    model: PRACTICE_HOUSE_MODEL,
    draftedAt: isoOf(nowMs),
    appliedToDraft: true,
  };
}

/** The floor as the practice app opens it, timed from `nowMs`. */
export function practiceFloor(nowMs: number): PracticeFloor {
  const passedMoved = nowMs - 9 * DAY_MS;
  const passedSeconded = passedMoved + 6 * HOUR_MS;
  const passedVoteOpened = passedSeconded + DEBATE_MS;
  const passedClosed = passedVoteOpened + 2 * DAY_MS;
  const passedHoused = passedClosed + 2 * MINUTE_MS;

  const debateMoved = nowMs - 30 * HOUR_MS;
  const debateSeconded = nowMs - 20 * HOUR_MS;

  const waitingMoved = nowMs - 2 * HOUR_MS;

  const passed: PracticeProposal = {
    id: 1,
    title: 'Show my Upland properties on a map in the Data app',
    pitch:
      'Right now the Data app lists my properties as rows. A map with a pin for each one would show at a glance where my holdings cluster, and which neighbourhoods I have never touched.\n\nNothing fancy: pins, a tap to see the row, and the same filters the table already has.',
    state: 'passed',
    mover: MAYA,
    movedAtMs: passedMoved,
    seconder: SAM,
    eligible: [MAYA, SAM, JO],
    consented: [MAYA],
    objected: [JO],
    votes: { [MAYA]: 'yes', [SAM]: 'yes', [JO]: 'no' },
    tally: { yes: 2, no: 1, abstain: 0, eligible: 3, quorumMet: true },
    comments: [
      comment(1, passedSeconded + 2 * HOUR_MS, JO, 'I like it, but only if the map works on a phone too. Most of us check our properties on the go.'),
      comment(2, passedSeconded + 5 * HOUR_MS, MAYA, 'Fair. Phones first, then: the pins and the filters have to work at phone size.'),
    ],
    events: [
      event(passedMoved, 'moved', `${MAYA} brought this proposal.`, MAYA),
      event(passedSeconded, 'seconded', `${SAM} seconded it. Debate is open for 3 days.`, SAM),
      event(passedSeconded + 3 * HOUR_MS, 'objected', `${JO} objected, so it goes to a vote after debate.`, JO),
      event(passedVoteOpened, 'debate_ended', 'Debate ended with an objection.'),
      event(passedVoteOpened, 'vote_opened', 'Voting is open for 2 days.'),
      event(passedClosed, 'vote_closed', 'The vote closed: Yes 2, No 1, Abstain 0. Quorum was met.'),
      event(passedClosed, 'passed', 'It passed: more Yes than No.'),
      event(passedClosed, 'task_drafted', 'It became a draft task. An admin will publish it to the Contribute board.'),
      event(passedHoused, 'house_drafted', HOUSE_DRAFTED_MESSAGE),
    ],
    quickConsents: [],
  };

  const inDebate: PracticeProposal = {
    id: 2,
    title: 'Let me follow a task and hear when it ships',
    pitch:
      "When I find a task on the Contribute board that I care about but can't take on myself, I'd like a Follow button. When the task ships, the bell tells me.\n\nIt's a small thing, but it would make the board feel like something I'm part of even on weeks I have no time to build.",
    state: 'debate',
    mover: SAM,
    movedAtMs: debateMoved,
    seconder: JO,
    deadlineMs: debateSeconded + DEBATE_MS,
    eligible: [SAM, JO, MAYA, PRACTICE_ME],
    consented: [SAM, MAYA],
    objected: [],
    votes: {},
    comments: [
      comment(3, debateSeconded + HOUR_MS, MAYA, 'Yes please. I lose track of tasks I wanted to see finished.'),
      comment(4, debateSeconded + 3 * HOUR_MS, JO, 'Seconded so we can talk it through. Could the same Follow button work on proposals?'),
    ],
    events: [
      event(debateMoved, 'moved', `${SAM} brought this proposal.`, SAM),
      event(debateSeconded, 'seconded', `${JO} seconded it. Debate is open for 3 days.`, JO),
      event(debateSeconded + HOUR_MS, 'consented', `${MAYA} consented.`, MAYA),
    ],
    quickConsents: [],
  };

  const waiting: PracticeProposal = {
    id: WALKTHROUGH_ID,
    title: 'Add a dark and light theme switch',
    pitch:
      'FORGE is dark everywhere. Some of us read it in daylight, and a light theme would be easier on the eyes there.\n\nA switch in Settings would do: dark stays the default, light is one tap away, and FORGE remembers the choice.',
    state: 'submitted',
    mover: JO,
    movedAtMs: waitingMoved,
    deadlineMs: waitingMoved + LAPSE_MS,
    eligible: [],
    consented: [],
    objected: [],
    votes: {},
    comments: [],
    events: [event(waitingMoved, 'moved', `${JO} brought this proposal.`, JO)],
    quickConsents: [MAYA, SAM],
  };

  return { proposals: [{ ...passed, house: practiceHouse(passed, passedHoused) }, inDebate, waiting], nextCommentId: 5 };
}

function cardOf(proposal: PracticeProposal): ProposalCard {
  return {
    id: proposal.id,
    title: proposal.title,
    state: proposal.state,
    mover: proposal.mover,
    movedAt: isoOf(proposal.movedAtMs),
    ...(proposal.seconder === undefined ? {} : { seconder: proposal.seconder }),
    ...(proposal.deadlineMs === undefined ? {} : { deadline: isoOf(proposal.deadlineMs) }),
    commentCount: proposal.comments.length,
    objectionCount: proposal.objected.length,
  };
}

function youOf(proposal: PracticeProposal): ProposalYou {
  const inSet = proposal.eligible.includes(PRACTICE_ME);
  const consent = proposal.objected.includes(PRACTICE_ME)
    ? 'objected'
    : proposal.consented.includes(PRACTICE_ME)
      ? 'consented'
      : undefined;
  const vote = proposal.votes[PRACTICE_ME];
  return {
    canEdit: false,
    canWithdraw: false,
    canSecond: proposal.state === 'submitted' && proposal.mover !== PRACTICE_ME,
    canConsent: proposal.state === 'debate' && inSet && consent === undefined,
    ...(consent === undefined ? {} : { consent }),
    canComment: proposal.state === 'debate' || proposal.state === 'voting',
    canVote: proposal.state === 'voting' && inSet,
    ...(vote === undefined ? {} : { vote }),
    isAdmin: false,
  };
}

function detailOf(proposal: PracticeProposal, signedIn: boolean): ProposalDetail {
  const counted = proposal.eligible.length > 0;
  return {
    proposal: cardOf(proposal),
    pitch: proposal.pitch,
    ...(counted
      ? {
          eligibleCount: proposal.eligible.length,
          consentCount: proposal.consented.filter((member) => proposal.eligible.includes(member)).length,
        }
      : {}),
    ...(proposal.state === 'voting' ? { turnout: Object.keys(proposal.votes).length } : {}),
    ...(proposal.tally === undefined ? {} : { tally: proposal.tally }),
    comments: proposal.comments.slice(-COMMENTS_PAGE),
    ...(proposal.comments.length > COMMENTS_PAGE ? { moreComments: true } : {}),
    events: [...proposal.events],
    ...(signedIn ? { you: youOf(proposal) } : {}),
    // Live, an admin's only; here nobody is an admin, and the page shows it as practice.
    ...(proposal.house === undefined ? {} : { house: proposal.house }),
    revision: PRACTICE_REVISION,
  };
}

/**
 * GET /api/proposals: newest first. Test timers are never on in practice, and
 * the three samples fit on one page; `decidedBefore` gives the decided ones
 * numbered below it, as the API pages them.
 */
export function practiceList(floor: PracticeFloor, decidedBefore?: number): ProposalList {
  const listed =
    decidedBefore === undefined
      ? floor.proposals
      : floor.proposals.filter(
          (proposal) =>
            proposal.id < decidedBefore &&
            proposal.state !== 'submitted' &&
            proposal.state !== 'debate' &&
            proposal.state !== 'voting',
        );
  return {
    proposals: [...listed].sort((a, b) => b.id - a.id).map(cardOf),
    testTimers: false,
  };
}

/** GET /api/proposals/{id}/comments?before=: the comments numbered below `before`, a page at most, oldest first. */
export function practiceComments(floor: PracticeFloor, id: number, before: number): ProposalCommentPage | null {
  const proposal = floor.proposals.find((candidate) => candidate.id === id);
  if (proposal === undefined) return null;
  const older = proposal.comments.filter((entry) => entry.id < before);
  return { comments: older.slice(-COMMENTS_PAGE), moreComments: older.length > COMMENTS_PAGE };
}

/** GET /api/proposals/{id}: `you` only for the signed-in practice account, as the API gives it only to identified callers. */
export function practiceDetail(floor: PracticeFloor, id: number, signedIn: boolean): ProposalDetail | null {
  const proposal = floor.proposals.find((candidate) => candidate.id === id);
  return proposal === undefined ? null : detailOf(proposal, signedIn);
}

function change(
  floor: PracticeFloor,
  id: number,
  apply: (proposal: PracticeProposal) => PracticeProposal | { status: number; code: string },
  nextCommentId = floor.nextCommentId,
): PracticeResult {
  const proposal = floor.proposals.find((candidate) => candidate.id === id);
  if (proposal === undefined) return { ok: false, status: 404, code: 'proposal_not_found' };
  const changed = apply(proposal);
  if ('code' in changed) {
    return { ok: false, ...changed, ...(changed.code === 'wrong_state' ? { state: proposal.state } : {}) };
  }
  const next: PracticeFloor = {
    proposals: floor.proposals.map((candidate) => (candidate.id === id ? changed : candidate)),
    nextCommentId,
  };
  return { ok: true, floor: next, detail: detailOf(changed, true) };
}

/**
 * POST /api/proposals/{id}/second: debate opens, the eligible set freezes, and
 * the quick members consent. `revision` is the text you read (409
 * proposal_changed for any other).
 */
export function practiceSecond(floor: PracticeFloor, id: number, revision: number, nowMs: number): PracticeResult {
  const result = change(floor, id, (proposal) => {
    if (proposal.state !== 'submitted') {
      return proposal.seconder === undefined ? { status: 409, code: 'wrong_state' } : { status: 409, code: 'already_seconded' };
    }
    if (proposal.mover === PRACTICE_ME) return { status: 403, code: 'own_proposal' };
    if (revision !== PRACTICE_REVISION) return { status: 409, code: 'proposal_changed' };
    const eligible = [proposal.mover, ...PRACTICE_MEMBERS.filter((member) => member !== proposal.mover)];
    const quick = proposal.quickConsents.filter((member) => eligible.includes(member) && member !== proposal.mover);
    return {
      ...proposal,
      state: 'debate',
      seconder: PRACTICE_ME,
      deadlineMs: nowMs + DEBATE_MS,
      eligible,
      consented: [proposal.mover, ...quick],
      events: [
        ...proposal.events,
        event(nowMs, 'seconded', `${PRACTICE_ME} seconded it. Debate is open for 3 days.`, PRACTICE_ME),
        ...quick.map((member) => event(nowMs, 'consented', `${member} consented.`, member)),
      ],
    };
  });
  return !result.ok && result.code === 'proposal_changed' ? { ...result, revision: PRACTICE_REVISION } : result;
}

/**
 * POST /api/proposals/{id}/consent: both answers are final. Consenting may pass
 * it at once; objecting sends it to a vote after debate.
 */
export function practiceConsent(floor: PracticeFloor, id: number, consent: boolean, nowMs: number): PracticeResult {
  return change(floor, id, (proposal) => {
    if (proposal.state !== 'debate') return { status: 409, code: 'wrong_state' };
    if (!proposal.eligible.includes(PRACTICE_ME)) return { status: 409, code: 'not_eligible' };
    if (proposal.consented.includes(PRACTICE_ME) || proposal.objected.includes(PRACTICE_ME)) {
      return { status: 409, code: 'already_decided_consent' };
    }
    if (!consent) {
      return {
        ...proposal,
        objected: [...proposal.objected, PRACTICE_ME],
        events: [
          ...proposal.events,
          event(nowMs, 'objected', `${PRACTICE_ME} objected, so it goes to a vote after debate.`, PRACTICE_ME),
        ],
      };
    }
    const consented = [...proposal.consented, PRACTICE_ME];
    const everyone = proposal.objected.length === 0 && proposal.eligible.every((member) => consented.includes(member));
    const events = [...proposal.events, event(nowMs, 'consented', `${PRACTICE_ME} consented.`, PRACTICE_ME)];
    if (!everyone) {
      return { ...proposal, consented, events };
    }
    // The house model drafts the task at once (live, it takes a minute or two after the pass).
    return {
      ...proposal,
      state: 'passed',
      deadlineMs: undefined,
      consented,
      events: [
        ...events,
        event(nowMs, 'passed', 'Everyone counted at the second consented, so it passed without a vote.'),
        event(nowMs, 'task_drafted', 'It became a draft task. An admin will publish it to the Contribute board.'),
        event(nowMs, 'house_drafted', HOUSE_DRAFTED_MESSAGE),
      ],
      house: practiceHouse(proposal, nowMs),
    };
  });
}

/** POST /api/proposals/{id}/comments: anyone signed in, from the second until the vote closes. */
export function practiceComment(floor: PracticeFloor, id: number, text: string, nowMs: number): PracticeResult {
  const commentId = floor.nextCommentId;
  return change(
    floor,
    id,
    (proposal) => {
      if (proposal.state !== 'debate' && proposal.state !== 'voting') return { status: 409, code: 'wrong_state' };
      return {
        ...proposal,
        comments: [...proposal.comments, comment(commentId, nowMs, PRACTICE_ME, text)],
        events: [...proposal.events, event(nowMs, 'commented', `${PRACTICE_ME} commented.`, PRACTICE_ME)],
      };
    },
    commentId + 1,
  );
}

/** POST /api/proposals/{id}/vote: the eligible set only, changeable until the close. */
export function practiceVote(floor: PracticeFloor, id: number, choice: VoteChoice, nowMs: number): PracticeResult {
  return change(floor, id, (proposal) => {
    if (proposal.state !== 'voting') return { status: 409, code: 'wrong_state' };
    if (!proposal.eligible.includes(PRACTICE_ME)) return { status: 409, code: 'not_eligible' };
    const first = proposal.votes[PRACTICE_ME] === undefined;
    return {
      ...proposal,
      votes: { ...proposal.votes, [PRACTICE_ME]: choice },
      events: first ? [...proposal.events, event(nowMs, 'voted', `${PRACTICE_ME} voted.`, PRACTICE_ME)] : proposal.events,
    };
  });
}
