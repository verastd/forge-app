import { describe, expect, it } from 'vitest';

import { THROW_TIME } from './actions.js';
import {
  BALL,
  GESTURE,
  HOLD,
  THROW,
  arrivalVelocity,
  ballAt,
  canCatch,
  catchPoint,
  foreDirection,
  gesturePose,
  landingAhead,
  missPath,
  reachArm,
  throwShape,
  throwTarget,
  unit,
} from './play.js';
import type { Vec3 } from './attenuation.js';

const near = (a: Vec3, b: Vec3, digits = 4): void => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

describe('a throw', () => {
  const from = { x: 0, y: 1.4, z: 0 };
  const dest = { x: 0, y: 1.35, z: -8 };

  it('takes longer and arcs higher the farther it goes, within the time a message allows', () => {
    expect(throwShape(10).time).toBeGreaterThan(throwShape(2).time);
    expect(throwShape(10).arc).toBeGreaterThan(throwShape(2).arc);
    expect(throwShape(0).time).toBeGreaterThanOrEqual(THROW_TIME.min);
    expect(throwShape(1000).time).toBe(THROW_TIME.max);
    expect(throwShape(Number.NaN)).toEqual(throwShape(0));
  });

  it('leaves the hand, arcs above the line and comes down where it was aimed', () => {
    const { time, arc } = throwShape(8);
    near(ballAt(from, dest, time, 0), from);
    near(ballAt(from, dest, time, time), dest);
    const middle = ballAt(from, dest, time, time / 2);
    expect(middle.y).toBeCloseTo((from.y + dest.y) / 2 + arc, 4);
    near(ballAt(from, dest, time, -1), from);
    near(ballAt(from, dest, time, time * 3), dest);
    near(ballAt(from, dest, 0, 0.5), dest);
  });

  it('comes in falling, along the throw', () => {
    const v = arrivalVelocity(from, dest, 1);
    expect(v.y).toBeLessThan(0);
    expect(v.z).toBeCloseTo(-8, 4);
  });
});

describe('a missed ball', () => {
  it('falls to the floor, bounces lower each time, then rolls to a stop', () => {
    const start = { x: 0, y: 1.3, z: 0 };
    const v = { x: 0, y: -2, z: -6 };
    let lowest = Infinity;
    let last = start;
    for (let t = 0; t < 6; t += 0.01) {
      const { at } = missPath(start, v, t);
      expect(at.y).toBeGreaterThanOrEqual(BALL.radius - 1e-6);
      lowest = Math.min(lowest, at.y);
      expect(at.z).toBeLessThanOrEqual(last.z + 1e-9);
      last = at;
    }
    expect(lowest).toBeCloseTo(BALL.radius, 4);
    const end = missPath(start, v, 20);
    expect(end.rest).toBe(true);
    expect(end.at.y).toBe(BALL.radius);
    // Once it stops, it stays.
    near(missPath(start, v, 30).at, end.at);
  });

  it('just rolls when dropped flat on the floor, and stays put with no speed', () => {
    const still = missPath({ x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, 2);
    expect(still.rest).toBe(true);
    near(still.at, { x: 1, y: BALL.radius, z: 1 });
    expect(missPath({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, -1).at.y).toBe(BALL.radius);
  });
});

describe('who catches', () => {
  it('aims in front of the catcher’s chest, toward the thrower', () => {
    const point = catchPoint({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: -6 });
    expect(point.y).toBeCloseTo(1.7 - THROW.chest);
    expect(point.z).toBeCloseTo(-6 + 0.35);
  });

  it('lands a throw at nobody ahead, on the floor', () => {
    const point = landingAhead({ x: 0, y: 1.4, z: 0 }, 0);
    expect(point).toEqual({ x: 0, y: BALL.radius, z: -THROW.ahead });
  });

  it('catches within reach, and not beyond', () => {
    const eye = { x: 0, y: 1.7, z: 0 };
    expect(canCatch(eye, { x: 0.3, y: 1.3, z: 0.3 })).toBe(true);
    expect(canCatch(eye, { x: 2, y: 1.3, z: 0 })).toBe(false);
  });

  it('throws to whoever is nearest straight ahead, in range and in the cone', () => {
    const eye = { x: 0, y: 1.7, z: 0 };
    const others = new Map<string, Vec3>([
      ['behind', { x: 0, y: 1.7, z: 4 }],
      ['ahead-far', { x: 0, y: 1.7, z: -12 }],
      ['ahead-near', { x: 0.5, y: 1.7, z: -5 }],
      ['wide', { x: 4, y: 1.7, z: -2 }],
      ['too-far', { x: 0, y: 1.7, z: -30 }],
      ['on-top', { x: 0.1, y: 1.7, z: 0 }],
    ]);
    expect(throwTarget(eye, 0, others)).toBe('ahead-near');
    expect(throwTarget(eye, Math.PI, others)).toBe('behind');
    expect(throwTarget(eye, Math.PI / 2, new Map([['x', { x: 0, y: 1.7, z: 9 }]]))).toBeNull();
  });
});

describe('gestures', () => {
  it('blend in and out, and end', () => {
    for (const kind of ['wave', 'throw', 'catch'] as const) {
      expect(gesturePose(kind, 0, false, false)?.weight).toBe(0);
      expect(gesturePose(kind, GESTURE[kind] / 2, false, false)?.weight).toBe(1);
      expect(gesturePose(kind, GESTURE[kind] + 0.01, false, false)).toBeNull();
      expect(gesturePose(kind, -0.01, false, false)).toBeNull();
    }
  });

  it('waves the right hand high, and holds still with reduced motion', () => {
    const a = gesturePose('wave', 0.5, false, true)!;
    const b = gesturePose('wave', 0.9, false, true)!;
    expect(a.right!.upper.y).toBeGreaterThan(0);
    expect(a.right!.upper.x).toBeLessThan(0);
    expect(a.right!.bend).toBeCloseTo(b.right!.bend);
    expect(gesturePose('wave', 0.5, false, false)!.left).toBeNull();
    expect(gesturePose('wave', 0.5, true, false)!.left).toBe(HOLD);
  });

  it('throws from back over the shoulder through to out in front', () => {
    const early = gesturePose('throw', GESTURE.release * 0.5, true, false)!;
    const late = gesturePose('throw', GESTURE.release, true, false)!;
    expect(early.right!.upper.z).toBeLessThan(late.right!.upper.z);
    expect(late.right!.upper.z).toBeGreaterThan(0.8);
  });

  it('reaches both hands out to catch', () => {
    const pose = gesturePose('catch', 0.4, false, false)!;
    expect(pose.right!.upper.z).toBeGreaterThan(0.9);
    expect(pose.left!.upper.x).toBeGreaterThan(0);
  });
});

describe('arms', () => {
  it('bends the forearm toward the hint by the bend', () => {
    const fore = foreDirection({ upper: { x: 0, y: -1, z: 0 }, bend: Math.PI / 2, hint: { x: 0, y: 0, z: 1 } });
    near(fore, { x: 0, y: 0, z: 1 });
    // A hint along the arm still bends it somewhere square to it.
    const along = foreDirection({ upper: { x: 0, y: 0, z: 1 }, bend: Math.PI / 2, hint: { x: 0, y: 0, z: 1 } });
    expect(Math.abs(along.z)).toBeLessThan(1e-6);
    near(foreDirection({ upper: { x: 0, y: -1, z: 0 }, bend: 0, hint: { x: 0, y: 1, z: 0 } }), { x: 0, y: -1, z: 0 });
  });

  it('puts the hand on a target in reach, the elbow toward the pole', () => {
    const shoulder = { x: 0, y: 0, z: 0 };
    const target = { x: 0, y: 0, z: 0.4 };
    const { upper, fore } = reachArm(shoulder, target, 0.25, 0.25, { x: 0, y: -1, z: 0 });
    const elbow = { x: upper.x * 0.25, y: upper.y * 0.25, z: upper.z * 0.25 };
    const hand = { x: elbow.x + fore.x * 0.25, y: elbow.y + fore.y * 0.25, z: elbow.z + fore.z * 0.25 };
    near(hand, target, 3);
    expect(elbow.y).toBeLessThan(0);
    expect(len(upper)).toBeCloseTo(1);
  });

  it('points straight at a target out of reach, and copes with a pole along the reach', () => {
    const { upper, fore } = reachArm({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }, 0.25, 0.25, { x: 0, y: 0, z: 1 });
    expect(upper.z).toBeGreaterThan(0.99);
    expect(fore.z).toBeGreaterThan(0.99);
    const up = reachArm({ x: 0, y: 0, z: 0 }, { x: 0, y: 0.3, z: 0 }, 0.25, 0.25, { x: 0, y: 1, z: 0 });
    expect(len(up.upper)).toBeCloseTo(1);
  });

  it('has a unit vector for everything, straight down for nothing', () => {
    expect(unit({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: -1, z: 0 });
    expect(len(unit({ x: 3, y: 4, z: 0 }))).toBeCloseTo(1);
  });
});
