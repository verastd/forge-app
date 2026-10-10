/**
 * Building bricks in the cave: their shapes and colours, the stud grid they
 * sit on, and the rules for where one may go. The API keeps the same rules
 * (apps/api services/brick_rules.py) and has the last word; the browser uses
 * these to show, before it asks, whether a brick fits.
 *
 * The grid: x and z count studs (BRICK.stud metres each) from the cave's
 * middle, y counts plates (a brick is three plates tall) up from the floor.
 * A brick's (x, y, z) is its lowest corner cell. Rotations are quarter turns.
 *
 * A placed brick is loose (anyone may pick it up) until another brick is
 * fastened to it, stud to tube, above or below: then it's part of a build,
 * frozen for everyone but whoever makes the bricks.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

/** The grid and its limits, metres. Frozen. */
export const BRICK = Object.freeze({
  /** One stud, across. */
  stud: 0.2,
  /** One plate, up (a brick is three: 1.2 studs, as the real thing). */
  plate: 0.08,
  /** Building stays this far inside the walking disk's edge. */
  radius: 24,
  /** The highest a brick may reach, in plates (20 metres). */
  maxPlates: 250,
  /** How many bricks the cave holds, all told (so it stays smooth on a phone). */
  limit: 5000,
  /** How far away a brick can be reached, metres. */
  reach: 6,
});

export interface BrickShape {
  id: string;
  label: string;
  /** Studs along x and z before turning, and plates tall. */
  sx: number;
  sz: number;
  h: number;
  /** A slope: studs only along its high row (its first row along z). */
  slope?: boolean;
}

/** In the order keys 1–9 choose them. */
export const BRICK_SHAPES: readonly BrickShape[] = Object.freeze([
  { id: 'brick-1x1', label: '1×1 brick', sx: 1, sz: 1, h: 3 },
  { id: 'brick-1x2', label: '1×2 brick', sx: 2, sz: 1, h: 3 },
  { id: 'brick-1x4', label: '1×4 brick', sx: 4, sz: 1, h: 3 },
  { id: 'brick-2x2', label: '2×2 brick', sx: 2, sz: 2, h: 3 },
  { id: 'brick-2x4', label: '2×4 brick', sx: 4, sz: 2, h: 3 },
  { id: 'plate-1x2', label: '1×2 plate', sx: 2, sz: 1, h: 1 },
  { id: 'plate-2x2', label: '2×2 plate', sx: 2, sz: 2, h: 1 },
  { id: 'plate-2x4', label: '2×4 plate', sx: 4, sz: 2, h: 1 },
  { id: 'slope-2x2', label: '2×2 slope', sx: 2, sz: 2, h: 3, slope: true },
].map((shape) => Object.freeze(shape)));

/** The colours, in the order C steps through them. */
export const BRICK_COLORS: readonly { id: string; label: string; hex: string }[] = Object.freeze([
  { id: 'red', label: 'Red', hex: '#c91a09' },
  { id: 'blue', label: 'Blue', hex: '#0055bf' },
  { id: 'yellow', label: 'Yellow', hex: '#f2cd37' },
  { id: 'green', label: 'Green', hex: '#237841' },
  { id: 'white', label: 'White', hex: '#f4f4f4' },
  { id: 'black', label: 'Black', hex: '#1b2a34' },
  { id: 'orange', label: 'Orange', hex: '#fe8a18' },
  { id: 'lime', label: 'Lime', hex: '#bbe90b' },
  { id: 'azure', label: 'Azure', hex: '#36aebf' },
  { id: 'pink', label: 'Pink', hex: '#e4adc8' },
  { id: 'tan', label: 'Tan', hex: '#e4cd9e' },
  { id: 'grey', label: 'Grey', hex: '#a0a5a9' },
].map((colour) => Object.freeze(colour)));

export type BrickRot = 0 | 1 | 2 | 3;

/** A brick where it sits: its shape, its lowest corner cell, its turn. */
export interface BrickAt {
  shape: string;
  x: number;
  y: number;
  z: number;
  rot: BrickRot;
}

/** Why a brick can't go where it's aimed; null when it can. */
/** `machine`: a machine stands there (machine.ts `brickInMachine`; the rules here never say it). */
export type BrickProblem = 'shape' | 'outside' | 'overlap' | 'floating' | 'machine';

/** What each problem is, in words (the ghost's hint). */
export const BRICK_PROBLEM_TEXT: Readonly<Record<BrickProblem, string>> = Object.freeze({
  shape: 'That isn’t a brick shape.',
  outside: 'Too far out (or too high) to build there.',
  overlap: 'It would overlap a brick.',
  floating: 'Nothing to fasten it to: build on the floor or on studs.',
  machine: 'A machine is in the way.',
});

export function brickShape(id: string): BrickShape | null {
  return BRICK_SHAPES.find((shape) => shape.id === id) ?? null;
}

/** A shape's local cell (i along x, j along z) turned `rot` quarter turns, as an offset from the brick's corner. */
function turned(shape: BrickShape, rot: BrickRot, i: number, j: number): [number, number] {
  switch (rot) {
    case 0:
      return [i, j];
    case 1:
      return [shape.sz - 1 - j, i];
    case 2:
      return [shape.sx - 1 - i, shape.sz - 1 - j];
    case 3:
      return [j, shape.sx - 1 - i];
  }
}

/** The columns (x, z) a brick covers. */
export function brickCells(brick: BrickAt): [number, number][] {
  const shape = brickShape(brick.shape);
  if (!shape) return [];
  const cells: [number, number][] = [];
  for (let i = 0; i < shape.sx; i += 1) {
    for (let j = 0; j < shape.sz; j += 1) {
      const [dx, dz] = turned(shape, brick.rot, i, j);
      cells.push([brick.x + dx, brick.z + dz]);
    }
  }
  return cells;
}

/** The columns where its top has studs (a slope: only its high row). */
export function brickStuds(brick: BrickAt): [number, number][] {
  const shape = brickShape(brick.shape);
  if (!shape) return [];
  const cells: [number, number][] = [];
  for (let i = 0; i < shape.sx; i += 1) {
    for (let j = 0; j < (shape.slope ? 1 : shape.sz); j += 1) {
      const [dx, dz] = turned(shape, brick.rot, i, j);
      cells.push([brick.x + dx, brick.z + dz]);
    }
  }
  return cells;
}

/** How many plates tall. */
export function brickHeight(brick: BrickAt): number {
  return brickShape(brick.shape)?.h ?? 0;
}

const key = ([x, z]: [number, number]): string => `${x},${z}`;

function sharesCell(a: [number, number][], b: [number, number][]): boolean {
  const set = new Set(a.map(key));
  return b.some((cell) => set.has(key(cell)));
}

/** Whether two bricks take up any of the same space. */
export function bricksOverlap(a: BrickAt, b: BrickAt): boolean {
  const aTop = a.y + brickHeight(a);
  const bTop = b.y + brickHeight(b);
  if (a.y >= bTop || b.y >= aTop) return false;
  return sharesCell(brickCells(a), brickCells(b));
}

/** Whether two bricks are fastened: one sits right on the other's studs. */
export function bricksConnected(a: BrickAt, b: BrickAt): boolean {
  if (a.y + brickHeight(a) === b.y) return sharesCell(brickStuds(a), brickCells(b));
  if (b.y + brickHeight(b) === a.y) return sharesCell(brickStuds(b), brickCells(a));
  return false;
}

/** Why `brick` can't go where it says among `placed` (the bricks already there); null when it can. */
export function brickProblem(brick: BrickAt, placed: readonly BrickAt[]): BrickProblem | null {
  const shape = brickShape(brick.shape);
  if (!shape || ![0, 1, 2, 3].includes(brick.rot)) return 'shape';
  if (![brick.x, brick.y, brick.z].every(Number.isInteger)) return 'outside';
  if (brick.y < 0 || brick.y + shape.h > BRICK.maxPlates) return 'outside';
  const reach = BRICK.radius / BRICK.stud;
  // Every corner of every cell it covers within the build circle.
  for (const [x, z] of brickCells(brick)) {
    for (const [cx, cz] of [
      [x, z],
      [x + 1, z],
      [x, z + 1],
      [x + 1, z + 1],
    ] as const) {
      if (Math.hypot(cx, cz) > reach) return 'outside';
    }
  }
  if (placed.some((other) => bricksOverlap(brick, other))) return 'overlap';
  if (brick.y > 0 && !placed.some((other) => bricksConnected(brick, other))) return 'floating';
  return null;
}

/** Whether a placed brick is part of a build (another brick is fastened to it): frozen for all but the maker. */
export function brickFrozen(brick: BrickAt, placed: readonly BrickAt[]): boolean {
  return placed.some((other) => other !== brick && bricksConnected(brick, other));
}

/** A brick's box in metres (cave frame), for drawing and aiming. */
export function brickBox(brick: BrickAt): { min: [number, number, number]; max: [number, number, number] } {
  const cells = brickCells(brick);
  const xs = cells.map(([x]) => x);
  const zs = cells.map(([, z]) => z);
  return {
    min: [Math.min(...xs) * BRICK.stud, brick.y * BRICK.plate, Math.min(...zs) * BRICK.stud],
    max: [(Math.max(...xs) + 1) * BRICK.stud, (brick.y + brickHeight(brick)) * BRICK.plate, (Math.max(...zs) + 1) * BRICK.stud],
  };
}

export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
}

/** Where a ray first meets a box (distance and the face's outward normal), or null. */
export function rayBox(ray: Ray, min: readonly number[], max: readonly number[]): { t: number; normal: [number, number, number] } | null {
  let near = -Infinity;
  let far = Infinity;
  let axis = -1;
  let sign = 0;
  for (let k = 0; k < 3; k += 1) {
    const o = ray.origin[k]!;
    const d = ray.dir[k]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min[k]! || o > max[k]!) return null;
      continue;
    }
    let t0 = (min[k]! - o) / d;
    let t1 = (max[k]! - o) / d;
    let s = -1;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
      s = 1;
    }
    if (t0 > near) {
      near = t0;
      axis = k;
      sign = s;
    }
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  if (far < 0 || axis < 0 || near < 0) return null;
  const normal: [number, number, number] = [0, 0, 0];
  normal[axis] = sign;
  return { t: near, normal };
}

/** The placed brick a ray hits first, within reach; null for none. */
export function brickUnderRay<T extends BrickAt>(ray: Ray, placed: readonly T[], reach: number = BRICK.reach): { brick: T; t: number; normal: [number, number, number] } | null {
  let best: { brick: T; t: number; normal: [number, number, number] } | null = null;
  for (const brick of placed) {
    const box = brickBox(brick);
    const hit = rayBox(ray, box.min, box.max);
    if (hit && hit.t <= reach && (!best || hit.t < best.t)) best = { brick, ...hit };
  }
  return best;
}

/**
 * Where a held brick of `shape`, turned `rot`, would go for a ray: on the
 * floor or a brick's top where it hits, or beside a brick's side; centred on
 * the cell it hits. Null when the ray meets nothing within reach.
 */
export function aimBrick(ray: Ray, shape: string, rot: BrickRot, placed: readonly BrickAt[], reach: number = BRICK.reach): BrickAt | null {
  const kind = brickShape(shape);
  if (!kind) return null;
  const turnedX = rot % 2 === 0 ? kind.sx : kind.sz;
  const turnedZ = rot % 2 === 0 ? kind.sz : kind.sx;
  const hit = brickUnderRay(ray, placed, reach);
  let point: [number, number, number];
  let y: number;
  if (hit) {
    const at = ray.origin.map((o, k) => o + ray.dir[k]! * hit.t) as [number, number, number];
    const box = brickBox(hit.brick);
    if (hit.normal[1] > 0) {
      y = hit.brick.y + brickHeight(hit.brick);
    } else if (hit.normal[1] < 0) {
      y = hit.brick.y - kind.h;
    } else {
      y = hit.brick.y;
    }
    // Just outside the face it hits, so a side hit lands beside it.
    point = [at[0] + hit.normal[0] * BRICK.stud * 0.5, at[1], at[2] + hit.normal[2] * BRICK.stud * 0.5];
    if (hit.normal[1] !== 0) point = [Math.min(Math.max(at[0], box.min[0]), box.max[0] - 1e-6), at[1], Math.min(Math.max(at[2], box.min[2]), box.max[2] - 1e-6)];
  } else {
    // The floor.
    if (ray.dir[1] >= 0) return null;
    const t = -ray.origin[1] / ray.dir[1];
    if (t > reach) return null;
    point = [ray.origin[0] + ray.dir[0] * t, 0, ray.origin[2] + ray.dir[2] * t];
    y = 0;
  }
  const cx = Math.floor(point[0] / BRICK.stud);
  const cz = Math.floor(point[2] / BRICK.stud);
  return {
    shape,
    x: cx - Math.floor((turnedX - 1) / 2),
    y: Math.max(0, y),
    z: cz - Math.floor((turnedZ - 1) / 2),
    rot,
  };
}

/**
 * A free spot on the floor for a dropped brick, as near as can be to (x, z)
 * metres: the cell under it, else the nearest free one in rings around it.
 */
export function floorSpot(shape: string, rot: BrickRot, x: number, z: number, placed: readonly BrickAt[]): BrickAt | null {
  const cx = Math.floor(x / BRICK.stud);
  const cz = Math.floor(z / BRICK.stud);
  for (let ring = 0; ring <= 12; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const brick: BrickAt = { shape, x: cx + dx, y: 0, z: cz + dz, rot };
        if (brickProblem(brick, placed) === null) return brick;
      }
    }
  }
  return null;
}

/** The next turn. */
export function nextRot(rot: BrickRot): BrickRot {
  return ((rot + 1) % 4) as BrickRot;
}
