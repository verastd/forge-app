/**
 * A back model that moves like an arm (`placement.motion: 'arm'`), from a
 * model that has no rig of its own: an auto-rig and what it does.
 *
 * - `armAxis`: the arm's length, from the end nearest where it's mounted (its
 *   base) to its far end (its tip, where its camera is): the model's longest
 *   direction (its vertices' principal axis), end to end.
 * - `armWeights`: how much each vertex follows each bone of a chain of
 *   `segments` bones laid evenly along that axis (blended across each joint).
 * - `stepArmLook`: where the tip aims, frame by frame: now at someone near
 *   (followed as they move), now somewhere around its rest direction (a quick
 *   hop to each new spot, a little bob while it holds); a few seconds each,
 *   picked at random. Reduced motion: it holds still (null).
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import type { Vec3 } from './attenuation.js';

export const ARM = Object.freeze({
  /** Bones along the arm (joints where it bends). */
  segments: 4,
  /** How near someone must be for it to look at them (metres from its base). */
  lookRange: 8,
  /** How likely it is to look at someone near when it picks what to do next. */
  lookChance: 0.65,
  /** How long it holds each pick (seconds, at random between these). */
  holdMin: 0.8,
  holdMax: 2.8,
  /** Each spot it hops to is this far off its rest direction (radians, at random between these), any way round. */
  wanderMin: 0.45,
  wanderMax: 1.3,
  /** How fast it gets there (per second): snappy hops while it wanders, smoother while it watches. */
  followWander: 7,
  followLook: 3.5,
  /** Its bob while it holds (metres, times per second). */
  bob: 0.08,
  bobRate: 5.5,
  /** The most each joint bends from where the model has it (radians). */
  jointLimit: 1.1,
});

export interface ArmAxis {
  base: Vec3;
  tip: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const along = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t });
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normal = (a: Vec3): Vec3 => {
  const size = length(a) || 1;
  return { x: a.x / size, y: a.y / size, z: a.z / size };
};

/**
 * The arm's axis among `positions` (x, y, z, x, y, z…, in one frame), its base
 * the end nearer `anchor` (where it's mounted, in the same frame). Null with
 * nothing to measure (fewer than two distinct points).
 */
export function armAxis(positions: ArrayLike<number>, anchor: Vec3): ArmAxis | null {
  const count = Math.floor(positions.length / 3);
  if (count < 2) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i += 1) {
    cx += positions[i * 3]!;
    cy += positions[i * 3 + 1]!;
    cz += positions[i * 3 + 2]!;
  }
  const centre = { x: cx / count, y: cy / count, z: cz / count };
  // Their spread (covariance), then its main direction by power iteration.
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]! - centre.x;
    const y = positions[i * 3 + 1]! - centre.y;
    const z = positions[i * 3 + 2]! - centre.z;
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  let d: Vec3 = { x: 0.6, y: 0.7, z: 0.4 };
  for (let k = 0; k < 48; k += 1) {
    const next = { x: xx * d.x + xy * d.y + xz * d.z, y: xy * d.x + yy * d.y + yz * d.z, z: xz * d.x + yz * d.y + zz * d.z };
    const size = length(next);
    if (size < 1e-12) return null;
    d = { x: next.x / size, y: next.y / size, z: next.z / size };
  }
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const t = dot({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! }, d) - dot(centre, d);
    low = Math.min(low, t);
    high = Math.max(high, t);
  }
  const a = along(centre, d, low);
  const b = along(centre, d, high);
  return length(sub(a, anchor)) <= length(sub(b, anchor)) ? { base: a, tip: b } : { base: b, tip: a };
}

/**
 * Each vertex's two bones and how much it follows each (four of each per
 * vertex, as glTF skins have them; the last two always 0). Bone k sits k /
 * `segments` of the way from base to tip and turns everything past it; a
 * vertex near a joint is shared between the bones either side of it.
 */
export function armWeights(positions: ArrayLike<number>, axis: ArmAxis, segments: number = ARM.segments): { joints: Uint16Array; weights: Float32Array } {
  const count = Math.floor(positions.length / 3);
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const span = sub(axis.tip, axis.base);
  const size2 = Math.max(dot(span, span), 1e-12);
  for (let i = 0; i < count; i += 1) {
    const p = { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! };
    const t = Math.min(1, Math.max(0, dot(sub(p, axis.base), span) / size2));
    const s = t * segments;
    const k = Math.min(segments - 1, Math.floor(s));
    const f = s - k;
    // The first half of a segment blends into the bone before it, eased; the rest is all its own.
    const own = k === 0 ? 1 : f >= 0.5 ? 1 : 0.5 + 0.5 * (1 - Math.cos(Math.PI * f));
    joints[i * 4] = k;
    joints[i * 4 + 1] = Math.max(0, k - 1);
    weights[i * 4] = own;
    weights[i * 4 + 1] = 1 - own;
  }
  return { joints, weights };
}

/** What the arm is up to: where its tip aims now, what it's after, until when, and whom it watches. */
export interface ArmLook {
  aim: Vec3 | null;
  goal: Vec3 | null;
  until: number;
  /** Index into the people it was last given; null while it wanders. */
  watching: number | null;
  /** Its own random sequence (xorshift32 state). */
  seed: number;
}

export function createArmLook(seed: number): ArmLook {
  return { aim: null, goal: null, until: -Infinity, watching: null, seed: (Math.floor(Math.abs(seed) * 2654435761) >>> 0) || 1 };
}

export interface ArmLookInput {
  t: number;
  dt: number;
  /** Its base, in the cave. */
  base: Vec3;
  /** Which way it points at rest (unit length): it wanders around this. */
  rest: Vec3;
  /** How far its tip reaches from its base (metres). */
  reach: number;
  /** Whom it may look at: their eyes, in the cave. */
  people: readonly Vec3[];
  reducedMotion: boolean;
}

const random = (state: ArmLook): number => {
  let x = state.seed;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  state.seed = x || 1;
  return state.seed / 0x100000000;
};

/** Advances `state` to `input.t`; the point its tip aims at (null: hold still). */
export function stepArmLook(state: ArmLook, input: ArmLookInput): Vec3 | null {
  if (input.reducedMotion) {
    state.aim = null;
    state.goal = null;
    state.watching = null;
    return null;
  }
  const near = (i: number): boolean => i < input.people.length && length(sub(input.people[i]!, input.base)) <= ARM.lookRange;
  if (state.watching !== null && !near(state.watching)) state.until = input.t;
  if (input.t >= state.until) {
    const candidates = input.people.map((_, i) => i).filter(near);
    const look = candidates.length > 0 && random(state) < ARM.lookChance;
    if (look) {
      state.watching = candidates[Math.floor(random(state) * candidates.length)]!;
    } else {
      state.watching = null;
      // Somewhere off its rest direction: tipped away from it by an angle, at a random turn around it.
      const off = ARM.wanderMin + random(state) * (ARM.wanderMax - ARM.wanderMin);
      const around = random(state) * Math.PI * 2;
      const r = input.rest;
      // Two directions square to the rest direction (from whichever axis it's least along).
      const seed = Math.abs(r.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const u = normal(cross(r, seed));
      const v = cross(r, u);
      const side = { x: u.x * Math.cos(around) + v.x * Math.sin(around), y: u.y * Math.cos(around) + v.y * Math.sin(around), z: u.z * Math.cos(around) + v.z * Math.sin(around) };
      const dir = {
        x: r.x * Math.cos(off) + side.x * Math.sin(off),
        y: r.y * Math.cos(off) + side.y * Math.sin(off),
        z: r.z * Math.cos(off) + side.z * Math.sin(off),
      };
      state.goal = along(input.base, dir, input.reach);
    }
    state.until = input.t + ARM.holdMin + random(state) * (ARM.holdMax - ARM.holdMin);
  }
  if (state.watching !== null) state.goal = { ...input.people[state.watching]! };
  const goal = state.goal!;
  const rate = state.watching === null ? ARM.followWander : ARM.followLook;
  const step = 1 - Math.exp(-Math.max(0, input.dt) * rate);
  const aim = state.aim ?? goal;
  state.aim = { x: aim.x + (goal.x - aim.x) * step, y: aim.y + (goal.y - aim.y) * step, z: aim.z + (goal.z - aim.z) * step };
  const bob = Math.sin(input.t * ARM.bobRate) * ARM.bob;
  return { x: state.aim.x, y: state.aim.y + bob, z: state.aim.z };
}
