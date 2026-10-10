/**
 * The behaviour catalog: everything a robot can do in the cave besides move,
 * as data the kernel enforces.
 *
 * An entry is a behaviour's contract with the lobby: which intents it accepts
 * (the action kinds on the wire), which entity kinds it owns, whose word on
 * them is final, what it may cost (budget.ts), the flag that switches it off
 * without a deploy, and the words the screen shows for every state a press can
 * be in. `validateBehaviors` refuses an entry that leaves any of that out, the
 * way `validateRegistry` refuses an app, so the first community behaviour has
 * to pass the same door as the first two.
 *
 * The states are not optional. A press that shows nothing while its intent is
 * in flight is a defect: between the press and the outcome there is a gap, and
 * the gap has to be on screen (ADR-009).
 */

import { ACTION_MAX_LENGTH, MAX_ACTIONS_PER_SECOND } from '../actions.js';
import type { Authority } from './entity.js';
import { isBudget } from './budget.js';
import type { BehaviorBudget } from './budget.js';

/** Every state a behaviour's control can be in, from the press to the outcome. */
export const BEHAVIOR_STATES = ['requested', 'confirmed', 'contested', 'rejected', 'outOfRange', 'paused'] as const;
export type BehaviorStateName = (typeof BEHAVIOR_STATES)[number];

/** The copy the screen shows for each state: short, plain, present tense. */
export type BehaviorStates = Readonly<Record<BehaviorStateName, string>>;

export interface BehaviorEntry {
  /** A slug: lowercase letters, digits and hyphens. */
  id: string;
  title: string;
  /** The flag that switches it off (packages/flags). Named here, read by the shell. */
  flag: string;
  /** The action kinds it accepts. Each kind belongs to exactly one entry. */
  intents: readonly string[];
  /** The entity kinds it may own. */
  entityKinds: readonly string[];
  /** Whose word on its entities is final today. */
  authority: Authority;
  budget: BehaviorBudget;
  states: BehaviorStates;
  /** How soon after `requested` the screen must show an outcome, in ms. */
  confirmWithinMs: number;
  /** The version byte or field its messages carry. A new layout takes a new number. */
  wireVersion: number;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const FLAG = /^[a-z][a-z0-9_]{2,40}$/;
const KIND = /^[a-z][a-z0-9-]{0,15}$/;
const STATE_MAX_CHARS = 80;
const CONFIRM_MS = Object.freeze({ min: 100, max: 10_000 });

/** The lobby's behaviours today: a wave, catch-and-throw (actions.ts, play.ts), and building bricks (bricks.ts). */
export const BEHAVIORS: readonly BehaviorEntry[] = deepFreeze<readonly BehaviorEntry[]>([
  {
    id: 'wave',
    title: 'Wave',
    flag: 'apps_lobby',
    intents: ['wave'],
    entityKinds: [],
    authority: 'owner',
    budget: { entities: 0, bytesPerSecond: ACTION_MAX_LENGTH * MAX_ACTIONS_PER_SECOND, msPerTick: 1, intentsPerSecond: MAX_ACTIONS_PER_SECOND },
    states: {
      requested: 'Waving…',
      confirmed: 'Waved',
      contested: 'Waved',
      rejected: "Couldn't wave right now",
      outOfRange: 'Nobody close enough to see',
      paused: 'Waving is switched off for now',
    },
    confirmWithinMs: 500,
    wireVersion: 1,
  },
  {
    id: 'catch-and-throw',
    title: 'Catch and throw',
    flag: 'apps_lobby',
    intents: ['ball', 'throw', 'catch'],
    entityKinds: ['ball'],
    authority: 'owner',
    budget: { entities: 64, bytesPerSecond: ACTION_MAX_LENGTH * MAX_ACTIONS_PER_SECOND * 4, msPerTick: 2, intentsPerSecond: MAX_ACTIONS_PER_SECOND },
    states: {
      requested: 'Throwing…',
      confirmed: 'Caught',
      contested: 'Two of you went for it',
      rejected: 'Missed',
      outOfRange: 'Nobody in range to throw to',
      paused: 'Catch is switched off for now',
    },
    confirmWithinMs: 3500,
    wireVersion: 1,
  },
  {
    id: 'bricks',
    title: 'Building bricks',
    flag: 'apps_lobby',
    // Only a ping: the API keeps the bricks and has the last word (bricks.ts).
    intents: ['bricks'],
    entityKinds: ['brick'],
    authority: 'world',
    budget: { entities: 5000, bytesPerSecond: ACTION_MAX_LENGTH * MAX_ACTIONS_PER_SECOND, msPerTick: 2, intentsPerSecond: MAX_ACTIONS_PER_SECOND },
    states: {
      requested: 'Placing…',
      confirmed: 'Placed',
      contested: 'Taken: someone got it first',
      rejected: 'It doesn’t fit there',
      outOfRange: 'Too far away to reach',
      paused: 'Building is switched off for now',
    },
    confirmWithinMs: 3000,
    wireVersion: 1,
  },
]);

/** The entry that accepts `intent`, or null. */
export function behaviorForIntent(intent: string, entries: readonly BehaviorEntry[] = BEHAVIORS): BehaviorEntry | null {
  return entries.find((entry) => entry.intents.includes(intent)) ?? null;
}

/** The entry with `id`, or null. */
export function behaviorById(id: string, entries: readonly BehaviorEntry[] = BEHAVIORS): BehaviorEntry | null {
  return entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Throws, naming every problem, unless every entry is complete: a slug id,
 * a title, a flag name, at least one intent (no intent in two entries), kinds
 * that are kinds, a known authority, a budget `isBudget` accepts, copy for
 * every state, a confirm window from 100 ms to 10 s, and a positive integer
 * wire version. The lobby calls it on BEHAVIORS at start-up, and a test calls
 * it on every change.
 */
export function validateBehaviors(entries: readonly BehaviorEntry[]): void {
  if (!Array.isArray(entries)) {
    throw new Error('Behaviour catalog is invalid: it is not an array');
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  const intents = new Map<string, string>();
  entries.forEach((raw: unknown, index) => {
    const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    const label = entry && typeof entry.id === 'string' ? ` (${entry.id})` : '';
    for (const problem of entryProblems(entry, ids, intents)) {
      problems.push(`behaviors[${index}]${label}: ${problem}`);
    }
  });
  if (problems.length > 0) {
    throw new Error(`Behaviour catalog is invalid:\n- ${problems.join('\n- ')}`);
  }
}

function entryProblems(entry: Record<string, unknown> | null, ids: Set<string>, intents: Map<string, string>): string[] {
  if (entry === null) return ['not an object'];
  const problems: string[] = [];
  const id = entry.id;
  if (typeof id !== 'string' || !SLUG.test(id)) {
    problems.push(`id must be a slug (got ${show(id)})`);
  } else if (ids.has(id)) {
    problems.push(`id ${id} is taken`);
  } else {
    ids.add(id);
  }
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    problems.push('title must be a non-empty string');
  }
  if (typeof entry.flag !== 'string' || !FLAG.test(entry.flag)) {
    problems.push(`flag must be a flag name (got ${show(entry.flag)})`);
  }
  if (!Array.isArray(entry.intents) || entry.intents.length === 0) {
    problems.push('intents must list at least one action kind');
  } else {
    for (const intent of entry.intents as unknown[]) {
      if (typeof intent !== 'string' || !KIND.test(intent)) {
        problems.push(`intent ${show(intent)} is not a kind`);
      } else if (intents.has(intent)) {
        problems.push(`intent ${intent} already belongs to ${intents.get(intent)}`);
      } else if (typeof id === 'string') {
        intents.set(intent, id);
      }
    }
  }
  if (!Array.isArray(entry.entityKinds) || (entry.entityKinds as unknown[]).some((kind) => typeof kind !== 'string' || !KIND.test(kind))) {
    problems.push('entityKinds must be a list of kinds');
  }
  if (entry.authority !== 'owner' && entry.authority !== 'world') {
    problems.push(`authority must be owner or world (got ${show(entry.authority)})`);
  }
  if (!isBudget(entry.budget)) {
    problems.push('budget must give entities, bytesPerSecond, msPerTick and intentsPerSecond (at least 1)');
  }
  const states = typeof entry.states === 'object' && entry.states !== null ? (entry.states as Record<string, unknown>) : null;
  if (states === null) {
    problems.push('states must give copy for every state');
  } else {
    for (const name of BEHAVIOR_STATES) {
      const copy = states[name];
      if (typeof copy !== 'string' || copy.trim() === '' || copy.length > STATE_MAX_CHARS) {
        problems.push(`states.${name} must be 1 to ${STATE_MAX_CHARS} characters of copy`);
      }
    }
    for (const name of Object.keys(states)) {
      if (!(BEHAVIOR_STATES as readonly string[]).includes(name)) {
        problems.push(`states.${name} is not a state`);
      }
    }
  }
  const confirm = entry.confirmWithinMs;
  if (typeof confirm !== 'number' || !Number.isFinite(confirm) || confirm < CONFIRM_MS.min || confirm > CONFIRM_MS.max) {
    problems.push(`confirmWithinMs must be ${CONFIRM_MS.min} to ${CONFIRM_MS.max} (got ${show(confirm)})`);
  }
  if (!Number.isInteger(entry.wireVersion) || (entry.wireVersion as number) < 1) {
    problems.push(`wireVersion must be a positive integer (got ${show(entry.wireVersion)})`);
  }
  return problems;
}

function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
