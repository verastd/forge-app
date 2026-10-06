import { describe, expect, it } from 'vitest';

import { CAMERA_LIMITS } from './camera.js';
import { BODY, collideBodies } from './collide.js';

const EYE = 5;
const still = { x: 0, y: 0, z: 0 };
const reach = 2 * BODY.radius;
const height = BODY.below + BODY.above;

describe('collideBodies', () => {
  it('leaves a member alone with nobody near', () => {
    const pos = { x: 1, y: EYE, z: 2 };
    const vel = { x: 3, y: 0, z: -1 };
    const bump = collideBodies(pos, vel, [{ x: 1 + reach + 0.01, y: EYE, z: 2 }, { x: 1, y: EYE + height + 0.01, z: 2 }]);
    expect(bump).toEqual({ pos, vel, hits: 0 });
  });

  it('pushes a member out sideways and bounces it back', () => {
    const bump = collideBodies({ x: 0.5, y: EYE, z: 0 }, { x: -4, y: 0, z: 0 }, [{ x: 0, y: EYE, z: 0 }]);
    expect(bump.hits).toBe(1);
    expect(bump.pos.x).toBeCloseTo(reach);
    expect(bump.pos.y).toBe(EYE);
    expect(bump.vel.x).toBeCloseTo(4 * BODY.restitution);
  });

  it('keeps the speed of a member already moving away, and the speed along the body', () => {
    const bump = collideBodies({ x: 0.5, y: EYE, z: 0 }, { x: 2, y: 0, z: 3 }, [{ x: 0, y: EYE, z: 0 }]);
    expect(bump.vel).toEqual({ x: 2, y: 0, z: 3 });
  });

  it('lands a member on top when over is the shorter way out', () => {
    const bump = collideBodies({ x: 0.1, y: EYE + height - 0.1, z: 0 }, { x: 0, y: -6, z: 0 }, [{ x: 0, y: EYE, z: 0 }]);
    expect(bump.pos.y).toBeCloseTo(EYE + height);
    expect(bump.pos.x).toBe(0.1);
    expect(bump.vel.y).toBeCloseTo(6 * BODY.restitution);
  });

  it('pushes a member under one hovering just above', () => {
    const bump = collideBodies({ x: 0, y: EYE, z: 0.1 }, still, [{ x: 0, y: EYE + height - 0.2, z: 0 }]);
    expect(bump.pos.y).toBeCloseTo(EYE - 0.2);
  });

  it('goes sideways rather than through the floor', () => {
    const floor = CAMERA_LIMITS.minY;
    const bump = collideBodies({ x: 0.85, y: floor, z: 0 }, still, [{ x: 0, y: floor + 0.5, z: 0 }]);
    expect(bump.pos.y).toBe(floor);
    expect(bump.pos.x).toBeCloseTo(reach);
  });

  it('takes the tie angle out of a body on the very same spot', () => {
    const here = { x: 0, y: EYE, z: 0 };
    const bump = collideBodies(here, still, [here], Math.PI / 2);
    expect(bump.pos.x).toBeCloseTo(0);
    expect(bump.pos.z).toBeCloseTo(reach);
    const other = collideBodies(here, still, [here]);
    expect(other.pos.x).toBeCloseTo(reach);
  });

  it('settles between two bodies in one call', () => {
    const bump = collideBodies({ x: 0, y: EYE, z: 0 }, still, [
      { x: -0.6, y: EYE, z: 0 },
      { x: 0.6, y: EYE, z: 0.2 },
    ]);
    expect(bump.hits).toBeGreaterThanOrEqual(2);
  });

  it('stays inside the cave when a body pushes it at the wall', () => {
    const edge = CAMERA_LIMITS.radius;
    const bump = collideBodies({ x: edge - 0.1, y: EYE, z: 0 }, still, [{ x: edge - 0.5, y: EYE, z: 0 }]);
    expect(Math.hypot(bump.pos.x, bump.pos.z)).toBeCloseTo(edge);
  });

  it('ignores bodies that are not numbers, and leaves a member that is not alone', () => {
    const pos = { x: 0, y: EYE, z: 0 };
    expect(collideBodies(pos, still, [{ x: Number.NaN, y: EYE, z: 0 }]).hits).toBe(0);
    const lost = collideBodies({ x: Number.NaN, y: EYE, z: 0 }, still, [pos]);
    expect(lost.hits).toBe(0);
    expect(Number.isNaN(lost.pos.x)).toBe(true);
    expect(collideBodies(pos, { x: Infinity, y: 0, z: 0 }, [pos]).hits).toBe(0);
  });

  it('never answers -0 and never changes what it was given', () => {
    const pos = { x: 0, y: EYE, z: 0.2 };
    const vel = { x: 0, y: 0, z: -1 };
    const bump = collideBodies(pos, vel, [{ x: 0, y: EYE, z: 0 }]);
    expect(Object.is(bump.pos.x, -0)).toBe(false);
    expect(Object.is(bump.vel.x, -0)).toBe(false);
    expect(pos).toEqual({ x: 0, y: EYE, z: 0.2 });
    expect(vel).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(BODY)).toBe(true);
  });
});
