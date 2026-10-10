import { describe, expect, it } from 'vitest';

import {
  MACHINE,
  MACHINE_PROBLEM_TEXT,
  aimFloor,
  buildOrder,
  buildTime,
  machineAngle,
  machineExtent,
  machineFootprint,
  machineParts,
  machineProblem,
  machineUnderRay,
  partFrame,
  partGap,
  partStart,
} from './machine.js';
import type { MachineMesh, MachinePart, MachineSpot } from './machine.js';

/** A box as 8 shared corners and 12 triangles. */
function box(cx: number, cy: number, cz: number, s: number): MachineMesh {
  const h = s / 2;
  const positions: number[] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) positions.push(cx + x, cy + y, cz + z);
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const index = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  return { positions, index };
}

/** Several meshes as one (indices shifted): a fused model with pieces that share no vertex. */
function fuse(meshes: MachineMesh[]): MachineMesh {
  const positions: number[] = [];
  const index: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...Array.from(mesh.positions));
    index.push(...Array.from(mesh.index!).map((i) => i + base));
  }
  return { positions, index };
}

/** A flat grid of n×n squares (2n² triangles), all one piece, unindexed. */
function sheet(n: number, size: number): MachineMesh {
  const positions: number[] = [];
  const step = size / n;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const [x0, x1, z0, z1] = [i * step, (i + 1) * step, j * step, (j + 1) * step];
      positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
    }
  }
  return { positions, index: null };
}

const engine: MachineSpot = { size: [2, 1.5, 3], x: 1, z: -2, turn: 0, scale: 1 };

describe('where a machine may stand (mirrored by apps/api machine_rules.py)', () => {
  it('scales its longest side to MACHINE.size times its scale', () => {
    const [w, h, d] = machineExtent([2, 1.5, 3], 1);
    expect([w, h, d].map((v) => +v.toFixed(6))).toEqual([0.8, 0.6, 1.2]);
    expect(machineExtent([2, 1.5, 3], 2)[2]).toBeCloseTo(2.4);
  });

  it('turns its footprint', () => {
    const box0 = machineFootprint(engine);
    expect([box0.minX, box0.maxX, box0.minZ, box0.maxZ].map((v) => +v.toFixed(6))).toEqual([0.6, 1.4, -2.6, -1.4]);
    const quarter = machineFootprint({ ...engine, x: 0, z: 0, turn: 6 });
    expect(quarter.maxX).toBeCloseTo(0.6);
    expect(quarter.maxZ).toBeCloseTo(0.4);
    expect(machineFootprint({ ...engine, x: 0, z: 0, turn: 3 }).maxX).toBeCloseTo(0.70710678);
    expect(machineAngle(6)).toBeCloseTo(Math.PI / 2);
  });

  it('stays inside, off other machines and off bricks', () => {
    expect(machineProblem(engine, [], [])).toBeNull();
    expect(machineProblem({ size: [1, 1, 1], x: 23.5, z: 0, turn: 0, scale: 1 }, [], [])).toBe('outside');
    expect(machineProblem({ ...engine, x: 1.8 }, [engine], [])).toBeNull();
    expect(machineProblem(engine, [engine], [])).toBe('overlap');
    expect(machineProblem(engine, [], [{ shape: 'brick-1x1', x: 5, y: 0, z: -10, rot: 0 }])).toBe('bricks');
    expect(machineProblem(engine, [], [{ shape: 'brick-1x1', x: 50, y: 0, z: 50, rot: 0 }])).toBeNull();
    expect(MACHINE_PROBLEM_TEXT.bricks).toMatch(/Bricks/);
  });
});

describe('aiming', () => {
  it('finds the floor within reach', () => {
    expect(aimFloor({ origin: [0, 2, 0], dir: [0, -Math.SQRT1_2, Math.SQRT1_2] })).toEqual({ x: 0, z: expect.closeTo(2) });
    expect(aimFloor({ origin: [0, 2, 0], dir: [0, 1, 0] })).toBeNull();
    expect(aimFloor({ origin: [0, 2, 0], dir: [0, -0.01, 0.99995] })).toBeNull();
    expect(aimFloor({ origin: [0, -1, 0], dir: [0, -1, 0] })).toBeNull();
  });

  it('finds the nearest machine a ray hits', () => {
    const near = { ...engine, x: 0, z: 2 };
    const far = { ...engine, x: 0, z: 5 };
    const ray = { origin: [0, 0.3, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number] };
    expect(machineUnderRay(ray, [far, near])).toBe(near);
    expect(machineUnderRay(ray, [far, near], 1)).toBeNull();
    expect(machineUnderRay({ origin: [0, 0.3, 0], dir: [0, 0, -1] }, [near])).toBeNull();
  });
});

describe('a model’s parts', () => {
  it('has none when there are no triangles', () => {
    const split = machineParts([{ positions: [], index: [] }]);
    expect(split.parts).toEqual([]);
    expect(split.triangleParts[0]!.length).toBe(0);
  });

  it('keeps a model’s own pieces, one part each', () => {
    const meshes = Array.from({ length: 9 }, (_, i) => box(i * 2, 0, 0, 1));
    const split = machineParts(meshes);
    expect(split.parts).toHaveLength(9);
    expect(split.triangleParts.map((parts) => [...new Set(parts)])).toEqual(meshes.map((_, i) => [i]));
    expect(split.parts[3]!.centre.x).toBeCloseTo(6);
    expect(split.parts[3]!.min).toEqual({ x: 5.5, y: -0.5, z: -0.5 });
    expect(split.parts[3]!.triangles).toBe(12);
  });

  it('splits a fused model where it falls apart', () => {
    const split = machineParts([fuse(Array.from({ length: 10 }, (_, i) => box(i * 2, 0, 0, 1)))]);
    expect(split.parts).toHaveLength(10);
    expect(new Set(split.triangleParts[0]).size).toBe(10);
  });

  it('puts crumbs with their nearest neighbour', () => {
    const meshes = [...Array.from({ length: 8 }, (_, i) => box(i * 2, 0, 0, 1)), box(14.6, 0, 0, 0.05)];
    const split = machineParts(meshes);
    expect(split.parts).toHaveLength(8);
    // The crumb by the last box joins it.
    expect([...new Set(split.triangleParts[8])]).toEqual([...new Set(split.triangleParts[7])]);
    expect(split.parts[7]!.triangles).toBe(24);
    expect(split.parts[7]!.max.x).toBeCloseTo(14.625);
  });

  it('never has more than MACHINE.maxParts', () => {
    // 42 boxes in a 7×6 grid: none is a crumb, but there are too many.
    const split = machineParts(Array.from({ length: 42 }, (_, i) => box((i % 7) * 1.5, 0, Math.floor(i / 7) * 1.5, 1)));
    expect(split.parts).toHaveLength(MACHINE.maxParts);
    expect(split.parts.reduce((n, p) => n + p.triangles, 0)).toBe(504);
  });

  it('cuts a single fused piece into chunks', () => {
    const split = machineParts([sheet(12, 3)]);
    expect(split.parts).toHaveLength(MACHINE.minParts);
    expect(split.parts.reduce((n, p) => n + p.triangles, 0)).toBe(288);
    // Deterministic.
    expect(machineParts([sheet(12, 3)]).triangleParts[0]).toEqual(split.triangleParts[0]);
  });

  it('leaves a piece whole when it can’t be cut', () => {
    // Too few triangles to cut.
    expect(machineParts([{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], index: null }]).parts).toHaveLength(1);
    // Every triangle in the same spot: one chunk.
    const same = Array.from({ length: 20 }, () => [0, 0, 0, 1, 0, 0, 0, 1, 0]).flat();
    expect(machineParts([{ positions: same, index: null }]).parts).toHaveLength(1);
    // A part made of merged pieces isn't cut.
    const merged = machineParts([box(0, 0, 0, 1), box(0.7, 0, 0, 0.02)]);
    expect(merged.parts).toHaveLength(1);
  });
});

function part(minY: number, maxY: number, size: number): MachinePart {
  return {
    min: { x: 0, y: minY, z: 0 },
    max: { x: size, y: maxY, z: size },
    centre: { x: size / 2, y: (minY + maxY) / 2, z: size / 2 },
    triangles: 12,
  };
}

describe('the build', () => {
  it('goes in bottom up, big before small', () => {
    expect(buildOrder([])).toEqual([]);
    const parts = [part(8, 10, 1), part(0, 4, 1), part(0, 2, 3), part(0, 2, 3), part(5, 9, 2)];
    expect(buildOrder(parts)).toEqual([2, 3, 1, 4, 0]);
    expect(buildOrder([part(0, 0, 1)])).toEqual([0]);
  });

  it('spaces parts out, never taking longer than MACHINE.buildMax', () => {
    expect(partGap(1)).toBe(MACHINE.gap);
    expect(partGap(10)).toBe(MACHINE.gap);
    expect(partStart(3, 10)).toBeCloseTo(3 * MACHINE.gap);
    expect(buildTime(400)).toBeCloseTo(MACHINE.buildMax);
    expect(buildTime(0)).toBeCloseTo(MACHINE.fly + MACHINE.snap);
  });

  it('flies a part from the ramp to its place, then snaps it in', () => {
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 2, y: 0.5, z: 0 };
    expect(partFrame(-1, from, to)).toEqual({ at: from, scale: MACHINE.startScale, spin: 0, phase: 'waiting' });
    const start = partFrame(0, from, to);
    expect(start.at).toEqual(from);
    expect(start.phase).toBe('flying');
    const mid = partFrame(MACHINE.fly / 2, from, to);
    expect(mid.at.y).toBeGreaterThan(1);
    expect(mid.scale).toBeGreaterThan(MACHINE.startScale);
    expect(mid.spin).toBeGreaterThan(0);
    const snap = partFrame(MACHINE.fly + MACHINE.snap / 2, from, to);
    expect(snap.phase).toBe('snapping');
    expect(snap.scale).toBeGreaterThan(1);
    expect(snap.at).toEqual(to);
    expect(partFrame(5, from, to)).toEqual({ at: to, scale: 1, spin: 0, phase: 'placed' });
  });
});
