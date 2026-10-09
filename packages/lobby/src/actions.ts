/**
 * What members do, besides move: the action message they exchange (a wave,
 * having a ball, a throw, and the catcher's word on how it went), on a
 * reliable channel beside the lossy position packets. Pure like presence.ts:
 * the feeds move the text and pass the time in.
 *
 * Everything a peer sends is untrusted input, so parsing rejects rather than
 * repairs: an unknown kind, a missing or extra field, a number out of range or
 * a point no camera could reach drops the whole message.
 *
 * Nothing here carries a time. A throw names how long the ball is in the air,
 * and every client starts it when the message arrives: tens of milliseconds
 * apart, and no shared clock to agree on.
 */

import type { Vec3 } from './attenuation.js';
import { CAMERA_LIMITS } from './camera.js';

/** The first field of every action message. A new layout takes a new number, and older peers drop it. */
export const ACTION_VERSION = 1;

/** The longest an action message may be, in characters. */
export const ACTION_MAX_LENGTH = 320;

/** Most actions a member may send in any one second; more is dropped. */
export const MAX_ACTIONS_PER_SECOND = 8;

/** How long a ball may be in the air, seconds. */
export const THROW_TIME = Object.freeze({ min: 0.3, max: 3 });

/** A member's id as the room gives it (`gh:123`, `practice-0a1b2c`): never anything else. */
const ID = /^[A-Za-z0-9:_.-]{1,64}$/;

export type LobbyAction =
  /** A wave, played once. */
  | { kind: 'wave' }
  /** Whether the sender has a ball in hand: said on picking one up or putting it away, and again every few seconds. */
  | { kind: 'ball'; holding: boolean }
  /** A throw from `from` to `dest`, at `to` (an id) or at nobody (null), in the air for `time` seconds. */
  | { kind: 'throw'; to: string | null; from: Vec3; dest: Vec3; time: number }
  /** The catcher's own word on the ball `thrower` threw at them: caught it, or missed. */
  | { kind: 'catch'; thrower: string; caught: boolean };

export type LobbyActionKind = LobbyAction['kind'];

/** Rounds to the centimetre, so the text stays short and a message reads back as it was sent. */
const cm = (value: number): number => Math.round(value * 100) / 100;
const point = (p: Vec3): [number, number, number] => [cm(p.x), cm(p.y), cm(p.z)];

/** The message as text, for the wire. */
export function encodeAction(action: LobbyAction): string {
  switch (action.kind) {
    case 'wave':
      return JSON.stringify({ v: ACTION_VERSION, k: 'wave' });
    case 'ball':
      return JSON.stringify({ v: ACTION_VERSION, k: 'ball', h: action.holding });
    case 'throw':
      return JSON.stringify({
        v: ACTION_VERSION,
        k: 'throw',
        to: action.to,
        f: point(action.from),
        d: point(action.dest),
        t: Math.round(action.time * 1000) / 1000,
      });
    case 'catch':
      return JSON.stringify({ v: ACTION_VERSION, k: 'catch', by: action.thrower, c: action.caught });
  }
}

/** Exactly these keys, no more and no fewer. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A point in the cave: inside the walking disk (with a little room for an arm), from the floor up. */
function parsePoint(raw: unknown): Vec3 | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [x, y, z] = raw as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (Math.hypot(x, z) > CAMERA_LIMITS.radius + 2 || y < 0 || y > CAMERA_LIMITS.maxY + 1) return null;
  return { x, y, z };
}

/** The message `raw` says, or null for anything else (wrong version, unknown kind, stray fields, bad values). */
export function parseAction(raw: unknown): LobbyAction | null {
  if (typeof raw !== 'string' || raw.length > ACTION_MAX_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.v !== ACTION_VERSION) return null;
  switch (message.k) {
    case 'wave':
      return hasKeys(message, ['v', 'k']) ? { kind: 'wave' } : null;
    case 'ball':
      return hasKeys(message, ['v', 'k', 'h']) && typeof message.h === 'boolean' ? { kind: 'ball', holding: message.h } : null;
    case 'throw': {
      if (!hasKeys(message, ['v', 'k', 'to', 'f', 'd', 't'])) return null;
      const { to, t } = message;
      if (to !== null && (typeof to !== 'string' || !ID.test(to))) return null;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < THROW_TIME.min || t > THROW_TIME.max) return null;
      const from = parsePoint(message.f);
      const dest = parsePoint(message.d);
      if (!from || !dest) return null;
      return { kind: 'throw', to, from, dest, time: t };
    }
    case 'catch': {
      if (!hasKeys(message, ['v', 'k', 'by', 'c'])) return null;
      const { by, c } = message;
      if (typeof by !== 'string' || !ID.test(by) || typeof c !== 'boolean') return null;
      return { kind: 'catch', thrower: by, caught: c };
    }
    default:
      return null;
  }
}

/** Each sender's recent action times (ms), for `acceptAction`. */
export interface ActionLimiter {
  readonly recent: Map<string, number[]>;
}

export function createActionLimiter(): ActionLimiter {
  return { recent: new Map() };
}

/**
 * Whether to take an action from `sender` arriving at `now` (ms, a monotonic
 * clock): at most MAX_ACTIONS_PER_SECOND in any one-second window per sender.
 * A rejected one doesn't count, a non-finite time is rejected, and a clock
 * that went backwards starts that sender's window over.
 */
export function acceptAction(limiter: ActionLimiter, sender: string, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  const times = limiter.recent.get(sender) ?? [];
  const newest = times[times.length - 1];
  const kept = newest !== undefined && now < newest ? [] : times.filter((time) => now - time < 1000);
  if (kept.length >= MAX_ACTIONS_PER_SECOND) {
    limiter.recent.set(sender, kept);
    return false;
  }
  kept.push(now);
  limiter.recent.set(sender, kept);
  return true;
}

/** Forgets a sender who has left. */
export function forgetActionSender(limiter: ActionLimiter, sender: string): void {
  limiter.recent.delete(sender);
}
