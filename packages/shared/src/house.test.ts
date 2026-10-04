/**
 * The house model's wire types (Phase 6 contract §2): HouseSpec, HouseDraft,
 * ProposalDetail.house and the `house_drafted` timeline line.
 *
 * wire.test.ts holds each schema here to its pydantic mirror field for field,
 * limits included (tests/fixtures/wire-golden.json); this file pins the
 * vocabularies and what each schema takes, with the contract's numbers written
 * out, so a wrong limit fails here on its own. apps/api/tests/test_house_models.py
 * runs the same cases against the pydantic models.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  DraftTaskRequestSchema,
  HOUSE_FAILURE_REASONS,
  HOUSE_OFF_REASONS,
  HOUSE_REASONS,
  HOUSE_SPEC_LIMITS,
  HOUSE_STATUSES,
  HOUSE_VERDICTS,
  HouseDraftSchema,
  HouseReasonSchema,
  HouseSpecSchema,
  HouseStatusSchema,
  HouseVerdictSchema,
  PROPOSAL_EVENT_KINDS,
  ProposalDetailSchema,
  ProposalEventSchema,
  SIZES,
  TIER_FLOORS,
} from './index.js';
import type { HouseDraft, HouseSpec, ProposalDetail } from './index.js';

/** One character that is two UTF-16 units. */
const ASTRAL = '\u{1F3DB}';

const SPEC: HouseSpec = {
  title: 'A map of every app on the wall',
  civilianSummary: 'One page that lists every app on the wall, with a link to each.',
  acceptanceCriteria: ['/apps/map lists every lit panel by name', 'Each entry links to its app'],
  size: 'S',
  tierFloor: 'T0',
  scopeIn: ['apps/web/src/app/apps/map/**', 'tests/e2e/map.spec.ts'],
  scopeOut: ['apps/api/'],
  risks: ['The panel list is written by hand in the lobby for now.'],
  questions: ['Should panels that are switched off be listed too?'],
  verdict: 'ready',
  verdictReason: 'Small, testable, and all of it in apps/web.',
};

const DONE: HouseDraft = {
  status: 'done',
  spec: SPEC,
  model: 'house-test-model',
  draftedAt: '2026-10-04T12:00:00Z',
  appliedToDraft: true,
};

const DETAIL = {
  proposal: {
    id: 12,
    title: 'A map of every app on the wall',
    state: 'passed',
    mover: 'maya',
    movedAt: '2026-10-01T09:00:00Z',
    seconder: 'sam',
    commentCount: 0,
    objectionCount: 0,
  },
  pitch: 'Show every app on one page.',
  comments: [],
  events: [{ at: '2026-10-04T09:00:00Z', kind: 'passed', message: 'It passed by consent.' }],
  revision: 1,
};

const DRAFT = {
  title: SPEC.title,
  civilianSummary: SPEC.civilianSummary,
  acceptanceCriteria: SPEC.acceptanceCriteria,
  size: SPEC.size,
  tierFloor: 'T0',
  rewardClass: 'R1',
};

/** Whether `schema` takes `base` with `field` set to `value` (`undefined`: left out). */
function takes(schema: z.ZodTypeAny, base: object, field: string, value: unknown): boolean {
  const payload: Record<string, unknown> = { ...base, [field]: value };
  if (value === undefined) delete payload[field];
  return schema.safeParse(payload).success;
}

const entries = (count: number, text = 'It works'): string[] => Array.from({ length: count }, () => text);

describe('house vocabularies', () => {
  it('the verdicts, statuses and reasons, in order', () => {
    expect(HOUSE_VERDICTS).toEqual(['ready', 'needs_clarification', 'not_feasible']);
    expect(HouseVerdictSchema.options).toEqual([...HOUSE_VERDICTS]);
    expect(HOUSE_STATUSES).toEqual(['off', 'queued', 'running', 'done', 'failed']);
    expect(HouseStatusSchema.options).toEqual([...HOUSE_STATUSES]);
    expect(HOUSE_OFF_REASONS).toEqual(['not_configured', 'switched_off']);
    expect(HOUSE_FAILURE_REASONS).toEqual([
      'refused',
      'invalid_output',
      'unavailable',
      'too_large',
      'bad_request',
      'daily_limit',
    ]);
    expect(HOUSE_REASONS).toEqual([...HOUSE_OFF_REASONS, ...HOUSE_FAILURE_REASONS]);
    expect(HouseReasonSchema.options).toEqual([...HOUSE_REASONS]);
  });

  it('rejects anything outside them, case included', () => {
    for (const verdict of HOUSE_VERDICTS) expect(HouseVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(HouseVerdictSchema.safeParse('maybe').success).toBe(false);
    expect(HouseVerdictSchema.safeParse('Ready').success).toBe(false);
    expect(HouseStatusSchema.safeParse('cancelled').success).toBe(false);
    expect(HouseStatusSchema.safeParse('').success).toBe(false);
    expect(HouseReasonSchema.safeParse('timeout').success).toBe(false);
    expect(HouseReasonSchema.safeParse('DAILY_LIMIT').success).toBe(false);
  });

  it('house_drafted is the last timeline kind, and a public line takes it', () => {
    expect(PROPOSAL_EVENT_KINDS[PROPOSAL_EVENT_KINDS.length - 1]).toBe('house_drafted');
    expect(PROPOSAL_EVENT_KINDS.filter((kind) => kind === 'house_drafted')).toHaveLength(1);
    const line = {
      at: '2026-10-04T12:00:00Z',
      kind: 'house_drafted',
      message: "FORGE's house model drafted the task from this proposal.",
    };
    expect(ProposalEventSchema.parse(line)).toEqual(line);
  });

  it('the limits are the contract numbers', () => {
    expect(HOUSE_SPEC_LIMITS).toEqual({
      title: 100,
      summary: 500,
      criteria: 10,
      criterion: 300,
      scope: 20,
      path: 200,
      risks: 10,
      risk: 300,
      questions: 10,
      question: 300,
      verdictReason: 500,
    });
  });

  it('a spec at every limit still fits the draft task it fills', () => {
    const longest: HouseSpec = {
      ...SPEC,
      title: ASTRAL.repeat(HOUSE_SPEC_LIMITS.title),
      civilianSummary: ASTRAL.repeat(HOUSE_SPEC_LIMITS.summary),
      acceptanceCriteria: entries(HOUSE_SPEC_LIMITS.criteria, ASTRAL.repeat(HOUSE_SPEC_LIMITS.criterion)),
    };
    expect(HouseSpecSchema.safeParse(longest).success).toBe(true);
    const { title, civilianSummary, acceptanceCriteria, size } = longest;
    const draft = { title, civilianSummary, acceptanceCriteria, size, tierFloor: 'T0', rewardClass: 'R1' };
    expect(DraftTaskRequestSchema.safeParse(draft).success).toBe(true);
  });
});

describe('HouseSpecSchema', () => {
  it('round-trips a spec unchanged', () => {
    expect(HouseSpecSchema.parse(SPEC)).toEqual(SPEC);
    expect(HouseSpecSchema.parse(JSON.parse(JSON.stringify(SPEC)))).toEqual(SPEC);
  });

  it('takes empty scope, risks and questions', () => {
    const bare: HouseSpec = { ...SPEC, scopeIn: [], scopeOut: [], risks: [], questions: [] };
    expect(HouseSpecSchema.parse(bare)).toEqual(bare);
  });

  it('drops a key it does not know, as the pydantic model does', () => {
    expect(HouseSpecSchema.parse({ ...SPEC, rewardClass: 'R4' })).toEqual(SPEC);
  });

  it.each(Object.keys(SPEC))('requires %s, and never takes null for it', (field) => {
    expect(takes(HouseSpecSchema, SPEC, field, undefined)).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, field, null)).toBe(false);
  });

  it('size and tierFloor are the task board enums; the verdict is one of three', () => {
    for (const size of SIZES) expect(takes(HouseSpecSchema, SPEC, 'size', size)).toBe(true);
    expect(SIZES).toEqual(['XS', 'S', 'M']);
    expect(takes(HouseSpecSchema, SPEC, 'size', 'L')).toBe(false);
    for (const tier of TIER_FLOORS) expect(takes(HouseSpecSchema, SPEC, 'tierFloor', tier)).toBe(true);
    expect(TIER_FLOORS).toEqual(['T0', 'T1', 'T2']);
    expect(takes(HouseSpecSchema, SPEC, 'tierFloor', 'T3')).toBe(false);
    for (const verdict of HOUSE_VERDICTS) expect(takes(HouseSpecSchema, SPEC, 'verdict', verdict)).toBe(true);
    expect(takes(HouseSpecSchema, SPEC, 'verdict', 'needs clarification')).toBe(false);
  });

  it('refuses a value of the wrong type rather than reading it', () => {
    expect(takes(HouseSpecSchema, SPEC, 'title', 42)).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, 'civilianSummary', ['One page.'])).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, 'acceptanceCriteria', 'It works')).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, 'risks', [1])).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, 'scopeIn', { 0: 'apps/web/' })).toBe(false);
  });

  const TEXTS: [string, number][] = [
    ['title', 100],
    ['civilianSummary', 500],
    ['verdictReason', 500],
  ];

  it.each(TEXTS)('%s takes 1 to %i characters', (field, most) => {
    for (const char of ['a', ASTRAL]) {
      expect(takes(HouseSpecSchema, SPEC, field, '')).toBe(false);
      expect(takes(HouseSpecSchema, SPEC, field, char)).toBe(true);
      expect(takes(HouseSpecSchema, SPEC, field, char.repeat(most))).toBe(true);
      expect(takes(HouseSpecSchema, SPEC, field, char.repeat(most + 1))).toBe(false);
    }
  });

  const LISTS: [string, number, number, number][] = [
    ['acceptanceCriteria', 1, 10, 300],
    ['scopeIn', 0, 20, 200],
    ['scopeOut', 0, 20, 200],
    ['risks', 0, 10, 300],
    ['questions', 0, 10, 300],
  ];

  it.each(LISTS)('%s holds %i to %i entries of 1 to %i characters', (field, fewest, most, longest) => {
    if (fewest > 0) expect(takes(HouseSpecSchema, SPEC, field, entries(fewest - 1))).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, field, entries(fewest))).toBe(true);
    expect(takes(HouseSpecSchema, SPEC, field, entries(most))).toBe(true);
    expect(takes(HouseSpecSchema, SPEC, field, entries(most + 1))).toBe(false);
    for (const char of ['a', ASTRAL]) {
      expect(takes(HouseSpecSchema, SPEC, field, [char.repeat(longest)])).toBe(true);
      expect(takes(HouseSpecSchema, SPEC, field, [char.repeat(longest + 1)])).toBe(false);
    }
    expect(takes(HouseSpecSchema, SPEC, field, ['Fine', ''])).toBe(false);
    expect(takes(HouseSpecSchema, SPEC, field, ['Fine', null])).toBe(false);
  });

  it('explains a limit in plain words', () => {
    const result = HouseSpecSchema.safeParse({ ...SPEC, title: 't'.repeat(101), scopeIn: [''] });
    expect(result.success ? [] : result.error.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['title', 'Use 1 to 100 characters.'],
      ['scopeIn.0', 'Use 1 to 200 characters.'],
    ]);
  });
});

describe('HouseDraftSchema', () => {
  /** What describes a spec that succeeded. */
  const SAVED = { model: 'house-test-model', draftedAt: '2026-10-04T12:00:00Z' };

  it('round-trips the house at every status', () => {
    const drafts: HouseDraft[] = [
      { status: 'off', reason: 'not_configured' },
      { status: 'off', reason: 'switched_off' },
      { status: 'queued' },
      { status: 'running' },
      // A new draft on its way keeps showing the latest one that succeeded.
      { status: 'queued', spec: SPEC, ...SAVED, appliedToDraft: false },
      { status: 'running', spec: SPEC, ...SAVED, appliedToDraft: true },
      DONE,
      { status: 'done', spec: SPEC, ...SAVED, appliedToDraft: false },
      { status: 'failed', reason: 'daily_limit' },
      { status: 'failed', reason: 'refused', spec: SPEC, ...SAVED, appliedToDraft: true },
    ];
    for (const draft of drafts) {
      expect(HouseDraftSchema.parse(draft)).toEqual(draft);
      expect(HouseDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    }
  });

  it('needs only its status', () => {
    expect(HouseDraftSchema.parse({ status: 'queued' })).toEqual({ status: 'queued' });
    expect(HouseDraftSchema.safeParse({}).success).toBe(false);
    expect(HouseDraftSchema.safeParse({ ...DONE, status: undefined }).success).toBe(false);
    expect(HouseDraftSchema.safeParse({ ...DONE, status: null }).success).toBe(false);
  });

  it.each(['reason', 'spec', 'model', 'draftedAt', 'appliedToDraft'])('%s is optional: absent, never null', (field) => {
    const full = { ...DONE, reason: 'refused' };
    expect(takes(HouseDraftSchema, full, field, undefined)).toBe(true);
    expect(takes(HouseDraftSchema, full, field, null)).toBe(false);
  });

  it('takes only the statuses and reasons it knows', () => {
    for (const status of HOUSE_STATUSES) expect(takes(HouseDraftSchema, DONE, 'status', status)).toBe(true);
    for (const reason of HOUSE_REASONS) expect(takes(HouseDraftSchema, DONE, 'reason', reason)).toBe(true);
    expect(takes(HouseDraftSchema, DONE, 'status', 'drafting')).toBe(false);
    expect(takes(HouseDraftSchema, DONE, 'reason', 'timeout')).toBe(false);
  });

  it('every reason is either an off reason or a failure reason', () => {
    const off: readonly string[] = HOUSE_OFF_REASONS;
    expect(HOUSE_FAILURE_REASONS.filter((reason) => off.includes(reason))).toEqual([]);
    expect(new Set(HOUSE_REASONS).size).toBe(8);
  });

  it('appliedToDraft is a real boolean, and the model and time are text', () => {
    for (const value of [1, 0, 'true', 'false']) {
      expect(takes(HouseDraftSchema, DONE, 'appliedToDraft', value)).toBe(false);
    }
    expect(takes(HouseDraftSchema, DONE, 'model', 5)).toBe(false);
    expect(takes(HouseDraftSchema, DONE, 'draftedAt', 1759579200000)).toBe(false);
  });

  it('its spec is held to the spec limits', () => {
    expect(takes(HouseDraftSchema, DONE, 'spec', { ...SPEC, acceptanceCriteria: [] })).toBe(false);
    expect(takes(HouseDraftSchema, DONE, 'spec', { ...SPEC, title: 't'.repeat(101) })).toBe(false);
    expect(takes(HouseDraftSchema, DONE, 'spec', { ...SPEC, verdict: 'unsure' })).toBe(false);
  });
});

describe('ProposalDetailSchema.house', () => {
  it('is optional: a detail without it parses as before, and gains no key', () => {
    const parsed = ProposalDetailSchema.parse(DETAIL);
    expect(parsed).toEqual(DETAIL);
    expect('house' in parsed).toBe(false);
  });

  it("carries the house's draft for an admin, next to the draft task, and round-trips", () => {
    const admin: ProposalDetail = ProposalDetailSchema.parse({
      ...DETAIL,
      events: [
        ...DETAIL.events,
        { at: '2026-10-04T12:00:00Z', kind: 'house_drafted', message: "FORGE's house model drafted the task." },
      ],
      draft: DRAFT,
      house: DONE,
    });
    expect(admin.house).toEqual(DONE);
    expect(ProposalDetailSchema.parse(JSON.parse(JSON.stringify(admin)))).toEqual(admin);
    const fields = Object.keys(ProposalDetailSchema.shape);
    expect(fields.indexOf('house')).toBe(fields.indexOf('draft') + 1);
  });

  it('once building or shipped too, and while the house is off', () => {
    for (const state of ['building', 'shipped']) {
      const later = { ...DETAIL, proposal: { ...DETAIL.proposal, state }, taskId: 10001, house: DONE };
      expect(ProposalDetailSchema.parse(later)).toEqual(later);
    }
    const off = { ...DETAIL, house: { status: 'off', reason: 'switched_off' } };
    expect(ProposalDetailSchema.parse(off)).toEqual(off);
  });

  it('refuses a null house, and a house without its status', () => {
    expect(takes(ProposalDetailSchema, DETAIL, 'house', null)).toBe(false);
    expect(takes(ProposalDetailSchema, DETAIL, 'house', {})).toBe(false);
    expect(takes(ProposalDetailSchema, DETAIL, 'house', { status: 'done', spec: { ...SPEC, title: '' } })).toBe(false);
  });
});
