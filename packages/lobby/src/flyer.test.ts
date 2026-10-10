import { describe, expect, it } from 'vitest';

import { FLYER, HEAD_FLYERS, flightArea, flightPose, flyerPhase, parseFlyer, roofAt, roofGrid } from './flyer.js';
import type { RoofGrid } from './flyer.js';

/** A 0.4 × 0.3 m top, floor at 0.3 m, with one tower (0.45 m) in the far-left cell. */
function city(): RoofGrid {
  const cols = 4;
  const rows = 3;
  const heights: (number | null)[] = new Array(cols * rows).fill(0.3);
  heights[0] = 0.45;
  return { min: [-0.2, -0.15], max: [0.2, 0.15], cols, rows, heights, top: 0.46 };
}

describe('flightArea', () => {
  it('flies over the middle of the top, above its tallest roof', () => {
    const area = flightArea(city())!;
    expect(area.center).toEqual([0, 0]);
    expect(area.halfX).toBeCloseTo(0.2 * FLYER.spread);
    expect(area.halfZ).toBeCloseTo(0.15 * FLYER.spread);
    expect(area.size).toBeCloseTo(0.075);
    expect(area.cruise).toBeGreaterThanOrEqual(0.45 + FLYER.clearance);
    // Kept in close: the whole loop spans at most 40% of the top, each way.
    expect(2 * area.halfX).toBeLessThanOrEqual(0.4 * 0.4);
    expect(2 * area.halfZ).toBeLessThanOrEqual(0.4 * 0.3);
  });

  it('keeps the helicopter a sensible size on a tiny or a huge head', () => {
    const tiny = flightArea({ ...city(), min: [-0.01, -0.01], max: [0.01, 0.01] })!;
    expect(tiny.size).toBe(FLYER.minSize);
    const huge = flightArea({ ...city(), min: [-5, -5], max: [5, 5] })!;
    expect(huge.size).toBe(FLYER.maxSize);
  });

  it('flies over the part of the top that is there, not its whole box', () => {
    // Only the left half (columns 0 and 1) has anything in it.
    const half = { ...city(), heights: city().heights.map((h, i) => (i % 4 < 2 ? h : null)) };
    const area = flightArea(half)!;
    expect(area.center[0]).toBeCloseTo(-0.1);
    expect(area.halfX).toBeCloseTo(0.1 * FLYER.spread);
    expect(area.halfZ).toBeCloseTo(0.15 * FLYER.spread);
  });

  it('with nothing measured, cruises above the model’s top', () => {
    const area = flightArea({ ...city(), heights: new Array(12).fill(null) })!;
    expect(area.cruise).toBeGreaterThan(0.46);
  });

  it('has nowhere to fly over a flat, empty or broken grid', () => {
    expect(flightArea({ ...city(), max: [-0.2, 0.15] })).toBeNull();
    expect(flightArea({ ...city(), min: [-0.2, 0.15] })).toBeNull();
    expect(flightArea({ ...city(), top: Number.NaN })).toBeNull();
  });
});

describe('flightPose', () => {
  const grid = city();
  const area = flightArea(grid)!;
  const times = Array.from({ length: 400 }, (_, i) => (i / 400) * FLYER.period * 2);

  it('stays inside its area, above the roofs', () => {
    for (const t of times) {
      const { position } = flightPose(area, grid, t, 1.1);
      expect(Math.abs(position[0] - area.center[0])).toBeLessThanOrEqual(area.halfX + 1e-9);
      expect(Math.abs(position[2] - area.center[1])).toBeLessThanOrEqual(area.halfZ + 1e-9);
      expect(position[1]).toBeGreaterThan(0.45);
    }
  });

  it('goes round and round: a period later it is back where it was', () => {
    const a = flightPose(area, grid, 2.5, 0.4);
    const b = flightPose(area, grid, 2.5 + FLYER.period, 0.4);
    expect(b.position[0]).toBeCloseTo(a.position[0]);
    expect(b.position[2]).toBeCloseTo(a.position[2]);
    expect(b.yaw).toBeCloseTo(a.yaw);
  });

  it('crosses itself in the middle: a figure-8, not a loop', () => {
    const start = flightPose(area, grid, 0).position;
    const half = flightPose(area, grid, FLYER.period / 2).position;
    expect(start[0]).toBeCloseTo(area.center[0]);
    expect(half[0]).toBeCloseTo(area.center[0]);
    expect(half[2]).toBeCloseTo(area.center[1]);
    // …and reaches both sides.
    expect(flightPose(area, grid, FLYER.period / 4).position[0]).toBeCloseTo(area.center[0] + area.halfX);
    expect(flightPose(area, grid, (FLYER.period * 3) / 4).position[0]).toBeCloseTo(area.center[0] - area.halfX);
  });

  it('points its nose the way it is going', () => {
    for (const t of [0.3, 1.7, 4.2, 6.6]) {
      const now = flightPose(area, grid, t).position;
      const soon = flightPose(area, grid, t + 0.01).position;
      const { yaw } = flightPose(area, grid, t);
      const going = Math.atan2(soon[0] - now[0], soon[2] - now[2]);
      expect(Math.abs(Math.atan2(Math.sin(yaw - going), Math.cos(yaw - going)))).toBeLessThan(0.05);
    }
  });

  it('banks into its turns, one way then the other, never past its most', () => {
    const banks = times.map((t) => flightPose(area, grid, t).bank);
    expect(Math.max(...banks)).toBeGreaterThan(0.05);
    expect(Math.min(...banks)).toBeLessThan(-0.05);
    for (const b of banks) expect(Math.abs(b)).toBeLessThanOrEqual(FLYER.maxBank);
    expect(flightPose(area, grid, 1).pitch).toBe(FLYER.lean);
  });

  it('shines on the roofs, within the top', () => {
    for (const t of times) {
      const { spot } = flightPose(area, grid, t, 2);
      expect(spot[0]).toBeGreaterThanOrEqual(grid.min[0]);
      expect(spot[0]).toBeLessThanOrEqual(grid.max[0]);
      expect(spot[2]).toBeGreaterThanOrEqual(grid.min[1]);
      expect(spot[2]).toBeLessThanOrEqual(grid.max[1]);
      expect(spot[1]).toBeCloseTo(roofAt(grid, spot[0], spot[2]));
    }
  });

  it('never shines on thin air: a pool that would land where nothing is moves to the nearest roof', () => {
    // A ring: everything measured but the middle two cells (a hole in the top).
    const ring = { ...city(), heights: city().heights.map((h, i) => (i === 5 || i === 6 ? null : h)) };
    const ringArea = flightArea(ring)!;
    for (let t = 0; t < 20; t += 0.25) {
      const { spot } = flightPose(ringArea, ring, t, 0.5);
      const col = Math.min(3, Math.floor(((spot[0] + 0.2) / 0.4) * 4));
      const row = Math.min(2, Math.floor(((spot[2] + 0.15) / 0.3) * 3));
      expect(ring.heights[row * 4 + col]).not.toBeNull();
    }
    // With nothing measured anywhere, it shines where it would have.
    const empty = { ...city(), heights: new Array(12).fill(null) };
    const { spot } = flightPose(flightArea(empty)!, empty, 1);
    expect(Number.isFinite(spot[0]) && Number.isFinite(spot[2])).toBe(true);
  });

  it('starts where its phase says, and copes with nonsense times', () => {
    const shifted = flightPose(area, grid, 0, Math.PI / 2).position;
    expect(shifted[0]).toBeCloseTo(area.center[0] + area.halfX);
    expect(flightPose(area, grid, Number.NaN, Number.NaN).position).toEqual(flightPose(area, grid, 0, 0).position);
  });
});

describe('roofAt', () => {
  const grid = city();

  it('is the measured height at a cell’s middle, and blends between', () => {
    expect(roofAt(grid, -0.15, -0.1)).toBeCloseTo(0.45);
    expect(roofAt(grid, 0.15, 0.1)).toBeCloseTo(0.3);
    const between = roofAt(grid, -0.1, -0.1);
    expect(between).toBeGreaterThan(0.3);
    expect(between).toBeLessThan(0.45);
  });

  it('off the grid, takes its nearest edge', () => {
    expect(roofAt(grid, -9, -9)).toBeCloseTo(0.45);
    expect(roofAt(grid, 9, 9)).toBeCloseTo(0.3);
  });

  it('where nothing was hit, the lowest roof; with nothing at all, the top', () => {
    const holes = { ...grid, heights: grid.heights.map((h, i) => (i === 11 ? null : h)) };
    expect(roofAt(holes, 0.15, 0.1)).toBeCloseTo(0.3);
    expect(roofAt({ ...grid, heights: new Array(12).fill(null) }, 0, 0)).toBe(0.46);
    expect(roofAt({ ...grid, cols: 0 }, 0, 0)).toBe(0.46);
    expect(roofAt({ ...grid, heights: [] }, 0, 0)).toBe(0.46);
  });
});

describe('flyerPhase and parseFlyer', () => {
  it('gives each robot its own, steady phase', () => {
    expect(flyerPhase('gh:1001')).toBe(flyerPhase('gh:1001'));
    expect(flyerPhase('gh:1001')).not.toBe(flyerPhase('gh:1002'));
    for (const id of ['', 'gh:1', 'practice-abc']) {
      expect(flyerPhase(id)).toBeGreaterThanOrEqual(0);
      expect(flyerPhase(id)).toBeLessThan(Math.PI * 2);
    }
  });

  it('knows the helicopter and nothing else', () => {
    expect([...HEAD_FLYERS]).toEqual(['helicopter']);
    expect(parseFlyer('helicopter')).toBe('helicopter');
    for (const raw of ['blimp', null, undefined, 3]) expect(parseFlyer(raw)).toBeNull();
  });
});

describe('roofGrid', () => {
  /** A flat square roof, `y` high over x, z in [lo, hi]: four corners, two triangles, as a box's top is. */
  function roof(lo: number, hi: number, y: number, at = 0): { positions: number[]; indices: number[] } {
    return {
      positions: [lo, y, lo, hi, y, lo, hi, y, hi, lo, y, hi],
      indices: [at, at + 1, at + 2, at, at + 2, at + 3],
    };
  }

  it('fills every cell under a roof that has points only at its corners', () => {
    const { positions, indices } = roof(-0.2, 0.2, 0.3);
    const grid = roofGrid(positions, indices, 4)!;
    expect(grid.min).toEqual([-0.2, -0.2]);
    expect(grid.max).toEqual([0.2, 0.2]);
    expect(grid.top).toBe(0.3);
    for (const h of grid.heights) expect(h).toBeCloseTo(0.3);
    // Without the triangles, only the corner cells know the roof.
    const corners = roofGrid(positions, null, 4)!;
    expect(corners.heights.filter((h) => h !== null)).toHaveLength(4);
  });

  it('lets a taller building win the cells it stands over', () => {
    const base = roof(-0.2, 0.2, 0.3);
    const tower = roof(-0.2, 0, 0.5, 4);
    const grid = roofGrid([...base.positions, ...tower.positions], [...base.indices, ...tower.indices], 4)!;
    // The tower covers the low-x, low-z quarter: cells (0..1, 0..1).
    expect(grid.heights[0]).toBeCloseTo(0.5);
    expect(grid.heights[1 * 4 + 1]).toBeCloseTo(0.5);
    expect(grid.heights[3 * 4 + 3]).toBeCloseTo(0.3);
    expect(roofAt(grid, -0.15, -0.15)).toBeCloseTo(0.5);
  });

  it('blends a slope’s height across its triangle', () => {
    // A ramp rising from 0 at x = −1 to 1 at x = 1.
    const grid = roofGrid([-1, 0, -1, 1, 1, -1, 1, 1, 1, -1, 0, 1], [0, 1, 2, 0, 2, 3], 4)!;
    // The middle cells hold no corner: their heights come from the triangles alone.
    expect(grid.heights[1 * 4 + 1]).toBeCloseTo(0.375);
    expect(grid.heights[1 * 4 + 2]).toBeCloseTo(0.625);
    // A corner cell keeps its corner (a point counts as it stands).
    expect(grid.heights[3]).toBe(1);
  });

  it('skips walls, broken triangles and broken points, and has nothing for no points', () => {
    const wall = [0, 0, 0, 0, 1, 0, 1, 0, 0];
    const grid = roofGrid([...wall, Number.NaN, 0, 0], [0, 1, 2, 0, 1, 9, 0, 1, -1, 0, 1, 3], 2)!;
    expect(grid.top).toBe(1);
    expect(roofGrid([], null)).toBeNull();
    expect(roofGrid([Number.NaN, 0, 0], null)).toBeNull();
    expect(roofGrid([0, 0, 0], null, 0)).toBeNull();
    // A single point: a grid of one spot, its height there.
    const dot = roofGrid([0.1, 0.4, 0.1], null)!;
    expect(dot.top).toBe(0.4);
    expect(dot.heights.filter((h) => h !== null)).toEqual([0.4]);
  });
});
