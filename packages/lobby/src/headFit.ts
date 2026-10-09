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
 *   back on the face screen: the robot's own, or a replacing head's (`onto`). Where an eye shows through is the admin's call
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
  /**
   * The whole model's angles, [tilt, turn, slant] radians, about `offset` (see `turnPoint`);
   * `eyes` and `screen` are given unangled and turn with it.
   */
  angles?: [number, number, number] | null;
  /** The glowing eyes' size, times their own. */
  eyeScale?: number | null;
  /** A shiny black LED face screen across the face opening (head frame, metres). */
  screen?: HeadScreen | null;
}

export interface HeadScreen {
  center: Point3;
  size: [number, number];
}

export type HeadFitKind = 'replace' | 'accessory';

export const HEAD_FIT = Object.freeze({
  /** A replacing head's lower band (ears and all) is this wide, metres: the robot's own head. */
  headWidth: 0.37,
  /** The lower band: this share of the model's height, from its bottom. */
  band: 0.2,
  /** The most any eye angle may be, radians (AvatarHeadPlacement's limit). */
  eyeAngle: 1.2,
  /** A hollow this much deeper (metres) than the frame around it is an open face, to be closed with a screen. */
  screenRecess: 0.03,
  /** How far a face screen sits behind the frame around it, metres. */
  screenInset: 0.004,
  /** How far the search for the opening's edges goes from the middle, and in what steps (metres). */
  screenSearch: 0.3,
  screenStep: 0.005,
  /** How much a face screen reaches past the opening on each side, behind the frame (metres). */
  screenTuck: 0.005,
  /** The largest a face screen may be across or down (AvatarHeadPlacement's limit), metres. */
  screenMax: 0.6,
  /**
   * A closed face (no hollow): the flat front round the eyes, within this much (metres) of
   * its depth between them, takes the screen too, so the model's own eyes (painted or
   * sculpted) give way to the robot's.
   */
  faceDepth: 0.005,
  /** How squarely (the surface normal's forward share) a closed face must look ahead to take a flat screen. */
  faceFlat: 0.97,
  /** How small a closed face may be and still take a screen (both eyes on it), metres. */
  faceMinWidth: 0.12,
  faceMinHeight: 0.06,
  /** The largest screen a closed face takes, metres: the face, not the whole front of the head. */
  faceMaxWidth: 0.4,
  faceMaxHeight: 0.3,
  /** The renderer cuts the model this far behind a screen, so a screen laid on a face shows through it. */
  screenCut: 0.002,
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
/** The face an accessory is worn on: a replacing head's eyes and its face screen, if it has one. */
export interface WornFace {
  eyes: [Point3, Point3];
  screen?: HeadScreen | null;
}

export function autoPlacement(
  kind: HeadFitKind,
  positions: ArrayLike<number>,
  triangles: ArrayLike<number> = [],
  onto: WornFace | null = null,
): HeadPlacement {
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
    const screen = findScreen(triangles, scale, offset) ?? findFace(triangles, scale, offset, front);
    if (screen) {
      // An open face is closed by a screen, a closed one covered: the eyes sit on it, facing straight out.
      // Centred on the screen, at the robot's own spacing.
      const z = screen.center[2] + HEAD_FIT.eyeLift;
      const eyes = ROBOT_EYES.map((eye) => clampPoint([screen.center[0] + eye[0], screen.center[1], z])) as [Point3, Point3];
      return { scale, offset, eyes, eyeAngles: [0, 0, 0], screen };
    }
    const hits = ROBOT_EYES.map((eye) => surfaceAt(triangles, scale, offset, eye));
    const eyes = ROBOT_EYES.map((eye, i) => clampPoint([eye[0], eye[1], (hits[i]?.z ?? front) + HEAD_FIT.eyeLift])) as [Point3, Point3];
    const aims = hits.flatMap((hit, i) => (hit ? [anglesFromNormal(hit.normal, i === 0 ? 'left' : 'right')] : []));
    if (aims.length === 0) return { scale, offset, eyes };
    const mean = (k: 0 | 1): number => aims.reduce((sum, aim) => sum + aim[k], 0) / aims.length;
    return { scale, offset, eyes, eyeAngles: clampAngles([0, mean(0), mean(1)]) };
  }
  const [x0, x1] = spread(points.map((p) => p[0]));
  const [z0] = spread(points.map((p) => p[2]));
  // Over a replacing head, its face (screen width, eye height, eye depth); else the robot's own.
  const faceWidth = onto?.screen ? onto.screen.size[0] * 0.9 : HEAD_FIT.faceWidth;
  const eyeY = onto ? (onto.eyes[0][1] + onto.eyes[1][1]) / 2 : ROBOT_EYES[0][1];
  const faceZ = onto ? Math.min(onto.eyes[0][2], onto.eyes[1][2]) : FACE_PANEL.z;
  const scale = clampScale(faceWidth / Math.max(x1 - x0, 1e-9));
  const middle = (bottom + top) / 2;
  const offset = clampPoint([-scale * ((x0 + x1) / 2), eyeY - scale * middle, faceZ + 0.002 - scale * z0]);
  return { scale, offset };
}

/**
 * `v` turned by a model's `angles` ([tilt, turn, slant] radians; three.js's Euler
 * order YXZ: slant about Z, then tilt about X, then turn about Y). Tilt nods the
 * top forward (+Z), turn faces +Z toward +X (the robot's left), slant leans the
 * top toward -X.
 */
export function turnPoint(v: Readonly<Point3>, angles: Readonly<[number, number, number]> | null | undefined): Point3 {
  if (!angles) return [v[0], v[1], v[2]];
  const [tilt, turn, slant] = angles;
  const [x0, y0, z0] = v;
  const x1 = x0 * Math.cos(slant) - y0 * Math.sin(slant);
  const y1 = x0 * Math.sin(slant) + y0 * Math.cos(slant);
  const y2 = y1 * Math.cos(tilt) - z0 * Math.sin(tilt);
  const z2 = y1 * Math.sin(tilt) + z0 * Math.cos(tilt);
  return [x1 * Math.cos(turn) + z2 * Math.sin(turn), y2, -x1 * Math.sin(turn) + z2 * Math.cos(turn)];
}

/** Where `point`, given unangled in a placement's head frame (its eyes, its screen), really is once the model is angled. */
export function rotateAbout(placement: HeadPlacement, point: Readonly<Point3>): Point3 {
  const o = placement.offset;
  const t = turnPoint([point[0] - o[0], point[1] - o[1], point[2] - o[2]], placement.angles);
  return [round(t[0] + o[0]), round(t[1] + o[1]), round(t[2] + o[2])];
}

/** Where `point` (in the file's own frame) lands under `placement`, angles and all. */
export function placePoint(placement: HeadPlacement, point: Readonly<Point3>): Point3 {
  const t = turnPoint([placement.scale * point[0], placement.scale * point[1], placement.scale * point[2]], placement.angles);
  return [round(t[0] + placement.offset[0]), round(t[1] + placement.offset[1]), round(t[2] + placement.offset[2])];
}

/**
 * Moves an accessory across the face (x and y only) so that `point`, a spot
 * in the file's own frame (the middle of an eye hole), sits over the robot's
 * `side` eye.
 */
export function alignToEye(
  placement: HeadPlacement,
  point: Readonly<Point3>,
  side: 'left' | 'right',
  eyes: Readonly<[Readonly<Point3>, Readonly<Point3>]> = ROBOT_EYES,
): HeadPlacement {
  const eye = eyes[side === 'left' ? 0 : 1];
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

/**
 * The opening of an open face, if the model has one: rays along -Z between
 * the eyes go deep into the head (its hollow), well behind the frame around
 * them. The opening is the hollow's extent, flooded out from between the
 * eyes over a grid of rays (islands inside it, like the model's sculpted
 * eyes, don't stop it); the screen fills it, set just behind the frame. The
 * renderer cuts away whatever of the model stands in front of the screen
 * inside it, so the screen hides the model's own eyes. Null for a closed face.
 */
function findScreen(triangles: ArrayLike<number>, scale: number, offset: Point3): HeadScreen | null {
  if (triangles.length < 9) return null;
  const step = HEAD_FIT.screenStep;
  const reach = Math.round(HEAD_FIT.screenSearch / step);
  const middle: Point3 = [0, ROBOT_EYES[0][1], 0];
  const cache = new Map<string, number>();
  const depth = (i: number, j: number): number => {
    const key = `${i},${j}`;
    let z = cache.get(key);
    if (z === undefined) {
      z = surfaceAt(triangles, scale, offset, [middle[0] + i * step, middle[1] + j * step, 0])?.z ?? -Infinity;
      cache.set(key, z);
    }
    return z;
  };
  const inside = depth(0, 0);
  /** The extent of what `deep` admits, flooded out from between the eyes; null if it isn't framed. */
  const flood = (deep: (z: number) => boolean): [number, number, number, number] | null => {
    const seen = new Set<string>(['0,0']);
    const queue: [number, number][] = [[0, 0]];
    let [left, right, down, up] = [0, 0, 0, 0];
    while (queue.length > 0) {
      const [i, j] = queue.pop()!;
      left = Math.min(left, i);
      right = Math.max(right, i);
      down = Math.min(down, j);
      up = Math.max(up, j);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const [ni, nj] = [i + di, j + dj];
        const key = `${ni},${nj}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Reaching the search's edge: not framed, so no opening.
        if (Math.abs(ni) > reach || Math.abs(nj) > reach) return null;
        if (deep(depth(ni, nj))) queue.push([ni, nj]);
      }
    }
    return [left, right, down, up];
  };
  /** The frame: the middle depth of what the rays meet just outside an extent, if they mostly meet something. */
  const frameAround = ([left, right, down, up]: [number, number, number, number], deep: (z: number) => boolean): number | null => {
    const ring: number[] = [];
    for (let i = left - 1; i <= right + 1; i += 1) ring.push(depth(i, down - 1), depth(i, up + 1));
    for (let j = down; j <= up; j += 1) ring.push(depth(left - 1, j), depth(right + 1, j));
    const framed = ring.filter((z) => Number.isFinite(z) && !deep(z)).sort((a, b) => a - b);
    return framed.length < ring.length * 0.75 ? null : framed[Math.floor(framed.length / 2)]!;
  };
  // First the hollow itself, for the frame's depth; then all that lies behind the frame (a ledge, a sill).
  const hollow = (z: number): boolean => z < inside + HEAD_FIT.screenRecess;
  const first = flood(hollow);
  if (first === null) return null;
  const frame = frameAround(first, hollow);
  if (frame === null || frame - inside < HEAD_FIT.screenRecess) return null;
  const behind = (z: number): boolean => z < frame - HEAD_FIT.screenInset * 2;
  const extent = flood(behind) ?? first;
  const [left, right, down, up] = extent;
  if (right - left < 2 || up - down < 2) return null;
  const width = Math.min(HEAD_FIT.screenMax, (right - left + 1) * step + 2 * HEAD_FIT.screenTuck);
  const height = Math.min(HEAD_FIT.screenMax, (up - down + 1) * step + 2 * HEAD_FIT.screenTuck);
  return {
    center: clampPoint([middle[0] + ((left + right) / 2) * step, middle[1] + ((down + up) / 2) * step, frame - HEAD_FIT.screenInset]),
    size: [round(width), round(height)],
  };
}

/**
 * The flat front of a closed face, round the eyes: flooded out from between
 * them over a grid of rays, as far as the face stays within HEAD_FIT.faceDepth
 * of its depth there. The screen lies on it (its middle depth), sized to it
 * and no bigger than a face; the renderer cuts what stands proud of it (a
 * sculpted eye), and the screen covers what is painted on it. Null when there
 * is no such face: nothing between the eyes, or a face too curved or too small
 * to hold both eyes.
 */
function findFace(triangles: ArrayLike<number>, scale: number, offset: Point3, front: number): HeadScreen | null {
  if (triangles.length < 9) return null;
  const step = HEAD_FIT.screenStep;
  const reach = Math.round(HEAD_FIT.screenSearch / step);
  const middle: Point3 = [0, ROBOT_EYES[0][1], 0];
  // Only squarely forward-facing surface counts: a curved or angled face keeps its own shape (and eye angles).
  const depth = (i: number, j: number): number => {
    const hit = surfaceAt(triangles, scale, offset, [middle[0] + i * step, middle[1] + j * step, 0]);
    if (!hit) return -Infinity;
    const [nx, ny, nz] = hit.normal;
    return nz >= HEAD_FIT.faceFlat * Math.hypot(nx, ny, nz) ? hit.z : -Infinity;
  };
  const z0 = depth(0, 0);
  // The face is the head's front, not the back of a hollow that isn't framed all round.
  if (!Number.isFinite(z0) || z0 < front - HEAD_FIT.screenRecess) return null;
  const seen = new Set<string>(['0,0']);
  const queue: [number, number][] = [[0, 0]];
  const depths: number[] = [];
  let [left, right, down, up] = [0, 0, 0, 0];
  while (queue.length > 0) {
    const [i, j] = queue.pop()!;
    left = Math.min(left, i);
    right = Math.max(right, i);
    down = Math.min(down, j);
    up = Math.max(up, j);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const [ni, nj] = [i + di, j + dj];
      const key = `${ni},${nj}`;
      if (seen.has(key) || Math.abs(ni) > reach || Math.abs(nj) > reach) continue;
      seen.add(key);
      const z = depth(ni, nj);
      if (Math.abs(z - z0) <= HEAD_FIT.faceDepth) {
        depths.push(z);
        queue.push([ni, nj]);
      }
    }
  }
  const width = (right - left + 1) * step;
  const height = (up - down + 1) * step;
  if (width < HEAD_FIT.faceMinWidth || height < HEAD_FIT.faceMinHeight) return null;
  depths.sort((a, b) => a - b);
  const z = depths[Math.floor(depths.length / 2)]!;
  /** The screen along one axis: the whole face when it fits, else a face-sized window round the eyes, kept on the face. */
  const span = (lo: number, hi: number, max: number): [number, number] => {
    const [from, to] = [lo * step - step / 2, hi * step + step / 2];
    if (to - from <= max) return [(from + to) / 2, to - from];
    return [Math.min(to - max / 2, Math.max(from + max / 2, 0)), max];
  };
  const [x, w] = span(left, right, HEAD_FIT.faceMaxWidth);
  const [y, h] = span(down, up, HEAD_FIT.faceMaxHeight);
  return { center: clampPoint([middle[0] + x, middle[1] + y, z]), size: [round(w), round(h)] };
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
