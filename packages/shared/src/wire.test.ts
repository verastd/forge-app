/**
 * Field-for-field drift guard between these zod schemas and the Pydantic
 * models in apps/api/src/forge_api/models.py.
 *
 * tests/fixtures/wire-golden.json describes every Bridge, Proposals and
 * notifications model (field names, type, optional, enum values in order, and
 * length limits); apps/api/tests/test_wire_models.py holds the Pydantic side to
 * the same file. A field renamed, retyped, made optional, given a new enum
 * value or a different limit on one side only fails on both.
 *
 * An array's limits are read off it. A string's have to be found by asking the
 * schema, because characters are counted by a refinement (`textLength`) that
 * can't be read. The probe runs with plain letters and again with astral
 * characters, so a limit that counts UTF-16 units (zod's own .max()) instead
 * of characters fails here instead of disagreeing with the API.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as shared from './index.js';

interface FieldShape {
  type: string;
  optional?: true;
  values?: string[];
  items?: FieldShape;
  ref?: string;
  /** Characters (Unicode code points), for a string. */
  minLength?: number;
  maxLength?: number;
  /** Entries, for an array. */
  minItems?: number;
  maxItems?: number;
}

const golden = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/wire-golden.json', import.meta.url), 'utf8'),
) as { models: Record<string, Record<string, FieldShape>> };

/** Every exported `XSchema` that is a zod object, by model name `X`. */
const OBJECT_SCHEMAS = new Map<string, z.AnyZodObject>(
  Object.entries(shared).flatMap(([name, value]): [string, z.AnyZodObject][] =>
    name.endsWith('Schema') && value instanceof z.ZodObject ? [[name.slice(0, -'Schema'.length), value]] : [],
  ),
);
const NAMES = new Map<z.ZodTypeAny, string>([...OBJECT_SCHEMAS].map(([name, schema]) => [schema, name]));

/** More characters than any limit on the wire allows: a string that takes this many has no maximum. */
const UNLIMITED = 1 << 14;
/** No minimum on the wire is above this. */
const MOST_MIN = 16;
/** One character that is two UTF-16 units. */
const ASTRAL = '\u{1F600}';

/** The fewest and the most `char`s `schema` takes; no `max` when it takes UNLIMITED. */
function range(schema: z.ZodTypeAny, char: string): { min: number; max?: number } {
  const takes = (count: number): boolean => schema.safeParse(char.repeat(count)).success;
  let min = 0;
  while (!takes(min)) {
    min += 1;
    if (min > MOST_MIN) throw new Error('no wire shape for a string that takes no short text');
  }
  if (takes(UNLIMITED)) return { min };
  let taken = min;
  let refused = UNLIMITED;
  while (refused - taken > 1) {
    const middle = Math.floor((taken + refused) / 2);
    if (takes(middle)) taken = middle;
    else refused = middle;
  }
  return { min, max: taken };
}

function lengthLimits(schema: z.ZodTypeAny): Pick<FieldShape, 'minLength' | 'maxLength'> {
  const letters = range(schema, 'a');
  const astral = range(schema, ASTRAL);
  if (letters.min !== astral.min || letters.max !== astral.max) {
    throw new Error(
      `counts UTF-16 units, not characters: ${JSON.stringify(letters)} letters, ${JSON.stringify(astral)} astral`,
    );
  }
  return {
    ...(letters.min > 0 ? { minLength: letters.min } : {}),
    ...(letters.max === undefined ? {} : { maxLength: letters.max }),
  };
}

function shapeOf(schema: z.ZodTypeAny): FieldShape {
  if (schema instanceof z.ZodOptional) {
    return { ...shapeOf(schema.unwrap() as z.ZodTypeAny), optional: true };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'enum', values: [...(schema.options as string[])] };
  }
  if (schema instanceof z.ZodString || (schema instanceof z.ZodEffects && schema.innerType() instanceof z.ZodString)) {
    return { type: 'string', ...lengthLimits(schema) };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: schema.isInt ? 'integer' : 'number' };
  }
  if (schema instanceof z.ZodArray) {
    const { minLength, maxLength } = schema._def;
    return {
      type: 'array',
      items: shapeOf(schema.element as z.ZodTypeAny),
      ...(minLength === null ? {} : { minItems: minLength.value }),
      ...(maxLength === null ? {} : { maxItems: maxLength.value }),
    };
  }
  if (schema instanceof z.ZodObject) {
    return { type: 'object', ref: NAMES.get(schema) ?? 'an unexported object' };
  }
  throw new Error(`no wire shape for ${schema.constructor.name}`);
}

function describeSchema(schema: z.AnyZodObject): Record<string, FieldShape> {
  return Object.fromEntries(
    Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([field, value]) => [field, shapeOf(value)]),
  );
}

describe('wire shapes, against tests/fixtures/wire-golden.json', () => {
  it.each(Object.keys(golden.models))('%s matches its Pydantic mirror field for field', (name) => {
    const schema = OBJECT_SCHEMAS.get(name);
    expect(schema, `${name}Schema is exported`).toBeDefined();
    const described = describeSchema(schema as z.AnyZodObject);
    expect(described).toEqual(golden.models[name]);
    expect(Object.keys(described)).toEqual(Object.keys(golden.models[name] ?? {}));
  });

  it('covers every Bridge v2 schema', () => {
    const covered = new Set(Object.keys(golden.models));
    for (const name of [
      'RailMeta',
      'RailInfo',
      'RailList',
      'TaskDetail',
      'TaskList',
      'ForkStatus',
      'Credential',
      'DispatchRequest',
      'DispatchResult',
      'BridgeEvent',
      'BridgeStatus',
      'CheckRun',
      'CheckResults',
      'FeedbackResponse',
      'SubmitRequest',
      'SavedCredential',
      'SavedCredentialList',
      'ConnectedAgent',
      'ConnectedAgentList',
      'AuthorizeParams',
      'AuthorizeCheck',
      'AuthorizeError',
      'AuthorizeDecision',
      'FlagConfig',
    ]) {
      expect(covered.has(name), name).toBe(true);
    }
  });

  it('covers every Proposals and notifications schema', () => {
    const covered = new Set(Object.keys(golden.models));
    for (const name of [
      'ProposalCard',
      'ProposalList',
      'ProposalComment',
      'ProposalEvent',
      'ProposalTally',
      'ProposalYou',
      'DraftTask',
      'ProposalDetail',
      'NewProposal',
      'ConsentRequest',
      'VoteRequest',
      'CommentRequest',
      'DraftTaskRequest',
      'ProposalSettings',
      'ProposalMe',
      'Notification',
      'NotificationList',
      'NotificationReadRequest',
      'ProposalCommentPage',
      'SecondRequest',
    ]) {
      expect(covered.has(name), name).toBe(true);
    }
  });

  it('cannot describe a type the wire does not use', () => {
    expect(() => shapeOf(z.date())).toThrow('no wire shape');
    expect(() => shapeOf(z.number().refine((value) => value > 0))).toThrow('no wire shape');
    expect(() => shapeOf(z.string().refine(() => false))).toThrow('no wire shape');
    expect(shapeOf(z.object({}))).toEqual({ type: 'object', ref: 'an unexported object' });
  });

  it('reads limits, and a string limit has to count characters, not UTF-16 units', () => {
    expect(shapeOf(z.string().min(1))).toEqual({ type: 'string', minLength: 1 });
    expect(() => shapeOf(z.string().max(5))).toThrow('counts UTF-16 units');
    expect(shapeOf(z.array(z.boolean()).min(1).max(3))).toEqual({
      type: 'array',
      items: { type: 'boolean' },
      minItems: 1,
      maxItems: 3,
    });
    expect(shapeOf(shared.NewProposalSchema.shape.title)).toEqual({ type: 'string', minLength: 1, maxLength: 100 });
  });
});
