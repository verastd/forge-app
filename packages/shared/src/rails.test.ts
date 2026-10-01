/**
 * The rail registry, held to tests/fixtures/rails-golden.json: the file
 * apps/api/tests/test_rails.py reads too, so the two registries cannot drift.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OPEN_RAILS, RAILS, RailMetaSchema, START_RAILS } from './index.js';
import { RAIL_REGISTRY, ROUTINE_PROMPT, isStartRail, railMeta } from './rails.js';

const golden = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/rails-golden.json', import.meta.url), 'utf8'),
) as { rails: unknown[]; routinePrompt: string };

/** Words the copy must not use (contract §2 copy rules). "pull request" is fine. */
const JARGON = /\b(PRs?|CI|leases?|MCP)\b/;

describe('RAIL_REGISTRY', () => {
  it('matches the golden exactly, in display order', () => {
    expect(Object.keys(golden)).toEqual(['rails', 'routinePrompt']);
    expect(RAIL_REGISTRY).toStrictEqual(golden.rails);
  });

  it('is every rail once: the start rails, then the open rails', () => {
    expect(RAIL_REGISTRY.map((meta) => meta.id)).toEqual([...RAILS]);
    expect(RAIL_REGISTRY.filter((meta) => meta.mode === 'start').map((meta) => meta.id)).toEqual([...START_RAILS]);
    expect(RAIL_REGISTRY.filter((meta) => meta.mode === 'open').map((meta) => meta.id)).toEqual([...OPEN_RAILS]);
  });

  it('every entry is a valid RailMeta', () => {
    for (const meta of RAIL_REGISTRY) {
      expect(RailMetaSchema.parse(meta)).toStrictEqual(meta);
    }
  });

  it('start rails say which credential and where the key comes from', () => {
    for (const meta of RAIL_REGISTRY) {
      if (meta.mode === 'start') {
        expect(meta.credential, meta.id).toBeDefined();
        expect(meta.keyUrl === undefined, meta.id).toBe(meta.id === 'copilot');
      } else {
        expect(meta.credential, meta.id).toBeUndefined();
        expect(meta.keyUrl, meta.id).toBeUndefined();
      }
    }
  });

  it('the copy has no jargon', () => {
    const texts = RAIL_REGISTRY.flatMap((meta) => [meta.label, meta.vendor, meta.blurb, meta.plan ?? '', ...meta.setup]);
    for (const text of [...texts, ROUTINE_PROMPT]) {
      expect(text).not.toMatch(JARGON);
    }
  });

  it('is frozen, so no caller can change it for the others', () => {
    const jules = railMeta('jules');
    expect(Object.isFrozen(RAIL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(jules)).toBe(true);
    expect(() => (jules.setup as string[]).push('Changed by a caller.')).toThrow(TypeError);
    expect({ ...jules, enabled: true }.enabled).toBe(true);
  });
});

describe('railMeta / isStartRail', () => {
  it('finds each rail by id', () => {
    for (const meta of RAIL_REGISTRY) {
      expect(railMeta(meta.id)).toBe(meta);
      expect(isStartRail(meta.id)).toBe(meta.mode === 'start');
    }
  });

  it('throws for an id that is not a rail', () => {
    expect(() => railMeta('gemini-cli' as never)).toThrow('unknown rail: gemini-cli');
    expect(isStartRail('gemini-cli' as never)).toBe(false);
  });
});

describe('ROUTINE_PROMPT', () => {
  it('matches the golden', () => {
    expect(ROUTINE_PROMPT).toBe(golden.routinePrompt);
  });

  it('opts in to the fired brief, only a FORGE brief, only in the fork', () => {
    expect(ROUTINE_PROMPT).toContain('routine-fire-payload');
    expect(ROUTINE_PROMPT).toContain('starts with "FORGE task #"');
    expect(ROUTINE_PROMPT).toContain('the branch the brief names');
    for (const refused of ['secrets', 'another repository', 'settings', '.github/']) {
      expect(ROUTINE_PROMPT).toContain(refused);
    }
  });
});
