import { describe, expect, it } from 'vitest';

import {
  ACTION_MAX_LENGTH,
  MAX_ACTIONS_PER_SECOND,
  THROW_TIME,
  acceptAction,
  createActionLimiter,
  encodeAction,
  forgetActionSender,
  parseAction,
} from './actions.js';
import type { LobbyAction } from './actions.js';

const json = (value: unknown): string => JSON.stringify(value);

describe('encodeAction / parseAction', () => {
  it('reads back every kind as it was sent', () => {
    const actions: LobbyAction[] = [
      { kind: 'wave' },
      { kind: 'ball', holding: true },
      { kind: 'ball', holding: false },
      { kind: 'throw', to: 'gh:1001', from: { x: 1.25, y: 1.4, z: -2 }, dest: { x: 0, y: 1.35, z: -8.5 }, time: 1.2 },
      { kind: 'throw', to: null, from: { x: 0, y: 1.4, z: 0 }, dest: { x: 0, y: 0.09, z: -7 }, time: 0.9 },
      { kind: 'catch', thrower: 'practice-0a0b0c', caught: true },
      { kind: 'catch', thrower: 'gh:7', caught: false },
    ];
    for (const action of actions) expect(parseAction(encodeAction(action))).toEqual(action);
  });

  it('rounds points to the centimetre and times to the millisecond', () => {
    const sent = encodeAction({ kind: 'throw', to: null, from: { x: 1.23456, y: 1.5, z: 0 }, dest: { x: 2, y: 1, z: 2 }, time: 0.98765 });
    const back = parseAction(sent);
    expect(back).toEqual({ kind: 'throw', to: null, from: { x: 1.23, y: 1.5, z: 0 }, dest: { x: 2, y: 1, z: 2 }, time: 0.988 });
    expect(sent.length).toBeLessThan(ACTION_MAX_LENGTH);
  });

  it('rejects what isn’t a message', () => {
    for (const raw of [null, 42, '', 'not json', '[]', 'null', '"wave"', 'x'.repeat(ACTION_MAX_LENGTH + 1)]) {
      expect(parseAction(raw)).toBeNull();
    }
  });

  it('rejects another version, an unknown kind or stray fields', () => {
    expect(parseAction(json({ v: 2, k: 'wave' }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'dance' }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'wave', extra: 1 }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'ball' }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'ball', h: 'yes' }))).toBeNull();
  });

  it('rejects a throw with a bad target, time or point', () => {
    const good = { v: 1, k: 'throw', to: 'gh:1', f: [0, 1.4, 0], d: [0, 1.3, -5], t: 1 };
    expect(parseAction(json(good))).not.toBeNull();
    expect(parseAction(json({ ...good, to: 'bad id!' }))).toBeNull();
    expect(parseAction(json({ ...good, to: 5 }))).toBeNull();
    expect(parseAction(json({ ...good, t: THROW_TIME.min - 0.01 }))).toBeNull();
    expect(parseAction(json({ ...good, t: THROW_TIME.max + 0.01 }))).toBeNull();
    expect(parseAction(json({ ...good, t: '1' }))).toBeNull();
    expect(parseAction(json({ ...good, f: [0, 1] }))).toBeNull();
    expect(parseAction(json({ ...good, f: [0, '1', 0] }))).toBeNull();
    expect(parseAction(json({ ...good, d: [500, 1, 0] }))).toBeNull();
    expect(parseAction(json({ ...good, d: [0, -1, 0] }))).toBeNull();
    expect(parseAction(json({ ...good, d: 'here' }))).toBeNull();
    expect(parseAction(json({ ...good, extra: true }))).toBeNull();
  });

  it('rejects a catch with a bad thrower or verdict', () => {
    expect(parseAction(json({ v: 1, k: 'catch', by: 'gh:1', c: 'yes' }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'catch', by: '', c: true }))).toBeNull();
    expect(parseAction(json({ v: 1, k: 'catch', by: 'gh:1' }))).toBeNull();
  });
});

describe('acceptAction', () => {
  it('takes at most MAX_ACTIONS_PER_SECOND from a sender in any second', () => {
    const limiter = createActionLimiter();
    for (let i = 0; i < MAX_ACTIONS_PER_SECOND; i += 1) expect(acceptAction(limiter, 'a', 1000 + i)).toBe(true);
    expect(acceptAction(limiter, 'a', 1500)).toBe(false);
    // Someone else has their own allowance; and a second later there's room again.
    expect(acceptAction(limiter, 'b', 1500)).toBe(true);
    expect(acceptAction(limiter, 'a', 2001)).toBe(true);
  });

  it('rejects a non-finite time, starts over when the clock goes back, and forgets a sender', () => {
    const limiter = createActionLimiter();
    expect(acceptAction(limiter, 'a', Number.NaN)).toBe(false);
    for (let i = 0; i < MAX_ACTIONS_PER_SECOND; i += 1) acceptAction(limiter, 'a', 5000);
    expect(acceptAction(limiter, 'a', 100)).toBe(true);
    forgetActionSender(limiter, 'a');
    expect(limiter.recent.has('a')).toBe(false);
  });
});
