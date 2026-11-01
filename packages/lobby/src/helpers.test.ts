import { describe, expect, it } from 'vitest';

import { AVATAR_PALETTES, defaultColors, paletteIndex } from './avatar.js';
import { wrapAngle } from './avatarMotion.js';
import { BRICK } from './bricks.js';
import { CAMERA_LIMITS } from './camera.js';
import { BODY } from './collide.js';
import {
  HELPER_BOTS,
  HELPER_ID,
  LAP,
  PATROL,
  helperBot,
  helperMode,
  helperWave,
  isHelperBot,
  loopPoint,
  scheduledArc,
  startHelper,
  stepHelper,
} from './helpers.js';
import type { HelperState } from './helpers.js';
import { GESTURE } from './play.js';
import type { Vec3 } from './attenuation.js';

const BOT = HELPER_BOTS[0]!;
/** Some wall-clock moment, ms: a real-sized epoch, so the schedule's arithmetic is tested at the size it runs at. */
const T0 = 1_793_000_000_000;

/** Steps `state` every `step` seconds for `seconds`, with `people` round it throughout. */
function run(state: HelperState, seconds: number, people: readonly Vec3[] = [], step = 1 / 60): HelperState {
  let s = state;
  const steps = Math.round(seconds / step);
  for (let i = 1; i <= steps; i += 1) s = stepHelper(BOT, s, people, state.now + i * step * 1000);
  return s;
}

/** How far `state` is behind its schedule, metres (negative: ahead). */
function behind(state: HelperState): number {
  const raw = scheduledArc(BOT, state.now) - state.arc;
  return ((((raw + LAP / 2) % LAP) + LAP) % LAP) - LAP / 2;
}

/** A point `metres` from the bot's eye, out from the loop toward the cave's middle. */
function inward(state: HelperState, metres: number): Vec3 {
  const { at } = loopPoint(state.arc);
  const k = 1 - metres / PATROL.radius;
  return { x: at.x * k, y: at.y, z: at.z * k };
}

describe('the helper bots', () => {
  it('are the cave’s own, never a member', () => {
    expect(HELPER_BOTS.length).toBe(1);
    for (const bot of HELPER_BOTS) {
      expect(bot.id).toMatch(HELPER_ID);
      expect(isHelperBot(bot.id)).toBe(true);
      expect(helperBot(bot.id)).toBe(bot);
      expect(bot.offset).toBeGreaterThanOrEqual(0);
      expect(bot.offset).toBeLessThan(1);
    }
    expect(new Set(HELPER_BOTS.map((bot) => bot.id)).size).toBe(HELPER_BOTS.length);
    expect(isHelperBot('gh:1001')).toBe(false);
    expect(helperBot('bot:nobody')).toBeNull();
    expect(HELPER_ID.test('gh:1001')).toBe(false);
    expect(Object.isFrozen(HELPER_BOTS) && Object.isFrozen(BOT) && Object.isFrozen(BOT.colors)).toBe(true);
  });

  it('wear their own paint until an admin dresses them; members still wear the palette', () => {
    expect(defaultColors(BOT.id)).toEqual({ shell: '#34353b', trim: '#ff9a1f', accent: '#ffb627', eye: '#ffc83d' });
    expect(defaultColors('gh:1001')).toBe(AVATAR_PALETTES[paletteIndex('gh:1001')]);
  });
});

describe('PATROL', () => {
  it('goes round just inside the walking disk’s edge, its shell clear of everything built', () => {
    expect(PATROL.radius + BODY.radius).toBeCloseTo(CAMERA_LIMITS.radius, 9);
    expect(PATROL.radius - BODY.radius).toBeGreaterThan(BRICK.radius);
    expect(LAP).toBeCloseTo(2 * Math.PI * PATROL.radius, 9);
    // Stops for someone before it could look past them, and lets go farther out than it stops.
    expect(PATROL.approach).toBeLessThan(PATROL.release);
    expect(PATROL.dawdle).toBeLessThan(1);
    expect(PATROL.hurry).toBeGreaterThan(1);
    expect(Object.isFrozen(PATROL)).toBe(true);
  });
});

describe('scheduledArc', () => {
  it('moves at cruising speed, wraps at a lap, and is the same on every client', () => {
    const a = scheduledArc(BOT, T0);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(LAP);
    expect(scheduledArc(BOT, T0)).toBe(a);
    const later = scheduledArc(BOT, T0 + 2_000);
    expect(((later - a + LAP) % LAP)).toBeCloseTo(2 * PATROL.speed, 5);
    const lapMs = (LAP / PATROL.speed) * 1000;
    expect(scheduledArc(BOT, T0 + lapMs)).toBeCloseTo(a, 3);
  });

  it('spaces bots out by their offset', () => {
    const half = scheduledArc({ offset: 0.5 }, T0);
    const none = scheduledArc({ offset: 0 }, T0);
    expect((half - none + LAP) % LAP).toBeCloseTo(LAP / 2, 5);
    expect(scheduledArc({ offset: 0 }, -1_000)).toBeGreaterThanOrEqual(0);
  });
});

describe('loopPoint', () => {
  it('is on the loop at eye height, starting on +X, facing the way it goes', () => {
    expect(loopPoint(0).at).toEqual({ x: PATROL.radius, y: PATROL.eye, z: 0 });
    for (const arc of [0, 10, LAP / 3, LAP - 1]) {
      const { at, yaw } = loopPoint(arc);
      expect(Math.hypot(at.x, at.z)).toBeCloseTo(PATROL.radius, 9);
      // A step along the loop goes where the yaw looks: forward is (sin yaw, −cos yaw) across the floor.
      const next = loopPoint(arc + 0.01).at;
      const dx = next.x - at.x;
      const dz = next.z - at.z;
      const length = Math.hypot(dx, dz);
      expect(dx / length).toBeCloseTo(Math.sin(yaw), 3);
      expect(dz / length).toBeCloseTo(-Math.cos(yaw), 3);
    }
  });
});

describe('stepHelper', () => {
  it('starts on schedule, cruising, with nobody near', () => {
    const state = startHelper(BOT, T0);
    expect(state.arc).toBe(scheduledArc(BOT, T0));
    expect(state.speed).toBe(PATROL.speed);
    expect(state.yaw).toBe(loopPoint(state.arc).yaw);
    expect(helperMode(state)).toBe('patrolling');
    expect(helperWave(state, T0)).toBeNull();
  });

  it('keeps to its schedule at sixty frames a second, and at one', () => {
    for (const step of [1 / 60, 1]) {
      const after = run(startHelper(BOT, T0), 30, [], step);
      expect(helperMode(after)).toBe('patrolling');
      expect(Math.abs(behind(after))).toBeLessThan(1e-6);
      expect(after.speed).toBeCloseTo(PATROL.speed, 6);
      expect(Math.abs(wrapAngle(after.yaw - loopPoint(after.arc).yaw))).toBeLessThan(0.01);
    }
  });

  it('wraps round the end of the lap', () => {
    const start = { ...startHelper(BOT, T0), arc: LAP - 0.3 };
    const after = stepHelper(BOT, start, [], T0 + 1_000);
    expect(after.arc).toBeGreaterThanOrEqual(0);
    expect(after.arc).toBeLessThan(2);
  });

  it('pays no mind to someone just out of reach, or high overhead', () => {
    const start = startHelper(BOT, T0);
    const { at } = loopPoint(start.arc);
    const after = run(start, 1, [inward(start, PATROL.approach + 0.6), { ...at, y: at.y + 30 }]);
    expect(helperMode(after)).toBe('patrolling');
    expect(after.speed).toBeCloseTo(PATROL.speed, 6);
  });

  it('stops for someone who comes up to it, faces them and waves hello', () => {
    const start = startHelper(BOT, T0);
    const visitor = inward(start, 3);
    const greeted = stepHelper(BOT, start, [visitor], T0 + 16);
    expect(helperMode(greeted)).toBe('stopped');
    expect(greeted.stoppedAt).toBe(T0 + 16);
    expect(greeted.facing).toEqual(visitor);
    expect(helperWave(greeted, T0 + 16)).toBe(0);

    const after = run(start, 3, [visitor]);
    expect(after.speed).toBe(0);
    // It drifted to a halt, slowing at PATROL.accel: about speed² / 2·accel.
    const drift = (after.arc - start.arc + LAP) % LAP;
    expect(drift).toBeGreaterThan(0.3);
    expect(drift).toBeLessThan((PATROL.speed ** 2 / (2 * PATROL.accel)) * 1.1);
    const { at } = loopPoint(after.arc);
    const toward = Math.atan2(visitor.x - at.x, -(visitor.z - at.z));
    expect(Math.abs(wrapAngle(after.yaw - toward))).toBeLessThan(0.01);
    // The wave lasts as long as a member's own, once per stop.
    expect(helperWave(after, after.stoppedAt! + GESTURE.wave * 1000)).toBeCloseTo(GESTURE.wave, 9);
    expect(helperWave(after, after.stoppedAt! + GESTURE.wave * 1000 + 1)).toBeNull();
    expect(helperWave(after, after.stoppedAt! - 1)).toBeNull();
    // Still there a minute on: it waits as long as they stay.
    const waited = run(after, 60, [visitor], 0.5);
    expect(helperMode(waited)).toBe('stopped');
    expect(waited.arc).toBe(after.arc);
    expect(waited.stoppedAt).toBe(after.stoppedAt);
  });

  it('faces whoever is nearest, and keeps facing where they were while it lingers', () => {
    const start = startHelper(BOT, T0);
    const far = inward(start, 3.5);
    const near = inward(start, 1.5);
    expect(stepHelper(BOT, start, [far, near], T0 + 16).facing).toEqual(near);
    const stopped = run(start, 2, [far]);
    const lingering = stepHelper(BOT, stopped, [], stopped.now + 100);
    expect(helperMode(lingering)).toBe('stopped');
    expect(lingering.facing).toEqual(far);
  });

  it('stays stopped for someone who steps back a little, then goes once nobody has been near for a moment', () => {
    const stopped = run(startHelper(BOT, T0), 2, [inward(startHelper(BOT, T0), 2)]);
    // Between the reach that stops it and the one that lets it go: still stopped, still seen.
    const backed = run(stopped, 5, [inward(stopped, PATROL.approach + 1)]);
    expect(helperMode(backed)).toBe('stopped');
    expect(backed.seenAt).toBe(backed.now);

    // Gone: it lingers…
    const leftAt = backed.now;
    const lingering = run(backed, PATROL.linger - 0.1, [], 0.05);
    expect(helperMode(lingering)).toBe('stopped');
    expect(lingering.speed).toBe(0);
    // …then sets off.
    const freed = run(lingering, 0.2, [], 0.05);
    expect(helperMode(freed)).toBe('patrolling');
    expect(freed.facing).toBeNull();
    expect(freed.seenAt).toBe(leftAt);
    expect(helperWave(freed, freed.now)).toBeNull();
  });

  it('turns back to its way before it sets off, then hurries to catch up with its schedule', () => {
    const start = startHelper(BOT, T0);
    // Someone behind it, on the loop: it turns right round to face them.
    const behindIt = loopPoint((start.arc - 2.5 + LAP) % LAP).at;
    const stopped = run(start, 20, [behindIt]);
    expect(Math.abs(wrapAngle(stopped.yaw - loopPoint(stopped.arc).yaw))).toBeGreaterThan(2.5);
    const lag = behind(stopped);
    expect(lag).toBeGreaterThan(20);

    // Free, and still turning: it stays put until it faces its way.
    let s = run(stopped, PATROL.linger + 0.05, [], 0.05);
    expect(helperMode(s)).toBe('patrolling');
    const turning = run(s, 0.3, [], 0.05);
    expect(turning.arc).toBe(s.arc);
    expect(turning.speed).toBe(0);

    // Then off, faster than cruising while behind…
    s = run(turning, 6, [], 0.05);
    expect(s.speed).toBeGreaterThan(PATROL.speed);
    expect(s.speed).toBeLessThanOrEqual(PATROL.speed * PATROL.hurry + 1e-9);
    expect(behind(s)).toBeLessThan(lag);
    // …and back on schedule, at cruising speed, a minute and a half on (it eases the last metres in).
    s = run(s, 90, [], 0.1);
    expect(Math.abs(behind(s))).toBeLessThan(0.05);
    expect(s.speed).toBeCloseTo(PATROL.speed, 2);
  });

  it('slows down while ahead of its schedule', () => {
    const ahead = { ...startHelper(BOT, T0), arc: (scheduledArc(BOT, T0) + 6) % LAP };
    const after = run(ahead, 2);
    expect(after.speed).toBeLessThan(PATROL.speed);
    expect(after.speed).toBeGreaterThanOrEqual(PATROL.speed * PATROL.dawdle - 1e-9);
  });

  it('is back on schedule after a long gap on its way (a hidden tab)', () => {
    const start = { ...startHelper(BOT, T0), arc: (scheduledArc(BOT, T0) + 40) % LAP };
    const later = T0 + 5 * 60_000;
    const after = stepHelper(BOT, start, [], later);
    expect(after.arc).toBe(scheduledArc(BOT, later));
    expect(after.now).toBe(later);
    expect(helperMode(after)).toBe('patrolling');
  });

  it('after a long gap while stopped, waits on if someone is still there', () => {
    const start = startHelper(BOT, T0);
    const visitor = inward(start, 2);
    const stopped = run(start, 2, [visitor]);
    const after = stepHelper(BOT, stopped, [visitor], stopped.now + 60_000);
    expect(helperMode(after)).toBe('stopped');
    expect(after.arc).toBe(stopped.arc);
  });

  it('holds still when the clock goes backwards, and ignores what isn’t a number', () => {
    const start = startHelper(BOT, T0);
    const back = stepHelper(BOT, start, [], T0 - 5_000);
    expect(back.arc).toBe(start.arc);
    expect(back.now).toBe(T0 - 5_000);
    expect(stepHelper(BOT, start, [], Number.NaN)).toBe(start);
    const after = stepHelper(BOT, start, [{ x: Number.NaN, y: 0, z: 0 }, { x: Infinity, y: 1, z: 1 }], T0 + 16);
    expect(helperMode(after)).toBe('patrolling');
  });
});
