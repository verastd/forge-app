import { describe, expect, it } from 'vitest';

import { ARM, armAxis, armWeights, createArmLook, stepArmLook } from './arm.js';
import type { ArmLookInput } from './arm.js';

/** A thin rod of points from (0, 0, 0) to (0, 1, 0), a little wide. */
const rod = (): Float32Array => {
  const out: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const y = i / 20;
    out.push(0.02, y, 0, -0.02, y, 0, 0, y, 0.02);
  }
  return new Float32Array(out);
};

describe('armAxis', () => {
  it('runs end to end along the model, its base the end nearest the mount', () => {
    const axis = armAxis(rod(), { x: 0, y: -0.2, z: 0 })!;
    expect(axis.base.y).toBeCloseTo(0, 5);
    expect(axis.tip.y).toBeCloseTo(1, 5);
    // Through the middle of the rod (its points sit a little off the line on average).
    expect(Math.abs(axis.base.x) + Math.abs(axis.tip.z)).toBeLessThan(0.01);
    const flipped = armAxis(rod(), { x: 0, y: 1.3, z: 0 })!;
    expect(flipped.base.y).toBeCloseTo(1, 5);
    expect(flipped.tip.y).toBeCloseTo(0, 5);
  });

  it('finds a slanted arm too', () => {
    const points: number[] = [];
    for (let i = 0; i <= 10; i += 1) points.push(i * 0.1, i * 0.1, 0, i * 0.1 + 0.01, i * 0.1, 0.01);
    const axis = armAxis(points, { x: 0, y: 0, z: 0 })!;
    expect(axis.tip.x - axis.base.x).toBeCloseTo(axis.tip.y - axis.base.y, 1);
    expect(axis.tip.x).toBeGreaterThan(axis.base.x);
  });

  it('has nothing to say about fewer than two points, or one point twice', () => {
    expect(armAxis([1, 2, 3], { x: 0, y: 0, z: 0 })).toBeNull();
    expect(armAxis([1, 2, 3, 1, 2, 3], { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('armWeights', () => {
  it('gives each vertex the bone of its stretch, shared with the one before near a joint', () => {
    const positions = [0, 0, 0, 0, 0.3, 0, 0, 0.5, 0, 0, 0.65, 0, 0, 1, 0, 0, 1.4, 0, 0, -0.2, 0];
    const { joints, weights } = armWeights(positions, { base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 1, z: 0 } }, 4);
    const at = (i: number) => ({ bones: [joints[i * 4], joints[i * 4 + 1]], weights: [weights[i * 4]!, weights[i * 4 + 1]!] });
    // The base: all the first bone's.
    expect(at(0)).toEqual({ bones: [0, 0], weights: [1, 0] });
    // 0.3 is past the second joint's middle (s = 1.2): mostly bone 1, some of bone 0.
    expect(at(1).bones).toEqual([1, 0]);
    expect(at(1).weights[0]).toBeGreaterThan(0.5);
    expect(at(1).weights[0]).toBeLessThan(1);
    // Right on a joint (s = 2): half and half.
    expect(at(2).bones).toEqual([2, 1]);
    expect(at(2).weights[0]).toBeCloseTo(0.5, 5);
    // Past a segment's middle: all its own.
    expect(at(3).weights).toEqual([1, 0]);
    // The tip and beyond (clamped), and behind the base: the last and the first bone.
    expect(at(4).bones[0]).toBe(3);
    expect(at(5).bones[0]).toBe(3);
    expect(at(6)).toEqual({ bones: [0, 0], weights: [1, 0] });
    // The two unused slots stay empty, and every vertex's weights add to 1.
    for (let i = 0; i < 7; i += 1) {
      expect(weights[i * 4]! + weights[i * 4 + 1]!).toBeCloseTo(1, 6);
      expect(weights[i * 4 + 2]).toBe(0);
      expect(weights[i * 4 + 3]).toBe(0);
    }
  });

  it('survives an axis with no length', () => {
    const { joints } = armWeights([0, 0, 0], { base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 0 } });
    expect(joints[0]).toBe(0);
  });
});

describe('stepArmLook', () => {
  const base = { x: 0, y: 1, z: 0 };
  const input = (over: Partial<ArmLookInput> = {}): ArmLookInput => ({
    t: 0,
    dt: 1 / 60,
    base,
    rest: { x: 0, y: 0, z: -1 },
    reach: 0.6,
    people: [],
    reducedMotion: false,
    ...over,
  });

  it('holds still for reduced motion, and forgets what it was doing', () => {
    const state = createArmLook(3);
    stepArmLook(state, input());
    expect(stepArmLook(state, input({ reducedMotion: true }))).toBeNull();
    expect(state.aim).toBeNull();
  });

  it.each([
    ['behind', { x: 0, y: 0, z: -1 }],
    ['straight up', { x: 0, y: 1, z: 0 }],
  ])('with nobody near, hops around its rest direction (%s), within reach, to a new spot now and then', (_, rest) => {
    const state = createArmLook(7);
    const goals = new Set<string>();
    let t = 0;
    for (let i = 0; i < 60 * 30; i += 1) {
      t += 1 / 60;
      const aim = stepArmLook(state, input({ t, rest }))!;
      expect(state.watching).toBeNull();
      // Within its reach (and a bob)…
      expect(Math.hypot(aim.x - base.x, aim.y - base.y, aim.z - base.z)).toBeLessThan(0.6 + ARM.bob + 1e-6);
      // …each spot reach away, tipped wanderMin–wanderMax off its rest direction.
      const g = state.goal!;
      const d = { x: (g.x - base.x) / 0.6, y: (g.y - base.y) / 0.6, z: (g.z - base.z) / 0.6 };
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
      const off = Math.acos(Math.min(1, d.x * rest.x + d.y * rest.y + d.z * rest.z));
      expect(off).toBeGreaterThanOrEqual(ARM.wanderMin - 1e-6);
      expect(off).toBeLessThanOrEqual(ARM.wanderMax + 1e-6);
      goals.add(JSON.stringify(state.goal));
    }
    // A pick lasts holdMin–holdMax seconds: in 30 s, several picks.
    expect(goals.size).toBeGreaterThanOrEqual(Math.floor(30 / ARM.holdMax));
    expect(goals.size).toBeLessThanOrEqual(Math.ceil(30 / ARM.holdMin) + 1);
  });

  it('looks at someone near, following them as they move, and lets them go once they leave', () => {
    const state = createArmLook(11);
    const person = { x: 2, y: 1.7, z: 1 };
    let t = 0;
    let watched = false;
    for (let i = 0; i < 60 * 40 && !watched; i += 1) {
      t += 1 / 60;
      stepArmLook(state, input({ t, people: [person] }));
      watched = state.watching === 0;
    }
    expect(watched).toBe(true);
    // Followed: the aim settles on them, wherever they go (while it watches).
    const moved = { x: 3, y: 1.7, z: -1 };
    for (let i = 0; i < 60; i += 1) {
      t += 1 / 60;
      stepArmLook(state, input({ t, people: [moved] }));
      if (state.watching === null) break;
    }
    if (state.watching === 0) {
      expect(state.aim!.x).toBeCloseTo(3, 0);
      expect(state.goal).toEqual(moved);
    }
    // Out of range: it stops watching at once.
    stepArmLook(state, input({ t: t + 1 / 60, people: [{ x: 50, y: 1.7, z: 0 }] }));
    expect(state.watching).toBeNull();
    // Someone gone from the list entirely: the same.
    state.watching = 4;
    state.until = Infinity;
    stepArmLook(state, input({ t: t + 2 / 60, people: [] }));
    expect(state.watching).toBeNull();
  });

  it('is the same for everyone with the same seed, and different with another', () => {
    const run = (seed: number): string => {
      const state = createArmLook(seed);
      const out: string[] = [];
      for (let i = 1; i <= 300; i += 1) out.push(JSON.stringify(stepArmLook(state, input({ t: i / 30, dt: 1 / 30 }))));
      return out.join();
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
    // A seed of 0 still gets a sequence of its own.
    expect(createArmLook(0).seed).toBeGreaterThan(0);
  });

  it('takes a stalled clock in its stride (no step back)', () => {
    const state = createArmLook(2);
    const first = stepArmLook(state, input({ t: 1 }))!;
    const again = stepArmLook(state, input({ t: 1, dt: -1 }))!;
    expect(again).toEqual(first);
  });
});
