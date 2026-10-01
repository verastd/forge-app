/**
 * Field-for-field drift guard between these zod schemas and the Pydantic
 * models in apps/api/src/forge_api/models.py.
 *
 * tests/fixtures/wire-golden.json describes every Bridge model (field names,
 * type, optional, enum values in order); apps/api/tests/test_wire_models.py
 * holds the Pydantic side to the same file. A field renamed, retyped, made
 * optional or given a new enum value on one side only fails on both.
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

function shapeOf(schema: z.ZodTypeAny): FieldShape {
  if (schema instanceof z.ZodOptional) {
    return { ...shapeOf(schema.unwrap() as z.ZodTypeAny), optional: true };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'enum', values: [...(schema.options as string[])] };
  }
  if (schema instanceof z.ZodString) {
    return { type: 'string' };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: schema.isInt ? 'integer' : 'number' };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: shapeOf(schema.element as z.ZodTypeAny) };
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

  it('cannot describe a type the wire does not use', () => {
    expect(() => shapeOf(z.date())).toThrow('no wire shape');
    expect(shapeOf(z.object({}))).toEqual({ type: 'object', ref: 'an unexported object' });
  });
});
