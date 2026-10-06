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
  /** [slant, turn, pitch] radians for the left eye, mirrored for the right (see `eyeRotations`). */
  eyeAngles?: [number, number, number] | null;
}

export type HeadFitKind = 'replace' | 'accessory';

export const HEAD_FIT = Object.freeze({
  /** A replacing head's lower band (ears and all) is this wide, metres: the robot's own head. */
  headWidth: 0.37,
  /** The lower band: this share of the model's height, from its bottom. */
  band: 0.2,
  /** The most any eye angle may be, radians (AvatarHeadPlacement's limit). */
  eyeAngle: 1.2,
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
    const hits = ROBOT_EYES.map((eye) => surfaceAt(triangles, scale, offset, eye));
    const eyes = ROBOT_EYES.map((eye, i) => clampPoint([eye[0], eye[1], (hits[i]?.z ?? front) + HEAD_FIT.eyeLift])) as [Point3, Point3];
    const aims = hits.flatMap((hit, i) => (hit ? [anglesFromNormal(hit.normal, i === 0 ? 'left' : 'right')] : []));
    if (aims.length === 0) return { scale, offset, eyes };
    const mean = (k: 0 | 1): number => aims.reduce((sum, aim) => sum + aim[k], 0) / aims.length;
    return { scale, offset, eyes, eyeAngles: clampAngles([0, mean(0), mean(1)]) };
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
 * The eye angles that face a surface whose normal (head frame) is `normal`,
 * for the eye on `side`: [turn, pitch], radians. Turn faces the eye toward
 * the middle (so it is mirrored between the eyes), pitch tips it up.
 */
export function anglesFromNormal(normal: Readonly<Point3>, side: 'left' | 'right'): [number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(length > 0)) return [0, 0];
  const [x, y, z] = [normal[0] / length, normal[1] / length, normal[2] / length];
  const toward = side === 'left' ? x : -x;
  return [clampAngle(Math.atan2(toward, z)), clampAngle(Math.asin(Math.max(-1, Math.min(1, y))))];
}

/**
 * Each eye's rotation (radians, applied in Y, X, Z order) for `angles`
 * ([slant, turn, pitch], the left eye's; the right mirrors slant and turn):
 * [x, y, z] for the left eye, then the right. The eye's own +Z faces out.
 */
export function eyeRotations(angles: Readonly<[number, number, number]> | null | undefined): [Point3, Point3] {
  const [slant, turn, pitch] = angles ?? [0, 0, 0];
  return [
    [round(-pitch), round(turn), round(-slant)],
    [round(-pitch), round(-turn), round(slant)],
  ];
}

/**
 * Where a ray along -Z through an eye's spot (placed, metres) first meets
 * one of `triangles` (x, y, z × 3 each, in the file's frame): its depth in
 * the head frame and the face's normal there (turned to face out), so an
 * eye sits on, and faces along, a recessed or angled face screen. Null when
 * nothing of the model is there.
 */
function surfaceAt(
  triangles: ArrayLike<number>,
  scale: number,
  offset: Point3,
  eye: Readonly<Point3>,
): { z: number; normal: Point3 } | null {
  const x = (eye[0] - offset[0]) / scale;
  const y = (eye[1] - offset[1]) / scale;
  let best: { z: number; normal: Point3 } | null = null;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const ax = triangles[i]!;
    const ay = triangles[i + 1]!;
    const az = triangles[i + 2]!;
    const bx = triangles[i + 3]!;
    const by = triangles[i + 4]!;
    const bz = triangles[i + 5]!;
    const cx = triangles[i + 6]!;
    const cy = triangles[i + 7]!;
    const cz = triangles[i + 8]!;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12) continue;
    const u = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
    const v = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    const z = u * az + v * bz + w * cz;
    if (best && z <= best.z) continue;
    // The face's normal, from its edges; flipped to face out (+Z), whichever way it was wound.
    const e1: Point3 = [bx - ax, by - ay, bz - az];
    const e2: Point3 = [cx - ax, cy - ay, cz - az];
    let normal: Point3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
    best = { z, normal };
  }
  return best ? { z: scale * best.z + offset[2], normal: best.normal } : null;
}

function clampAngle(angle: number): number {
  return round(Math.min(HEAD_FIT.eyeAngle, Math.max(-HEAD_FIT.eyeAngle, angle)));
}

function clampAngles(angles: [number, number, number]): [number, number, number] {
  return angles.map(clampAngle) as [number, number, number];
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
