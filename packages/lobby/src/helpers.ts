/**
 * The lobby's helper bots, the pure half: robots of the cave's own that
 * circle its edge, just outside where anyone can build, until somebody comes
 * up to one. Then it slows to a stop, turns to face them, waves hello and
 * waits; once nobody has been near it for a moment, it turns back to its way
 * and carries on.
 *
 * There is no server to keep a bot's place (ADR-009's world participant
 * doesn't exist yet), so its place on the loop comes from the wall clock
 * (`scheduledArc`): every client draws it in the same spot, give or take
 * their clocks. Who it stops for is everyone's own position, which every
 * client already has, so they agree on that too. A stop leaves the bot
 * behind its schedule; once it's free it cruises a little faster until it
 * has caught up (or, ahead of it, a little slower), so a client that joined
 * in the meantime, and drew it on schedule, soon agrees with everyone else.
 *
 * Axes and yaw are camera.ts's: metres, +Y up, yaw 0 looks down −Z and grows
 * turning right. Pure like the rest of the package: callers pass the time in.
 */

import type { AvatarColors } from './avatar.js';
import type { Vec3 } from './attenuation.js';
import { wrapAngle } from './avatarMotion.js';
import { CAMERA_LIMITS, normalizeYaw } from './camera.js';
import { BODY } from './collide.js';
import { GESTURE } from './play.js';
import { WALL } from './layout.js';

/** One of the cave's own robots. */
export interface HelperBot {
  /** Its id, in the lobby and the avatar editor: `bot:` and a name (never a member's `gh:`). */
  id: string;
  /** What its name tag says. */
  name: string;
  /** Its paint until an admin dresses it in the avatar editor. */
  colors: AvatarColors;
  /** Where on the loop it is at the clock's epoch, as a fraction of a lap: bots space themselves out by it. */
  offset: number;
}

/**
 * The cave's helper bots. Mirrored by `HELPER_BOTS` in the API's
 * services/avatars.py (the ids and names the editor offers), so a new one
 * goes in both.
 */
export const HELPER_BOTS: readonly HelperBot[] = Object.freeze([
  Object.freeze({
    id: 'bot:helper',
    name: 'Helper',
    // Gunmetal armour with amber trim, an amber frame and amber eyes (and so an amber thruster).
    colors: Object.freeze({ shell: '#34353b', trim: '#ff9a1f', accent: '#ffb627', eye: '#ffc83d' }),
    offset: 0,
  }),
]);

/** A helper bot's id: `bot:` and lower-case letters, digits and dashes. */
export const HELPER_ID = /^bot:[a-z0-9][a-z0-9-]{0,31}$/;

/** The helper bot with `id`, or null for anyone else. */
export function helperBot(id: string): HelperBot | null {
  return HELPER_BOTS.find((bot) => bot.id === id) ?? null;
}

/** Whether `id` is one of the cave's helper bots (rather than a member). */
export function isHelperBot(id: string): boolean {
  return helperBot(id) !== null;
}

/** How a helper bot goes round. Frozen. */
export const PATROL = Object.freeze({
  /**
   * The loop's radius: the walking disk's edge less a body, so a bot's shell
   * stays on the floor and clear of every brick and machine (they stand
   * within BRICK.radius, 24 m).
   */
  radius: CAMERA_LIMITS.radius - BODY.radius,
  /** Its eye height: it hovers where a member standing on the floor does. */
  eye: WALL.eye,
  /** Cruising speed, m/s: a lap in a little over two minutes. */
  speed: 1.2,
  /** The most it hurries to catch up with its schedule, as a multiple of `speed`… */
  hurry: 2,
  /** …and the least it slows to while ahead of it. */
  dawdle: 0.5,
  /** Metres behind its schedule at which it hurries at full (ahead, it slows the same way). */
  catchUp: 12,
  /** How quickly it speeds up and slows down, m/s². */
  accel: 1.2,
  /** How fast it turns, rad/s. */
  turn: 2.5,
  /** It only sets off again once it faces within this of its way, radians. */
  aligned: 0.5,
  /** Someone this close (metres, eye to eye) stops it… */
  approach: 4,
  /** …and it waits until nobody has been within this… */
  release: 5.5,
  /** …for this long, seconds. */
  linger: 2,
  /** A gap between steps longer than this (seconds: a hidden tab, a frozen page) puts it back on its schedule. */
  resync: 2,
});

/** One lap of the loop, metres. */
export const LAP = 2 * Math.PI * PATROL.radius;

/** What a helper bot is doing: going round, or stopped for someone. */
export type HelperMode = 'patrolling' | 'stopped';

/** One helper bot, as one client steps it. */
export interface HelperState {
  /** Metres along the loop, in [0, LAP). */
  arc: number;
  /** Its speed along the loop, m/s. */
  speed: number;
  /** Which way it faces (camera.ts yaw). */
  yaw: number;
  /** Whom it faces while stopped: the nearest person's eye; null on its way. */
  facing: Vec3 | null;
  /** When (wall clock, ms) someone was last near it; null if nobody has been. */
  seenAt: number | null;
  /** When (wall clock, ms) it stopped for someone; null while it's going round. */
  stoppedAt: number | null;
  /** When (wall clock, ms) this state is for. */
  now: number;
}

/** `a` modulo `n`, in [0, n). */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The yaw that looks along (dx, dz) across the floor. */
function yawAlong(dx: number, dz: number): number {
  return normalizeYaw(Math.atan2(dx, -dz));
}

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Where `bot` is due on its loop at `nowMs` (wall clock): metres along it, in [0, LAP). */
export function scheduledArc(bot: Pick<HelperBot, 'offset'>, nowMs: number): number {
  return mod((nowMs / 1000) * PATROL.speed + bot.offset * LAP, LAP);
}

/**
 * The point `arc` metres along the loop (its eye, at PATROL.eye) and the yaw
 * that looks the way a bot goes there. It goes round with the angle from +X
 * toward +Z, starting on +X.
 */
export function loopPoint(arc: number): { at: Vec3; yaw: number } {
  const angle = arc / PATROL.radius;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    at: { x: PATROL.radius * cos + 0, y: PATROL.eye, z: PATROL.radius * sin + 0 },
    yaw: yawAlong(-sin, cos),
  };
}

/** `bot` as a client that has just arrived draws it: on schedule, cruising, nobody near. */
export function startHelper(bot: HelperBot, nowMs: number): HelperState {
  const arc = scheduledArc(bot, nowMs);
  return { arc, speed: PATROL.speed, yaw: loopPoint(arc).yaw, facing: null, seenAt: null, stoppedAt: null, now: nowMs };
}

/** What `state` is doing. */
export function helperMode(state: HelperState): HelperMode {
  return state.stoppedAt === null ? 'patrolling' : 'stopped';
}

/**
 * How far into its wave hello a bot is (seconds), or null when it isn't
 * waving: it waves once each time it stops for someone, for as long as a
 * member's own wave lasts (GESTURE.wave).
 */
export function helperWave(state: HelperState, nowMs: number): number | null {
  if (state.stoppedAt === null) return null;
  const seconds = (nowMs - state.stoppedAt) / 1000;
  return seconds >= 0 && seconds <= GESTURE.wave ? seconds : null;
}

/**
 * `state` stepped to `nowMs` (the wall clock), with `people` (everyone in the
 * cave, by their eyes) round it. The step is the clock's own, not a frame's,
 * so a slow device keeps time with everyone else. A clock that went
 * backwards leaves it where it was, and a long gap while it was going round
 * (a hidden tab) puts it back on schedule.
 */
export function stepHelper(bot: HelperBot, state: HelperState, people: readonly Vec3[], nowMs: number): HelperState {
  if (!Number.isFinite(nowMs)) return state;
  const gap = (nowMs - state.now) / 1000;
  if (gap > PATROL.resync && state.stoppedAt === null) {
    return stepHelper(bot, startHelper(bot, nowMs), people, nowMs);
  }
  const dt = clamp(gap, 0, PATROL.resync);
  const here = loopPoint(state.arc).at;

  // The nearest person within reach: a longer reach once stopped, so someone on the line doesn't flicker it.
  let nearest: Vec3 | null = null;
  let best: number = state.stoppedAt === null ? PATROL.approach : PATROL.release;
  for (const person of people) {
    if (!finiteVec(person)) continue;
    const distance = Math.hypot(person.x - here.x, person.y - here.y, person.z - here.z);
    if (distance < best) {
      best = distance;
      nearest = person;
    }
  }
  const seenAt = nearest ? nowMs : state.seenAt;
  let stoppedAt = state.stoppedAt;
  if (nearest && stoppedAt === null) stoppedAt = nowMs;
  if (!nearest && stoppedAt !== null && (seenAt === null || nowMs - seenAt >= PATROL.linger * 1000)) stoppedAt = null;
  const facing = stoppedAt === null ? null : nearest ? { x: nearest.x, y: nearest.y, z: nearest.z } : state.facing;

  // How fast: still while stopped, or turned away from its way; otherwise cruising, hurrying while behind its schedule.
  const way = loopPoint(state.arc).yaw;
  let target = 0;
  if (stoppedAt === null && Math.abs(wrapAngle(way - state.yaw)) <= PATROL.aligned) {
    // Measured where it was, against where it was due then.
    const behind = mod(scheduledArc(bot, state.now) - state.arc + LAP / 2, LAP) - LAP / 2;
    target = PATROL.speed * clamp(1 + behind / PATROL.catchUp, PATROL.dawdle, PATROL.hurry);
  }
  const most = PATROL.accel * dt;
  const speed = clamp(target, state.speed - most, state.speed + most);
  const arc = mod(state.arc + ((state.speed + speed) / 2) * dt, LAP);

  // Which way: along the loop, or at whoever it stopped for.
  const there = loopPoint(arc);
  const want = facing ? yawAlong(facing.x - there.at.x, facing.z - there.at.z) : there.yaw;
  const turn = clamp(wrapAngle(want - state.yaw), -PATROL.turn * dt, PATROL.turn * dt);
  return { arc, speed: speed + 0, yaw: normalizeYaw(state.yaw + turn), facing, seenAt, stoppedAt, now: nowMs };
}
