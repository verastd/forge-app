/**
 * A back model that moves like an arm (`placement.motion: 'arm'`), from a
 * model that has no rig of its own: an auto-rig and what it does.
 *
 * - `armAxis`: the arm's length, from the end nearest where it's mounted (its
 *   base) to its far end (its tip, where its camera is): the model's longest
 *   direction (its vertices' principal axis), end to end.
 * - `armJoints`: where it bends: the narrowest points along it (a robot arm's
 *   wrists and elbows), away from its ends, so its thick parts (its camera
 *   head among them) stay whole.
 * - `armWeights`: which bone each vertex follows, all of it (rigid: each part
 *   of the arm moves as one solid piece and only turns at a joint).
 * - `clearOf`: whether a point keeps out of the robot (boxes in its frame).
 * - `armLens`, `lensShare`, `lensZoom`: its camera's lens (the front of the
 *   piece past its last joint, the way the model faces) zooming in and out:
 *   the lens itself moves wholly, the barrel behind it stretches.
 * - `stepArmLook`: where the tip aims, frame by frame: now at someone near
 *   (followed as they move), now somewhere around its rest direction (a quick
 *   hop to each new spot, a little bob while it holds); a few seconds each,
 *   picked at random, never a spot straight through the robot. Reduced
 *   motion: it holds still (null).
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import type { Vec3 } from './attenuation.js';

export const ARM = Object.freeze({
  /** The most joints it bends at, and where they may go: this far from either end (a share of its length) and from each other. */
  maxJoints: 3,
  jointEdge: 0.15,
  jointGap: 0.15,
  /** Slices its thickness is measured in, and how much narrower than the thick parts either side a joint must be. */
  profileSlices: 40,
  jointDip: 0.18,
  /**
   * Its lens: the front `lensFront` of the camera piece's depth (the way the model faces, +z)
   * moves wholly, the barrel behind it out to `lensNeck` stretches; it zooms out as far as
   * `lensReach` of that depth, to a new depth every `zoomEvery` seconds, taking `zoomTime` to get there.
   */
  lensFront: 0.22,
  lensNeck: 0.45,
  lensReach: 0.28,
  zoomEvery: 3,
  zoomTime: 0.7,
  /** How many spots it tries before it gives up on wandering (each a straight line from its base that mustn't cross the robot). */
  wanderTries: 8,
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

const fraction = (p: Vec3, axis: ArmAxis): number => {
  const span = sub(axis.tip, axis.base);
  return dot(sub(p, axis.base), span) / Math.max(dot(span, span), 1e-12);
};
const at = (positions: ArrayLike<number>, i: number): Vec3 => ({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! });

/**
 * Where the arm bends, as shares of its length from base to tip (ascending):
 * the narrowest points along it, each a good deal (ARM.jointDip) narrower
 * than the thickest parts either side, at least ARM.jointEdge from either end
 * and ARM.jointGap apart, the most pronounced first, at most `max`. With no
 * narrowing to go by, two joints at its thirds.
 */
export function armJoints(positions: ArrayLike<number>, axis: ArmAxis, max: number = ARM.maxJoints): number[] {
  const slices = ARM.profileSlices;
  const spread: number[][] = Array.from({ length: slices }, () => []);
  const span = sub(axis.tip, axis.base);
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i += 1) {
    const p = at(positions, i);
    const t = fraction(p, axis);
    const off = sub(sub(p, axis.base), { x: span.x * t, y: span.y * t, z: span.z * t });
    spread[Math.min(slices - 1, Math.max(0, Math.floor(t * slices)))]!.push(length(off));
  }
  // Each slice's thickness: the 90th percentile of how far its points are from the axis.
  const raw = spread.map((r) => {
    if (r.length === 0) return Number.NaN;
    r.sort((a, b) => a - b);
    return r[Math.floor(r.length * 0.9)]!;
  });
  // Evened out over five slices (an empty one counts for nothing).
  const thick = raw.map((_, k) => {
    const near = raw.slice(Math.max(0, k - 2), k + 3).filter((v) => !Number.isNaN(v));
    return near.length === 0 ? Number.NaN : near.reduce((a, b) => a + b, 0) / near.length;
  });
  const found: { t: number; dip: number }[] = [];
  for (let k = 1; k < slices - 1; k += 1) {
    const t = (k + 0.5) / slices;
    const here = thick[k]!;
    if (t < ARM.jointEdge || t > 1 - ARM.jointEdge || Number.isNaN(here)) continue;
    if (!(here <= thick[k - 1]! && here < thick[k + 1]!)) continue;
    const before = Math.max(...thick.slice(0, k).filter((v) => !Number.isNaN(v)));
    const after = Math.max(...thick.slice(k + 1).filter((v) => !Number.isNaN(v)));
    const dip = 1 - here / Math.min(before, after);
    if (dip >= ARM.jointDip) found.push({ t, dip });
  }
  found.sort((a, b) => b.dip - a.dip);
  const chosen: number[] = [];
  for (const { t } of found) {
    if (chosen.length >= max) break;
    if (chosen.every((c) => Math.abs(c - t) >= ARM.jointGap)) chosen.push(t);
  }
  return chosen.length > 0 ? chosen.sort((a, b) => a - b) : [1 / 3, 2 / 3].slice(0, Math.max(1, max));
}

/**
 * Which bone each vertex follows, wholly (four of each per vertex, as glTF
 * skins have them; only the first is ever used). Bone 0 is at the base and
 * bone k at `joints[k - 1]`: a vertex follows the bone at the start of the
 * stretch it's in, so every part of the arm moves as one solid piece.
 */
export function armWeights(positions: ArrayLike<number>, axis: ArmAxis, joints: readonly number[]): { joints: Uint16Array; weights: Float32Array } {
  const count = Math.floor(positions.length / 3);
  const bones = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const t = fraction(at(positions, i), axis);
    bones[i * 4] = joints.filter((j) => j <= t).length;
    weights[i * 4] = 1;
  }
  return { joints: bones, weights };
}

/** The camera's lens, along the model's forward (z, in its own frame): where the barrel starts to stretch, where the lens itself starts, and how far it zooms out. */
export interface ArmLens {
  neck: number;
  full: number;
  reach: number;
}

/**
 * Its camera's lens among `positions`: the front of the camera piece (past
 * the last of `joints`) along +z. Null when there's no camera piece.
 */
export function armLens(positions: ArrayLike<number>, axis: ArmAxis, joints: readonly number[]): ArmLens | null {
  const last = joints.length > 0 ? joints[joints.length - 1]! : 0;
  let back = Infinity;
  let front = -Infinity;
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i += 1) {
    const p = at(positions, i);
    if (fraction(p, axis) < last) continue;
    back = Math.min(back, p.z);
    front = Math.max(front, p.z);
  }
  const depth = front - back;
  if (!(depth > 0)) return null;
  return { neck: front - depth * ARM.lensNeck, full: front - depth * ARM.lensFront, reach: depth * ARM.lensReach };
}

/** How much of the lens's zoom a vertex at depth `z` follows: none behind the neck, all of it at the lens, eased between. */
export function lensShare(z: number, lens: ArmLens): number {
  if (z <= lens.neck) return 0;
  if (z >= lens.full) return 1;
  const f = (z - lens.neck) / (lens.full - lens.neck);
  return f * f * (3 - 2 * f);
}

const hashed = (seed: number, k: number): number => {
  let x = (Math.imul(seed | 0, 2654435761) ^ Math.imul(k | 0, 2246822519)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
};

/**
 * How far out the lens is at `t` seconds (0 all the way in, 1 all the way
 * out): every ARM.zoomEvery seconds it eases to a new depth (its own, from
 * `seed`) over ARM.zoomTime, and holds it.
 */
export function lensZoom(t: number, seed: number): number {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const k = Math.floor(time / ARM.zoomEvery);
  const from = k === 0 ? 0 : hashed(seed, k - 1);
  const to = hashed(seed, k);
  const f = Math.min(1, (time - k * ARM.zoomEvery) / ARM.zoomTime);
  return from + (to - from) * f * f * (3 - 2 * f);
}

/** A box the arm keeps out of (in the robot's own frame). */
export interface ArmBox {
  min: Vec3;
  max: Vec3;
}

/** Whether `point` is at least `margin` outside every one of `boxes`. */
export function clearOf(point: Vec3, boxes: readonly ArmBox[], margin: number): boolean {
  return boxes.every(
    (box) =>
      point.x < box.min.x - margin ||
      point.x > box.max.x + margin ||
      point.y < box.min.y - margin ||
      point.y > box.max.y + margin ||
      point.z < box.min.z - margin ||
      point.z > box.max.z + margin,
  );
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
  /** Whether reaching straight out from its base this way (unit length) would cross the robot; absent: never. */
  blocked?: (dir: Vec3) => boolean;
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
    // Moving again, it picks something new straight away.
    state.until = -Infinity;
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
      const r = input.rest;
      // Two directions square to the rest direction (from whichever axis it's least along).
      const seed = Math.abs(r.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const u = normal(cross(r, seed));
      const v = cross(r, u);
      // Somewhere off its rest direction (tipped away from it by an angle, at a random turn around
      // it) that doesn't mean reaching through the robot; failing that, its rest direction.
      let dir: Vec3 = r;
      for (let tries = 0; tries < ARM.wanderTries; tries += 1) {
        const off = ARM.wanderMin + random(state) * (ARM.wanderMax - ARM.wanderMin);
        const around = random(state) * Math.PI * 2;
        const side = { x: u.x * Math.cos(around) + v.x * Math.sin(around), y: u.y * Math.cos(around) + v.y * Math.sin(around), z: u.z * Math.cos(around) + v.z * Math.sin(around) };
        const pick = {
          x: r.x * Math.cos(off) + side.x * Math.sin(off),
          y: r.y * Math.cos(off) + side.y * Math.sin(off),
          z: r.z * Math.cos(off) + side.z * Math.sin(off),
        };
        if (!input.blocked?.(pick)) {
          dir = pick;
          break;
        }
      }
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
