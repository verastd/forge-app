/**
 * Fitting a library head to the robot: the editor's first guess at how a
 * raw model (straight from Tripo, say) should be worn, and the moves it
 * offers after that.
 *
 * A placement scales the file about its own origin, then moves it, in the
 * robot's unscaled head frame: metres from the neck (HEAD_ANCHOR), +Y up,
 * facing +Z. The same shape as @forge/shared's AvatarHeadPlacement, kept
 * structural here so this package stays dependency-free.
 *
 * - A replacing head is sized by its lower band (where a head is, below any
 *   hat brim): that band's width becomes the robot's head width, its bottom
 *   sits on the neck and its middle over it. Its eyes start where the
 *   robot's own are, on the band's front.
 * - A face accessory is sized to the face, its middle at eye height, its
 *   back on the face screen. Where an eye shows through is the admin's call
 *   (`alignToEye`): a hole is the one thing a model can't point at.
 *
 * Given the model's triangles too, a replacing head's eyes sit on its face
 * where they are (a recessed screen behind a rim, say), not out at its front.
 *
 * Widths are taken between the 2nd and 98th percentiles, so a stray vertex
 * or a sliver of brim doesn't decide the size. Pure and deterministic.
 */
import { FACE_PANEL, HEAD_ANCHOR } from './avatar.js';

export type Point3 = [number, number, number];

/** How a head is worn (@forge/shared's AvatarHeadPlacement). */
export interface HeadPlacement {
  scale: number;
  offset: Point3;
  eyes?: [Point3, Point3] | null;
}

export type HeadFitKind = 'replace' | 'accessory';

export const HEAD_FIT = Object.freeze({
  /** A replacing head's lower band (ears and all) is this wide, metres: the robot's own head. */
  headWidth: 0.37,
  /** The lower band: this share of the model's height, from its bottom. */
  band: 0.2,
  /** How far an eye sits proud of the face under it, metres. */
  eyeLift: 0.004,
  /** A face accessory is this wide, metres: most of the face screen. */
  faceWidth: 0.25,
  /** The limits AvatarHeadPlacement takes. */
  minScale: 0.01,
  maxScale: 10,
  reach: 1,
});

/** The robot's own eyes in the head frame (left, right): on the face screen, just proud of it. */
export const ROBOT_EYES: readonly [Readonly<Point3>, Readonly<Point3>] = Object.freeze([
  Object.freeze([-0.058, eyeHeight(), FACE_PANEL.z + 0.004] as Point3),
  Object.freeze([0.058, eyeHeight(), FACE_PANEL.z + 0.004] as Point3),
]) as readonly [Readonly<Point3>, Readonly<Point3>];

function eyeHeight(): number {
  return round((FACE_PANEL.minY + FACE_PANEL.maxY) / 2 + 0.01 - HEAD_ANCHOR.y);
}

/**
 * The first guess for a model whose vertex positions (x, y, z, x, y, z…, in
 * the file's own frame, node transforms applied) are `positions`. A model
 * with no usable vertex is worn as it is.
 */
export function autoPlacement(kind: HeadFitKind, positions: ArrayLike<number>, triangles: ArrayLike<number> = []): HeadPlacement {
  const points = finitePoints(positions);
  if (points.length === 0) {
    return { scale: 1, offset: [0, 0, 0], ...(kind === 'replace' ? { eyes: null } : {}) };
  }
  let bottom = Infinity;
  let top = -Infinity;
  for (const p of points) {
    bottom = Math.min(bottom, p[1]);
    top = Math.max(top, p[1]);
  }
  if (kind === 'replace') {
    const cut = bottom + Math.max(top - bottom, 1e-9) * HEAD_FIT.band;
    const band = points.filter((p) => p[1] <= cut);
    const [x0, x1] = spread(band.map((p) => p[0]));
    const [z0, z1] = spread(band.map((p) => p[2]));
    const scale = clampScale(HEAD_FIT.headWidth / Math.max(x1 - x0, 1e-9));
    const offset = clampPoint([-scale * ((x0 + x1) / 2), -scale * bottom, -scale * ((z0 + z1) / 2)]);
    const front = scale * z1 + offset[2];
    const eyes = ROBOT_EYES.map((eye) => clampPoint([eye[0], eye[1], surfaceAt(triangles, scale, offset, eye, front) + HEAD_FIT.eyeLift])) as [
      Point3,
      Point3,
    ];
    return { scale, offset, eyes };
  }
  const [x0, x1] = spread(points.map((p) => p[0]));
  const [z0] = spread(points.map((p) => p[2]));
  const scale = clampScale(HEAD_FIT.faceWidth / Math.max(x1 - x0, 1e-9));
  const middle = (bottom + top) / 2;
  const offset = clampPoint([-scale * ((x0 + x1) / 2), ROBOT_EYES[0][1] - scale * middle, FACE_PANEL.z + 0.002 - scale * z0]);
  return { scale, offset };
}

/** Where `point` (in the file's own frame) lands under `placement`. */
export function placePoint(placement: HeadPlacement, point: Readonly<Point3>): Point3 {
  return [
    round(placement.scale * point[0] + placement.offset[0]),
    round(placement.scale * point[1] + placement.offset[1]),
    round(placement.scale * point[2] + placement.offset[2]),
  ];
}

/**
 * Moves an accessory across the face (x and y only) so that `point`, a spot
 * in the file's own frame (the middle of an eye hole), sits over the robot's
 * `side` eye.
 */
export function alignToEye(placement: HeadPlacement, point: Readonly<Point3>, side: 'left' | 'right'): HeadPlacement {
  const eye = ROBOT_EYES[side === 'left' ? 0 : 1];
  const placed = placePoint(placement, point);
  return {
    ...placement,
    offset: clampPoint([
      placement.offset[0] + eye[0] - placed[0],
      placement.offset[1] + eye[1] - placed[1],
      placement.offset[2],
    ]),
  };
}

/**
 * Scales a placement by `factor` about the neck's centre line, so a head
 * grows and shrinks in place rather than sliding off: the offset and any
 * eyes scale with it.
 */
export function rescale(placement: HeadPlacement, scale: number): HeadPlacement {
  const next = clampScale(scale);
  const factor = next / placement.scale;
  const grow = (p: Readonly<Point3>): Point3 => clampPoint([p[0] * factor, p[1] * factor, p[2] * factor]);
  return {
    ...placement,
    scale: next,
    offset: grow(placement.offset),
    ...(placement.eyes ? { eyes: [grow(placement.eyes[0]), grow(placement.eyes[1])] as [Point3, Point3] } : {}),
  };
}

/** A placement moved by `delta` metres, its eyes with it. */
export function nudge(placement: HeadPlacement, delta: Readonly<Point3>): HeadPlacement {
  const move = (p: Readonly<Point3>): Point3 => clampPoint([p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]]);
  return {
    ...placement,
    offset: move(placement.offset),
    ...(placement.eyes ? { eyes: [move(placement.eyes[0]), move(placement.eyes[1])] as [Point3, Point3] } : {}),
  };
}

/**
 * The front of the model straight in front of an eye's spot (placed, metres):
 * where a ray along -Z through the spot first meets one of `triangles` (x, y,
 * z × 3 each, in the file's frame), so an eye sits on a recessed face screen
 * rather than out at the frame around it. `fallback` (the lower band's front)
 * when nothing of the model is there.
 */
function surfaceAt(triangles: ArrayLike<number>, scale: number, offset: Point3, eye: Readonly<Point3>, fallback: number): number {
  const x = (eye[0] - offset[0]) / scale;
  const y = (eye[1] - offset[1]) / scale;
  let best = -Infinity;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const ax = triangles[i]!;
    const ay = triangles[i + 1]!;
    const bx = triangles[i + 3]!;
    const by = triangles[i + 4]!;
    const cx = triangles[i + 6]!;
    const cy = triangles[i + 7]!;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12) continue;
    const u = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
    const v = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    best = Math.max(best, u * triangles[i + 2]! + v * triangles[i + 5]! + w * triangles[i + 8]!);
  }
  return Number.isFinite(best) ? scale * best + offset[2] : fallback;
}

function finitePoints(positions: ArrayLike<number>): Point3[] {
  const points: Point3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) points.push([x, y, z]);
  }
  return points;
}

/** The 2nd and 98th percentiles of `values` (at least one). */
function spread(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
  return [at(0.02), at(0.98)];
}

function clampScale(scale: number): number {
  return round(Math.min(HEAD_FIT.maxScale, Math.max(HEAD_FIT.minScale, scale)));
}

function clampPoint(p: Point3): Point3 {
  return p.map((v) => round(Math.min(HEAD_FIT.reach, Math.max(-HEAD_FIT.reach, v)))) as Point3;
}

/** To the tenth of a millimetre, without -0: what is saved and compared. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000 + 0;
}
