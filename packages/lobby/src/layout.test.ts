import { describe, expect, it } from 'vitest';

import {
  WALL,
  deriveWall,
  isGridSlot,
  isSlotIndex,
  sameSlot,
  slotFromIndex,
  slotIndex,
  slotPose,
  validateWall,
} from './layout.js';
import type { WallSpec } from './layout.js';

const SLOTS = WALL.columns * WALL.rows;
const close = (value: number, expected: number): void => expect(value).toBeCloseTo(expected, 9);

describe('WALL', () => {
  it('is the prototype cave: 32 columns, 90 rows, radius 28, floor gap 0.3, eye 1.7', () => {
    expect(WALL.columns).toBe(32);
    expect(WALL.rows).toBe(90);
    expect(WALL.radius).toBe(28);
    expect(WALL.y0).toBe(0.3);
    expect(WALL.eye).toBe(1.7);
  });

  it('derives the panel size and the ring from the radius and column count', () => {
    close(WALL.panelWidth, 2 * 28 * Math.sin(Math.PI / 32));
    close(WALL.panelHeight, (WALL.panelWidth * 9) / 16);
    close(WALL.ringRadius, 28 * Math.cos(Math.PI / 32));
    // About 5.49 m × 3.09 m, standing 27.87 m from the axis.
    expect(WALL.panelWidth).toBeCloseTo(5.48896, 5);
    expect(WALL.panelHeight).toBeCloseTo(3.08754, 5);
    expect(WALL.ringRadius).toBeCloseTo(27.86517, 5);
  });

  it('is frozen, and passes its own validation', () => {
    expect(Object.isFrozen(WALL)).toBe(true);
    expect(() => validateWall()).not.toThrow();
    expect(() => validateWall(WALL)).not.toThrow();
  });
});

describe('slot indices', () => {
  it('number 2,880 slots, 0 to 2,879', () => {
    expect(SLOTS).toBe(2880);
    expect(isSlotIndex(0)).toBe(true);
    expect(isSlotIndex(2879)).toBe(true);
    for (const value of [2880, -1, 1.5, Number.NaN, Infinity, -0.5, '3', null, undefined, {}]) {
      expect(isSlotIndex(value)).toBe(false);
    }
  });

  it('run around the ring first, then up a row: index = row·32 + col', () => {
    expect(slotIndex({ col: 0, row: 0 })).toBe(0);
    expect(slotIndex({ col: 31, row: 0 })).toBe(31);
    expect(slotIndex({ col: 0, row: 1 })).toBe(32);
    expect(slotIndex({ col: 5, row: 2 })).toBe(69);
    expect(slotIndex({ col: 31, row: 89 })).toBe(2879);
    expect(slotFromIndex(69)).toEqual({ col: 5, row: 2 });
    expect(slotFromIndex(2879)).toEqual({ col: 31, row: 89 });
  });

  it('round-trip for every slot on the wall', () => {
    for (let index = 0; index < SLOTS; index += 1) {
      const slot = slotFromIndex(index);
      expect(isGridSlot(slot)).toBe(true);
      expect(slotIndex(slot)).toBe(index);
    }
    for (let row = 0; row < WALL.rows; row += 1) {
      for (let col = 0; col < WALL.columns; col += 1) {
        expect(slotFromIndex(slotIndex({ col, row }))).toEqual({ col, row });
      }
    }
  });

  it('throw a RangeError for anything off the wall', () => {
    for (const slot of [
      { col: 32, row: 0 },
      { col: -1, row: 0 },
      { col: 0, row: 90 },
      { col: 0, row: -1 },
      { col: 1.5, row: 0 },
      { col: Number.NaN, row: 0 },
    ]) {
      expect(isGridSlot(slot)).toBe(false);
      expect(() => slotIndex(slot)).toThrow(RangeError);
    }
    expect(() => slotIndex({ col: 32, row: 0 })).toThrow(/col 32, row 0 is not on the 32×90 wall/);
    for (const index of [2880, -1, 0.5, Number.NaN]) {
      expect(() => slotFromIndex(index)).toThrow(RangeError);
      expect(() => slotPose(index)).toThrow(RangeError);
    }
    expect(() => slotFromIndex(2880)).toThrow(/2880 is not a slot index on the 32×90 wall/);
  });
});

describe('slotPose', () => {
  it('puts every panel on the ring, facing inward', () => {
    for (let index = 0; index < SLOTS; index += 1) {
      const { position, rotationY } = slotPose(index);
      const [x, , z] = position;
      close(Math.hypot(x, z), WALL.ringRadius);
      // PlaneGeometry's front face is +Z; rotation.y = r turns it to (sin r, 0, cos r).
      const normal = [Math.sin(rotationY), Math.cos(rotationY)] as const;
      const towardAxis = [-x / WALL.ringRadius, -z / WALL.ringRadius] as const;
      close(normal[0] * towardAxis[0] + normal[1] * towardAxis[1], 1);
    }
  });

  it('follows the contract: column angle th = col·2π/32, rotation −th, rows edge to edge from y0', () => {
    for (const index of [0, 1, 8, 16, 24, 31, 32, 100, 2879]) {
      const { col, row } = slotFromIndex(index);
      const th = (col * 2 * Math.PI) / 32;
      const { position, rotationY } = slotPose(index);
      close(position[0], Math.sin(th) * WALL.ringRadius);
      close(position[1], 0.3 + WALL.panelHeight / 2 + row * WALL.panelHeight);
      close(position[2], -Math.cos(th) * WALL.ringRadius);
      close(rotationY, -th);
    }
  });

  it('starts straight ahead down −Z on the floor row, and turns right around the ring', () => {
    const first = slotPose(0);
    expect(first.position[0]).toBe(0);
    close(first.position[1], 0.3 + WALL.panelHeight / 2);
    close(first.position[2], -WALL.ringRadius);
    expect(Object.is(first.rotationY, -0)).toBe(false);
    expect(first.rotationY).toBe(0);
    // Column 8 is a quarter turn to the right: +X.
    const right = slotPose(8).position;
    close(right[0], WALL.ringRadius);
    close(right[2], 0);
    close(slotPose(32).position[1] - slotPose(0).position[1], WALL.panelHeight);
  });

  it('closes the ring: neighbouring panels meet exactly at the cave radius', () => {
    const half = WALL.panelWidth / 2;
    close(Math.hypot(WALL.ringRadius, half), WALL.radius);
  });
});

describe('sameSlot', () => {
  it('matches rows exactly and columns once wrapped around the ring', () => {
    expect(sameSlot({ col: 0, row: 0 }, { col: 0, row: 0 })).toBe(true);
    expect(sameSlot({ col: 32, row: 4 }, { col: 0, row: 4 })).toBe(true);
    expect(sameSlot({ col: -1, row: 4 }, { col: 31, row: 4 })).toBe(true);
    expect(sameSlot({ col: 0, row: 0 }, { col: 0, row: 1 })).toBe(false);
    expect(sameSlot({ col: 1, row: 0 }, { col: 0, row: 0 })).toBe(false);
  });
});

describe('validateWall', () => {
  const wall = (overrides: Partial<WallSpec>): WallSpec => ({ ...WALL, ...overrides });

  it('accepts any wall derived from sound inputs', () => {
    expect(() => validateWall(deriveWall({ columns: 12, rows: 7, radius: 14, y0: 0, eye: 1.6 }))).not.toThrow();
    expect(() => validateWall(deriveWall({ columns: 3, rows: 1, radius: 1, y0: 2, eye: 0.1 }))).not.toThrow();
  });

  it('rejects impossible grids and sizes, naming every problem', () => {
    expect(() => validateWall(wall({ columns: 2 }))).toThrow(/columns must be a whole number of at least 3/);
    expect(() => validateWall(wall({ columns: 31.5 }))).toThrow(/columns must be a whole number/);
    expect(() => validateWall(wall({ rows: 0 }))).toThrow(/rows must be a whole number of at least 1/);
    expect(() => validateWall(wall({ radius: 0 }))).toThrow(/radius must be a positive number/);
    expect(() => validateWall(wall({ radius: Number.NaN }))).toThrow(/radius must be a positive number/);
    expect(() => validateWall(wall({ eye: -1 }))).toThrow(/eye must be a positive number/);
    expect(() => validateWall(wall({ y0: -0.1 }))).toThrow(/y0 must be a number of at least 0/);
    expect(() => validateWall(wall({ y0: Infinity }))).toThrow(/y0 must be a number of at least 0/);
    expect(() => validateWall(wall({ columns: 1, rows: 0.5 }))).toThrow(/columns .*; rows /);
  });

  it('rejects derived sizes that drifted from their formulas', () => {
    expect(() => validateWall(wall({ panelWidth: 5.5 }))).toThrow(/panelWidth must be/);
    expect(() => validateWall(wall({ panelHeight: WALL.panelWidth / 2 }))).toThrow(/panelHeight must be/);
    expect(() => validateWall(wall({ ringRadius: 28 }))).toThrow(/ringRadius must be/);
    expect(() => validateWall(wall({ ringRadius: Number.NaN }))).toThrow(/ringRadius must be/);
    // A 16:9 panel on a 12-column wall is not this wall's panel.
    expect(() => validateWall(wall({ columns: 12 }))).toThrow(/panelWidth must be .*; panelHeight must be .*; ringRadius must be/);
  });
});
