/**
 * The mechanic's machines: a 3D model (a blueprint) built on the cave's floor,
 * part by part, the parts flying out of the engine on his back.
 *
 * - Where one may stand (`machineProblem`, mirrored by apps/api's
 *   services/machine_rules.py): its blueprint is scaled so its longest side is
 *   MACHINE.size metres times its `scale`, turned `turn` steps of 15°, on the
 *   floor at (x, z). Its footprint (the floor box around it, turned) stays
 *   inside the building circle and off every other machine and every brick.
 * - Its parts (`machineParts`): a model that comes in pieces (a STEP
 *   conversion, or a glTF with several meshes) keeps them; a model that's one
 *   fused mesh (Tripo's) is split where it falls apart (pieces that share no
 *   vertex), and its biggest pieces into chunks by where their triangles are.
 *   Crumbs go with their nearest neighbour, and there are never more than
 *   MACHINE.maxParts.
 * - Its build (`buildOrder`, `partStart`, `partFrame`): bottom up, big before
 *   small, a part every so often, each one flying from the ramp in an arc,
 *   growing as it goes, and snapping into place.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import type { Vec3 } from './attenuation.js';
import { BRICK, brickBox, brickCells, rayBox } from './bricks.js';
import type { BrickAt, Ray } from './bricks.js';

export const MACHINE = Object.freeze({
  /** A blueprint's longest side at scale 1, metres. */
  size: 1.2,
  /** How many machines the cave holds. */
  limit: 40,
  /** Steps in a whole turn (15° each). */
  turns: 24,
  scaleMin: 0.5,
  scaleMax: 2,
  /** How far away the floor can be aimed at, metres. */
  reach: 10,
  /** At least this many parts (a fused model is cut up until it has them) and at most this many. */
  minParts: 8,
  maxParts: 30,
  /** A piece smaller than this, across, against the whole model goes with its nearest neighbour. */
  crumb: 0.04,
  /** Seconds between parts, and the most a whole build takes. */
  gap: 0.45,
  buildMax: 18,
  /** Seconds a part flies, how small it starts, and how high its arc goes (metres, plus a share of its distance). */
  fly: 0.9,
  startScale: 0.15,
  lift: 0.5,
  liftShare: 0.3,
  /** Turns a part spins on the way (it lands square). */
  spin: 1.25,
  /** Seconds its snap into place lasts (a little overshoot, then still). */
  snap: 0.18,
});

const SLACK = 1e-9;

export type MachineProblem = 'outside' | 'overlap' | 'bricks';

export const MACHINE_PROBLEM_TEXT: Readonly<Record<MachineProblem, string>> = Object.freeze({
  outside: 'That’s outside the building area.',
  overlap: 'Another machine is in the way.',
  bricks: 'Bricks are in the way.',
});

/** A machine where it stands: its blueprint's size (its own units) and its placing. */
export interface MachineSpot {
  size: readonly [number, number, number];
  x: number;
  z: number;
  turn: number;
  scale: number;
}

export interface FloorBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Its width, height and depth in metres. */
export function machineExtent(size: readonly [number, number, number], scale: number): [number, number, number] {
  const k = (MACHINE.size * scale) / Math.max(...size);
  return [size[0] * k, size[1] * k, size[2] * k];
}

/** Its turn in radians (about up). */
export function machineAngle(turn: number): number {
  return (turn * 2 * Math.PI) / MACHINE.turns;
}

/** The floor box around it, turned. */
export function machineFootprint(spot: MachineSpot): FloorBox {
  const [w, , d] = machineExtent(spot.size, spot.scale);
  const angle = machineAngle(spot.turn);
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const hw = (w * c + d * s) / 2;
  const hd = (w * s + d * c) / 2;
  return { minX: spot.x - hw, maxX: spot.x + hw, minZ: spot.z - hd, maxZ: spot.z + hd };
}

function overlap(a: FloorBox, b: FloorBox): boolean {
  return a.minX < b.maxX - SLACK && b.minX < a.maxX - SLACK && a.minZ < b.maxZ - SLACK && b.minZ < a.maxZ - SLACK;
}

/** Why it can't stand there, or null. */
export function machineProblem(spot: MachineSpot, others: readonly MachineSpot[], bricks: readonly BrickAt[]): MachineProblem | null {
  const box = machineFootprint(spot);
  const farX = Math.max(Math.abs(box.minX), Math.abs(box.maxX));
  const farZ = Math.max(Math.abs(box.minZ), Math.abs(box.maxZ));
  if (Math.hypot(farX, farZ) > BRICK.radius) return 'outside';
  if (others.some((other) => overlap(box, machineFootprint(other)))) return 'overlap';
  for (const brick of bricks) {
    for (const [cx, cz] of brickCells(brick)) {
      const cell = { minX: cx * BRICK.stud, maxX: (cx + 1) * BRICK.stud, minZ: cz * BRICK.stud, maxZ: (cz + 1) * BRICK.stud };
      if (overlap(box, cell)) return 'bricks';
    }
  }
  return null;
}

/** Whether a brick would stand inside a machine: over its footprint, below its top (mirrored by machine_rules.brick_blocked). */
export function brickInMachine(brick: BrickAt, machines: readonly MachineSpot[]): boolean {
  const box = brickBox(brick);
  return machines.some((machine) => {
    if (box.min[1] >= machineExtent(machine.size, machine.scale)[1] - SLACK) return false;
    const footprint = machineFootprint(machine);
    return brickCells(brick).some(([cx, cz]) =>
      overlap(footprint, { minX: cx * BRICK.stud, maxX: (cx + 1) * BRICK.stud, minZ: cz * BRICK.stud, maxZ: (cz + 1) * BRICK.stud }),
    );
  });
}

/** Where a ray meets the floor within reach, or null (looking up, or too far). */
export function aimFloor(ray: Ray, reach: number = MACHINE.reach): { x: number; z: number } | null {
  const dy = ray.dir[1];
  if (dy >= -1e-6) return null;
  const t = -ray.origin[1] / dy;
  if (t < 0 || t > reach) return null;
  return { x: ray.origin[0] + ray.dir[0] * t, z: ray.origin[2] + ray.dir[2] * t };
}

/** The machine a ray hits first (its standing box), within reach; null for none. */
export function machineUnderRay<T extends MachineSpot>(ray: Ray, machines: readonly T[], reach: number = MACHINE.reach): T | null {
  let best: { machine: T; t: number } | null = null;
  for (const machine of machines) {
    const box = machineFootprint(machine);
    const height = machineExtent(machine.size, machine.scale)[1];
    const hit = rayBox(ray, [box.minX, 0, box.minZ], [box.maxX, height, box.maxZ]);
    if (hit && hit.t <= reach && (!best || hit.t < best.t)) best = { machine, t: hit.t };
  }
  return best?.machine ?? null;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** A mesh of the model: its vertex positions (x, y, z, … in the model's frame) and its triangles (null: unindexed). */
export interface MachineMesh {
  positions: ArrayLike<number>;
  index: ArrayLike<number> | null;
}

export interface MachinePart {
  /** Its box in the model's frame, and its middle. */
  min: Vec3;
  max: Vec3;
  centre: Vec3;
  triangles: number;
}

export interface MachineSplit {
  parts: MachinePart[];
  /** For each mesh, each triangle's part. */
  triangleParts: Int32Array[];
}

interface Piece {
  mesh: number;
  /** Its triangles (in its mesh). */
  tris: number[];
  min: [number, number, number];
  max: [number, number, number];
  /** Sum of its triangles' middles, for its centroid. */
  sum: [number, number, number];
}

function triangleCount(mesh: MachineMesh): number {
  return Math.floor((mesh.index ? mesh.index.length : mesh.positions.length / 3) / 3);
}

function corner(mesh: MachineMesh, tri: number, k: number): number {
  return mesh.index ? mesh.index[tri * 3 + k]! : tri * 3 + k;
}

function triMiddle(mesh: MachineMesh, tri: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    const v = corner(mesh, tri, k);
    for (let a = 0; a < 3; a += 1) out[a]! += mesh.positions[v * 3 + a]! / 3;
  }
  return out;
}

function newPiece(mesh: number): Piece {
  return { mesh, tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0] };
}

function addTriangle(piece: Piece, meshes: readonly MachineMesh[], tri: number): void {
  const mesh = meshes[piece.mesh]!;
  piece.tris.push(tri);
  for (let k = 0; k < 3; k += 1) {
    const v = corner(mesh, tri, k);
    for (let a = 0; a < 3; a += 1) {
      const value = mesh.positions[v * 3 + a]!;
      piece.min[a] = Math.min(piece.min[a]!, value);
      piece.max[a] = Math.max(piece.max[a]!, value);
    }
  }
  const middle = triMiddle(mesh, tri);
  for (let a = 0; a < 3; a += 1) piece.sum[a]! += middle[a]!;
}

function find(parent: Int32Array, i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root]!;
  while (parent[i] !== root) {
    const next = parent[i]!;
    parent[i] = root;
    i = next;
  }
  return root;
}

/** A mesh's pieces that share no vertex (vertices at the same spot, within `weld`, count as one). */
function connectedPieces(meshes: readonly MachineMesh[], m: number, weld: number): Piece[] {
  const mesh = meshes[m]!;
  const count = triangleCount(mesh);
  const vertexCount = mesh.positions.length / 3;
  // Weld: one id per spot.
  const spots = new Map<string, number>();
  const spotOf = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${Math.round(mesh.positions[v * 3]! / weld)},${Math.round(mesh.positions[v * 3 + 1]! / weld)},${Math.round(mesh.positions[v * 3 + 2]! / weld)}`;
    let id = spots.get(key);
    if (id === undefined) {
      id = spots.size;
      spots.set(key, id);
    }
    spotOf[v] = id;
  }
  const parent = new Int32Array(spots.size);
  for (let i = 0; i < parent.length; i += 1) parent[i] = i;
  for (let tri = 0; tri < count; tri += 1) {
    const a = find(parent, spotOf[corner(mesh, tri, 0)]!);
    for (let k = 1; k < 3; k += 1) {
      const b = find(parent, spotOf[corner(mesh, tri, k)]!);
      if (a !== b) parent[b] = a;
    }
  }
  const byRoot = new Map<number, Piece>();
  for (let tri = 0; tri < count; tri += 1) {
    const root = find(parent, spotOf[corner(mesh, tri, 0)]!);
    let piece = byRoot.get(root);
    if (!piece) {
      piece = newPiece(m);
      byRoot.set(root, piece);
    }
    addTriangle(piece, meshes, tri);
  }
  return [...byRoot.values()];
}

/** A mesh as one piece. */
function wholePiece(meshes: readonly MachineMesh[], m: number): Piece {
  const piece = newPiece(m);
  for (let tri = 0; tri < triangleCount(meshes[m]!); tri += 1) addTriangle(piece, meshes, tri);
  return piece;
}

const diag = (min: readonly number[], max: readonly number[]): number => Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);

function centroid(piece: Piece): [number, number, number] {
  const n = Math.max(1, piece.tris.length);
  return [piece.sum[0] / n, piece.sum[1] / n, piece.sum[2] / n];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** Merges `from` into `into` (a part may span meshes: its pieces keep their own triangles). */
function merge(into: Piece & { extra?: Piece[] }, from: Piece & { extra?: Piece[] }): void {
  into.extra = [...(into.extra ?? []), from, ...(from.extra ?? [])];
  for (let a = 0; a < 3; a += 1) {
    into.min[a] = Math.min(into.min[a]!, from.min[a]!);
    into.max[a] = Math.max(into.max[a]!, from.max[a]!);
    into.sum[a]! += from.sum[a]!;
  }
}

/** Cuts a piece into `k` chunks by where its triangles are (k-means on their middles, seeded far apart). */
function cut(meshes: readonly MachineMesh[], piece: Piece, k: number): Piece[] {
  const mesh = meshes[piece.mesh]!;
  const middles = piece.tris.map((tri) => triMiddle(mesh, tri));
  // Seeds: the lowest triangle, then each next the farthest from those chosen.
  let lowest = 0;
  middles.forEach((m, i) => {
    if (m[1] < middles[lowest]![1]) lowest = i;
  });
  const seeds: [number, number, number][] = [middles[lowest]!];
  const near = middles.map((m) => distance(m, seeds[0]!));
  while (seeds.length < k) {
    let far = 0;
    near.forEach((d, i) => {
      if (d > near[far]!) far = i;
    });
    seeds.push([...middles[far]!]);
    middles.forEach((m, i) => {
      near[i] = Math.min(near[i]!, distance(m, seeds[seeds.length - 1]!));
    });
  }
  const label = new Int32Array(middles.length);
  for (let round = 0; round < 8; round += 1) {
    middles.forEach((m, i) => {
      let best = 0;
      for (let s = 1; s < seeds.length; s += 1) if (distance(m, seeds[s]!) < distance(m, seeds[best]!)) best = s;
      label[i] = best;
    });
    const sums = seeds.map(() => [0, 0, 0, 0]);
    middles.forEach((m, i) => {
      const sum = sums[label[i]!]!;
      sum[0]! += m[0];
      sum[1]! += m[1];
      sum[2]! += m[2];
      sum[3]! += 1;
    });
    sums.forEach((sum, s) => {
      if (sum[3]! > 0) seeds[s] = [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!];
    });
  }
  const chunks = seeds.map(() => newPiece(piece.mesh));
  piece.tris.forEach((tri, i) => addTriangle(chunks[label[i]!]!, meshes, tri));
  return chunks.filter((chunk) => chunk.tris.length > 0);
}

/**
 * A model's parts: a model in pieces keeps them, a fused one is split (see
 * the module's comment). Deterministic: the same model always splits the same.
 */
export function machineParts(meshes: readonly MachineMesh[]): MachineSplit {
  const live = meshes.map((mesh, m) => ({ mesh, m })).filter(({ mesh }) => triangleCount(mesh) > 0);
  const triangleParts = meshes.map((mesh) => new Int32Array(triangleCount(mesh)));
  if (live.length === 0) return { parts: [], triangleParts };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { mesh } of live) {
    for (let i = 0; i < mesh.positions.length; i += 1) {
      min[i % 3] = Math.min(min[i % 3]!, mesh.positions[i]!);
      max[i % 3] = Math.max(max[i % 3]!, mesh.positions[i]!);
    }
  }
  const whole = Math.max(diag(min, max), 1e-9);
  // One mesh: where it falls apart. Several: each as it comes.
  const pieces: (Piece & { extra?: Piece[] })[] =
    live.length === 1 ? connectedPieces(meshes, live[0]!.m, whole * 1e-5) : live.map(({ m }) => wholePiece(meshes, m));
  // Crumbs (and anything past the most) go with their nearest neighbour.
  const sized = (p: Piece): number => diag(p.min, p.max);
  for (;;) {
    if (pieces.length <= 1) break;
    let smallest = 0;
    pieces.forEach((p, i) => {
      if (sized(p) < sized(pieces[smallest]!)) smallest = i;
    });
    const crumb = pieces[smallest]!;
    if (pieces.length <= MACHINE.maxParts && sized(crumb) >= whole * MACHINE.crumb) break;
    const at = centroid(crumb);
    let nearest = smallest === 0 ? 1 : 0;
    pieces.forEach((p, i) => {
      if (i !== smallest && distance(centroid(p), at) < distance(centroid(pieces[nearest]!), at)) nearest = i;
    });
    merge(pieces[nearest]!, crumb);
    pieces.splice(smallest, 1);
  }
  // Too few: cut the biggest (by triangles) until there are enough, while it has triangles to spare.
  while (pieces.length < MACHINE.minParts) {
    let biggest = 0;
    pieces.forEach((p, i) => {
      if (p.tris.length > pieces[biggest]!.tris.length) biggest = i;
    });
    const piece = pieces[biggest]!;
    if (piece.extra?.length || piece.tris.length < 2 * (MACHINE.minParts - pieces.length + 1)) break;
    const chunks = cut(meshes, piece, MACHINE.minParts - pieces.length + 1);
    if (chunks.length < 2) break;
    pieces.splice(biggest, 1, ...chunks);
  }
  const parts: MachinePart[] = pieces.map((piece, index) => {
    const all = [piece, ...(piece.extra ?? [])];
    for (const member of all) for (const tri of member.tris) triangleParts[member.mesh]![tri] = index;
    const count = all.reduce((n, member) => n + member.tris.length, 0);
    const sum = all.reduce((acc, member) => [acc[0]! + member.sum[0], acc[1]! + member.sum[1], acc[2]! + member.sum[2]], [0, 0, 0]);
    return {
      min: { x: piece.min[0], y: piece.min[1], z: piece.min[2] },
      max: { x: piece.max[0], y: piece.max[1], z: piece.max[2] },
      centre: { x: sum[0]! / count, y: sum[1]! / count, z: sum[2]! / count },
      triangles: count,
    };
  });
  return { parts, triangleParts };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** The order parts go in: bottom up (in bands a tenth of the model tall), big before small within a band. */
export function buildOrder(parts: readonly MachinePart[]): number[] {
  if (parts.length === 0) return [];
  const bottom = Math.min(...parts.map((p) => p.min.y));
  const top = Math.max(...parts.map((p) => p.max.y));
  const band = Math.max((top - bottom) / 10, 1e-9);
  const volume = (p: MachinePart): number => (p.max.x - p.min.x) * (p.max.y - p.min.y) * (p.max.z - p.min.z);
  return parts
    .map((part, index) => ({ index, band: Math.floor((part.min.y - bottom) / band), volume: volume(part) }))
    .sort((a, b) => a.band - b.band || b.volume - a.volume || a.index - b.index)
    .map(({ index }) => index);
}

/** Seconds between parts for a build of `count`, so it never takes longer than MACHINE.buildMax. */
export function partGap(count: number): number {
  if (count <= 1) return MACHINE.gap;
  return Math.min(MACHINE.gap, (MACHINE.buildMax - MACHINE.fly - MACHINE.snap) / (count - 1));
}

/** When the `k`th part to go in leaves the ramp, seconds into the build. */
export function partStart(k: number, count: number): number {
  return k * partGap(count);
}

/** How long a build of `count` parts takes, seconds. */
export function buildTime(count: number): number {
  return partStart(Math.max(0, count - 1), count) + MACHINE.fly + MACHINE.snap;
}

/** A flying part at `t` seconds since it left the ramp: where its middle is, its scale, its spin, and how far along it is. */
export interface PartFrame {
  at: Vec3;
  scale: number;
  spin: number;
  /** In flight (not yet left: `waiting`), snapping into place, or still. */
  phase: 'waiting' | 'flying' | 'snapping' | 'placed';
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** A part's flight from the ramp at `from` to its place, `to`. */
export function partFrame(t: number, from: Vec3, to: Vec3): PartFrame {
  if (t < 0) return { at: { ...from }, scale: MACHINE.startScale, spin: 0, phase: 'waiting' };
  if (t >= MACHINE.fly + MACHINE.snap) return { at: { ...to }, scale: 1, spin: 0, phase: 'placed' };
  if (t >= MACHINE.fly) {
    // Snap: a small overshoot that settles.
    const s = (t - MACHINE.fly) / MACHINE.snap;
    return { at: { ...to }, scale: 1 + 0.08 * Math.sin(s * Math.PI), spin: 0, phase: 'snapping' };
  }
  const u = t / MACHINE.fly;
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  const top = Math.max(from.y, to.y) + MACHINE.lift + MACHINE.liftShare * span;
  const mid = 2 * top - (from.y + to.y) / 2;
  const e = easeOut(u);
  return {
    at: {
      x: from.x + (to.x - from.x) * e,
      y: (1 - u) * (1 - u) * from.y + 2 * (1 - u) * u * mid + u * u * to.y,
      z: from.z + (to.z - from.z) * e,
    },
    scale: MACHINE.startScale + (1 - MACHINE.startScale) * e,
    spin: (1 - e) * MACHINE.spin * 2 * Math.PI,
    phase: 'flying',
  };
}
