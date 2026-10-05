import { describe, expect, it } from 'vitest';

import { CAMERA_LIMITS, CAMERA_SPEED, INITIAL_CAMERA, clampCamera, facing, normalizeYaw } from './camera.js';
import type { CameraState } from './camera.js';
import { WALL, slotPose } from './layout.js';

const PI = Math.PI;
const state = (overrides: Partial<CameraState> = {}): CameraState => ({ ...INITIAL_CAMERA, ...overrides });

describe('CAMERA_SPEED', () => {
  it('is the fastest the camera walks and rises, frozen', () => {
    expect(CAMERA_SPEED).toEqual({ walk: 16, rise: 24 });
    expect(Object.isFrozen(CAMERA_SPEED)).toBe(true);
    // The scene's walk (scene/controls.ts: acceleration 22 m/s² against drag to
    // 2% a second) tops out at 22 / ln 50 a second for each push, and the keys
    // and the stick together push twice, on a diagonal.
    const terminal = 22 / Math.log(50);
    expect(2 * Math.SQRT2 * terminal).toBeLessThanOrEqual(CAMERA_SPEED.walk);
    expect(terminal).toBeLessThanOrEqual(CAMERA_SPEED.rise);
  });
});

describe('INITIAL_CAMERA and CAMERA_LIMITS', () => {
  it('opens at the centre, at eye height, facing slot 0 and looking a touch down', () => {
    expect(INITIAL_CAMERA).toEqual({ x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0.04 });
    expect(Object.isFrozen(INITIAL_CAMERA)).toBe(true);
  });

  it('keeps the visitor 2.5 m short of the panels, between eye height and 220 m', () => {
    expect(CAMERA_LIMITS.radius).toBeCloseTo(WALL.ringRadius - 2.5, 12);
    expect(CAMERA_LIMITS).toMatchObject({ minY: 1.7, maxY: 220, minPitch: -1.45, maxPitch: 1.5 });
    expect(Object.isFrozen(CAMERA_LIMITS)).toBe(true);
  });

  it('starts inside its own limits', () => {
    expect(clampCamera(INITIAL_CAMERA)).toEqual(INITIAL_CAMERA);
  });
});

describe('normalizeYaw', () => {
  it('wraps into (−π, π]', () => {
    expect(normalizeYaw(0)).toBe(0);
    expect(normalizeYaw(1)).toBe(1);
    expect(normalizeYaw(PI)).toBe(PI);
    expect(normalizeYaw(-PI)).toBe(PI);
    expect(normalizeYaw(3 * PI)).toBeCloseTo(PI, 12);
    expect(normalizeYaw(-3 * PI)).toBeCloseTo(PI, 12);
    expect(normalizeYaw(2 * PI)).toBe(0);
    expect(normalizeYaw(7)).toBeCloseTo(7 - 2 * PI, 12);
    expect(normalizeYaw(-7)).toBeCloseTo(-7 + 2 * PI, 12);
    expect(normalizeYaw(PI + 1e-9)).toBeCloseTo(-PI + 1e-9, 12);
    expect(normalizeYaw(1e6)).toBeGreaterThan(-PI);
    expect(normalizeYaw(1e6)).toBeLessThanOrEqual(PI);
  });

  it('never returns −0, and turns non-finite yaws into 0', () => {
    expect(Object.is(normalizeYaw(-0), 0)).toBe(true);
    expect(Object.is(normalizeYaw(-2 * PI), 0)).toBe(true);
    for (const yaw of [Number.NaN, Infinity, -Infinity]) {
      expect(normalizeYaw(yaw)).toBe(0);
    }
  });
});

describe('clampCamera', () => {
  it('leaves a state inside the cave as it is, as a new object', () => {
    const inside = { x: 3, y: 12, z: -4, yaw: 1, pitch: -0.5 };
    const clamped = clampCamera(inside);
    expect(clamped).toEqual(inside);
    expect(clamped).not.toBe(inside);
  });

  it('pulls a position past the walking disk straight back to its edge', () => {
    const limit = CAMERA_LIMITS.radius;
    const out = clampCamera(state({ x: 30, z: -40 }));
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(limit, 12);
    expect(out.x / out.z).toBeCloseTo(30 / -40, 12);
    const edge = clampCamera(state({ x: 0, z: limit }));
    expect(edge.z).toBe(limit);
    const huge = clampCamera(state({ x: 1e308, z: 1e308 }));
    expect(huge.x).toBeCloseTo(limit / Math.SQRT2, 9);
    expect(huge.z).toBeCloseTo(limit / Math.SQRT2, 9);
    // Both components inside the limit, the diagonal inside too: stays put.
    const inside = clampCamera(state({ x: limit * 0.7, z: limit * 0.7 }));
    expect(inside).toMatchObject({ x: limit * 0.7, z: limit * 0.7 });
    // Both components inside the limit, but the diagonal past it: pulled in.
    const diagonal = clampCamera(state({ x: limit * 0.8, z: -limit * 0.8 }));
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(limit, 12);
    expect(diagonal.x).toBeCloseTo(-diagonal.z, 12);
  });

  it('clamps the height between eye height and 220 m', () => {
    expect(clampCamera(state({ y: 0 })).y).toBe(1.7);
    expect(clampCamera(state({ y: -50 })).y).toBe(1.7);
    expect(clampCamera(state({ y: 1.7 })).y).toBe(1.7);
    expect(clampCamera(state({ y: 219.9 })).y).toBe(219.9);
    expect(clampCamera(state({ y: 500 })).y).toBe(220);
  });

  it('clamps the pitch between −1.45 (up) and 1.5 (down)', () => {
    expect(clampCamera(state({ pitch: -2 })).pitch).toBe(-1.45);
    expect(clampCamera(state({ pitch: 2 })).pitch).toBe(1.5);
    expect(clampCamera(state({ pitch: -1.45 })).pitch).toBe(-1.45);
    expect(clampCamera(state({ pitch: 1.5 })).pitch).toBe(1.5);
    expect(clampCamera(state({ pitch: 0 })).pitch).toBe(0);
  });

  it('wraps the yaw rather than clamping it', () => {
    expect(clampCamera(state({ yaw: 3 * PI })).yaw).toBeCloseTo(PI, 12);
    expect(clampCamera(state({ yaw: -PI })).yaw).toBe(PI);
    expect(clampCamera(state({ yaw: -1 })).yaw).toBe(-1);
  });

  it("puts INITIAL_CAMERA's value in place of any field that is not a finite number", () => {
    expect(
      clampCamera({ x: Number.NaN, y: Infinity, z: -Infinity, yaw: Number.NaN, pitch: Number.NaN }),
    ).toEqual(INITIAL_CAMERA);
    expect(clampCamera(state({ x: Number.NaN, z: 5 }))).toMatchObject({ x: 0, z: 5 });
    expect(clampCamera({} as CameraState)).toEqual(INITIAL_CAMERA);
  });

  it('never returns −0', () => {
    const out = clampCamera({ x: -0, y: 2, z: -0, yaw: -0, pitch: -0 });
    for (const value of Object.values(out)) {
      expect(Object.is(value, -0)).toBe(false);
    }
  });
});

describe('facing', () => {
  it('is the column angle, normalised, the same for every row', () => {
    expect(facing(0)).toBe(0);
    expect(facing(8)).toBeCloseTo(PI / 2, 12);
    expect(facing(16)).toBeCloseTo(PI, 12);
    expect(facing(24)).toBeCloseTo(-PI / 2, 12);
    expect(facing(31)).toBeCloseTo(-PI / 16, 12);
    expect(facing(32)).toBe(0);
    expect(facing(2879)).toBeCloseTo(-PI / 16, 12);
  });

  it('looks straight at the slot from the centre: forward (sin yaw, 0, −cos yaw) points at it', () => {
    for (const index of [0, 3, 8, 13, 16, 21, 24, 31, 45, 1000]) {
      const yaw = facing(index);
      const [x, , z] = slotPose(index).position;
      const distance = Math.hypot(x, z);
      expect(Math.sin(yaw)).toBeCloseTo(x / distance, 12);
      expect(-Math.cos(yaw)).toBeCloseTo(z / distance, 12);
    }
  });

  it('throws a RangeError for anything but a slot index', () => {
    for (const index of [-1, 2880, 0.5, Number.NaN]) {
      expect(() => facing(index)).toThrow(RangeError);
    }
  });
});
