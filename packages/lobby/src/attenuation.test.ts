import { describe, expect, it } from 'vitest';

import {
  clamp01,
  computeGain,
  distance,
  distanceAlpha,
  evalCurve,
  listenerSpace,
  relativePosition,
  shouldSubscribe,
} from './attenuation.js';
import type { AttenuationCurve, AttenuationParams, Vec3 } from './attenuation.js';

/** The cave's numbers (voice.ts): full volume within 5 m, silent from 35 m, natural at −40 dB. */
const CAVE: AttenuationParams = { fullVolumeDistance: 5, falloffDistance: 35, curve: 'natural', naturalDbAtMax: -40 };

describe('distance and clamp01', () => {
  it('measures straight-line distance in three dimensions', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distance({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(0);
    expect(distance({ x: -1, y: 1.7, z: 2 }, { x: 1, y: 1.7, z: 2 })).toBe(2);
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 6 })).toBe(7);
  });

  it('clamps into [0, 1]', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });

  it('maps NaN to 0, so a NaN never reaches an AudioParam (FORGE)', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    // Everything that clamps through it is a number again: an alpha that is
    // NaN reads as near, and an occlusion that is NaN as none.
    expect(distanceAlpha(Number.NaN, 5, 35)).toBe(0);
    expect(evalCurve(Number.NaN, 'natural', -40)).toBe(1);
    expect(evalCurve(Number.NaN, 'logReverse')).toBe(1);
    expect(evalCurve(Number.NaN, 'linear')).toBe(1);
  });
});

describe('distanceAlpha', () => {
  it('is 0 inside full volume, 1 at and past falloff, and linear between', () => {
    expect(distanceAlpha(0, 5, 35)).toBe(0);
    expect(distanceAlpha(5, 5, 35)).toBe(0);
    expect(distanceAlpha(20, 5, 35)).toBe(0.5);
    expect(distanceAlpha(35, 5, 35)).toBe(1);
    expect(distanceAlpha(80, 5, 35)).toBe(1);
  });

  it('with a zero (or negative) span is a step at the full-volume radius', () => {
    expect(distanceAlpha(4, 5, 5)).toBe(0);
    expect(distanceAlpha(5, 5, 5)).toBe(0);
    expect(distanceAlpha(5.01, 5, 5)).toBe(1);
    expect(distanceAlpha(6, 10, 5)).toBe(0);
    expect(distanceAlpha(11, 10, 5)).toBe(1);
  });
});

describe('evalCurve', () => {
  it('linear: 1 − alpha, clamped', () => {
    expect(evalCurve(0, 'linear')).toBe(1);
    expect(evalCurve(0.25, 'linear')).toBe(0.75);
    expect(evalCurve(0.5, 'linear')).toBe(0.5);
    expect(evalCurve(1, 'linear')).toBe(0);
    expect(evalCurve(-1, 'linear')).toBe(1);
    expect(evalCurve(2, 'linear')).toBe(0);
  });

  it('logReverse: 1 + ½·ln(1 − alpha), clamped to 0 once that goes negative', () => {
    expect(evalCurve(0, 'logReverse')).toBe(1);
    expect(evalCurve(0.5, 'logReverse')).toBeCloseTo(1 + 0.5 * Math.log(0.5), 12);
    // Stays near 1 for a long time…
    expect(evalCurve(0.3, 'logReverse')).toBeGreaterThan(0.8);
    // …then crosses 0 at alpha = 1 − e⁻², where the clamp takes over.
    const crossing = 1 - Math.exp(-2);
    expect(evalCurve(crossing - 0.01, 'logReverse')).toBeGreaterThan(0);
    expect(evalCurve(crossing + 0.01, 'logReverse')).toBe(0);
    expect(evalCurve(0.9, 'logReverse')).toBe(0);
    expect(evalCurve(1, 'logReverse')).toBe(0);
  });

  it("natural: 10^(alpha·dB/20), Unreal's −60 dB by default", () => {
    expect(evalCurve(0, 'natural')).toBe(1);
    expect(evalCurve(0.5, 'natural')).toBeCloseTo(10 ** (-30 / 20), 12);
    expect(evalCurve(0.5, 'natural', -60)).toBeCloseTo(0.0316227766, 9);
    expect(evalCurve(0.999, 'natural')).toBeCloseTo(10 ** (-59.94 / 20), 12);
    expect(evalCurve(1, 'natural')).toBe(0);
  });

  it('natural at the cave’s −40 dB: −20 dB halfway, −40 dB just short of falloff', () => {
    expect(evalCurve(0.5, 'natural', -40)).toBeCloseTo(0.1, 12);
    expect(20 * Math.log10(evalCurve(0.999, 'natural', -40))).toBeCloseTo(-39.96, 9);
    // Gentler than Unreal's default everywhere between the radii.
    for (let alpha = 0.05; alpha < 1; alpha += 0.05) {
      expect(evalCurve(alpha, 'natural', -40)).toBeGreaterThan(evalCurve(alpha, 'natural', -60));
    }
  });

  it('treats an unknown curve as linear', () => {
    expect(evalCurve(0.25, 'bogus' as AttenuationCurve)).toBe(0.75);
  });
});

describe('computeGain', () => {
  it('is 1 at and inside full volume', () => {
    expect(computeGain(0, CAVE)).toBe(1);
    expect(computeGain(3, CAVE)).toBe(1);
    expect(computeGain(5, CAVE)).toBe(1);
  });

  it('is 0 at and outside falloff', () => {
    expect(computeGain(35, CAVE)).toBe(0);
    expect(computeGain(45, CAVE)).toBe(0);
    expect(computeGain(Infinity, CAVE)).toBe(0);
  });

  it('follows the curve between the radii', () => {
    expect(computeGain(20, CAVE)).toBeCloseTo(0.1, 12);
    expect(computeGain(15, CAVE)).toBeCloseTo(10 ** (-40 / 3 / 20), 12);
    expect(computeGain(30, CAVE)).toBeCloseTo(10 ** ((-40 * 25) / 30 / 20), 12);
    expect(computeGain(20, { ...CAVE, curve: 'linear' })).toBe(0.5);
    expect(computeGain(20, { fullVolumeDistance: 5, falloffDistance: 35, curve: 'natural' })).toBeCloseTo(10 ** (-30 / 20), 12);
  });

  it('never grows with distance', () => {
    let previous = computeGain(0, CAVE);
    for (let d = 0; d <= 40; d += 0.1) {
      const gain = computeGain(d, CAVE);
      expect(gain).toBeLessThanOrEqual(previous);
      previous = gain;
    }
  });
});

describe('shouldSubscribe', () => {
  const MARGIN = 5;

  it('with no position yet, never', () => {
    expect(shouldSubscribe(null, CAVE, MARGIN, false)).toBe(false);
    expect(shouldSubscribe(null, CAVE, MARGIN, true)).toBe(false);
  });

  it('walking in: subscribes from falloff + margin (40 m)', () => {
    expect(shouldSubscribe(41, CAVE, MARGIN, false)).toBe(false);
    expect(shouldSubscribe(40.01, CAVE, MARGIN, false)).toBe(false);
    expect(shouldSubscribe(40, CAVE, MARGIN, false)).toBe(true);
    expect(shouldSubscribe(3, CAVE, MARGIN, false)).toBe(true);
  });

  it('walking out: keeps it until falloff + 2 × margin (45 m)', () => {
    expect(shouldSubscribe(42, CAVE, MARGIN, true)).toBe(true);
    expect(shouldSubscribe(45, CAVE, MARGIN, true)).toBe(true);
    expect(shouldSubscribe(45.01, CAVE, MARGIN, true)).toBe(false);
  });

  it('so someone pacing between 40 m and 45 m never flips it either way', () => {
    for (const d of [40.5, 42, 44.9]) {
      expect(shouldSubscribe(d, CAVE, MARGIN, true)).toBe(true);
      expect(shouldSubscribe(d, CAVE, MARGIN, false)).toBe(false);
    }
  });
});

describe('relativePosition', () => {
  it('is the peer’s offset from the listener, whichever way the listener faces', () => {
    expect(relativePosition({ x: 1, y: 1.5, z: -2 }, { x: 4, y: 2.5, z: 2 })).toEqual({ x: 3, y: 1, z: 4 });
  });
});

describe('listenerSpace', () => {
  const at = (yaw: number): Vec3 & { yaw: number } => ({ x: 2, y: 1.7, z: -3, yaw });
  /** World direction of the listener's right and forward at `yaw` (camera.ts: 0 looks down −Z, growing turning right). */
  const right = (yaw: number): Vec3 => ({ x: Math.cos(yaw), y: 0, z: Math.sin(yaw) });
  const forward = (yaw: number): Vec3 => ({ x: Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
  const offset = (from: Vec3, by: Vec3, metres: number): Vec3 => ({
    x: from.x + by.x * metres,
    y: from.y + by.y * metres,
    z: from.z + by.z * metres,
  });
  const expectNear = (actual: Vec3, expected: Vec3): void => {
    expect(actual.x).toBeCloseTo(expected.x, 9);
    expect(actual.y).toBeCloseTo(expected.y, 9);
    expect(actual.z).toBeCloseTo(expected.z, 9);
  };

  for (const [label, yaw] of [
    ['0', 0],
    ['π/2', Math.PI / 2],
    ['−π/2', -Math.PI / 2],
    ['π', Math.PI],
  ] as const) {
    it(`at yaw ${label}: a peer at your right is +x, ahead is −z, at your left −x, behind +z`, () => {
      const listener = at(yaw);
      expectNear(listenerSpace(listener, offset(listener, right(yaw), 3)), { x: 3, y: 0, z: 0 });
      expectNear(listenerSpace(listener, offset(listener, forward(yaw), 4)), { x: 0, y: 0, z: -4 });
      expectNear(listenerSpace(listener, offset(listener, right(yaw), -3)), { x: -3, y: 0, z: 0 });
      expectNear(listenerSpace(listener, offset(listener, forward(yaw), -4)), { x: 0, y: 0, z: 4 });
    });
  }

  it('at yaw 0 it is just the offset, as relativePosition gives it', () => {
    const listener = at(0);
    const peer = { x: 7, y: 9.7, z: -11 };
    expectNear(listenerSpace(listener, peer), relativePosition(listener, peer));
  });

  it('keeps height as it is, and distance unchanged', () => {
    const listener = at(1.1);
    const peer = { x: -6, y: 12, z: 4 };
    const local = listenerSpace(listener, peer);
    expect(local.y).toBeCloseTo(peer.y - listener.y, 12);
    expect(distance({ x: 0, y: 0, z: 0 }, local)).toBeCloseTo(distance(listener, peer), 9);
  });

  it('turning 180° moves a peer from your right to your left: one 5 m along +X is +x at yaw 0, −x at yaw π', () => {
    const listener = at(0);
    const peer = { x: listener.x + 5, y: listener.y, z: listener.z };
    expect(listenerSpace(listener, peer).x).toBeGreaterThan(0);
    expect(listenerSpace({ ...listener, yaw: Math.PI }, peer).x).toBeLessThan(0);
  });
});
