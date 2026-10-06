import { describe, expect, it } from 'vitest';

import { FACE_PANEL } from './avatar.js';
import {
  HEAD_FIT,
  ROBOT_EYES,
  alignToEye,
  anglesFromNormal,
  autoPlacement,
  eyeRotations,
  nudge,
  placePoint,
  rescale,
  rotateAbout,
  turnPoint,
} from './headFit.js';
import type { HeadPlacement, Point3 } from './headFit.js';

/** A box's eight corners, flat. */
function box(min: Point3, max: Point3): number[] {
  const out: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return out;
}

/** A box as triangles (x, y, z × 3 each), as a modeller exports it. */
function slab(min: Point3, max: Point3): number[] {
  const c = (i: number): Point3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const faces = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return faces.flatMap((i) => c(i));
}

/** Points filling a box evenly, flat, so percentiles see its real edges. */
function solid(min: Point3, max: Point3, steps = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i += 1)
    for (let j = 0; j <= steps; j += 1)
      for (let k = 0; k <= steps; k += 1)
        out.push(
          min[0] + ((max[0] - min[0]) * i) / steps,
          min[1] + ((max[1] - min[1]) * j) / steps,
          min[2] + ((max[2] - min[2]) * k) / steps,
        );
  return out;
}

describe('autoPlacement, replacing the head', () => {
  // A Tripo-sized head: a 0.74 m box (off centre) under a wide hat brim, origin at its feet.
  const head = [...solid([-0.35, 0, -0.2], [0.39, 0.4, 0.3]), ...solid([-0.5, 0.42, -0.5], [0.5, 0.78, 0.5])];

  it('sizes the lower band to the robot’s head, on the neck and over its middle', () => {
    const placement = autoPlacement('replace', head);
    expect(placement.scale).toBeCloseTo(HEAD_FIT.headWidth / 0.74, 3);
    const left = placePoint(placement, [-0.35, 0, 0.05]);
    const right = placePoint(placement, [0.39, 0, 0.05]);
    expect(left[0] + right[0]).toBeCloseTo(0, 3);
    expect(left[1]).toBeCloseTo(0, 4);
    expect(left[2]).toBeCloseTo(0, 3);
  });

  it('starts its eyes where the robot’s own are, on the band’s front when it has no triangles to look at', () => {
    const placement = autoPlacement('replace', head);
    const front = placePoint(placement, [0, 0, 0.3])[2];
    expect(placement.eyes?.[0]).toEqual([ROBOT_EYES[0][0], ROBOT_EYES[0][1], Math.round((front + HEAD_FIT.eyeLift) * 10_000) / 10_000]);
    expect(placement.eyes?.[1]?.[0]).toBe(ROBOT_EYES[1][0]);
  });

  it('seats its eyes on a recessed face screen, not out at the rim around it', () => {
    // A flat screen face (two big triangles, no vertex near the eyes) 0.1 m behind a rim: Tripo's robot heads look like this.
    const shell = slab([-0.35, 0, -0.2], [0.35, 0.4, 0.15]);
    const screen = slab([-0.27, 0.02, 0.15], [0.27, 0.38, 0.2]);
    const rim = [...slab([-0.35, 0, 0.2], [-0.27, 0.4, 0.3]), ...slab([0.27, 0, 0.2], [0.35, 0.4, 0.3])];
    const triangles = [...shell, ...screen, ...rim];
    const placement = autoPlacement('replace', triangles, triangles);
    const screenFront = placePoint(placement, [0, 0.2, 0.2])[2];
    const rimFront = placePoint(placement, [0.3, 0.2, 0.3])[2];
    for (const eye of placement.eyes ?? []) {
      expect(eye[2]).toBeCloseTo(screenFront + HEAD_FIT.eyeLift, 3);
      expect(eye[2]).toBeLessThan(rimFront);
    }
    // A flat screen faces straight ahead.
    expect(placement.eyeAngles).toEqual([0, 0, 0]);
  });

  it('turns its eyes in on a face whose halves angle toward the middle', () => {
    // A V-shaped face: each half recedes toward the middle, so each faces in by atan(0.1 / 0.3).
    const left = [-0.3, 0.02, 0.2, 0, 0.02, 0.1, 0, 0.38, 0.1, -0.3, 0.02, 0.2, 0, 0.38, 0.1, -0.3, 0.38, 0.2];
    const right = left.map((v, i) => (i % 3 === 0 ? -v : v));
    const shell = slab([-0.35, 0, -0.2], [0.35, 0.4, 0.05]);
    const triangles = [...shell, ...left, ...right];
    const placement = autoPlacement('replace', triangles, triangles);
    expect(placement.eyeAngles?.[0]).toBe(0);
    expect(placement.eyeAngles?.[1]).toBeCloseTo(Math.atan(0.1 / 0.3), 3);
    expect(placement.eyeAngles?.[2]).toBeCloseTo(0, 4);
  });

  it('falls back to the band’s front when nothing of the model is in front of the eyes, and skips flat-on triangles', () => {
    const shell = slab([-0.35, 0, -0.2], [0.35, 0.4, 0.3]);
    // Only triangles away from the eyes' spots, plus one seen edge-on.
    const aside = [...slab([0.3, 0, 0.3], [0.35, 0.05, 0.35]), 0, 0.2, 0.5, 0, 0.3, 0.6, 0, 0.4, 0.7];
    const placement = autoPlacement('replace', shell, aside);
    const front = placePoint(placement, [0, 0, 0.3])[2];
    expect(placement.eyes?.[0]?.[2]).toBeCloseTo(front + HEAD_FIT.eyeLift, 3);
    expect(placement.eyeAngles).toBeUndefined();
  });

  it('wears a model with nothing to measure as it is', () => {
    expect(autoPlacement('replace', [])).toEqual({ scale: 1, offset: [0, 0, 0], eyes: null });
    expect(autoPlacement('accessory', [Number.NaN, 0, 0])).toEqual({ scale: 1, offset: [0, 0, 0] });
  });

  it('keeps to the limits a placement may have', () => {
    const tiny = autoPlacement('replace', box([-1e-6, 0, -1e-6], [1e-6, 1e-6, 1e-6]));
    expect(tiny.scale).toBe(HEAD_FIT.maxScale);
    const huge = autoPlacement('replace', box([-500, 300, -500], [500, 600, 500]));
    expect(huge.scale).toBe(HEAD_FIT.minScale);
    expect(huge.offset[1]).toBe(-HEAD_FIT.reach);
  });
});

describe('autoPlacement, an open face', () => {
  // Robot-sized already (0.37 m across), so it is worn at about its own size: a hollow box
  // head whose face is a frame round an opening, the sculpted eyes standing out in front.
  const back = slab([-0.185, 0, -0.15], [0.185, 0.25, -0.1]);
  const frame = [
    ...slab([-0.185, 0, 0.05], [0.185, 0.04, 0.1]),
    ...slab([-0.185, 0.18, 0.05], [0.185, 0.25, 0.1]),
    ...slab([-0.185, 0.04, 0.05], [-0.12, 0.18, 0.1]),
    ...slab([0.12, 0.04, 0.05], [0.185, 0.18, 0.1]),
  ];
  const ledge = slab([-0.12, 0.04, 0.0], [0.12, 0.07, 0.07]);
  const pills = [...slab([-0.08, 0.08, 0], [-0.04, 0.13, 0.12]), ...slab([0.04, 0.08, 0], [0.08, 0.13, 0.12])];
  const head = [...back, ...frame, ...ledge, ...pills];

  it('closes it with a screen just behind the frame, filling the opening, the eyes on it', () => {
    const placement = autoPlacement('replace', head, head);
    expect(placement.scale).toBeCloseTo(1, 1);
    const screen = placement.screen!;
    expect(screen).toBeDefined();
    const frameFront = placePoint(placement, [0, 0, 0.1])[2];
    expect(screen.center[2]).toBeCloseTo(frameFront - HEAD_FIT.screenInset, 2);
    // The opening (0.24 x 0.14, ledge included) and a tuck behind the frame all round.
    expect(screen.size[0]).toBeGreaterThan(0.24 * placement.scale);
    expect(screen.size[1]).toBeGreaterThan(0.14 * placement.scale);
    expect(screen.size[0]).toBeLessThan(0.3);
    for (const eye of placement.eyes ?? []) expect(eye[2]).toBeCloseTo(screen.center[2] + HEAD_FIT.eyeLift, 4);
    expect(placement.eyeAngles).toEqual([0, 0, 0]);
  });

  it('leaves a face alone whose hollow is not framed all round', () => {
    // No frame at the top: the hollow runs out of the head.
    const bottom = slab([-0.185, 0, 0.05], [0.185, 0.04, 0.1]);
    const sides = [...slab([-0.185, 0.04, 0.05], [-0.12, 0.25, 0.1]), ...slab([0.12, 0.04, 0.05], [0.185, 0.25, 0.1])];
    const open = [...back, ...bottom, ...sides, ...ledge];
    expect(autoPlacement('replace', open, open).screen).toBeUndefined();
  });
});

describe('autoPlacement, a face accessory', () => {
  const mask = solid([-0.4, 0, -0.25], [0.4, 1, 0.25]);

  it('sizes it to the face, its middle at eye height and its back on the screen', () => {
    const placement = autoPlacement('accessory', mask);
    expect(placement.scale).toBeCloseTo(HEAD_FIT.faceWidth / 0.8, 3);
    expect(placement.eyes).toBeUndefined();
    expect(placePoint(placement, [0, 0.5, 0])[1]).toBeCloseTo(ROBOT_EYES[0][1], 3);
    expect(placePoint(placement, [0, 0.5, -0.25])[2]).toBeCloseTo(FACE_PANEL.z + 0.002, 3);
    expect(placePoint(placement, [0, 0.5, 0])[0]).toBeCloseTo(0, 3);
  });

  it('is worn on a replacing head’s face when it has one: its screen’s width, its eyes’ height and depth', () => {
    const onto = {
      eyes: [[-0.06, 0.12, 0.08], [0.06, 0.12, 0.08]] as [Point3, Point3],
      screen: { center: [0, 0.12, 0.076] as Point3, size: [0.3, 0.15] as [number, number] },
    };
    const placement = autoPlacement('accessory', mask, [], onto);
    expect(placement.scale).toBeCloseTo((0.3 * 0.9) / 0.8, 3);
    expect(placePoint(placement, [0, 0.5, 0])[1]).toBeCloseTo(0.12, 3);
    expect(placePoint(placement, [0, 0.5, -0.25])[2]).toBeCloseTo(0.082, 3);
    const eyesOnly = autoPlacement('accessory', mask, [], { eyes: onto.eyes });
    expect(eyesOnly.scale).toBeCloseTo(HEAD_FIT.faceWidth / 0.8, 3);
    // An eye hole goes over that head's eye.
    const hole: Point3 = [-0.06, 0.56, 0.1];
    expect(placePoint(alignToEye(placement, hole, 'left', onto.eyes), hole)[0]).toBeCloseTo(-0.06, 3);
  });

  it('moves an eye hole over either eye, across the face only', () => {
    const placement = autoPlacement('accessory', mask);
    const hole: Point3 = [-0.06, 0.56, 0.1];
    const left = alignToEye(placement, hole, 'left');
    expect(placePoint(left, hole)[0]).toBeCloseTo(ROBOT_EYES[0][0], 3);
    expect(placePoint(left, hole)[1]).toBeCloseTo(ROBOT_EYES[0][1], 3);
    expect(left.offset[2]).toBe(placement.offset[2]);
    expect(placePoint(alignToEye(placement, hole, 'right'), hole)[0]).toBeCloseTo(ROBOT_EYES[1][0], 3);
  });
});

describe('eye angles', () => {
  it('face a surface: turn toward the middle, mirrored, and pitch up', () => {
    expect(anglesFromNormal([0, 0, 1], 'left')).toEqual([0, 0]);
    const [turn] = anglesFromNormal([0.5, 0, 1], 'left');
    expect(turn).toBeGreaterThan(0);
    expect(anglesFromNormal([-0.5, 0, 1], 'right')[0]).toBeCloseTo(turn, 6);
    expect(anglesFromNormal([0.5, 0, 1], 'right')[0]).toBeCloseTo(-turn, 6);
    expect(anglesFromNormal([0, 0.5, 1], 'left')[1]).toBeCloseTo(Math.asin(0.5 / Math.hypot(0.5, 1)), 4);
    expect(anglesFromNormal([0, 0, 0], 'left')).toEqual([0, 0]);
    expect(anglesFromNormal([5, 0, 0.01], 'left')[0]).toBe(HEAD_FIT.eyeAngle);
  });

  it('rotate the two eyes as mirror images', () => {
    expect(eyeRotations(null)).toEqual([[0, 0, 0], [0, 0, 0]]);
    expect(eyeRotations([0.2, 0.3, 0.1])).toEqual([
      [-0.1, 0.3, -0.2],
      [-0.1, -0.3, 0.2],
    ]);
  });
});

describe('angling a whole model', () => {
  const near = (actual: Point3, expected: Point3): void => {
    actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 4));
  };
  const quarter = Math.PI / 2;

  it('tilts the top forward, turns the front to the robot’s left, slants the top to its right', () => {
    near(turnPoint([0, 1, 0], [quarter, 0, 0]), [0, 0, 1]);
    near(turnPoint([0, 0, 1], [0, quarter, 0]), [1, 0, 0]);
    near(turnPoint([0, 1, 0], [0, 0, quarter]), [-1, 0, 0]);
    expect(turnPoint([1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  it('turns in three.js’s YXZ order: slant, then tilt, then turn', () => {
    // Slanted a quarter, the top lies along -X; tilting about X leaves it there; turning takes it to +Z.
    near(turnPoint([0, 1, 0], [quarter, quarter, quarter]), [0, 0, 1]);
  });

  it('carries eyes and points about the offset, and an eye hole still lands on the eye', () => {
    const angled: HeadPlacement = { scale: 0.5, offset: [0, 0.1, 0], angles: [0, 0, quarter] };
    near(rotateAbout(angled, [0, 0.2, 0]), [-0.1, 0.1, 0]);
    expect(rotateAbout({ scale: 1, offset: [0, 0, 0] }, [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    near(placePoint(angled, [0, 0.2, 0]), [-0.1, 0.1, 0]);
    const lined = alignToEye(angled, [0.1, 0.1, 0.2], 'left');
    const hole = placePoint(lined, [0.1, 0.1, 0.2]);
    expect(hole[0]).toBeCloseTo(ROBOT_EYES[0][0], 3);
    expect(hole[1]).toBeCloseTo(ROBOT_EYES[0][1], 3);
  });
});

describe('moving a fitted head', () => {
  const fitted: HeadPlacement = { scale: 0.5, offset: [0.01, 0.02, -0.03], eyes: [[-0.05, 0.1, 0.13], [0.05, 0.1, 0.13]] };

  it('grows and shrinks in place, eyes and all', () => {
    const bigger = rescale(fitted, 1);
    expect(bigger.scale).toBe(1);
    expect(bigger.offset).toEqual([0.02, 0.04, -0.06]);
    expect(bigger.eyes?.[1]).toEqual([0.1, 0.2, 0.26]);
    expect(rescale({ scale: 1, offset: [0, 0, 0] }, 50)).toEqual({ scale: HEAD_FIT.maxScale, offset: [0, 0, 0] });
  });

  it('nudges, eyes and all, never past the reach', () => {
    const moved = nudge(fitted, [0, 0.01, 0]);
    expect(moved.offset).toEqual([0.01, 0.03, -0.03]);
    expect(moved.eyes?.[0]).toEqual([-0.05, 0.11, 0.13]);
    expect(nudge({ scale: 1, offset: [0.99, 0, 0] }, [0.5, 0, 0]).offset[0]).toBe(HEAD_FIT.reach);
    expect(nudge({ scale: 1, offset: [0, 0, 0], eyes: null }, [0, 0, -0.001])).toEqual({ scale: 1, offset: [0, 0, -0.001], eyes: null });
  });

  it('never answers -0', () => {
    expect(Object.is(placePoint({ scale: 1, offset: [0, 0, 0] }, [-0, -0, -0])[0], -0)).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(HEAD_FIT)).toBe(true);
    expect(Object.isFrozen(ROBOT_EYES)).toBe(true);
    expect(Object.isFrozen(ROBOT_EYES[0])).toBe(true);
  });
});
