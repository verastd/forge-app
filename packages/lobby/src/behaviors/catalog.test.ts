import { describe, expect, it } from 'vitest';

import { ACTION_MAX_LENGTH, MAX_ACTIONS_PER_SECOND, parseAction } from '../actions.js';
import type { LobbyActionKind } from '../actions.js';
import { BEHAVIORS, BEHAVIOR_STATES, behaviorById, behaviorForIntent, validateBehaviors } from './catalog.js';
import type { BehaviorEntry } from './catalog.js';

/** Every action kind the lobby sends today, from the wire format itself. */
const ACTION_KINDS: LobbyActionKind[] = ['wave', 'ball', 'throw', 'catch', 'bricks'];

function entry(changes: Partial<BehaviorEntry> = {}): BehaviorEntry {
  return {
    id: 'crates',
    title: 'Crates',
    flag: 'apps_lobby',
    intents: ['crate-push'],
    entityKinds: ['crate'],
    authority: 'world',
    budget: { entities: 10, bytesPerSecond: 2000, msPerTick: 2, intentsPerSecond: 4 },
    states: {
      requested: 'Pushing…',
      confirmed: 'Pushed',
      contested: 'Someone else got there first',
      rejected: "Couldn't push it",
      outOfRange: 'Too far to reach',
      paused: 'Crates are switched off for now',
    },
    confirmWithinMs: 800,
    wireVersion: 1,
    ...changes,
  };
}

describe('BEHAVIORS', () => {
  it('passes its own validator', () => {
    expect(() => validateBehaviors(BEHAVIORS)).not.toThrow();
  });

  it('gives every action kind the lobby sends to exactly one entry, under the lobby flag, at the wire’s own rate', () => {
    for (const kind of ACTION_KINDS) {
      const owners = BEHAVIORS.filter((b) => b.intents.includes(kind));
      expect(owners).toHaveLength(1);
      expect(owners[0]!.flag).toBe('apps_lobby');
      expect(owners[0]!.budget.intentsPerSecond).toBe(MAX_ACTIONS_PER_SECOND);
      expect(owners[0]!.budget.bytesPerSecond).toBeGreaterThanOrEqual(ACTION_MAX_LENGTH * MAX_ACTIONS_PER_SECOND);
    }
    const kinds = BEHAVIORS.flatMap((b) => b.intents);
    expect(kinds.sort()).toEqual([...ACTION_KINDS].sort());
  });

  it('names a real action kind in every intent', () => {
    for (const behavior of BEHAVIORS) {
      for (const intent of behavior.intents) {
        expect(ACTION_KINDS).toContain(intent);
      }
    }
    // The wire format agrees: a wave parses, and its kind is catalogued.
    const wave = parseAction(JSON.stringify({ v: 1, k: 'wave' }));
    expect(wave).not.toBeNull();
    expect(behaviorForIntent(wave!.kind)?.id).toBe('wave');
  });

  it('is frozen through and through', () => {
    expect(Object.isFrozen(BEHAVIORS)).toBe(true);
    for (const behavior of BEHAVIORS) {
      expect(Object.isFrozen(behavior)).toBe(true);
      expect(Object.isFrozen(behavior.states)).toBe(true);
      expect(Object.isFrozen(behavior.budget)).toBe(true);
      expect(Object.isFrozen(behavior.intents)).toBe(true);
    }
  });

  it('has copy for every state, so a press is never silent', () => {
    for (const behavior of BEHAVIORS) {
      for (const state of BEHAVIOR_STATES) {
        expect(behavior.states[state].trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('lookups', () => {
  it('finds an entry by intent or id, or null', () => {
    expect(behaviorForIntent('throw')?.id).toBe('catch-and-throw');
    expect(behaviorForIntent('dance')).toBeNull();
    expect(behaviorById('wave')?.title).toBe('Wave');
    expect(behaviorById('dance')).toBeNull();
    expect(behaviorForIntent('crate-push', [entry()])?.id).toBe('crates');
  });
});

describe('validateBehaviors', () => {
  it('accepts a complete entry beside the shipped ones', () => {
    expect(() => validateBehaviors([...BEHAVIORS, entry()])).not.toThrow();
  });

  it('refuses something that is not a list, or an entry that is not an object', () => {
    expect(() => validateBehaviors(null as unknown as BehaviorEntry[])).toThrow('not an array');
    expect(() => validateBehaviors(['wave' as unknown as BehaviorEntry])).toThrow('behaviors[0]: not an object');
  });

  const cases: Array<[string, Partial<BehaviorEntry>, string]> = [
    ['an id that is not a slug', { id: 'Crates!' }, 'id must be a slug'],
    ['a taken id', { id: 'wave' }, 'id wave is taken'],
    ['no title', { title: ' ' }, 'title must be'],
    ['a flag that is not a flag name', { flag: 'Apps Lobby' }, 'flag must be a flag name'],
    ['no intents', { intents: [] }, 'at least one action kind'],
    ['an intent that is not a kind', { intents: ['Push It'] }, 'is not a kind'],
    ['an intent another entry owns', { intents: ['throw'] }, 'already belongs to catch-and-throw'],
    ['entity kinds that are not kinds', { entityKinds: ['Crate'] }, 'entityKinds must be'],
    ['an unknown authority', { authority: 'me' as unknown as 'owner' }, 'authority must be'],
    ['a budget missing a number', { budget: { entities: 1 } as unknown as BehaviorEntry['budget'] }, 'budget must give'],
    ['a budget with no intents a second', { budget: { entities: 1, bytesPerSecond: 1, msPerTick: 1, intentsPerSecond: 0 } }, 'budget must give'],
    ['no states', { states: null as unknown as BehaviorEntry['states'] }, 'states must give copy'],
    ['a blank state', { states: { ...entry().states, rejected: '  ' } }, 'states.rejected must be'],
    ['state copy too long', { states: { ...entry().states, paused: 'x'.repeat(81) } }, 'states.paused must be'],
    ['a state that is not one', { states: { ...entry().states, loading: 'Loading' } as unknown as BehaviorEntry['states'] }, 'states.loading is not a state'],
    ['a confirm window too short', { confirmWithinMs: 50 }, 'confirmWithinMs must be'],
    ['a confirm window too long', { confirmWithinMs: 60_000 }, 'confirmWithinMs must be'],
    ['a wire version that is not a positive integer', { wireVersion: 0 }, 'wireVersion must be'],
  ];

  it.each(cases)('refuses %s', (_name, changes, message) => {
    expect(() => validateBehaviors([...BEHAVIORS, entry(changes)])).toThrow(message);
  });

  it('names every problem, with the entry’s index and id', () => {
    let message = '';
    try {
      validateBehaviors([entry({ id: 'Bad', title: '', wireVersion: -1 })]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('behaviors[0] (Bad): id must be a slug');
    expect(message).toContain('title must be');
    expect(message).toContain('wireVersion must be');
  });
});
