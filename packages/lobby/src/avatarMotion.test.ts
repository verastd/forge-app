import { describe, expect, it } from 'vitest';

import { BLINK, HOVER, createBlinker, hashId, robotPose, seededRandom, stepSpring, wrapAngle } from './avatarMotion.js';
import type { MotionInput } from './avatarMotion.js';

const rest: MotionInput = {
  t: 0,
  phase: 0,
  speed: 0,
  climb: 0,
  turnRate: 0,
  viewerBearing: 0,
  viewerDistance: 100,
  reducedMotion: false,
};

describe('seededRandom and hashId', () => {
  it('repeats for a seed and differs between seeds', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const sa = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(sa);
    expect(c()).not.toBe(sa[0]);
    for (const v of sa) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hashes ids stably to 32-bit unsigned values', () => {
    expect(hashId('gh:1')).toBe(hashId('gh:1'));
    expect(hashId('gh:1')).not.toBe(hashId('gh:2'));
    expect(hashId('')).toBe(0x811c9dc5);
    expect(Number.isInteger(hashId('x'))).toBe(true);
  });
});

/** Every blink a blinker makes in `seconds`, sampled at 120 Hz: start times of each closing. */
function blinkStarts(seed: number, seconds: number): number[] {
  const b = createBlinker(seed);
  const starts: number[] = [];
  let open = true;
  for (let i = 0; i <= seconds * 120; i += 1) {
    const t = i / 120;
    const o = b.openness(t);
    if (open && o < 0.5) starts.push(t);
    open = o >= 0.5;
  }
  return starts;
}

describe('createBlinker', () => {
  it('stays between shut and fully open', () => {
    const b = createBlinker(3);
    for (let i = 0; i < 6000; i += 1) {
      const o = b.openness(i / 240);
      expect(o).toBeGreaterThanOrEqual(BLINK.shut - 1e-9);
      expect(o).toBeLessThanOrEqual(1);
    }
  });

  it('blinks every 2.5–6 s, with the odd double blink close behind', () => {
    const starts = blinkStarts(11, 600);
    expect(starts.length).toBeGreaterThan(600 / BLINK.maxGap - 5);
    let doubles = 0;
    for (let i = 1; i < starts.length; i += 1) {
      const gap = starts[i]! - starts[i - 1]!;
      if (gap < 0.5) {
        doubles += 1;
        expect(gap).toBeCloseTo(BLINK.doubleGap, 1);
      } else {
        expect(gap).toBeGreaterThan(BLINK.minGap - 0.05);
        expect(gap).toBeLessThan(BLINK.maxGap + BLINK.doubleGap + 0.05);
      }
    }
    expect(doubles).toBeGreaterThan(0);
  });

  it('is the same rhythm for the same seed, and a different one for another', () => {
    expect(blinkStarts(5, 60)).toEqual(blinkStarts(5, 60));
    expect(blinkStarts(5, 60)).not.toEqual(blinkStarts(6, 60));
  });

  it('closes fast and opens a little slower, fully shut in between', () => {
    const b = createBlinker(1);
    let t = 0;
    while (b.openness(t) === 1) t += 0.001;
    const start = t;
    while (b.openness(t) > BLINK.shut + 1e-6) t += 0.001;
    expect(t - start).toBeCloseTo(BLINK.close, 2);
    const shut = t;
    while (b.openness(t) < 1) t += 0.001;
    expect(t - shut).toBeCloseTo(BLINK.hold + BLINK.open, 1);
  });

  it('catches up across a long pause between frames', () => {
    const b = createBlinker(9, 10);
    expect(b.openness(10_000)).toBeLessThanOrEqual(1);
    expect(b.openness(10_000.5)).toBeGreaterThan(0);
  });
});

describe('stepSpring', () => {
  it('settles on the target without overshooting', () => {
    const s = { value: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < 300; i += 1) {
      stepSpring(s, 1, 1 / 60, 8);
      peak = Math.max(peak, s.value);
    }
    expect(s.value).toBeCloseTo(1, 4);
    expect(peak).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is frame-rate independent', () => {
    const a = { value: 0, velocity: 0 };
    const b = { value: 0, velocity: 0 };
    for (let i = 0; i < 30; i += 1) stepSpring(a, 1, 1 / 30, 5);
    for (let i = 0; i < 120; i += 1) stepSpring(b, 1, 1 / 120, 5);
    expect(a.value).toBeCloseTo(b.value, 6);
  });
});

describe('wrapAngle', () => {
  it.each([
    [0, 0],
    [Math.PI, Math.PI],
    [-Math.PI, Math.PI],
    [3 * Math.PI, Math.PI],
    [Math.PI / 2 + 4 * Math.PI, Math.PI / 2],
    [-Math.PI / 2 - 2 * Math.PI, -Math.PI / 2],
  ])('%f → %f', (a, b) => {
    expect(wrapAngle(a)).toBeCloseTo(b, 9);
  });
});

describe('robotPose', () => {
  it('hovers at rest: a bob within ±4 cm, upright, low thrust', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 200; i += 1) {
      const p = robotPose({ ...rest, t: i / 50 });
      lo = Math.min(lo, p.bob);
      hi = Math.max(hi, p.bob);
      expect(p.pitch).toBe(0);
      expect(p.flight).toBe(0);
      expect(p.thrust).toBeCloseTo(0.35, 6);
    }
    expect(hi).toBeCloseTo(HOVER.bob, 2);
    expect(lo).toBeCloseTo(-HOVER.bob, 2);
  });

  it('leans forward, trails its arms and burns brighter in flight', () => {
    const p = robotPose({ ...rest, speed: HOVER.flySpeed * 2 });
    expect(p.flight).toBe(1);
    expect(p.pitch).toBeCloseTo(HOVER.maxPitch, 6);
    expect(p.armSwing).toBeCloseTo(HOVER.armTrail, 6);
    expect(p.thrust).toBe(1);
    expect(Math.abs(p.bob)).toBeLessThanOrEqual(HOVER.bob * 0.4 + 1e-9);
  });

  it('banks into a turn, the way it turns, never past the limit', () => {
    expect(robotPose({ ...rest, speed: 8, turnRate: 1 }).roll).toBeGreaterThan(0);
    expect(robotPose({ ...rest, speed: 8, turnRate: -1 }).roll).toBeLessThan(0);
    expect(robotPose({ ...rest, speed: 8, turnRate: 50 }).roll).toBeCloseTo(HOVER.maxRoll, 6);
  });

  it('tips its nose up climbing and down diving, and thrusts climbing straight up', () => {
    expect(robotPose({ ...rest, climb: 4 }).pitch).toBeLessThan(0);
    expect(robotPose({ ...rest, climb: -4 }).pitch).toBeGreaterThan(0);
    expect(robotPose({ ...rest, climb: 4 }).thrust).toBe(1);
  });

  it('looks at a near viewer, clamped, and not at a far one', () => {
    const near = robotPose({ ...rest, viewerBearing: 0.5, viewerDistance: 2, reducedMotion: true });
    expect(near.headYaw).toBeCloseTo(0.5, 6);
    const clamped = robotPose({ ...rest, viewerBearing: 3, viewerDistance: 1, reducedMotion: true });
    expect(clamped.headYaw).toBeCloseTo(HOVER.maxLook, 6);
    const far = robotPose({ ...rest, viewerBearing: 0.5, viewerDistance: 20, reducedMotion: true });
    expect(far.headYaw).toBe(0);
    const edge = robotPose({ ...rest, viewerBearing: 0.5, viewerDistance: HOVER.lookRange - 0.5, reducedMotion: true });
    expect(edge.headYaw).toBeCloseTo(0.25, 6);
  });

  it('holds still for reduced motion, but keeps looking and the thruster', () => {
    const p = robotPose({ ...rest, t: 1.234, speed: 2, turnRate: 1, reducedMotion: true });
    expect(p.bob).toBe(0);
    expect(p.pitch).toBe(0);
    expect(p.roll).toBe(0);
    expect(p.armSwing).toBe(0);
    expect(p.breath).toBe(0);
    expect(p.thrust).toBeGreaterThan(0.35);
  });
});
