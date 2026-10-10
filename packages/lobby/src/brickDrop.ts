/**
 * A brick dropping out of the Lego bot's backpack: it slides out of the ramp
 * tiny, falls in an arc to where it lands on the floor, growing to its full
 * size on the way, with a tumble that settles as it lands. And a blueprint's
 * burst: little bricks shot from the ramp toward where the build went.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import type { Vec3 } from './attenuation.js';

export const BRICK_DROP = Object.freeze({
  /** How small it comes out (times its full size). */
  startScale: 0.06,
  /** Seconds sliding out of the ramp, then falling to the floor. */
  slide: 0.25,
  fall: 0.75,
  /** How far it slides out, metres. */
  slideDistance: 0.14,
  /** How high the arc goes above the higher of its ends, metres. */
  lift: 0.35,
  /** Turns it tumbles on the way (it lands square). */
  tumble: 1,
  /** A burst: how many little bricks, their size, and how long they fly. */
  burstCount: 12,
  burstScale: 0.08,
  burstTime: 0.8,
});

/** Where a dropping brick is at `t` seconds: its centre, its scale, its tumble (radians), and whether it's landed. */
export interface DropFrame {
  at: Vec3;
  scale: number;
  spin: number;
  done: boolean;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => t * t * (3 - 2 * t);

/**
 * A brick's drop from the ramp at `from` (pointing `dir`, unit length, out of
 * the ramp) to its centre where it lands, `to`.
 */
export function dropFrame(t: number, from: Vec3, dir: Vec3, to: Vec3): DropFrame {
  const time = Math.max(0, t);
  const out: Vec3 = {
    x: from.x + dir.x * BRICK_DROP.slideDistance,
    y: from.y + dir.y * BRICK_DROP.slideDistance,
    z: from.z + dir.z * BRICK_DROP.slideDistance,
  };
  if (time < BRICK_DROP.slide) {
    const s = ease(time / BRICK_DROP.slide);
    return { at: { x: lerp(from.x, out.x, s), y: lerp(from.y, out.y, s), z: lerp(from.z, out.z, s) }, scale: BRICK_DROP.startScale, spin: 0, done: false };
  }
  const f = Math.min(1, (time - BRICK_DROP.slide) / BRICK_DROP.fall);
  // A parabola through the ramp's mouth and the landing spot, peaking `lift` above the higher.
  const top = Math.max(out.y, to.y) + BRICK_DROP.lift;
  const y = (1 - f) * (1 - f) * out.y + 2 * (1 - f) * f * (2 * top - (out.y + to.y) / 2) + f * f * to.y;
  return {
    at: { x: lerp(out.x, to.x, f), y, z: lerp(out.z, to.z, f) },
    scale: lerp(BRICK_DROP.startScale, 1, ease(f)),
    spin: BRICK_DROP.tumble * Math.PI * 2 * ease(f),
    done: f >= 1,
  };
}

/** How long a drop takes, seconds. */
export const DROP_TIME = BRICK_DROP.slide + BRICK_DROP.fall;

/**
 * Where the little bricks of a burst land: spread over a disk of `radius`
 * metres around `to`, the same for everyone who sees it (`seed` picks them).
 */
export function burstTargets(to: Vec3, radius: number, seed: number, count: number = BRICK_DROP.burstCount): Vec3[] {
  let state = (Math.floor(seed) >>> 0) || 1;
  const next = (): number => {
    // xorshift32: small, fast, the same everywhere.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return Array.from({ length: count }, () => {
    const angle = next() * Math.PI * 2;
    const r = Math.sqrt(next()) * radius;
    return { x: to.x + Math.cos(angle) * r, y: to.y, z: to.z + Math.sin(angle) * r };
  });
}
