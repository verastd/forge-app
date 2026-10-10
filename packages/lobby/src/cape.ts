/**
 * The built-in cape: cloth hung from the shoulders, in the back frame
 * (BACK_ANCHOR: origin on the torso's back plate between the shoulder blades,
 * +Y up, +Z toward the robot's front, so behind it is −Z).
 *
 * It's not simulated, it's shaped: each frame its middle line is laid down
 * row by row, every row the same length (the cloth never stretches), swung
 * back by the robot's speed (streaming out behind it in flight), down a little
 * more when it climbs and up when it drops, out to one side as it turns, and
 * across its width a ripple runs down it, flapping harder the faster it goes.
 * With reduced motion it hangs still. Pure and deterministic like the rest of
 * the package: no DOM, no three.js.
 */
import type { Point3 } from './headFit.js';

/** Its size and how it moves. Frozen. */
export const CAPE = Object.freeze({
  /** Rows down it and columns across it (a grid of rows+1 × cols+1 points). */
  rows: 16,
  cols: 12,
  /** Where it hangs from: this high above the anchor, this far behind the back plate. */
  top: 0.06,
  behind: 0.012,
  /** Its length down the middle, its width at the shoulders and at the hem (metres). */
  length: 0.62,
  topWidth: 0.36,
  hemWidth: 0.5,
  /** How far back from straight down it hangs at rest (radians, at the hem), so it clears the pod. */
  droop: 0.08,
  /** How far back it streams at full speed (radians, at the hem), and the speed that is (m/s). */
  maxLift: 1.15,
  fullSpeed: 5,
  /** Radians more droop per m/s of climb (and lift per m/s of fall), and the most either way. */
  climbGain: 0.12,
  maxClimb: 0.35,
  /** How far it swings out per rad/s of turning, and the most (radians, at the hem). */
  swingGain: 0.35,
  maxSwing: 0.5,
  /** The ripple across it: its height at rest and the extra at full speed (metres). */
  ripple: 0.006,
  flap: 0.022,
  /** Its slow sway at rest (radians at the hem) and how fast (radians a second). */
  sway: 0.05,
  swaySpeed: 1.3,
  /** Never closer than this behind the back plate (metres), across the back's width (half-width, metres)… */
  clearance: 0.004,
  backHalfWidth: 0.148,
  /** …and beyond it, wrapping round the shoulders, never further forward than this (still behind the arms). */
  wrapLimit: 0.03,
  /** How far its top corners wrap forward round the shoulders, and the depth of its folds (metres). */
  wrap: 0.05,
  pleat: 0.012,
});

/** What moves the cape: the robot's own motion (avatarMotion's MotionInput). */
export interface CapeInput {
  t: number;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Vertical speed, m/s (up positive). */
  climb: number;
  /** Turning, rad/s (positive: turning to its left). */
  turnRate: number;
  reducedMotion: boolean;
}

/** How the cape hangs now: how far it streams back (0..1), its swing out to the side (radians), time. */
export interface CapePose {
  lift: number;
  climb: number;
  swing: number;
  t: number;
  still: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** The cape's pose for the robot's motion now. Reduced motion: hanging still, whatever it does. */
export function capePose(input: CapeInput): CapePose {
  if (input.reducedMotion) return { lift: 0, climb: 0, swing: 0, t: 0, still: true };
  const speed = Math.max(0, finiteOr(input.speed, 0));
  return {
    lift: clamp(speed / CAPE.fullSpeed, 0, 1),
    climb: clamp(finiteOr(input.climb, 0) * CAPE.climbGain, -CAPE.maxClimb, CAPE.maxClimb) + 0,
    // A turn to its left swings the cloth out to its right (−X): it's left behind the turn.
    swing: clamp(-finiteOr(input.turnRate, 0) * CAPE.swingGain, -CAPE.maxSwing, CAPE.maxSwing) + 0,
    t: finiteOr(input.t, 0),
    still: false,
  };
}

/** How far down the cape row `i` is, 0 at the shoulders to 1 at the hem. */
function down(i: number): number {
  return i / CAPE.rows;
}

/**
 * The cape's middle line, shoulders to hem (rows + 1 points, back frame).
 * Every step is `length / rows` long. Each step leans back by the droop, the
 * lift and the climb, more toward the hem, and out to the side by the swing.
 */
export function capeSpine(pose: CapePose): Point3[] {
  const step = CAPE.length / CAPE.rows;
  const points: Point3[] = [[0, CAPE.top, -CAPE.behind]];
  for (let i = 0; i < CAPE.rows; i += 1) {
    const along = down(i + 0.5);
    const sway = pose.still ? 0 : CAPE.sway * Math.sin(pose.t * CAPE.swaySpeed) * along;
    // Back from straight down (climbing, the air presses it down; falling, it lifts): never
    // forward into the robot.
    const back = Math.max(0, (CAPE.droop + CAPE.maxLift * pose.lift * Math.pow(along, 0.8) - pose.climb * along + sway) * Math.min(1, along * 2 + 0.2));
    const side = pose.swing * Math.pow(along, 1.5);
    const [x, y, z] = points[i]!;
    points.push([x + step * Math.sin(side), y - step * Math.cos(side) * Math.cos(back), z - step * Math.cos(side) * Math.sin(back)]);
  }
  return points;
}

/**
 * Every point of the cape (rows + 1 by cols + 1, row by row from the
 * shoulders, each row from −X to +X), x, y, z in turn, into `out` if it's big
 * enough. Wider toward the hem; the ripple runs across it and down it, and it
 * is never closer to the robot than the back plate allows.
 */
export function capePoints(pose: CapePose, out?: Float32Array): Float32Array {
  const size = (CAPE.rows + 1) * (CAPE.cols + 1) * 3;
  const points = out && out.length >= size ? out : new Float32Array(size);
  const spine = capeSpine(pose);
  const amplitude = pose.still ? 0 : CAPE.ripple + CAPE.flap * pose.lift;
  for (let i = 0; i <= CAPE.rows; i += 1) {
    const along = down(i);
    const half = (CAPE.topWidth + (CAPE.hemWidth - CAPE.topWidth) * along) / 2;
    const [cx, cy, cz] = spine[i]!;
    for (let j = 0; j <= CAPE.cols; j += 1) {
      const u = (j / CAPE.cols) * 2 - 1;
      // Folds across it, travelling down from the shoulders, bigger toward the hem; the edges curl back.
      const ripple = amplitude * along * Math.sin(u * 5.5 + pose.t * 6 - along * 7);
      const curl = 0.02 * u * u * along;
      // Its resting folds, and its top corners wrapped forward round the shoulders.
      const pleat = CAPE.pleat * Math.sin(u * Math.PI * 3.5) * (0.3 + 0.7 * along);
      const wrap = CAPE.wrap * Math.max(0, (Math.abs(u) - 0.6) / 0.4) * (1 - along) ** 2;
      const x = cx + u * half;
      const k = (i * (CAPE.cols + 1) + j) * 3;
      points[k] = x;
      points[k + 1] = cy;
      points[k + 2] = Math.min(Math.abs(x) <= CAPE.backHalfWidth ? -CAPE.clearance : CAPE.wrapLimit, cz - ripple - curl - pleat + wrap);
    }
  }
  return points;
}
