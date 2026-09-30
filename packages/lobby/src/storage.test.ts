import { describe, expect, it } from 'vitest';

import { CAMERA_LIMITS, INITIAL_CAMERA, clampCamera } from './camera.js';
import type { CameraState } from './camera.js';
import { CAMERA_STORAGE_ITEM, parseCameraState, serializeCameraState } from './storage.js';

const stored = (value: Record<string, unknown>): string =>
  JSON.stringify({ x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.1, ...value });

describe('CAMERA_STORAGE_ITEM', () => {
  it('is versioned in the key, and is not the prototype’s key', () => {
    expect(CAMERA_STORAGE_ITEM).toBe('forge.lobby.pos.v2');
    expect(CAMERA_STORAGE_ITEM).not.toBe('forge.lobby.pos');
  });
});

describe('serializeCameraState', () => {
  it('writes exactly {x, y, z, yaw, pitch}', () => {
    expect(JSON.parse(serializeCameraState(INITIAL_CAMERA))).toEqual({ x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0.04 });
    expect(Object.keys(JSON.parse(serializeCameraState(INITIAL_CAMERA)))).toEqual(['x', 'y', 'z', 'yaw', 'pitch']);
    expect(serializeCameraState({ x: -25.123456789, y: 219.98765, z: 17.5, yaw: -3.1, pitch: 1.49 }).length).toBeLessThan(256);
  });

  it('clamps into the cave first, so whatever it writes reads back', () => {
    const wild: CameraState = { x: 100, y: 999, z: 0, yaw: 7, pitch: -9 };
    const written = JSON.parse(serializeCameraState(wild)) as CameraState;
    expect(written.x).toBeCloseTo(CAMERA_LIMITS.radius, 12);
    expect(written).toMatchObject({ y: 220, z: 0, pitch: -1.45 });
    expect(written.yaw).toBeCloseTo(7 - 2 * Math.PI, 12);
    const broken: CameraState = { x: Number.NaN, y: Number.NaN, z: Infinity, yaw: Number.NaN, pitch: Number.NaN };
    expect(parseCameraState(serializeCameraState(broken))).toEqual(INITIAL_CAMERA);
  });
});

describe('parseCameraState', () => {
  it('round-trips states exactly, clamped', () => {
    const states: CameraState[] = [
      INITIAL_CAMERA,
      { x: 3.25, y: 40, z: -12.5, yaw: -2.5, pitch: 0.75 },
      { x: -24, y: 1.7, z: 5, yaw: Math.PI, pitch: -1.45 },
      { x: 0.1, y: 219, z: 0.2, yaw: 0.001, pitch: 1.5 },
      { x: 50, y: -3, z: 50, yaw: -Math.PI, pitch: 3 },
    ];
    for (const state of states) {
      expect(parseCameraState(serializeCameraState(state))).toEqual(clampCamera(state));
    }
  });

  it('returns null for nothing saved and for anything unreadable, and never throws', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{',
      'null',
      '42',
      '"forge"',
      'true',
      '[]',
      '[1,2,3,4,5]',
      '{}',
      stored({ x: '1' }),
      stored({ y: null }),
      stored({ z: true }),
      stored({ yaw: [] }),
      stored({ pitch: {} }),
      JSON.stringify({ x: 1, y: 2, z: 3, yaw: 0 }),
      '{"x":1e999,"y":2,"z":3,"yaw":0,"pitch":0}',
      '{"x":1,"y":2,"z":3,"yaw":0,"pitch":-1e999}',
      '{"__proto__":{"x":1,"y":2,"z":3,"yaw":0,"pitch":0}}',
      stored({ pad: 'x'.repeat(300) }),
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      expect(() => parseCameraState(raw)).not.toThrow();
      expect(parseCameraState(raw)).toBeNull();
    }
  });

  it('reads the prototype’s own shape, which is the same five numbers', () => {
    expect(parseCameraState('{"yaw":0.3,"pitch":0.04,"x":1,"y":1.7,"z":-2}')).toEqual({
      x: 1,
      y: 1.7,
      z: -2,
      yaw: 0.3,
      pitch: 0.04,
    });
  });

  it('clamps what it reads into the cave, and drops extra fields', () => {
    const read = parseCameraState(stored({ x: 0, z: -90, y: 5000, yaw: -7, pitch: 9, v: 99, focus: 'data' }));
    expect(read).not.toBeNull();
    expect(read?.z).toBeCloseTo(-CAMERA_LIMITS.radius, 12);
    expect(read).toMatchObject({ x: 0, y: 220, pitch: 1.5 });
    expect(read?.yaw).toBeCloseTo(-7 + 2 * Math.PI, 12);
    expect(Object.keys(read ?? {})).toEqual(['x', 'y', 'z', 'yaw', 'pitch']);
  });
});
