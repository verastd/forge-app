import { describe, expect, it } from 'vitest';

import { ARM, armAxis, armJoints, armLens, armWeights, clearOf, createArmLook, lensShare, lensZoom, stepArmLook } from './arm.js';
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

/** An arm along +y, 0 to 1 m, as rings of points whose radius follows `radius(t)`. */
const shaped = (radius: (t: number) => number, rings = 200): Float32Array => {
  const out: number[] = [];
  for (let i = 0; i <= rings; i += 1) {
    const t = i / rings;
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      out.push(Math.cos(a) * radius(t), t, Math.sin(a) * radius(t));
    }
  }
  return new Float32Array(out);
};
const UP = { base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 1, z: 0 } };

describe('armJoints', () => {
  it('bends at its narrowings (a wrist, an elbow), not in its thick parts', () => {
    // Thick base, a waist at 0.35, a thick elbow, a thin forearm around 0.72, a big camera head at the end.
    const radius = (t: number): number => (t < 0.3 ? 0.25 : t < 0.4 ? 0.12 : t < 0.62 ? 0.3 : t < 0.8 ? 0.1 : 0.28);
    const joints = armJoints(shaped(radius), UP);
    expect(joints).toHaveLength(2);
    expect(joints[0]).toBeGreaterThan(0.3);
    expect(joints[0]).toBeLessThan(0.4);
    expect(joints[1]).toBeGreaterThan(0.62);
    expect(joints[1]).toBeLessThan(0.8);
    // Never within the camera head (the last fifth) or the base.
    for (const j of joints) {
      expect(j).toBeGreaterThanOrEqual(ARM.jointEdge);
      expect(j).toBeLessThanOrEqual(1 - ARM.jointEdge);
    }
  });

  it('keeps joints apart and to at most `max`, the deepest first', () => {
    // Waists at 0.3 (the deepest), 0.4 (too near it to count too) and 0.65.
    const waist = (t: number, at: number, r: number): number | null => (Math.abs(t - at) < 0.04 ? r : null);
    const radius = (t: number): number => waist(t, 0.3, 0.04) ?? waist(t, 0.4, 0.1) ?? waist(t, 0.65, 0.12) ?? 0.3;
    const two = armJoints(shaped(radius, 400), UP, 2);
    expect(two).toHaveLength(2);
    expect(two[0]).toBeGreaterThan(0.25);
    expect(two[0]).toBeLessThan(0.38);
    expect(two[1]).toBeGreaterThan(0.6);
    expect(two[1]).toBeLessThan(0.7);
    expect(two[1]! - two[0]!).toBeGreaterThanOrEqual(ARM.jointGap);
    // With room for one, the deepest.
    const one = armJoints(shaped(radius, 400), UP, 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toBeLessThan(0.38);
  });

  it('with no narrowing to go by (a plain rod), bends at its thirds', () => {
    expect(armJoints(shaped(() => 0.1), UP)).toEqual([1 / 3, 2 / 3]);
    expect(armJoints(shaped(() => 0.1), UP, 1)).toEqual([1 / 3]);
    // Points only at its ends (empty slices between) are no different.
    expect(armJoints([0.1, 0, 0, 0.1, 1, 0], UP)).toEqual([1 / 3, 2 / 3]);
  });
});

describe('armWeights', () => {
  it('gives each vertex wholly to the bone of its stretch, so each part moves as one piece', () => {
    const positions = [0, 0, 0, 0, 0.2, 0, 0, 0.35, 0, 0, 0.5, 0, 0, 0.9, 0, 0, 1.4, 0, 0, -0.2, 0];
    const { joints, weights } = armWeights(positions, UP, [0.35, 0.7]);
    const bones = Array.from({ length: 7 }, (_, i) => joints[i * 4]);
    // Base stretch, then from each joint on (a vertex right at a joint goes with the part past it).
    expect(bones).toEqual([0, 0, 1, 1, 2, 2, 0]);
    for (let i = 0; i < 7; i += 1) {
      expect(weights[i * 4]).toBe(1);
      expect([weights[i * 4 + 1], weights[i * 4 + 2], weights[i * 4 + 3]]).toEqual([0, 0, 0]);
    }
  });

  it('survives an axis with no length', () => {
    const { joints } = armWeights([0, 0, 0], { base: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 0 } }, [0.5]);
    expect(joints[0]).toBe(0);
  });
});

describe('the lens', () => {
  // A camera piece past a joint at 0.7: from z = -0.1 to z = 0.3 at the far end, nothing forward before it.
  const positions = [0, 0.2, 0, 0, 0.5, 0.05, 0, 0.8, -0.1, 0, 0.9, 0.1, 0, 1, 0.3];
  it('is the front of the camera piece, the way the model faces', () => {
    const lens = armLens(positions, UP, [0.35, 0.7])!;
    expect(lens.full).toBeCloseTo(0.3 - 0.4 * ARM.lensFront);
    expect(lens.neck).toBeCloseTo(0.3 - 0.4 * ARM.lensNeck);
    expect(lens.reach).toBeCloseTo(0.4 * ARM.lensReach);
    // With no camera piece to speak of (a flat one, or none at all), none.
    expect(armLens([0, 0.9, 0.1, 0, 1, 0.1], UP, [0.5])).toBeNull();
    expect(armLens([0, 0.2, 0], UP, [])).toBeNull();
  });

  it('moves the lens wholly, the barrel behind it partly (eased), and nothing behind that', () => {
    const lens = { neck: 0.1, full: 0.2, reach: 0.05 };
    expect(lensShare(0.05, lens)).toBe(0);
    expect(lensShare(0.1, lens)).toBe(0);
    expect(lensShare(0.15, lens)).toBeCloseTo(0.5);
    expect(lensShare(0.12, lens)).toBeLessThan(0.2);
    expect(lensShare(0.2, lens)).toBe(1);
    expect(lensShare(0.25, lens)).toBe(1);
  });

  it('zooms in and out: in at first, then to a new depth every few seconds, eased, held between', () => {
    expect(lensZoom(0, 7)).toBe(0);
    for (let t = 0; t < 60; t += 0.1) {
      const z = lensZoom(t, 7);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
    }
    // Held once it gets there…
    const settle = ARM.zoomEvery + ARM.zoomTime + 0.1;
    expect(lensZoom(settle, 7)).toBeCloseTo(lensZoom(2 * ARM.zoomEvery - 0.01, 7));
    // …and it does move: not the same depth all the time.
    const depths = new Set(Array.from({ length: 10 }, (_, k) => lensZoom(k * ARM.zoomEvery + ARM.zoomTime + 0.1, 7).toFixed(3)));
    expect(depths.size).toBeGreaterThan(5);
    // Each robot's its own, and the same for everyone; nonsense times are the start.
    expect(lensZoom(10, 7)).toBe(lensZoom(10, 7));
    expect(lensZoom(10, 7)).not.toBe(lensZoom(10, 8));
    expect(lensZoom(Number.NaN, 7)).toBe(0);
    expect(lensZoom(-5, 7)).toBe(0);
  });
});

describe('clearOf', () => {
  const torso = { min: { x: -0.2, y: 0.3, z: -0.12 }, max: { x: 0.2, y: 0.8, z: 0.14 } };
  const head = { min: { x: -0.19, y: 0.8, z: -0.15 }, max: { x: 0.19, y: 1.1, z: 0.15 } };
  it('is clear outside every box by the margin, and not inside or within it', () => {
    expect(clearOf({ x: 0, y: 1.3, z: 0 }, [torso, head], 0.05)).toBe(true);
    expect(clearOf({ x: 0, y: 0.5, z: -0.3 }, [torso, head], 0.05)).toBe(true);
    expect(clearOf({ x: 0, y: 0.5, z: 0 }, [torso, head], 0.05)).toBe(false);
    expect(clearOf({ x: 0, y: 1, z: 0 }, [torso, head], 0.05)).toBe(false);
    // Just outside the torso's back, but within the margin.
    expect(clearOf({ x: 0, y: 0.5, z: -0.15 }, [torso], 0.05)).toBe(false);
    expect(clearOf({ x: 0, y: 0.5, z: -0.15 }, [torso], 0)).toBe(true);
    // Each side of each box counts.
    for (const p of [{ x: -0.5, y: 0.5, z: 0 }, { x: 0.5, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0.5 }]) expect(clearOf(p, [torso], 0.01)).toBe(true);
    expect(clearOf({ x: 0, y: 0, z: 0 }, [], 1)).toBe(true);
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

  it('holds still for reduced motion, forgets what it was doing, and picks afresh once it may move again', () => {
    const state = createArmLook(3);
    stepArmLook(state, input());
    expect(stepArmLook(state, input({ t: 0.1, reducedMotion: true }))).toBeNull();
    expect(state.aim).toBeNull();
    // Back to full motion mid-hold: a new pick at once, no stale (empty) goal.
    const aim = stepArmLook(state, input({ t: 0.2 }));
    expect(aim).not.toBeNull();
    expect(state.goal).not.toBeNull();
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

  it('never wanders a way that would reach through the robot, and holds its rest direction when every way would', () => {
    const rest = { x: 0, y: 1, z: 0 };
    // Nothing toward −Z (where the robot is, say).
    const blocked = (dir: { z: number }): boolean => dir.z < 0;
    const state = createArmLook(13);
    let t = 0;
    for (let i = 0; i < 60 * 30; i += 1) {
      t += 1 / 60;
      stepArmLook(state, input({ t, rest, blocked }));
      expect(state.goal!.z).toBeGreaterThanOrEqual(base.z - 1e-9);
    }
    const stuck = createArmLook(13);
    stepArmLook(stuck, input({ t: 1, rest, blocked: () => true }));
    expect(stuck.goal).toEqual({ x: base.x, y: base.y + 0.6, z: base.z });
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
