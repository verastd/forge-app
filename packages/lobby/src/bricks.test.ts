import { describe, expect, it } from 'vitest';

import {
  BRICK,
  BRICK_COLORS,
  BRICK_PROBLEM_TEXT,
  BRICK_SHAPES,
  aimBrick,
  brickBox,
  brickCells,
  brickFrozen,
  brickProblem,
  brickShape,
  brickStuds,
  brickUnderRay,
  bricksConnected,
  bricksOverlap,
  floorSpot,
  nextRot,
  rayBox,
} from './bricks.js';
import type { BrickAt } from './bricks.js';

const at = (shape: string, x: number, y: number, z: number, rot: 0 | 1 | 2 | 3 = 0): BrickAt => ({ shape, x, y, z, rot });

describe('shapes and colours', () => {
  it('has nine shapes for keys 1–9 and a dozen colours', () => {
    expect(BRICK_SHAPES).toHaveLength(9);
    expect(BRICK_COLORS).toHaveLength(12);
    expect(new Set(BRICK_SHAPES.map((s) => s.id)).size).toBe(9);
    expect(brickShape('brick-2x4')).toMatchObject({ sx: 4, sz: 2, h: 3 });
    expect(brickShape('nope')).toBeNull();
    expect(BRICK.plate * 3).toBeCloseTo(BRICK.stud * 1.2);
  });
});

describe('cells and studs', () => {
  it('covers its footprint, turned', () => {
    expect(brickCells(at('brick-1x2', 0, 0, 0)).sort()).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(brickCells(at('brick-1x2', 0, 0, 0, 1)).sort()).toEqual([
      [0, 0],
      [0, 1],
    ]);
    for (const rot of [0, 1, 2, 3] as const) expect(brickCells(at('brick-2x4', 5, 0, 5, rot))).toHaveLength(8);
    expect(brickCells(at('nope', 0, 0, 0))).toEqual([]);
    expect(brickStuds(at('nope', 0, 0, 0))).toEqual([]);
  });

  it('a slope has studs only along its high row, wherever it faces', () => {
    for (const rot of [0, 1, 2, 3] as const) {
      const slope = at('slope-2x2', 0, 0, 0, rot);
      expect(brickStuds(slope)).toHaveLength(2);
      expect(brickCells(slope)).toHaveLength(4);
    }
    expect(brickStuds(at('brick-2x2', 0, 0, 0))).toHaveLength(4);
  });
});

describe('overlap and fastening', () => {
  it('overlaps only sharing space', () => {
    expect(bricksOverlap(at('brick-2x2', 0, 0, 0), at('brick-2x2', 1, 0, 1))).toBe(true);
    expect(bricksOverlap(at('brick-2x2', 0, 0, 0), at('brick-2x2', 2, 0, 0))).toBe(false);
    expect(bricksOverlap(at('brick-2x2', 0, 0, 0), at('brick-2x2', 0, 3, 0))).toBe(false);
    expect(bricksOverlap(at('plate-2x2', 0, 0, 0), at('plate-2x2', 0, 1, 0))).toBe(false);
  });

  it('fastens stud to tube, above or below, on any shared column', () => {
    const base = at('brick-2x4', 0, 0, 0);
    expect(bricksConnected(base, at('brick-1x1', 3, 3, 1))).toBe(true);
    expect(bricksConnected(at('brick-1x1', 3, 3, 1), base)).toBe(true);
    expect(bricksConnected(base, at('brick-1x1', 4, 3, 1))).toBe(false);
    expect(bricksConnected(base, at('brick-1x1', 0, 4, 0))).toBe(false);
    // On a slope's sloped side there's nothing to fasten to.
    const slope = at('slope-2x2', 0, 0, 0);
    expect(bricksConnected(slope, at('brick-1x1', 0, 3, 0))).toBe(true);
    expect(bricksConnected(slope, at('brick-1x1', 0, 3, 1))).toBe(false);
  });
});

describe('brickProblem', () => {
  const floor = at('brick-2x4', 0, 0, 0);

  it('takes the floor, and studs', () => {
    expect(brickProblem(floor, [])).toBeNull();
    expect(brickProblem(at('brick-2x2', 1, 3, 0), [floor])).toBeNull();
    // Hanging under a brick is fastened too.
    expect(brickProblem(at('plate-2x2', 0, 2, 0), [at('brick-2x2', 0, 3, 0)])).toBeNull();
  });

  it('refuses overlapping, floating, out of the circle, too high, odd shapes and turns', () => {
    expect(brickProblem(at('brick-2x2', 1, 0, 0), [floor])).toBe('overlap');
    expect(brickProblem(at('brick-2x2', 10, 3, 10), [floor])).toBe('floating');
    expect(brickProblem(at('brick-1x1', 200, 0, 0), [])).toBe('outside');
    expect(brickProblem(at('brick-1x1', 0, -1, 0), [])).toBe('outside');
    expect(brickProblem(at('brick-1x1', 0, BRICK.maxPlates - 2, 0), [])).toBe('outside');
    expect(brickProblem(at('brick-1x1', 0.5, 0, 0), [])).toBe('outside');
    expect(brickProblem(at('nope', 0, 0, 0), [])).toBe('shape');
    expect(brickProblem({ ...floor, rot: 5 as 0 }, [])).toBe('shape');
    for (const problem of ['shape', 'outside', 'overlap', 'floating'] as const) expect(BRICK_PROBLEM_TEXT[problem]).toBeTruthy();
  });
});

describe('brickFrozen', () => {
  it('is loose alone and frozen once something is fastened to it', () => {
    const base = at('brick-2x4', 0, 0, 0);
    const top = at('brick-2x2', 0, 3, 0);
    expect(brickFrozen(base, [base])).toBe(false);
    expect(brickFrozen(base, [base, top])).toBe(true);
    expect(brickFrozen(top, [base, top])).toBe(true);
    expect(brickFrozen(base, [base, at('brick-2x2', 10, 0, 10)])).toBe(false);
  });
});

describe('aiming', () => {
  const down = (x: number, z: number): { origin: [number, number, number]; dir: [number, number, number] } => ({ origin: [x, 2, z], dir: [0, -1, 0] });

  it('finds the box a ray meets, and its face', () => {
    expect(rayBox(down(0.1, 0.1), [0, 0, 0], [1, 1, 1])).toEqual({ t: 1, normal: [0, 1, 0] });
    expect(rayBox(down(5, 5), [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(rayBox({ origin: [-2, 0.5, 0.5], dir: [1, 0, 0] }, [0, 0, 0], [1, 1, 1])).toEqual({ t: 2, normal: [-1, 0, 0] });
    expect(rayBox({ origin: [0.5, 0.5, 0.5], dir: [1, 0, 0] }, [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(rayBox({ origin: [2, 0.5, 0.5], dir: [1, 0, 0] }, [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(rayBox({ origin: [2, 0.5, 0.5], dir: [0, 1, 0] }, [0, 0, 0], [1, 1, 1])).toBeNull();
  });

  it('puts a brick on the floor where it points, centred on that cell', () => {
    const aimed = aimBrick(down(0.5, 0.5), 'brick-2x4', 0, []);
    expect(aimed).toEqual({ shape: 'brick-2x4', x: 1, y: 0, z: 2, rot: 0 });
    expect(aimBrick({ origin: [0, 2, 0], dir: [0, 1, 0] }, 'brick-1x1', 0, [])).toBeNull();
    expect(aimBrick({ origin: [0, 50, 0], dir: [0, -1, 0] }, 'brick-1x1', 0, [])).toBeNull();
    expect(aimBrick(down(0, 0), 'nope', 0, [])).toBeNull();
  });

  it('puts a brick on top of what it points at, beside a side it points at, under an underside', () => {
    const base = at('brick-2x4', 0, 0, 0);
    expect(aimBrick(down(0.1, 0.1), 'brick-1x1', 0, [base])).toEqual({ shape: 'brick-1x1', x: 0, y: 3, z: 0, rot: 0 });
    const side = aimBrick({ origin: [-1, 0.1, 0.1], dir: [1, 0, 0] }, 'brick-1x1', 0, [base]);
    expect(side).toEqual({ shape: 'brick-1x1', x: -1, y: 0, z: 0, rot: 0 });
    const raised = at('brick-2x2', 0, 6, 0);
    const under = aimBrick({ origin: [0.1, 0.1, 0.1], dir: [0, 1, 0] }, 'plate-2x2', 0, [raised]);
    expect(under).toEqual({ shape: 'plate-2x2', x: 0, y: 5, z: 0, rot: 0 });
  });

  it('finds the brick under the ray, the nearest, within reach', () => {
    const near = at('brick-1x1', 0, 3, 0);
    const far = at('brick-1x1', 0, 0, 0);
    expect(brickUnderRay(down(0.1, 0.1), [far, near])?.brick).toBe(near);
    expect(brickUnderRay(down(0.1, 0.1), [far, near], 0.5)).toBeNull();
    expect(brickBox(near).min[1]).toBeCloseTo(3 * BRICK.plate);
  });
});

describe('dropping', () => {
  it('lands where you stand, or the nearest free spot', () => {
    expect(floorSpot('brick-1x1', 0, 0.1, 0.1, [])).toEqual({ shape: 'brick-1x1', x: 0, y: 0, z: 0, rot: 0 });
    const spot = floorSpot('brick-1x1', 0, 0.1, 0.1, [at('brick-1x1', 0, 0, 0)]);
    expect(spot).not.toBeNull();
    expect(Math.max(Math.abs(spot!.x), Math.abs(spot!.z))).toBe(1);
    expect(floorSpot('brick-1x1', 0, 999, 999, [])).toBeNull();
  });

  it('turns a quarter at a time, round and round', () => {
    expect([nextRot(0), nextRot(1), nextRot(2), nextRot(3)]).toEqual([1, 2, 3, 0]);
  });
});
