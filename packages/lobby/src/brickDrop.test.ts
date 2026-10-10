import { describe, expect, it } from 'vitest';

import { BRICK_DROP, DROP_TIME, burstTargets, dropFrame } from './brickDrop.js';

const from = { x: 0, y: 1, z: 0 };
const dir = { x: 0, y: 0, z: -1 };
const to = { x: 0, y: 0.12, z: -1.5 };

describe('dropFrame', () => {
  it('slides out of the ramp tiny, then falls to the floor growing, and lands square at full size', () => {
    const start = dropFrame(0, from, dir, to);
    expect(start).toMatchObject({ at: from, scale: BRICK_DROP.startScale, spin: 0, done: false });
    const slid = dropFrame(BRICK_DROP.slide - 1e-9, from, dir, to);
    expect(slid.at.z).toBeCloseTo(-BRICK_DROP.slideDistance, 3);
    expect(slid.scale).toBe(BRICK_DROP.startScale);
    const mid = dropFrame(BRICK_DROP.slide + BRICK_DROP.fall / 2, from, dir, to);
    expect(mid.scale).toBeGreaterThan(BRICK_DROP.startScale);
    expect(mid.scale).toBeLessThan(1);
    // It arcs up before it comes down.
    expect(mid.at.y).toBeGreaterThan(to.y);
    const end = dropFrame(DROP_TIME, from, dir, to);
    expect(end.done).toBe(true);
    expect(end.scale).toBe(1);
    expect(end.at.x).toBeCloseTo(to.x);
    expect(end.at.y).toBeCloseTo(to.y);
    expect(end.at.z).toBeCloseTo(to.z);
    expect(end.spin % (Math.PI * 2)).toBeCloseTo(0);
    expect(dropFrame(DROP_TIME + 5, from, dir, to).done).toBe(true);
    expect(dropFrame(-1, from, dir, to).at).toEqual(from);
  });
});

describe('burstTargets', () => {
  it('spreads over the disk, the same for everyone with the same seed', () => {
    const centre = { x: 2, y: 0, z: -3 };
    const a = burstTargets(centre, 1.5, 42);
    expect(a).toHaveLength(BRICK_DROP.burstCount);
    expect(a).toEqual(burstTargets(centre, 1.5, 42));
    expect(a).not.toEqual(burstTargets(centre, 1.5, 43));
    for (const p of a) expect(Math.hypot(p.x - centre.x, p.z - centre.z)).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(burstTargets(centre, 1, 0, 3)).toHaveLength(3);
  });
});
