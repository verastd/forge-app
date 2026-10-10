/**
 * Something that flies over a worn head, forever: a helicopter doing
 * figure-8s just above the model's top (its rooftops, for a head with a city
 * on it), with a searchlight on what's below: always on the model itself
 * (the figure-8 is over the part of the top that's there, not its bounding
 * box, and a pool that would fall on thin air moves to the nearest roof).
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
  size: 0.1875,
  minSize: 0.03,
  maxSize: 0.12,
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
  // Over what's there: the cells something was measured in (all of it, when nothing was).
  const filled = occupied(grid);
  const [ox0, oz0, ox1, oz1] = filled ?? [x0, z0, x1, z1];
  return {
    center: [(ox0 + ox1) / 2, (oz0 + oz1) / 2],
    halfX: ((ox1 - ox0) / 2) * FLYER.spread,
    halfZ: ((oz1 - oz0) / 2) * FLYER.spread,
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
  const [sx, sz] = onRoof(grid, clamp(here.x + fx * ahead + fz * across, grid.min[0], grid.max[0]), clamp(here.z + fz * ahead - fx * across, grid.min[1], grid.max[1]));
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

const measured = (h: number | null | undefined): h is number => h !== null && h !== undefined && Number.isFinite(h);

/** The cell (column, row) that (x, z) falls in, and that cell's middle. */
function cellAt(grid: RoofGrid, x: number, z: number): { col: number; row: number } {
  const col = clamp(Math.floor(((x - grid.min[0]) / (grid.max[0] - grid.min[0] || 1)) * grid.cols), 0, grid.cols - 1);
  const row = clamp(Math.floor(((z - grid.min[1]) / (grid.max[1] - grid.min[1] || 1)) * grid.rows), 0, grid.rows - 1);
  return { col, row };
}
function middleOf(grid: RoofGrid, col: number, row: number): [number, number] {
  return [
    grid.min[0] + ((col + 0.5) / grid.cols) * (grid.max[0] - grid.min[0]),
    grid.min[1] + ((row + 0.5) / grid.rows) * (grid.max[1] - grid.min[1]),
  ];
}

/** The extent (x0, z0, x1, z1) of the cells something was measured in; null when none was. */
function occupied(grid: RoofGrid): [number, number, number, number] | null {
  let found: [number, number, number, number] | null = null;
  const cw = (grid.max[0] - grid.min[0]) / Math.max(1, grid.cols);
  const ch = (grid.max[1] - grid.min[1]) / Math.max(1, grid.rows);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      if (!measured(grid.heights[row * grid.cols + col])) continue;
      const [x, z] = middleOf(grid, col, row);
      found = found
        ? [Math.min(found[0], x - cw / 2), Math.min(found[1], z - ch / 2), Math.max(found[2], x + cw / 2), Math.max(found[3], z + ch / 2)]
        : [x - cw / 2, z - ch / 2, x + cw / 2, z + ch / 2];
    }
  }
  return found;
}

/**
 * (x, z) if there's roof under it; else the middle of the nearest cell that
 * has some (so the searchlight never lands on thin air). With nothing
 * measured anywhere, (x, z) as it is.
 */
function onRoof(grid: RoofGrid, x: number, z: number): [number, number] {
  const { col, row } = cellAt(grid, x, z);
  if (measured(grid.heights[row * grid.cols + col])) return [x, z];
  let best: [number, number] | null = null;
  let bestDistance = Infinity;
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      if (!measured(grid.heights[r * grid.cols + c])) continue;
      const [mx, mz] = middleOf(grid, c, r);
      const d = Math.hypot(mx - x, mz - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = [mx, mz];
      }
    }
  }
  return best ?? [x, z];
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

/**
 * Measures a model's top as a `RoofGrid` (`n` × `n` cells over its
 * footprint): `positions` are its points (x, y, z, x, y, z…, in the frame it
 * flies in), `indices` its triangles (three point numbers each; null: points
 * only). Each cell takes the highest surface straight down at its middle:
 * every triangle over it, height blended across the triangle, and every point
 * in it (a spire too thin to cover a cell middle still counts). A box-built
 * city's roofs have points only at their corners, so the triangles are what
 * fill them. Null with no points.
 */
export function roofGrid(positions: ArrayLike<number>, indices: ArrayLike<number> | null, n: number = FLYER.grid): RoofGrid | null {
  const count = Math.floor(positions.length / 3);
  if (count === 0 || n < 1) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let top = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (!finite(x, y, z)) continue;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
    top = Math.max(top, y);
  }
  if (top === -Infinity) return null;
  const width = x1 - x0 || 1;
  const depth = z1 - z0 || 1;
  const heights: (number | null)[] = new Array<number | null>(n * n).fill(null);
  const raise = (col: number, row: number, y: number): void => {
    const cell = row * n + col;
    const was = heights[cell];
    if (was === null || was === undefined || y > was) heights[cell] = y;
  };
  const colOf = (x: number): number => Math.min(n - 1, Math.max(0, Math.floor(((x - x0) / width) * n)));
  const rowOf = (z: number): number => Math.min(n - 1, Math.max(0, Math.floor(((z - z0) / depth) * n)));
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (finite(x, y, z)) raise(colOf(x), rowOf(z), y);
  }
  if (indices) {
    const point = (k: number): [number, number, number] | null => {
      const at = indices[k];
      if (at === undefined || !Number.isInteger(at) || at < 0 || at >= count) return null;
      const p: [number, number, number] = [positions[at * 3]!, positions[at * 3 + 1]!, positions[at * 3 + 2]!];
      return finite(...p) ? p : null;
    };
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const a = point(k);
      const b = point(k + 1);
      const c = point(k + 2);
      if (!a || !b || !c) continue;
      // Twice the triangle's area as seen from above: flat-on-edge (a wall) covers no cell middle.
      const area = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
      if (Math.abs(area) < 1e-12) continue;
      const cMin = colOf(Math.min(a[0], b[0], c[0]));
      const cMax = colOf(Math.max(a[0], b[0], c[0]));
      const rMin = rowOf(Math.min(a[2], b[2], c[2]));
      const rMax = rowOf(Math.max(a[2], b[2], c[2]));
      for (let row = rMin; row <= rMax; row += 1) {
        const pz = z0 + ((row + 0.5) / n) * depth;
        for (let col = cMin; col <= cMax; col += 1) {
          const px = x0 + ((col + 0.5) / n) * width;
          // Where the cell's middle falls in the triangle (barycentric), from above.
          const wb = ((px - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (pz - a[2])) / area;
          const wc = ((b[0] - a[0]) * (pz - a[2]) - (px - a[0]) * (b[2] - a[2])) / area;
          const wa = 1 - wb - wc;
          const edge = -1e-9;
          if (wa < edge || wb < edge || wc < edge) continue;
          raise(col, row, wa * a[1] + wb * b[1] + wc * c[1]);
        }
      }
    }
  }
  return { min: [x0, z0], max: [x1, z1], cols: n, rows: n, heights, top };
}
