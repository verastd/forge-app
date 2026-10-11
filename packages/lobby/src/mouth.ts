/**
 * A talking mouth: a replacing head whose mouth opens while its wearer talks,
 * pouring out a stream of green blocks.
 *
 * - `stepMouth`: how open the mouth is (0 shut, 1 open). It opens quickly
 *   when talking starts, and stays open for MOUTH.hold after it stops, so the
 *   gaps between words don't snap it shut.
 * - `spewDue`: how many blocks leave the mouth this frame, one every
 *   MOUTH.every seconds while the wearer talks and the mouth is open.
 * - `blockShot` / `blockFrame`: each block's own spread and spin (the same for
 *   everyone, from its number), and where it is as it flies out, arcs and
 *   tumbles to the floor, where it's gone.
 * - `mouthRecess`: the mouth's opening on a model, found from a click inside
 *   it: the hollow around the click, sunk well behind the face around it.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import type { Vec3 } from './attenuation.js';

export const MOUTH = Object.freeze({
  /** Seconds to open or shut. */
  open: 0.15,
  /** Seconds it stays open after the talking stops. */
  hold: 0.4,
  /** Seconds between blocks while talking. */
  every: 0.1,
  /** How open the mouth must be before blocks come out. */
  spewFrom: 0.6,
  /** How fast a block leaves the mouth (metres a second), give or take `speedSpread`. */
  speed: 1.5,
  speedSpread: 0.35,
  /** How far off straight out a block may go, radians (side to side, and up or down). */
  spread: 0.32,
  /** A little lift as it leaves (metres a second up). */
  lift: 0.35,
  gravity: 6.5,
  /** Seconds a block lives at most; it's gone sooner if it reaches the floor. */
  life: 1.6,
  /** How far above the floor a block vanishes, metres. */
  floor: 0.04,
  /** Seconds a block takes to grow from the mouth to its full size, and how small it starts. */
  grow: 0.12,
  startScale: 0.35,
  /** Most blocks in the air per mouth (the stream never needs more). */
  pool: 48,
  /** Turns a second a block tumbles at most. */
  spin: 2.2,
});

export interface MouthState {
  /** How open the mouth is, 0 (shut) to 1 (open). */
  open: number;
  /** Seconds since the wearer last talked (0 while they talk). */
  quiet: number;
  /** When the next block leaves (seconds, on the same clock as `spewDue`'s), or null while not spewing. */
  next: number | null;
  /** How many blocks have left so far: the next one's number. */
  count: number;
}

export function createMouthState(): MouthState {
  return { open: 0, quiet: Infinity, next: null, count: 0 };
}

/** Moves the mouth on by `dt` seconds: open while talking (and for MOUTH.hold after), shut otherwise. */
export function stepMouth(state: MouthState, talking: boolean, dt: number): MouthState {
  const step = Math.max(0, dt);
  const quiet = talking ? 0 : state.quiet + step;
  const target = quiet < MOUTH.hold ? 1 : 0;
  const move = step / MOUTH.open;
  const open = target > state.open ? Math.min(target, state.open + move) : Math.max(target, state.open - move);
  return { ...state, open, quiet };
}

/**
 * The blocks that leave the mouth up to `now` (seconds): their numbers and
 * when each left. One every MOUTH.every while talking with the mouth open; the
 * stream starts afresh each time talking starts.
 */
export function spewDue(state: MouthState, talking: boolean, now: number): { state: MouthState; blocks: { n: number; at: number }[] } {
  if (!talking || state.open < MOUTH.spewFrom) return { state: { ...state, next: null }, blocks: [] };
  let next = state.next ?? now;
  let count = state.count;
  const blocks: { n: number; at: number }[] = [];
  // Never more than a pool's worth at once (a long hitch in the frames doesn't flood the stream).
  while (next <= now && blocks.length < MOUTH.pool) {
    blocks.push({ n: count, at: next });
    count += 1;
    next += MOUTH.every;
  }
  if (next <= now) next = now + MOUTH.every;
  return { state: { ...state, next, count }, blocks };
}

/** A block's own spread and spin, from its number and the mouth's seed. */
export interface BlockShot {
  /** Off straight out, radians: side to side, and up or down. */
  yaw: number;
  pitch: number;
  speed: number;
  /** Its tumble: an axis (unit length) and turns a second. */
  axis: Vec3;
  spin: number;
}

/** A number from 0 up to 1, from two others (the same for everyone). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function blockShot(seed: number, n: number): BlockShot {
  const r = (k: number): number => hash(seed + k * 7919, n);
  const ax = r(4) * 2 - 1;
  const ay = r(5) * 2 - 1;
  const az = r(6) * 2 - 1;
  const length = Math.hypot(ax, ay, az) || 1;
  return {
    yaw: (r(0) * 2 - 1) * MOUTH.spread,
    pitch: (r(1) * 2 - 1) * MOUTH.spread * 0.6,
    speed: MOUTH.speed + (r(2) * 2 - 1) * MOUTH.speedSpread,
    axis: { x: ax / length, y: ay / length, z: az / length },
    spin: (0.4 + 0.6 * r(3)) * MOUTH.spin,
  };
}

/** Where a block is `age` seconds after leaving the mouth at `from`, heading `forward` (level, unit length). */
export interface BlockFrame {
  at: Vec3;
  /** Its tumble so far, radians about its shot's axis. */
  turn: number;
  scale: number;
  gone: boolean;
}

export function blockFrame(age: number, from: Vec3, forward: Vec3, shot: BlockShot): BlockFrame {
  const t = Math.max(0, age);
  // Straight out, turned by its spread: side to side about up, then up or down.
  const cy = Math.cos(shot.yaw);
  const sy = Math.sin(shot.yaw);
  const dx = forward.x * cy + forward.z * sy;
  const dz = -forward.x * sy + forward.z * cy;
  const cp = Math.cos(shot.pitch);
  const v = { x: dx * cp * shot.speed, y: Math.sin(shot.pitch) * shot.speed + MOUTH.lift, z: dz * cp * shot.speed };
  const at = {
    x: from.x + v.x * t,
    y: from.y + v.y * t - 0.5 * MOUTH.gravity * t * t,
    z: from.z + v.z * t,
  };
  const scale = t >= MOUTH.grow ? 1 : MOUTH.startScale + (1 - MOUTH.startScale) * (t / MOUTH.grow);
  const gone = t >= MOUTH.life || (at.y <= MOUTH.floor && v.y - MOUTH.gravity * t < 0);
  return { at, turn: shot.spin * 2 * Math.PI * t, scale, gone };
}

/**
 * The mouth's opening on a model, from a click inside it (the model's own
 * frame, its front facing +z; `triangles` flat, nine numbers each). Seen from
 * the front, the hollow the click is in: everything around it sunk well
 * behind the hollow's own walls. Its middle (at the face's depth) and its width
 * and height; null when the click isn't in a hollow.
 */
export function mouthRecess(triangles: ArrayLike<number>, at: Readonly<[number, number, number]>): { center: [number, number, number]; size: [number, number] } | null {
  const count = Math.floor(triangles.length / 9);
  if (count === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count * 9; i += 3) {
    minX = Math.min(minX, triangles[i]!);
    maxX = Math.max(maxX, triangles[i]!);
    minY = Math.min(minY, triangles[i + 1]!);
    maxY = Math.max(maxY, triangles[i + 1]!);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const cells = 160;
  const cell = span / cells;
  const W = Math.ceil((maxX - minX) / cell) + 1;
  const H = Math.ceil((maxY - minY) / cell) + 1;
  // The front-most surface in each cell, seen from +z.
  const depth = new Float64Array(W * H).fill(-Infinity);
  for (let t = 0; t < count; t += 1) {
    const o = t * 9;
    const xs = [(triangles[o]! - minX) / cell, (triangles[o + 3]! - minX) / cell, (triangles[o + 6]! - minX) / cell];
    const ys = [(triangles[o + 1]! - minY) / cell, (triangles[o + 4]! - minY) / cell, (triangles[o + 7]! - minY) / cell];
    const zs = [triangles[o + 2]!, triangles[o + 5]!, triangles[o + 8]!];
    const den = (ys[1]! - ys[2]!) * (xs[0]! - xs[2]!) + (xs[2]! - xs[1]!) * (ys[0]! - ys[2]!);
    if (Math.abs(den) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const a = ((ys[1]! - ys[2]!) * (px - xs[2]!) + (xs[2]! - xs[1]!) * (py - ys[2]!)) / den;
        const b = ((ys[2]! - ys[0]!) * (px - xs[2]!) + (xs[0]! - xs[2]!) * (py - ys[2]!)) / den;
        const c = 1 - a - b;
        if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
        const z = a * zs[0]! + b * zs[1]! + c * zs[2]!;
        const k = y * W + x;
        if (z > depth[k]!) depth[k] = z;
      }
    }
  }
  const cx = Math.min(W - 1, Math.max(0, Math.floor((at[0] - minX) / cell)));
  const cy = Math.min(H - 1, Math.max(0, Math.floor((at[1] - minY) / cell)));
  const start = depth[cy * W + cx]!;
  if (start === -Infinity) return null;
  // The face round about: the hollow's own walls, the first surface well in front of the click
  // going left, right, up and down (within half the model), climbed to their top. Their
  // middle depth, so a nose or brow beyond one wall isn't taken for the face.
  const reach = Math.round(cells / 2);
  const rise = span / 20;
  const climb = Math.round(cells / 20);
  const walls: number[] = [];
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    for (let step = 1; step <= reach; step += 1) {
      const x = cx + dx * step;
      const y = cy + dy * step;
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      let wall = depth[y * W + x]!;
      if (wall - start < rise) continue;
      // Up a sloped or bevelled lip to its top, as long as it keeps rising, but no further than a
      // twentieth of the model on, so it never climbs on into a nose or brow.
      for (let more = 1; more <= climb; more += 1) {
        const nx = x + dx * more;
        const ny = y + dy * more;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || depth[ny * W + nx]! <= wall) break;
        wall = depth[ny * W + nx]!;
      }
      walls.push(wall);
      break;
    }
  }
  // A hollow is walled in on at least two sides.
  if (walls.length < 2) return null;
  walls.sort((a, b) => a - b);
  const face = walls[Math.floor((walls.length - 1) / 2)]!;
  const sunk = start + (face - start) / 2;
  // Everything joined to the click that's sunk behind halfway to the face.
  const seen = new Uint8Array(W * H);
  const stack = [cy * W + cx];
  seen[cy * W + cx] = 1;
  let x0 = cx;
  let x1 = cx;
  let y0 = cy;
  let y1 = cy;
  let size = 0;
  while (stack.length > 0) {
    const k = stack.pop()!;
    size += 1;
    // A "hollow" that spreads over a third of the model is the open air round it, not a mouth.
    if (size > (W * H) / 3) return null;
    const x = k % W;
    const y = (k - x) / W;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (seen[n] || depth[n]! > sunk) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return {
    center: [minX + ((x0 + x1 + 1) / 2) * cell, minY + ((y0 + y1 + 1) / 2) * cell, face],
    size: [(x1 - x0 + 1) * cell, (y1 - y0 + 1) * cell],
  };
}
