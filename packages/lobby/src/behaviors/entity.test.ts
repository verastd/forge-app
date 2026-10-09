import { describe, expect, it } from 'vitest';

import { CAMERA_LIMITS } from '../camera.js';
import { CELLS, ENTITY_ID, OWNER_ID, WORLD_OWNER, cellOf, isEntity, neighbours, resolveClaim } from './entity.js';
import type { Claim, Entity } from './entity.js';

const TOTAL = CELLS.sectors * CELLS.bands;

const ball: Entity = {
  id: 'ball:1',
  kind: 'ball',
  owner: 'gh:1',
  authority: 'owner',
  epoch: 0,
  pose: { x: 1, y: 1.6, z: -2 },
  persistent: false,
};

describe('ids', () => {
  it('an entity id is <kind>:<name>', () => {
    for (const id of ['ball:1', 'crate:k7Qx', 'a:b', 'sign-post:x_y-Z']) expect(ENTITY_ID.test(id)).toBe(true);
    for (const id of ['', 'ball', ':1', 'Ball:1', 'ball:', 'ball:a b', `ball:${'x'.repeat(33)}`, 'ball:1:2']) {
      expect(ENTITY_ID.test(id)).toBe(false);
    }
  });

  it('an owner is a room id or the world', () => {
    for (const id of ['gh:123', 'practice-0a1b2c', WORLD_OWNER]) expect(OWNER_ID.test(id)).toBe(true);
    for (const id of ['', 'gh 1', 'x'.repeat(65)]) expect(OWNER_ID.test(id)).toBe(false);
  });
});

describe('cellOf', () => {
  it('covers every cell exactly, by sector around the axis and band of height', () => {
    const seen = new Set<number>();
    for (let sector = 0; sector < CELLS.sectors; sector += 1) {
      const angle = ((sector + 0.5) / CELLS.sectors) * 2 * Math.PI;
      for (let band = 0; band < CELLS.bands; band += 1) {
        const y = ((band + 0.5) / CELLS.bands) * CAMERA_LIMITS.maxY;
        const cell = cellOf({ x: Math.sin(angle) * 10, y, z: -Math.cos(angle) * 10 });
        expect(cell).toBe(band * CELLS.sectors + sector);
        seen.add(cell);
      }
    }
    expect(seen.size).toBe(TOTAL);
  });

  it('is a cell for every pose, however far out, and cell 0 for a pose that is not a number', () => {
    for (const pose of [
      { x: 0, y: 0, z: 0 },
      { x: 1e6, y: -1e6, z: 1e6 },
      { x: 0, y: CAMERA_LIMITS.maxY, z: 0 },
      { x: 0, y: CAMERA_LIMITS.maxY * 5, z: 0 },
    ]) {
      const cell = cellOf(pose);
      expect(Number.isInteger(cell) && cell >= 0 && cell < TOTAL).toBe(true);
    }
    expect(cellOf({ x: NaN, y: Infinity, z: -Infinity })).toBe(0);
  });

  it('is the same for the same pose', () => {
    expect(cellOf(ball.pose)).toBe(cellOf({ ...ball.pose }));
  });
});

describe('neighbours', () => {
  it('is symmetric: a cell is its neighbour’s neighbour', () => {
    for (let cell = 0; cell < TOTAL; cell += 1) {
      for (const other of neighbours(cell)) {
        expect(neighbours(other)).toContain(cell);
      }
    }
  });

  it('wraps around the axis within a band and never includes the cell itself', () => {
    const band1 = CELLS.sectors;
    expect(neighbours(band1)).toEqual([0, 1, CELLS.sectors - 1, band1 + 1, band1 + CELLS.sectors - 1, 2 * CELLS.sectors, 2 * CELLS.sectors + 1, 3 * CELLS.sectors - 1]);
    for (let cell = 0; cell < TOTAL; cell += 1) {
      expect(neighbours(cell)).not.toContain(cell);
      expect(neighbours(cell).length).toBeLessThanOrEqual(8);
    }
  });

  it('a bottom or top band has no band below or above it', () => {
    expect(neighbours(0).every((cell) => cell < 2 * CELLS.sectors)).toBe(true);
    expect(neighbours(TOTAL - 1).every((cell) => cell >= TOTAL - 2 * CELLS.sectors)).toBe(true);
  });

  it('is empty for a cell that does not exist', () => {
    for (const cell of [-1, TOTAL, 1.5, NaN]) expect(neighbours(cell)).toEqual([]);
  });
});

describe('resolveClaim', () => {
  const a: Claim = { entity: 'ball:1', claimant: 'gh:1', epoch: 3 };
  const b: Claim = { entity: 'ball:1', claimant: 'gh:2', epoch: 3 };

  it('the later epoch wins', () => {
    expect(resolveClaim({ ...a, epoch: 4 }, b)).toEqual({ ...a, epoch: 4 });
    expect(resolveClaim(a, { ...b, epoch: 4 })).toEqual({ ...b, epoch: 4 });
  });

  it('at the same epoch the lower claimant id wins, whichever order they are heard in', () => {
    expect(resolveClaim(a, b)).toBe(a);
    expect(resolveClaim(b, a)).toBe(a);
  });

  it('identical claims are one claim', () => {
    expect(resolveClaim(a, { ...a })).toBe(a);
  });
});

describe('isEntity', () => {
  it('accepts a well-formed entity', () => {
    expect(isEntity(ball)).toBe(true);
    expect(isEntity({ ...ball, owner: WORLD_OWNER, authority: 'world', persistent: true })).toBe(true);
    expect(isEntity({ ...ball, owner: '' })).toBe(true);
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      null,
      'ball:1',
      { ...ball, id: 'crate:1' },
      { ...ball, id: 'Ball:1', kind: 'Ball' },
      { ...ball, owner: 'gh 1' },
      { ...ball, authority: 'me' },
      { ...ball, epoch: -1 },
      { ...ball, epoch: 1.5 },
      { ...ball, pose: { x: 1, y: NaN, z: 0 } },
      { ...ball, pose: null },
      { ...ball, persistent: 'no' },
    ];
    for (const value of bad) expect(isEntity(value)).toBe(false);
  });
});
