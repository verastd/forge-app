/**
 * Playing catch, and the gestures robots make doing it: where a thrown ball
 * is at any moment, how a missed one bounces and rolls to a stop, who a throw
 * goes to, whether a catcher was close enough, and where a robot's arms
 * point for a wave, a held ball, a throw and a catch (with two-bone IK to
 * reach for the ball).
 *
 * Axes as everywhere in the lobby: metres, +Y up. Arm directions are in the
 * robot's own frame: it faces +Z, its left is +X. Pure and deterministic.
 */

import type { Vec3 } from './attenuation.js';
import { THROW_TIME } from './actions.js';

/** The ball: an American football, its long radius and the floor it bounces on. */
export const BALL = Object.freeze({
  /** Half its length, metres. */
  length: 0.14,
  /** Its girth's radius, metres: what it rests on. */
  radius: 0.085,
  gravity: 9.8,
  /** How much of its speed into the floor comes back up. */
  bounce: 0.45,
  /** How fast it slows rolling, metres per second per second. */
  friction: 2.2,
  /** Below this upward speed it stops bouncing and rolls. */
  settle: 0.6,
});

/** Throwing: how far, how long and how high. */
export const THROW = Object.freeze({
  /** Farthest a throw goes to someone, metres. */
  range: 18,
  /** How far off straight ahead someone may be and still be thrown to, radians. */
  cone: 0.6,
  /** A throw at nobody lands this far ahead. */
  ahead: 7,
  /** Under the catcher's eye, where hands catch. */
  chest: 0.35,
  /** How far a catcher can be from where the ball comes down and still catch it, metres. */
  reach: 1.3,
  /** Seconds a catcher's arms reach out before the ball arrives. */
  ready: 0.45,
});

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** `a` at unit length; straight down for a zero vector. */
export function unit(a: Vec3): Vec3 {
  const n = length(a);
  return n > 1e-9 ? scale(a, 1 / n) : { x: 0, y: -1, z: 0 };
}

// ---------- the throw ----------

/** How long a throw `distance` metres away is in the air, and how high it arcs over the straight line. */
export function throwShape(distance: number): { time: number; arc: number } {
  const d = Math.max(0, Number.isFinite(distance) ? distance : 0);
  return { time: clamp(0.45 + d * 0.07, THROW_TIME.min, THROW_TIME.max), arc: 0.3 + d * 0.11 };
}

/** Where a ball thrown from `from` to `dest` is `t` seconds into a `time`-second flight. Held at either end. */
export function ballAt(from: Vec3, dest: Vec3, time: number, t: number): Vec3 {
  const s = clamp(time > 0 ? t / time : 1, 0, 1);
  const { arc } = throwShape(length(sub(dest, from)));
  const along = add(from, scale(sub(dest, from), s));
  return { x: along.x, y: along.y + 4 * arc * s * (1 - s), z: along.z };
}

/** The ball's velocity as it comes down at `dest`, m/s: where a miss carries on from. */
export function arrivalVelocity(from: Vec3, dest: Vec3, time: number): Vec3 {
  const t = Math.max(time, 1e-3);
  const { arc } = throwShape(length(sub(dest, from)));
  const flat = scale(sub(dest, from), 1 / t);
  return { x: flat.x, y: flat.y - (4 * arc) / t, z: flat.z };
}

/**
 * A missed ball, `t` seconds after it passed `start` at `velocity`: falling,
 * bouncing lower each time, then rolling to a stop on the floor. `rest` is
 * true once it has stopped.
 */
export function missPath(start: Vec3, velocity: Vec3, t: number): { at: Vec3; rest: boolean } {
  const g = BALL.gravity;
  const floor = BALL.radius;
  let pos = { ...start, y: Math.max(start.y, floor) };
  let vx = velocity.x;
  let vy = velocity.y;
  let vz = velocity.z;
  let left = Math.max(0, t);
  // Bounces, each to the floor and back up, until it hardly leaves the floor.
  for (let i = 0; i < 12; i += 1) {
    const height = pos.y - floor;
    const land = (vy + Math.sqrt(vy * vy + 2 * g * height)) / g;
    if (left <= land) {
      return {
        at: { x: pos.x + vx * left, y: pos.y + vy * left - 0.5 * g * left * left, z: pos.z + vz * left },
        rest: false,
      };
    }
    left -= land;
    pos = { x: pos.x + vx * land, y: floor, z: pos.z + vz * land };
    const down = vy - g * land;
    vy = -down * BALL.bounce;
    vx *= 0.8;
    vz *= 0.8;
    if (vy < BALL.settle) break;
  }
  // Rolling: slowing evenly to a stop.
  const speed = Math.hypot(vx, vz);
  const stop = speed / BALL.friction;
  const rolled = Math.min(left, stop);
  const travel = speed > 1e-9 ? speed * rolled - 0.5 * BALL.friction * rolled * rolled : 0;
  const dir = speed > 1e-9 ? { x: vx / speed, z: vz / speed } : { x: 0, z: 0 };
  return { at: { x: pos.x + dir.x * travel, y: floor, z: pos.z + dir.z * travel }, rest: left >= stop };
}

/** Where a throw at `target` (their eye) comes down: in front of their chest. */
export function catchPoint(from: Vec3, target: Vec3): Vec3 {
  const flat = unit({ x: from.x - target.x, y: 0, z: from.z - target.z });
  return { x: target.x + flat.x * 0.35, y: Math.max(BALL.radius, target.y - THROW.chest), z: target.z + flat.z * 0.35 };
}

/** Where a throw at nobody comes down: THROW.ahead along `yaw`, at the floor. */
export function landingAhead(from: Vec3, yaw: number): Vec3 {
  return { x: from.x + Math.sin(yaw) * THROW.ahead, y: BALL.radius, z: from.z - Math.cos(yaw) * THROW.ahead };
}

/** Whether a catcher whose eye is at `eye` is close enough to where the ball comes down to catch it. */
export function canCatch(eye: Vec3, dest: Vec3): boolean {
  return length(sub({ x: eye.x, y: eye.y - THROW.chest, z: eye.z }, dest)) <= THROW.reach;
}

/**
 * Who a member at `eye` facing `yaw` throws to: whoever is nearest straight
 * ahead, within THROW.range and THROW.cone; null for nobody.
 */
export function throwTarget(eye: Vec3, yaw: number, others: ReadonlyMap<string, Vec3>): string | null {
  const ahead = { x: Math.sin(yaw), z: -Math.cos(yaw) };
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, at] of others) {
    const dx = at.x - eye.x;
    const dz = at.z - eye.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.5 || distance > THROW.range) continue;
    const angle = Math.acos(clamp((dx * ahead.x + dz * ahead.z) / distance, -1, 1));
    if (angle > THROW.cone) continue;
    // Off-centre counts as farther: someone straight ahead beats someone a little nearer at the edge.
    const score = distance * (1 + 2 * angle);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

// ---------- gestures ----------

export type GestureKind = 'wave' | 'throw' | 'catch';

/** How long each gesture plays, seconds; a throw lets go at `release`. */
export const GESTURE = Object.freeze({
  wave: 1.8,
  throw: 0.95,
  release: 0.5,
  catch: 0.9,
  /** Seconds to blend in and out. */
  ease: 0.15,
});

/**
 * Where one arm points: `upper` is the upper arm's direction from the
 * shoulder, `bend` the elbow's (0 straight, π/2 a right angle), bending the
 * forearm toward `hint`.
 */
export interface ArmAim {
  upper: Vec3;
  bend: number;
  hint: Vec3;
}

/** A pose for the arms, over the robot's own: `weight` 0 is its own, 1 is this. */
export interface ArmsPose {
  right: ArmAim | null;
  left: ArmAim | null;
  weight: number;
}

const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const smooth = (k: number): number => {
  const c = clamp(k, 0, 1);
  return c * c * (3 - 2 * c);
};
const lerp = (a: Vec3, b: Vec3, k: number): Vec3 => add(a, scale(sub(b, a), k));

/** In, hold, out: 0 → 1 over `ease`, 1 until `ease` before the end, then back to 0. */
function envelope(t: number, duration: number): number {
  if (t < 0 || t > duration) return 0;
  return smooth(Math.min(t / GESTURE.ease, (duration - t) / GESTURE.ease, 1));
}

/** Holding a ball: the right forearm up across the chest, the ball in front. */
export const HOLD: ArmAim = Object.freeze({ upper: unit({ x: -0.15, y: -0.75, z: 0.65 }), bend: 1.25, hint: UP });

/**
 * The arms `t` seconds into `kind` (with a ball in hand or not), or null
 * when it's over. With `reducedMotion` a wave holds still, raised.
 */
export function gesturePose(kind: GestureKind, t: number, holding: boolean, reducedMotion: boolean): ArmsPose | null {
  const duration = GESTURE[kind];
  if (t < 0 || t > duration) return null;
  const weight = envelope(t, duration);
  switch (kind) {
    case 'wave': {
      const swing = reducedMotion ? 0 : Math.sin(t * 2 * Math.PI * 2.2) * 0.45;
      return {
        right: { upper: unit({ x: -0.75, y: 0.55, z: 0.2 }), bend: 0.9 + swing * 0.5, hint: { x: Math.sin(swing), y: 1, z: 0.3 } },
        left: holding ? HOLD : null,
        weight,
      };
    }
    case 'throw': {
      // Up the side and back over the shoulder, through to out in front at the release, then follow through down.
      const keys: Array<[number, ArmAim]> = [
        [0, HOLD],
        [0.18, { upper: unit({ x: -0.8, y: 0.45, z: 0.1 }), bend: 1.4, hint: UP }],
        [0.36, { upper: unit({ x: -0.35, y: 0.75, z: -0.55 }), bend: 1.8, hint: UP }],
        [GESTURE.release, { upper: unit({ x: -0.15, y: 0.55, z: 0.82 }), bend: 0.2, hint: UP }],
        [0.72, { upper: unit({ x: -0.05, y: -0.35, z: 0.94 }), bend: 0.25, hint: UP }],
        [duration, HOLD],
      ];
      let i = 0;
      while (i < keys.length - 2 && t > keys[i + 1]![0]) i += 1;
      const [t0, a] = keys[i]!;
      const [t1, b] = keys[i + 1]!;
      const k = smooth((t - t0) / Math.max(t1 - t0, 1e-6));
      return {
        right: { upper: unit(lerp(a.upper, b.upper, k)), bend: a.bend + (b.bend - a.bend) * k, hint: UP },
        left: { upper: unit({ x: 0.35, y: -0.1, z: 0.93 }), bend: 0.3, hint: UP },
        // In fast and out slowly: the arm is already moving when it lets go.
        weight: smooth(Math.min(t / 0.08, (duration - t) / 0.25, 1)),
      };
    }
    case 'catch': {
      // Both hands out in front, a little apart: the reach for a real ball comes from `reachArm`.
      const out = (side: number): ArmAim => ({ upper: unit({ x: side * 0.25, y: -0.1, z: 1 }), bend: 0.35, hint: UP });
      return { right: out(-1), left: out(1), weight };
    }
  }
}

/**
 * Two-bone IK: the upper arm and forearm directions that put the hand of an
 * arm from `shoulder` (bones `upper` and `fore` metres long) on `target`, the
 * elbow bending toward `pole`. Out of reach, the arm points straight at it.
 */
export function reachArm(shoulder: Vec3, target: Vec3, upper: number, fore: number, pole: Vec3): { upper: Vec3; fore: Vec3 } {
  const toTarget = sub(target, shoulder);
  const dir = unit(toTarget);
  const d = clamp(length(toTarget), Math.abs(upper - fore) + 1e-4, upper + fore - 1e-4);
  const cosA = clamp((upper * upper + d * d - fore * fore) / (2 * upper * d), -1, 1);
  const a = Math.acos(cosA);
  // The elbow's side: the pole, square to the reach (or anything square to it, if the pole lies along it).
  let side = sub(pole, scale(dir, dot(pole, dir)));
  if (length(side) < 1e-6) side = cross(dir, Math.abs(dir.y) < 0.9 ? UP : FORWARD);
  side = unit(side);
  const upperDir = unit(add(scale(dir, Math.cos(a)), scale(side, Math.sin(a))));
  const elbow = add(shoulder, scale(upperDir, upper));
  const hand = add(shoulder, scale(dir, d));
  return { upper: upperDir, fore: unit(sub(hand, elbow)) };
}

/** The forearm's direction for an aim: the upper arm's, turned `bend` toward its hint. */
export function foreDirection(aim: ArmAim): Vec3 {
  const u = unit(aim.upper);
  let axis = cross(u, aim.hint);
  if (length(axis) < 1e-6) axis = cross(u, Math.abs(u.z) < 0.9 ? FORWARD : UP);
  axis = unit(axis);
  // Rodrigues, about `axis` (u ⟂ axis): u·cos + (axis × u)·sin.
  return unit(add(scale(u, Math.cos(aim.bend)), scale(cross(axis, u), Math.sin(aim.bend))));
}
