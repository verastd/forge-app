/**
 * A behaviour's budget, and the meter that holds it to one.
 *
 * A creative platform dies by one popular behaviour eating the room, so every
 * catalog entry declares how much it may cost (catalog.ts) and the kernel
 * meters it: intents per member per second, bytes per second room-wide, how
 * many entities it may own, and how long its step may take. Past a budget the
 * behaviour is paused, not the lobby, with a reason the panel can show; a
 * flag turns it off without a deploy, and the world participant can resume it.
 *
 * Pure, like everything in @forge/lobby: callers pass the time in.
 */

export interface BehaviorBudget {
  /** The most entities the behaviour may own at once, room-wide. */
  entities: number;
  /** The most bytes of its messages the room accepts in any one second. */
  bytesPerSecond: number;
  /** The most milliseconds its step may take in one tick before it is paused. */
  msPerTick: number;
  /** The most intents one member may send in any one second. */
  intentsPerSecond: number;
}

export type PauseReason = 'entities' | 'bytes' | 'tick' | 'flag' | 'operator';

export interface Pause {
  reason: PauseReason;
  /** When it was paused (ms on the caller's clock), so a panel can say for how long. */
  at: number;
}

/** Why an intent was not taken, or `accepted`. */
export type IntentVerdict = 'accepted' | 'paused' | 'member-rate' | 'bytes';

export interface BehaviorMeter {
  readonly budget: BehaviorBudget;
  /** Each member's accepted intent times (ms) within the last second, oldest first. */
  readonly recentByMember: Map<string, number[]>;
  /** Accepted (time, bytes) within the last second, oldest first. */
  readonly recentBytes: Array<[number, number]>;
  /** Milliseconds of the last ticks, newest last, at most TICK_WINDOW of them. */
  readonly ticks: number[];
  entities: number;
  paused: Pause | null;
}

const WINDOW_MS = 1000;
/** A step over budget this many ticks in a row pauses the behaviour… */
export const TICK_WINDOW = 5;
/** …and a single step this many times over budget pauses it at once. */
export const TICK_SPIKE = 4;

export function createBehaviorMeter(budget: BehaviorBudget): BehaviorMeter {
  return { budget, recentByMember: new Map(), recentBytes: [], ticks: [], entities: 0, paused: null };
}

function expire(times: number[], now: number): void {
  if (times.length > 0 && now < (times[times.length - 1] as number)) {
    times.length = 0;
    return;
  }
  let expired = 0;
  while (expired < times.length && (times[expired] as number) <= now - WINDOW_MS) {
    expired += 1;
  }
  times.splice(0, expired);
}

/**
 * Whether to take an intent of `bytes` from `member` arriving at `now` (ms, a
 * monotonic clock). Refused while paused, past the member's rate, or past the
 * room's bytes; a refused intent counts against nothing. A time that is not a
 * finite number is refused, and a clock that went backwards starts the windows
 * over.
 */
export function acceptIntent(meter: BehaviorMeter, member: string, bytes: number, now: number): IntentVerdict {
  if (!Number.isFinite(now) || !Number.isFinite(bytes) || bytes < 0) return 'member-rate';
  if (meter.paused !== null) return 'paused';
  let times = meter.recentByMember.get(member);
  if (times === undefined) {
    times = [];
    meter.recentByMember.set(member, times);
  }
  expire(times, now);
  if (times.length >= meter.budget.intentsPerSecond) return 'member-rate';
  const newest = meter.recentBytes[meter.recentBytes.length - 1];
  if (newest !== undefined && now < newest[0]) meter.recentBytes.length = 0;
  while (meter.recentBytes.length > 0 && (meter.recentBytes[0] as [number, number])[0] <= now - WINDOW_MS) {
    meter.recentBytes.shift();
  }
  const used = meter.recentBytes.reduce((sum, [, size]) => sum + size, 0);
  if (used + bytes > meter.budget.bytesPerSecond) return 'bytes';
  times.push(now);
  meter.recentBytes.push([now, bytes]);
  return 'accepted';
}

/** Drops a member who has left, so the meter never outgrows the room. */
export function forgetMember(meter: BehaviorMeter, member: string): void {
  meter.recentByMember.delete(member);
}

/**
 * Records that the behaviour's step took `ms` this tick, at `now`. Pauses it
 * (reason `tick`) on a single step TICK_SPIKE times over budget, or on
 * TICK_WINDOW steps in a row over it. Returns the pause, or null.
 */
export function recordTick(meter: BehaviorMeter, ms: number, now: number): Pause | null {
  if (!Number.isFinite(ms) || ms < 0) return meter.paused;
  meter.ticks.push(ms);
  if (meter.ticks.length > TICK_WINDOW) meter.ticks.shift();
  if (meter.paused !== null) return meter.paused;
  const over = meter.budget.msPerTick;
  const spike = ms > over * TICK_SPIKE;
  const sustained = meter.ticks.length === TICK_WINDOW && meter.ticks.every((t) => t > over);
  if (spike || sustained) {
    meter.paused = { reason: 'tick', at: now };
  }
  return meter.paused;
}

/** Records how many entities the behaviour owns now; past its budget it is paused (reason `entities`). */
export function setEntityCount(meter: BehaviorMeter, count: number, now: number): Pause | null {
  meter.entities = Number.isInteger(count) && count >= 0 ? count : meter.entities;
  if (meter.paused === null && meter.entities > meter.budget.entities) {
    meter.paused = { reason: 'entities', at: now };
  }
  return meter.paused;
}

/** Pauses by hand: a flag turned off, or an operator. A behaviour already paused keeps its first reason. */
export function pauseBehavior(meter: BehaviorMeter, reason: 'flag' | 'operator', now: number): Pause {
  if (meter.paused === null) {
    meter.paused = { reason, at: now };
  }
  return meter.paused;
}

/** Resumes, with clean windows, so one bad second doesn't pause it again at once. */
export function resumeBehavior(meter: BehaviorMeter): void {
  meter.paused = null;
  meter.ticks.length = 0;
  meter.recentBytes.length = 0;
  meter.recentByMember.clear();
}

/** Whether `budget` is one the catalog accepts: four finite numbers, none negative, and at least one intent a second. */
export function isBudget(value: unknown): value is BehaviorBudget {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  const keys: Array<keyof BehaviorBudget> = ['entities', 'bytesPerSecond', 'msPerTick', 'intentsPerSecond'];
  return (
    Object.keys(b).length === keys.length &&
    keys.every((key) => typeof b[key] === 'number' && Number.isFinite(b[key]) && (b[key] as number) >= 0) &&
    (b.intentsPerSecond as number) >= 1 &&
    Number.isInteger(b.entities)
  );
}
