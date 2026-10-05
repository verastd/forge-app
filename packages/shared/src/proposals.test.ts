/**
 * The Proposals and notifications wire types (Phase 5 contract §2).
 *
 * wire.test.ts holds every schema here to its pydantic mirror field for field,
 * limits included (tests/fixtures/wire-golden.json); this file pins the
 * vocabularies and what each schema takes. apps/api/tests/test_proposal_models.py
 * runs the same cases against the pydantic models.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ACTIVE_PROPOSAL_STATES,
  CONSENT_CHOICES,
  CommentRequestSchema,
  ConsentChoiceSchema,
  ConsentRequestSchema,
  DraftTaskRequestSchema,
  DraftTaskSchema,
  ELIGIBLE_ACTIVITY_DAYS,
  NOTIFICATION_KINDS,
  NewProposalSchema,
  NotificationKindSchema,
  NotificationListSchema,
  NotificationReadRequestSchema,
  NotificationSchema,
  PROPOSAL_EVENT_KINDS,
  PROPOSAL_LIMITS,
  PROPOSAL_STATES,
  ProposalCardSchema,
  ProposalCommentPageSchema,
  ProposalCommentSchema,
  ProposalDetailSchema,
  ProposalEventKindSchema,
  ProposalEventSchema,
  ProposalListSchema,
  ProposalMeSchema,
  ProposalSettingsSchema,
  ProposalStateSchema,
  ProposalTallySchema,
  ProposalYouSchema,
  SecondRequestSchema,
  VOTE_CHOICES,
  VoteChoiceSchema,
  VoteRequestSchema,
  textLength,
} from './index.js';
import type { DraftTaskRequest, NewProposal, Notification, ProposalDetail, ProposalState } from './index.js';

/** One character that is two UTF-16 units. */
const ASTRAL = '\u{1F3DB}';

const CARD = {
  id: 12,
  title: 'A map of every app on the wall',
  state: 'debate',
  mover: 'maya',
  movedAt: '2026-10-04T09:00:00Z',
  seconder: 'sam',
  deadline: '2026-10-07T09:05:00Z',
  commentCount: 1,
  objectionCount: 0,
};

const YOU = {
  canEdit: false,
  canWithdraw: true,
  canSecond: false,
  canConsent: false,
  consent: 'consented',
  canComment: true,
  canVote: false,
  isAdmin: false,
};

const DETAIL = {
  proposal: CARD,
  pitch: 'Show every app on one page.\nEach with a link.',
  eligibleCount: 6,
  consentCount: 4,
  comments: [{ id: 1, author: 'sam', text: 'Yes please.', at: '2026-10-04T10:00:00Z' }],
  events: [
    { at: '2026-10-04T09:00:00Z', kind: 'moved', actor: 'maya', message: 'maya moved this proposal.' },
    { at: '2026-10-04T09:05:00Z', kind: 'seconded', actor: 'sam', message: 'sam seconded it. Debate is open.' },
  ],
  you: YOU,
  revision: 1,
};

const DRAFT_REQUEST: DraftTaskRequest = {
  title: 'A map of every app on the wall',
  civilianSummary: 'One page that lists every app, with a link to each.',
  acceptanceCriteria: ['Every lit panel is listed', 'Each entry links to its app'],
  size: 'S',
  tierFloor: 'T0',
  rewardClass: 'R1',
};

/** Whether `schema` takes `base` with `field` set to `value`. */
function takes(schema: z.ZodTypeAny, base: object, field: string, value: unknown): boolean {
  return schema.safeParse({ ...base, [field]: value }).success;
}

describe('proposal vocabularies', () => {
  it('the stored states, without the momentary `seconded`', () => {
    expect(PROPOSAL_STATES).toEqual([
      'submitted',
      'debate',
      'voting',
      'passed',
      'failed',
      'building',
      'shipped',
      'lapsed',
      'withdrawn',
    ]);
    expect(ProposalStateSchema.options).toEqual([...PROPOSAL_STATES]);
    expect(ProposalStateSchema.safeParse('seconded').success).toBe(false);
  });

  it('the active states are the three before a decision', () => {
    expect(ACTIVE_PROPOSAL_STATES).toEqual(['submitted', 'debate', 'voting']);
    const state: ProposalState = 'passed';
    expect(ACTIVE_PROPOSAL_STATES.includes(state)).toBe(false);
    for (const active of ACTIVE_PROPOSAL_STATES) {
      expect(PROPOSAL_STATES).toContain(active);
    }
  });

  it('every timeline kind, in order', () => {
    expect(PROPOSAL_EVENT_KINDS).toEqual([
      'moved',
      'edited',
      'seconded',
      'consented',
      'objected',
      'commented',
      'debate_ended',
      'vote_opened',
      'voted',
      'vote_closed',
      'passed',
      'failed',
      'lapsed',
      'withdrawn',
      'task_drafted',
      'task_published',
      'shipped',
      'admin_ended_debate',
      'admin_closed_vote',
      'test_timers_on',
      'test_timers_off',
      'floor_paused',
      'floor_resumed',
      'house_drafted',
    ]);
    expect(ProposalEventKindSchema.options).toEqual([...PROPOSAL_EVENT_KINDS]);
  });

  it('votes, consents and notification kinds', () => {
    expect(VOTE_CHOICES).toEqual(['yes', 'no', 'abstain']);
    expect(VoteChoiceSchema.options).toEqual([...VOTE_CHOICES]);
    expect(CONSENT_CHOICES).toEqual(['consented', 'objected']);
    expect(ConsentChoiceSchema.options).toEqual([...CONSENT_CHOICES]);
    expect(NOTIFICATION_KINDS).toEqual([
      'proposal_moved',
      'proposal_seconded',
      'your_proposal_seconded',
      'proposal_passed',
      'proposal_failed',
      'proposal_lapsed',
      'vote_opened',
      'task_published',
    ]);
    expect(NotificationKindSchema.options).toEqual([...NOTIFICATION_KINDS]);
  });

  it('rejects anything outside them', () => {
    expect(ProposalEventKindSchema.safeParse('deleted').success).toBe(false);
    expect(VoteChoiceSchema.safeParse('maybe').success).toBe(false);
    expect(ConsentChoiceSchema.safeParse('abstained').success).toBe(false);
    expect(NotificationKindSchema.safeParse('proposal_shipped').success).toBe(false);
  });

  it('the limits', () => {
    expect(PROPOSAL_LIMITS).toEqual({
      title: 100,
      pitch: 4000,
      comment: 2000,
      summary: 500,
      criteria: 10,
      criterion: 300,
    });
  });
});

describe('textLength', () => {
  it('counts code points, as Python len() does', () => {
    expect(textLength('')).toBe(0);
    expect(textLength('abc')).toBe(3);
    expect(textLength(ASTRAL)).toBe(1);
    expect(ASTRAL.length).toBe(2);
    // A combining mark is a character of its own, as are both halves of a flag.
    expect(textLength('é')).toBe(2);
    expect(textLength('\u{1F1EB}\u{1F1F7}')).toBe(2);
    // A lone surrogate counts once.
    expect(textLength('\ud800')).toBe(1);
  });
});

describe('ProposalCardSchema / ProposalListSchema', () => {
  it('accepts a card before and after the second', () => {
    expect(ProposalCardSchema.safeParse(CARD).success).toBe(true);
    const fresh: Record<string, unknown> = { ...CARD, state: 'submitted', commentCount: 0 };
    delete fresh.seconder;
    delete fresh.deadline;
    expect(ProposalCardSchema.safeParse(fresh).success).toBe(true);
  });

  it('rejects null for an optional field, a stored `seconded` and a fractional id', () => {
    expect(ProposalCardSchema.safeParse({ ...CARD, seconder: null }).success).toBe(false);
    expect(ProposalCardSchema.safeParse({ ...CARD, deadline: null }).success).toBe(false);
    expect(ProposalCardSchema.safeParse({ ...CARD, state: 'seconded' }).success).toBe(false);
    expect(ProposalCardSchema.safeParse({ ...CARD, id: 1.5 }).success).toBe(false);
  });

  it('a list carries the cards and the Test timers switch', () => {
    expect(ProposalListSchema.safeParse({ proposals: [CARD], testTimers: true }).success).toBe(true);
    expect(ProposalListSchema.safeParse({ proposals: [] }).success).toBe(false);
  });

  it('a list may say older decided proposals exist and the floor is paused', () => {
    const paged = { proposals: [CARD], testTimers: false, moreDecided: true, floorPaused: true };
    expect(ProposalListSchema.parse(paged)).toEqual(paged);
    expect(ProposalListSchema.safeParse({ ...paged, moreDecided: null }).success).toBe(false);
    expect(ProposalListSchema.safeParse({ ...paged, floorPaused: 'yes' }).success).toBe(false);
  });
});

describe('ProposalDetailSchema and its parts', () => {
  it('accepts a proposal in debate, for an identified caller', () => {
    const parsed: ProposalDetail = ProposalDetailSchema.parse(DETAIL);
    expect(parsed.you?.consent).toBe('consented');
  });

  it('accepts a decided proposal, as an admin sees it once published', () => {
    const decided = {
      ...DETAIL,
      proposal: { ...CARD, state: 'building', objectionCount: 1 },
      tally: { yes: 4, no: 1, abstain: 1, eligible: 6, quorumMet: true },
      you: { ...YOU, consent: 'objected', vote: 'no', isAdmin: true },
      draft: { ...DRAFT_REQUEST, taskId: 10001 },
      taskId: 10001,
    };
    expect(ProposalDetailSchema.safeParse(decided).success).toBe(true);
  });

  it('carries the revision, and whether older comments exist or the floor is paused', () => {
    const current = { ...DETAIL, revision: 3, moreComments: true, floorPaused: true };
    expect(ProposalDetailSchema.parse(current)).toEqual(current);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, revision: 1.5 }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, revision: 0 }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, revision: undefined }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, moreComments: null }).success).toBe(false);
  });

  it('a page of comments says whether older ones exist', () => {
    const page = { comments: DETAIL.comments, moreComments: false };
    expect(ProposalCommentPageSchema.parse(page)).toEqual(page);
    expect(ProposalCommentPageSchema.safeParse({ comments: [] }).success).toBe(false);
  });

  it('accepts a signed-out view: no `you`, no counts', () => {
    const anonymous: Record<string, unknown> = { ...DETAIL };
    delete anonymous.you;
    delete anonymous.eligibleCount;
    delete anonymous.consentCount;
    expect(ProposalDetailSchema.safeParse(anonymous).success).toBe(true);
  });

  it('requires the thread and the timeline, and rejects nulls', () => {
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, comments: undefined }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, events: undefined }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, tally: null }).success).toBe(false);
    expect(ProposalDetailSchema.safeParse({ ...DETAIL, you: null }).success).toBe(false);
  });

  it('a timeline line may have no actor; a comment needs its author', () => {
    expect(ProposalEventSchema.safeParse({ at: 't', kind: 'lapsed', message: 'Nobody seconded it.' }).success).toBe(true);
    expect(ProposalEventSchema.safeParse({ at: 't', kind: 'lapsed', actor: null, message: 'm' }).success).toBe(false);
    expect(ProposalCommentSchema.safeParse({ id: 1, text: 'x', at: 't' }).success).toBe(false);
  });

  it('a tally has every count; `you` takes only known consents and votes', () => {
    expect(ProposalTallySchema.safeParse({ yes: 1, no: 1, abstain: 0, eligible: 3 }).success).toBe(false);
    expect(ProposalYouSchema.safeParse({ ...YOU, consent: 'abstained' }).success).toBe(false);
    expect(ProposalYouSchema.safeParse({ ...YOU, vote: 'maybe' }).success).toBe(false);
    const quiet: Record<string, unknown> = { ...YOU };
    delete quiet.consent;
    expect(ProposalYouSchema.safeParse(quiet).success).toBe(true);
  });
});

describe('DraftTaskSchema', () => {
  it('takes the draft as it starts: the whole pitch as the summary and no criteria yet', () => {
    const fresh = { ...DRAFT_REQUEST, civilianSummary: 'p'.repeat(PROPOSAL_LIMITS.pitch), acceptanceCriteria: [] };
    expect(DraftTaskSchema.safeParse(fresh).success).toBe(true);
  });

  it('reuses the task board enums', () => {
    expect(DraftTaskSchema.safeParse({ ...DRAFT_REQUEST, size: 'L' }).success).toBe(false);
    expect(DraftTaskSchema.safeParse({ ...DRAFT_REQUEST, tierFloor: 'T3' }).success).toBe(false);
    expect(DraftTaskSchema.safeParse({ ...DRAFT_REQUEST, rewardClass: 'R9' }).success).toBe(false);
    expect(DraftTaskSchema.safeParse({ ...DRAFT_REQUEST, taskId: 10001.5 }).success).toBe(false);
  });

  it('a request is the draft without taskId', () => {
    expect(Object.keys(DraftTaskRequestSchema.shape)).toEqual(
      Object.keys(DraftTaskSchema.shape).filter((field) => field !== 'taskId'),
    );
    expect(DraftTaskRequestSchema.parse({ ...DRAFT_REQUEST, taskId: 7 })).toEqual(DRAFT_REQUEST);
  });
});

describe('length limits on what members send', () => {
  const NEW: NewProposal = { title: 'A title', pitch: 'A pitch.' };
  const cases: [string, z.ZodTypeAny, object, string, number][] = [
    ['NewProposal.title', NewProposalSchema, NEW, 'title', PROPOSAL_LIMITS.title],
    ['NewProposal.pitch', NewProposalSchema, NEW, 'pitch', PROPOSAL_LIMITS.pitch],
    ['CommentRequest.text', CommentRequestSchema, { text: 'x' }, 'text', PROPOSAL_LIMITS.comment],
    ['DraftTaskRequest.title', DraftTaskRequestSchema, DRAFT_REQUEST, 'title', PROPOSAL_LIMITS.title],
    ['DraftTaskRequest.civilianSummary', DraftTaskRequestSchema, DRAFT_REQUEST, 'civilianSummary', PROPOSAL_LIMITS.summary],
  ];

  it.each(cases)('%s takes 1 to its limit in characters', (_name, schema, base, field, max) => {
    for (const char of ['a', ASTRAL]) {
      expect(takes(schema, base, field, '')).toBe(false);
      expect(takes(schema, base, field, char)).toBe(true);
      expect(takes(schema, base, field, char.repeat(max))).toBe(true);
      expect(takes(schema, base, field, char.repeat(max + 1))).toBe(false);
    }
    expect(takes(schema, base, field, undefined)).toBe(false);
  });

  it('the numbers are the contract numbers', () => {
    expect([PROPOSAL_LIMITS.title, PROPOSAL_LIMITS.pitch, PROPOSAL_LIMITS.comment]).toEqual([100, 4000, 2000]);
    expect([PROPOSAL_LIMITS.summary, PROPOSAL_LIMITS.criteria, PROPOSAL_LIMITS.criterion]).toEqual([500, 10, 300]);
  });

  it('a draft lists 1 to 10 acceptance criteria of 1 to 300 characters each', () => {
    const criteria = (count: number, text = 'It works'): string[] => Array.from({ length: count }, () => text);
    const field = 'acceptanceCriteria';
    expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, [])).toBe(false);
    expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, criteria(1))).toBe(true);
    expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, criteria(PROPOSAL_LIMITS.criteria))).toBe(true);
    expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, criteria(PROPOSAL_LIMITS.criteria + 1))).toBe(false);
    for (const char of ['a', ASTRAL]) {
      expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, criteria(1, char.repeat(PROPOSAL_LIMITS.criterion)))).toBe(true);
      expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, criteria(1, char.repeat(PROPOSAL_LIMITS.criterion + 1)))).toBe(false);
    }
    expect(takes(DraftTaskRequestSchema, DRAFT_REQUEST, field, ['Fine', ''])).toBe(false);
  });

  it('explains a limit in plain words', () => {
    const result = NewProposalSchema.safeParse({ title: 't'.repeat(101), pitch: '' });
    expect(result.success ? [] : result.error.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['title', 'Use 1 to 100 characters.'],
      ['pitch', 'Use 1 to 4000 characters.'],
    ]);
  });
});

describe('the other requests and the caller', () => {
  it('consent is a real boolean: true consents, false objects', () => {
    expect(ConsentRequestSchema.safeParse({ consent: true }).success).toBe(true);
    expect(ConsentRequestSchema.safeParse({ consent: false }).success).toBe(true);
    expect(ConsentRequestSchema.safeParse({ consent: 'false' }).success).toBe(false);
    expect(ConsentRequestSchema.safeParse({}).success).toBe(false);
  });

  it('a second names the revision it read: a positive integer', () => {
    expect(SecondRequestSchema.parse({ revision: 2 })).toEqual({ revision: 2 });
    for (const revision of ['2', 2.5, true, 0, -1, null]) {
      expect(SecondRequestSchema.safeParse({ revision }).success).toBe(false);
    }
    expect(SecondRequestSchema.safeParse({}).success).toBe(false);
  });

  it('the eligible set counts the last 30 days', () => {
    expect(ELIGIBLE_ACTIVITY_DAYS).toBe(30);
  });

  it('a vote is one of the three choices', () => {
    for (const choice of VOTE_CHOICES) {
      expect(VoteRequestSchema.safeParse({ choice }).success).toBe(true);
    }
    expect(VoteRequestSchema.safeParse({ choice: 'YES' }).success).toBe(false);
  });

  it('settings and the caller', () => {
    expect(ProposalSettingsSchema.safeParse({ testTimers: true }).success).toBe(true);
    expect(ProposalSettingsSchema.safeParse({}).success).toBe(false);
    expect(ProposalMeSchema.safeParse({ isAdmin: false, testTimers: false }).success).toBe(true);
    expect(ProposalMeSchema.safeParse({ isAdmin: true, activeProposalId: 12, testTimers: true }).success).toBe(true);
    expect(ProposalMeSchema.safeParse({ isAdmin: false, activeProposalId: null, testTimers: false }).success).toBe(false);
  });
});

describe('notifications', () => {
  const ITEM: Notification = {
    id: 3,
    kind: 'proposal_seconded',
    message: 'sam seconded "A map of every app on the wall". Debate is open.',
    href: '/propose/12',
    at: '2026-10-04T09:05:00Z',
    read: false,
  };

  it('a list is the items and the unread count', () => {
    expect(NotificationSchema.safeParse(ITEM).success).toBe(true);
    expect(NotificationListSchema.safeParse({ notifications: [ITEM, { ...ITEM, id: 2, read: true }], unread: 1 }).success).toBe(
      true,
    );
    expect(NotificationListSchema.safeParse({ notifications: [] }).success).toBe(false);
    expect(NotificationSchema.safeParse({ ...ITEM, kind: 'proposal_shipped' }).success).toBe(false);
  });

  it('marking read names the ids, or none for all of them', () => {
    expect(NotificationReadRequestSchema.safeParse({}).success).toBe(true);
    expect(NotificationReadRequestSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(NotificationReadRequestSchema.safeParse({ ids: ['1'] }).success).toBe(false);
    expect(NotificationReadRequestSchema.safeParse({ ids: [1.5] }).success).toBe(false);
    expect(NotificationReadRequestSchema.safeParse({ ids: null }).success).toBe(false);
  });
});
