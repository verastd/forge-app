import { describe, expect, it } from 'vitest';

import { CAPE, capePoints, capePose, capeSpine } from './cape.js';
import type { CapeInput } from './cape.js';

const HOVER: CapeInput = { t: 1.3, speed: 0, climb: 0, turnRate: 0, reducedMotion: false };

function hem(input: CapeInput): [number, number, number] {
  return capeSpine(capePose(input))[CAPE.rows]!;
}

describe('capePose', () => {
  it('streams back with speed, up to full, and swings out of a turn', () => {
    expect(capePose(HOVER).lift).toBe(0);
    expect(capePose({ ...HOVER, speed: CAPE.fullSpeed / 2 }).lift).toBeCloseTo(0.5);
    expect(capePose({ ...HOVER, speed: 99 }).lift).toBe(1);
    expect(capePose({ ...HOVER, turnRate: 1 }).swing).toBeLessThan(0);
    expect(capePose({ ...HOVER, turnRate: -1 }).swing).toBeGreaterThan(0);
    expect(Math.abs(capePose({ ...HOVER, turnRate: 99 }).swing)).toBe(CAPE.maxSwing);
    expect(capePose({ ...HOVER, climb: 99 }).climb).toBe(CAPE.maxClimb);
  });

  it('hangs still with reduced motion, whatever the robot does', () => {
    expect(capePose({ t: 5, speed: 4, climb: 1, turnRate: 2, reducedMotion: true })).toEqual({ lift: 0, climb: 0, swing: 0, t: 0, still: true });
  });

  it('takes nonsense as standing still', () => {
    const pose = capePose({ t: Number.NaN, speed: Number.NaN, climb: Number.POSITIVE_INFINITY, turnRate: Number.NaN, reducedMotion: false });
    expect(pose).toEqual({ lift: 0, climb: 0, swing: 0, t: 0, still: false });
    expect(capePose({ ...HOVER, speed: -3 }).lift).toBe(0);
  });
});

describe('capeSpine', () => {
  it('never stretches: every step down it is the same length', () => {
    const step = CAPE.length / CAPE.rows;
    for (const input of [HOVER, { ...HOVER, speed: 5, turnRate: 1.5, climb: -2 }, { ...HOVER, reducedMotion: true }]) {
      const spine = capeSpine(capePose(input));
      expect(spine).toHaveLength(CAPE.rows + 1);
      for (let i = 1; i < spine.length; i += 1) {
        const [a, b] = [spine[i - 1]!, spine[i]!];
        expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeCloseTo(step);
      }
    }
  });

  it('hangs from the shoulders, behind the back', () => {
    expect(capeSpine(capePose(HOVER))[0]).toEqual([0, CAPE.top, -CAPE.behind]);
  });

  it('streams further back the faster it goes, and rises toward level', () => {
    const still = hem(HOVER);
    const fast = hem({ ...HOVER, speed: 5 });
    expect(fast[2]).toBeLessThan(still[2] - 0.2);
    expect(fast[1]).toBeGreaterThan(still[1] + 0.1);
  });

  it('drops when climbing and lifts when falling', () => {
    const level = hem({ ...HOVER, speed: 2 });
    expect(hem({ ...HOVER, speed: 2, climb: 2 })[2]).toBeGreaterThan(level[2]);
    expect(hem({ ...HOVER, speed: 2, climb: -2 })[2]).toBeLessThan(level[2]);
  });

  it('swings out to the right in a turn to the left, and the other way', () => {
    expect(hem({ ...HOVER, turnRate: 1 })[0]).toBeLessThan(-0.02);
    expect(hem({ ...HOVER, turnRate: -1 })[0]).toBeGreaterThan(0.02);
  });

  it('hangs straight and still with reduced motion', () => {
    const a = capeSpine(capePose({ ...HOVER, t: 0, reducedMotion: true }));
    const b = capeSpine(capePose({ ...HOVER, t: 9, speed: 5, reducedMotion: true }));
    expect(b).toEqual(a);
    for (const p of a) expect(p[0]).toBe(0);
  });
});

describe('capePoints', () => {
  const count = (CAPE.rows + 1) * (CAPE.cols + 1) * 3;

  it('is every point of the grid, wider at the hem than the shoulders', () => {
    const points = capePoints(capePose(HOVER));
    expect(points).toHaveLength(count);
    const width = (row: number): number => points[(row * (CAPE.cols + 1) + CAPE.cols) * 3]! - points[row * (CAPE.cols + 1) * 3]!;
    expect(width(0)).toBeCloseTo(CAPE.topWidth);
    expect(width(CAPE.rows)).toBeCloseTo(CAPE.hemWidth);
  });

  it('never comes forward into the robot, however it moves: behind its back, and behind its arms round the sides', () => {
    for (const input of [HOVER, { ...HOVER, speed: 5, turnRate: -2, climb: 3, t: 7.7 }, { ...HOVER, climb: 10, t: 0.2 }]) {
      const points = capePoints(capePose(input));
      for (let k = 0; k < points.length; k += 3) {
        const limit = Math.abs(points[k]!) <= CAPE.backHalfWidth ? -CAPE.clearance : CAPE.wrapLimit;
        expect(points[k + 2]).toBeLessThanOrEqual(limit + 1e-6);
      }
    }
  });

  it('wraps its top corners forward round the shoulders', () => {
    const points = capePoints(capePose({ ...HOVER, reducedMotion: true }));
    const corner = points[2]!;
    const middle = points[(CAPE.cols / 2) * 3 + 2]!;
    expect(corner).toBeGreaterThan(middle + 0.02);
  });

  it('ripples while it moves, not when still, and fills a buffer it is given', () => {
    const at = (t: number): Float32Array => capePoints(capePose({ ...HOVER, t }));
    expect(Array.from(at(0.5))).not.toEqual(Array.from(at(1.1)));
    const still = capePose({ ...HOVER, reducedMotion: true });
    expect(Array.from(capePoints(still))).toEqual(Array.from(capePoints(still)));
    const buffer = new Float32Array(count);
    expect(capePoints(still, buffer)).toBe(buffer);
    expect(capePoints(still, new Float32Array(3))).toHaveLength(count);
  });
});
