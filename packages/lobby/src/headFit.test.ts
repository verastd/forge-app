import { describe, expect, it } from 'vitest';

import { FACE_PANEL } from './avatar.js';
import { HEAD_FIT, ROBOT_EYES, alignToEye, autoPlacement, nudge, placePoint, rescale } from './headFit.js';
import type { HeadPlacement, Point3 } from './headFit.js';

/** A box's eight corners, flat. */
function box(min: Point3, max: Point3): number[] {
  const out: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return out;
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

  it('starts its eyes where the robot’s own are, on the band’s front', () => {
    const placement = autoPlacement('replace', head);
    const front = placePoint(placement, [0, 0, 0.3])[2];
    expect(placement.eyes?.[0]).toEqual([ROBOT_EYES[0][0], ROBOT_EYES[0][1], Math.round((front + 0.005) * 10_000) / 10_000]);
    expect(placement.eyes?.[1]?.[0]).toBe(ROBOT_EYES[1][0]);
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
