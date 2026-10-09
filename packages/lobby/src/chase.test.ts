import { describe, expect, it } from 'vitest';

import { CAMERA_LIMITS } from './camera.js';
import {
  CAMERA_VIEWS,
  CAMERA_VIEW_STORAGE_ITEM,
  THIRD_PERSON,
  boomOffset,
  chaseCamera,
  clearAt,
  nextCameraView,
  parseCameraView,
} from './chase.js';

const EYE = { x: 0, y: 1.7, z: 0 };

describe('boomOffset', () => {
  it('sits behind, above and to the right of a member looking down −Z', () => {
    const offset = boomOffset(0, 0);
    expect(offset.x).toBeCloseTo(THIRD_PERSON.side);
    expect(offset.y).toBeCloseTo(THIRD_PERSON.up);
    expect(offset.z).toBeCloseTo(THIRD_PERSON.back);
  });

  it('swings round with the heading: facing +X (yaw π/2) puts it at −X, right is +Z', () => {
    const offset = boomOffset(Math.PI / 2, 0);
    expect(offset.x).toBeCloseTo(-THIRD_PERSON.back);
    expect(offset.z).toBeCloseTo(THIRD_PERSON.side);
  });

  it('rises when the member looks down, and its pitch is held to the boom’s range', () => {
    expect(boomOffset(0, 0.5).y).toBeGreaterThan(boomOffset(0, 0).y);
    expect(boomOffset(0, 3)).toEqual(boomOffset(0, THIRD_PERSON.maxPitch));
    expect(boomOffset(0, -3)).toEqual(boomOffset(0, THIRD_PERSON.minPitch));
  });

  it('takes no shoulder when asked: straight in front of a member turned round', () => {
    const offset = boomOffset(Math.PI, 0, 0);
    expect(offset.x).toBeCloseTo(0);
    expect(offset.z).toBeCloseTo(-THIRD_PERSON.back);
  });

  it('treats a non-finite heading or pitch as zero', () => {
    expect(boomOffset(Number.NaN, Number.POSITIVE_INFINITY)).toEqual(boomOffset(0, 0));
  });
});

describe('clearAt', () => {
  it('is clear in open space, and not past the wall, under the floor or in a body', () => {
    expect(clearAt({ x: 0, y: 2, z: 0 }, [])).toBe(true);
    expect(clearAt({ x: CAMERA_LIMITS.radius + THIRD_PERSON.wallMargin + 0.1, y: 2, z: 0 }, [])).toBe(false);
    expect(clearAt({ x: 0, y: 0.1, z: 0 }, [])).toBe(false);
    expect(clearAt({ x: 0, y: 1.5, z: 0 }, [{ x: 0.2, y: 1.7, z: 0 }])).toBe(false);
    expect(clearAt({ x: 0, y: 5, z: 0 }, [{ x: 0, y: 1.7, z: 0 }])).toBe(true);
  });
});

describe('chaseCamera', () => {
  it('puts the boom all the way out in open space', () => {
    const chase = chaseCamera(EYE, 0, 0);
    expect(chase.fraction).toBe(1);
    expect(chase.position.z).toBeCloseTo(THIRD_PERSON.back);
    expect(chase.position.y).toBeCloseTo(EYE.y + THIRD_PERSON.up);
  });

  it('shortens the boom with its back to the wall, staying inside the cave', () => {
    const eye = { x: 0, y: 1.7, z: CAMERA_LIMITS.radius };
    const chase = chaseCamera(eye, 0, 0);
    expect(chase.fraction).toBeLessThan(1);
    expect(Math.hypot(chase.position.x, chase.position.z)).toBeLessThanOrEqual(CAMERA_LIMITS.radius + THIRD_PERSON.wallMargin);
  });

  it('stays above the floor looking up', () => {
    const chase = chaseCamera(EYE, 0, THIRD_PERSON.minPitch);
    expect(chase.position.y).toBeGreaterThanOrEqual(THIRD_PERSON.floor);
  });

  it('stops short of someone standing behind', () => {
    const chase = chaseCamera(EYE, 0, 0, [{ x: 0.4, y: 2.2, z: 2 }]);
    expect(chase.fraction).toBeLessThan(0.7);
    expect(clearAt(chase.position, [{ x: 0.4, y: 2.2, z: 2 }])).toBe(true);
  });

  it('is never shorter than its minimum, however tight', () => {
    const chase = chaseCamera(EYE, 0, 0, [{ x: 0, y: 1.7, z: 0.3 }]);
    expect(chase.fraction).toBe(THIRD_PERSON.minFraction);
  });
});

describe('parseCameraView', () => {
  it('reads the views it knows, and nothing else', () => {
    for (const view of CAMERA_VIEWS) expect(parseCameraView(view)).toBe(view);
    expect(parseCameraView(null)).toBeNull();
    expect(parseCameraView('THIRD')).toBeNull();
    expect(parseCameraView('second')).toBeNull();
    expect(CAMERA_VIEW_STORAGE_ITEM).toBe('forge.lobby.view.v1');
  });
});

describe('nextCameraView', () => {
  it('steps first, third, front and round again', () => {
    expect(nextCameraView('first')).toBe('third');
    expect(nextCameraView('third')).toBe('front');
    expect(nextCameraView('front')).toBe('first');
  });
});
