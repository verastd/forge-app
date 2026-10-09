/**
 * Something that flies over a worn head, forever: a helicopter doing
 * figure-8s just above the model's top (its rooftops, for a head with a city
 * on it), with a searchlight on what's below.
 *
 * The renderer measures the model's top once, as a coarse grid of heights
 * (`RoofGrid`, the head frame, metres); from that this says where the
 * helicopter may fly (`flightArea`), where it is at any moment
 * (`flightPose`), and how high the roof is under any point (`roofAt`), so the
 * searchlight's pool lands on the buildings. Pure and deterministic like the
 * rest of the package: no DOM, no three.js.
 */
import type { Point3 } from './headFit.js';

/** What may fly over a head (@forge/shared's AVATAR_HEAD_FLYERS). */
export const HEAD_FLYERS = Object.freeze(['helicopter'] as const);
export type HeadFlyer = (typeof HEAD_FLYERS)[number];

/** How it flies. Frozen. */
export const FLYER = Object.freeze({
  /** Heights measured across the model's top, each way. */
  grid: 12,
  /** How much of the top's width and depth the figure-8 covers. */
  spread: 0.7,
  /** The helicopter's length, times the top's larger side, and its least and most, metres. */
  size: 0.25,
  minSize: 0.04,
  maxSize: 0.16,
  /** How far above the tallest roof it cruises: at least this, metres, or this many of its own lengths. */
  clearance: 0.04,
  clearanceLengths: 1.1,
  /** Seconds round the figure-8 once. */
  period: 9,
  /** Its gentle rise and fall: metres, and seconds a cycle. */
  bob: 0.006,
  bobPeriod: 2.3,
  /** Its lean into a turn, radians: per radian a second of turning, and the most. */
  bankGain: 0.35,
  maxBank: 0.5,
  /** Nose down, radians, as it flies forward. */
  lean: 0.12,
  /** The searchlight's pool: how far ahead of the helicopter, in its lengths, and its sweep, side to side. */
  ahead: 1.2,
  sweep: 0.3,
  sweepPeriod: 5.3,
});

/**
 * The model's top, measured: `heights[row * cols + col]` is the highest point
 * of the model straight down at that cell's middle (null: nothing there), over
 * `min`..`max` (x, z). `top` is the model's highest point anywhere.
 */
export interface RoofGrid {
  min: Readonly<[number, number]>;
  max: Readonly<[number, number]>;
  cols: number;
  rows: number;
  heights: readonly (number | null)[];
  top: number;
}

/** Where it flies: the figure-8's middle and half-widths (x, z), its height, and its length. */
export interface FlightArea {
  center: [number, number];
  halfX: number;
  halfZ: number;
  cruise: number;
  size: number;
}

/** Where it is now: position, heading (yaw, radians, 0 nose to +z), bank and nose-down lean, and the pool's spot. */
export interface FlightPose {
  position: Point3;
  yaw: number;
  bank: number;
  pitch: number;
  /** Where the searchlight's pool is, on the roofs (x, roof height, z). */
  spot: Point3;
}

const TAU = Math.PI * 2;

function finite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

/** The tallest roof measured, or the model's top when nothing was hit. */
function tallest(grid: RoofGrid): number {
  let most = -Infinity;
  for (const h of grid.heights) if (h !== null && Number.isFinite(h) && h > most) most = h;
  return most === -Infinity ? grid.top : most;
}

/**
 * Where the flyer may go over a model measured as `grid`: the middle
 * `FLYER.spread` of its top, above its tallest roof. Null when the grid has
 * no area to fly over.
 */
export function flightArea(grid: RoofGrid): FlightArea | null {
  const [x0, z0] = grid.min;
  const [x1, z1] = grid.max;
  const width = x1 - x0;
  const depth = z1 - z0;
  if (!finite(x0, z0, x1, z1, grid.top) || width <= 0 || depth <= 0) return null;
  const size = Math.min(FLYER.maxSize, Math.max(FLYER.minSize, FLYER.size * Math.max(width, depth)));
  return {
    center: [(x0 + x1) / 2, (z0 + z1) / 2],
    halfX: (width / 2) * FLYER.spread,
    halfZ: (depth / 2) * FLYER.spread,
    cruise: tallest(grid) + Math.max(FLYER.clearance, size * FLYER.clearanceLengths),
    size,
  };
}

/** Where along the figure-8 (a lemniscate of Gerono) it is at angle `s`, and which way it's going. */
function along(area: FlightArea, s: number): { x: number; z: number; dx: number; dz: number } {
  return {
    x: area.center[0] + area.halfX * Math.sin(s),
    z: area.center[1] + area.halfZ * Math.sin(2 * s),
    dx: area.halfX * Math.cos(s),
    dz: 2 * area.halfZ * Math.cos(2 * s),
  };
}

function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** `a - b`, the short way round. */
function turnBetween(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

/**
 * The flyer at `t` seconds, `phase` radians round (so two robots in the same
 * head don't fly in step; see `flyerPhase`), over `grid` (for the pool's
 * height). Banks into its turns, nose a little down, the searchlight just
 * ahead and sweeping side to side.
 */
export function flightPose(area: FlightArea, grid: RoofGrid, t: number, phase = 0): FlightPose {
  const time = Number.isFinite(t) ? t : 0;
  const start = Number.isFinite(phase) ? phase : 0;
  const omega = TAU / FLYER.period;
  const s = omega * time + start;
  const here = along(area, s);
  const yaw = headingOf(here.dx, here.dz);
  // How fast it turns (radians a second), from the heading a moment either side.
  const ds = 0.01;
  const before = along(area, s - ds);
  const after = along(area, s + ds);
  const turnRate = (turnBetween(headingOf(after.dx, after.dz), headingOf(before.dx, before.dz)) / (2 * ds)) * omega;
  const bank = Math.max(-FLYER.maxBank, Math.min(FLYER.maxBank, turnRate * FLYER.bankGain));
  const y = area.cruise + FLYER.bob * Math.sin((TAU * time) / FLYER.bobPeriod + start);
  // The pool: ahead along the heading, swept across it, kept over the top.
  const ahead = area.size * FLYER.ahead;
  const across = area.halfX * FLYER.sweep * Math.sin((TAU * time) / FLYER.sweepPeriod + start);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const sx = clamp(here.x + fx * ahead + fz * across, grid.min[0], grid.max[0]);
  const sz = clamp(here.z + fz * ahead - fx * across, grid.min[1], grid.max[1]);
  return {
    position: [here.x, y, here.z],
    yaw,
    bank,
    pitch: FLYER.lean,
    spot: [sx, roofAt(grid, sx, sz), sz],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * How high the model is straight down at (x, z): between the measured cells,
 * blended; off the grid, its nearest edge. Where nothing was hit, the lowest
 * roof measured (or the model's top when nothing was).
 */
export function roofAt(grid: RoofGrid, x: number, z: number): number {
  const { cols, rows, heights } = grid;
  if (cols < 1 || rows < 1 || heights.length < cols * rows) return grid.top;
  let lowest = Infinity;
  for (const h of heights) if (h !== null && Number.isFinite(h) && h < lowest) lowest = h;
  const fallback = lowest === Infinity ? grid.top : lowest;
  const at = (col: number, row: number): number => heights[row * cols + col] ?? fallback;
  // Cell middles sit at (i + 0.5) / n across: find where (x, z) falls between them.
  const u = clamp(((x - grid.min[0]) / (grid.max[0] - grid.min[0] || 1)) * cols - 0.5, 0, cols - 1);
  const v = clamp(((z - grid.min[1]) / (grid.max[1] - grid.min[1] || 1)) * rows - 0.5, 0, rows - 1);
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fu = u - c0;
  const fv = v - r0;
  const top = at(c0, r0) * (1 - fu) + at(c1, r0) * fu;
  const bottom = at(c0, r1) * (1 - fu) + at(c1, r1) * fu;
  return top * (1 - fv) + bottom * fv;
}

/** Where round the figure-8 a robot's flyer starts, radians: from its member id, so no two fly in step. */
export function flyerPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) * TAU;
}

/** The flyer a stored value names, or null for anything else. */
export function parseFlyer(raw: unknown): HeadFlyer | null {
  return raw === 'helicopter' ? raw : null;
}
