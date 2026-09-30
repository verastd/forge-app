import { describe, expect, it } from 'vitest';

import {
  AUDIBLE_RANGE,
  HEARTBEAT_MS,
  MAX_PACKETS_PER_SECOND,
  NAME_MAX_LENGTH,
  POSITION_BYTES,
  POSITION_VERSION,
  SEND_INTERVAL_MS,
  SUBSCRIBE_RANGE,
  acceptPacket,
  createPacketLimiter,
  decodePosition,
  encodePosition,
  forgetSender,
  gainFor,
  near,
  sanitizeName,
  sendPolicy,
} from './presence.js';
import type { SelfState } from './presence.js';
import { CAMERA_LIMITS } from './camera.js';

/** mulberry32: the lobby package allows no unseeded randomness, tests included. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A version-1 packet with raw int16 fields, bypassing the encoder's normalisation. */
function packet(x: number, y: number, z: number, yaw: number, version = POSITION_VERSION): Uint8Array {
  const bytes = new Uint8Array(POSITION_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, version);
  view.setInt16(1, x, true);
  view.setInt16(3, y, true);
  view.setInt16(5, z, true);
  view.setInt16(7, yaw, true);
  return bytes;
}

function fields(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint8(0), view.getInt16(1, true), view.getInt16(3, true), view.getInt16(5, true), view.getInt16(7, true)];
}

const HERE: SelfState = { x: 0, y: 1.7, z: 0, yaw: 0 };
const FRAME_MS = 1000 / 60;

describe('encodePosition', () => {
  it('writes the version byte, then little-endian int16 centimetres and milliradians', () => {
    const bytes = encodePosition({ x: 1.23, y: 4.56, z: -7.89, yaw: 0.5 });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(POSITION_BYTES);
    expect([...bytes]).toEqual([1, 123, 0, 200, 1, 235, 252, 244, 1]);
    expect(fields(bytes)).toEqual([POSITION_VERSION, 123, 456, -789, 500]);
  });

  it('rounds to the nearest centimetre and milliradian', () => {
    expect(fields(encodePosition({ x: 0.004, y: 0.006, z: -0.004, yaw: 0.0004 }))).toEqual([1, 0, 1, 0, 0]);
    expect(fields(encodePosition({ x: 12.345, y: 219.994, z: -20.126, yaw: -1.2345 }))).toEqual([1, 1235, 21999, -2013, -1234]);
  });

  it('normalises the yaw to (−π, π] first', () => {
    expect(fields(encodePosition({ ...HERE, yaw: 2 * Math.PI + 0.5 }))[4]).toBe(500);
    expect(fields(encodePosition({ ...HERE, yaw: -2 * Math.PI - 0.5 }))[4]).toBe(-500);
    expect(fields(encodePosition({ ...HERE, yaw: 3 * Math.PI - 0.25 }))[4]).toBe(2892);
    expect(fields(encodePosition({ ...HERE, yaw: 4 }))[4]).toBe(-2283);
    expect(fields(encodePosition({ ...HERE, yaw: -4 }))[4]).toBe(2283);
  });

  it('writes a yaw within 0.6 mrad of ±π as ±3141 mrad, so it reads back inside [−π, π]', () => {
    expect(fields(encodePosition({ ...HERE, yaw: Math.PI }))[4]).toBe(3141);
    expect(fields(encodePosition({ ...HERE, yaw: -Math.PI }))[4]).toBe(3141);
    expect(fields(encodePosition({ ...HERE, yaw: -Math.PI + 0.0001 }))[4]).toBe(-3141);
    expect(fields(encodePosition({ ...HERE, yaw: 3.1414 }))[4]).toBe(3141);
    expect(decodePosition(encodePosition({ ...HERE, yaw: Math.PI }))?.yaw).toBe(3.141);
  });

  it('saturates instead of wrapping around, so an out-of-range value never lands somewhere plausible', () => {
    // A plain setInt16 would wrap 400 m (40000 cm) to −25536 cm.
    expect(fields(encodePosition({ x: 400, y: -400, z: 327.68, yaw: 0 }))).toEqual([1, 32767, -32768, 32767, 0]);
    expect(decodePosition(encodePosition({ x: 400, y: 1.7, z: 0, yaw: 0 }))).toBeNull();
    expect(decodePosition(encodePosition({ x: 0, y: 1000, z: 0, yaw: 0 }))).toBeNull();
  });

  it('writes a non-finite value as the int16 minimum, which decoding always rejects', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const states: SelfState[] = [
        { ...HERE, x: bad },
        { ...HERE, y: bad },
        { ...HERE, z: bad },
        { ...HERE, yaw: bad },
      ];
      states.forEach((state, field) => {
        const written = fields(encodePosition(state));
        expect(written[field + 1]).toBe(-32768);
        expect(decodePosition(encodePosition(state))).toBeNull();
      });
    }
  });
});

describe('decodePosition', () => {
  it('reads back what encodePosition wrote, to the centimetre and milliradian, anywhere a camera can be', () => {
    let checked = 0;
    for (let x = -25; x <= 25; x += 3.17) {
      for (let z = -25; z <= 25; z += 2.93) {
        if (Math.hypot(x, z) > CAMERA_LIMITS.radius) {
          continue;
        }
        for (const y of [CAMERA_LIMITS.minY, 23.456, 150, CAMERA_LIMITS.maxY]) {
          for (const yaw of [-3.1, -1, -0.0004, 0, 0.7071, 2.5, Math.PI]) {
            const decoded = decodePosition(encodePosition({ x, y, z, yaw }));
            expect(decoded).not.toBeNull();
            expect(Math.abs((decoded as SelfState).x - x)).toBeLessThanOrEqual(0.005 + 1e-9);
            expect(Math.abs((decoded as SelfState).y - y)).toBeLessThanOrEqual(0.005 + 1e-9);
            expect(Math.abs((decoded as SelfState).z - z)).toBeLessThanOrEqual(0.005 + 1e-9);
            // Half a milliradian, or 0.6 mrad right at ±π (see above).
            expect(Math.abs((decoded as SelfState).yaw - yaw)).toBeLessThanOrEqual(0.0006);
            // Quantised once, stable forever after.
            expect(decodePosition(encodePosition(decoded as SelfState))).toEqual(decoded);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('decodes exact values', () => {
    expect(decodePosition(packet(123, 456, -789, 500))).toEqual({ x: 1.23, y: 4.56, z: -7.89, yaw: 0.5 });
    expect(decodePosition(packet(0, 170, 0, 0))).toEqual({ x: 0, y: 1.7, z: 0, yaw: 0 });
  });

  it('accepts the edges of where a camera can be (CAMERA_LIMITS), and a centimetre past them', () => {
    // The walking disk's radius is 25.365 m: 25.37 m is within the centimetre.
    expect(decodePosition(packet(2537, 170, 0, 0))).toEqual({ x: 25.37, y: 1.7, z: 0, yaw: 0 });
    expect(decodePosition(packet(0, 22000, -2537, 3141))).toEqual({ x: 0, y: 220, z: -25.37, yaw: 3.141 });
    expect(decodePosition(packet(-1793, 170, 1793, -3141))).toEqual({ x: -17.93, y: 1.7, z: 17.93, yaw: -3.141 });
    expect(decodePosition(packet(0, 169, 0, 0))).toEqual({ x: 0, y: 1.69, z: 0, yaw: 0 });
    expect(decodePosition(packet(0, 22001, 0, 0))).toEqual({ x: 0, y: 220.01, z: 0, yaw: 0 });
  });

  it('rejects the places a hostile peer was seen standing: in the ring of panels, on the floor, above the ceiling, past the wall', () => {
    expect(decodePosition(packet(0, 170, -2795, 0))).toBeNull();
    expect(decodePosition(packet(200, 0, -500, 0))).toBeNull();
    expect(decodePosition(packet(0, 22900, 0, 0))).toBeNull();
    expect(decodePosition(packet(0, 170, -2801, 0))).toBeNull();
  });

  it('rejects a position no camera can reach rather than clamping it', () => {
    // Two centimetres past each limit.
    expect(decodePosition(packet(2538, 170, 0, 0))).toBeNull();
    expect(decodePosition(packet(0, 168, 0, 0))).toBeNull();
    expect(decodePosition(packet(0, 22002, 0, 0))).toBeNull();
    // Each axis inside the limit, but 25.39 m from the axis.
    expect(decodePosition(packet(1795, 170, 1796, 0))).toBeNull();
    expect(decodePosition(packet(0, -1, 0, 0))).toBeNull();
    expect(decodePosition(packet(0, -32768, 0, 0))).toBeNull();
    expect(decodePosition(packet(32767, 32767, 32767, 0))).toBeNull();
  });

  it('rejects a yaw past π either way', () => {
    expect(decodePosition(packet(0, 170, 0, 3142))).toBeNull();
    expect(decodePosition(packet(0, 170, 0, -3142))).toBeNull();
    expect(decodePosition(packet(0, 170, 0, 32767))).toBeNull();
    expect(decodePosition(packet(0, 170, 0, -32768))).toBeNull();
  });

  it('rejects another version', () => {
    for (const version of [0, 2, 127, 255]) {
      expect(decodePosition(packet(0, 170, 0, 0, version))).toBeNull();
    }
  });

  it('rejects the wrong length, even when the first nine bytes are a good packet', () => {
    for (const length of [0, 1, 8, 10, 64]) {
      expect(decodePosition(new Uint8Array(length))).toBeNull();
    }
    const long = new Uint8Array(10);
    long.set(packet(0, 170, 0, 0));
    expect(decodePosition(long)).toBeNull();
    expect(decodePosition(packet(0, 170, 0, 0).subarray(0, 8))).toBeNull();
  });

  it('rejects anything that is not a byte array', () => {
    const good = packet(0, 170, 0, 0);
    const notBytes: unknown[] = [
      null,
      undefined,
      'x'.repeat(POSITION_BYTES),
      [...good],
      good.buffer,
      new DataView(good.buffer),
      new Uint16Array(POSITION_BYTES),
      new Int8Array(good.buffer),
      { byteLength: POSITION_BYTES },
    ];
    for (const value of notBytes) {
      expect(decodePosition(value as Uint8Array)).toBeNull();
    }
  });

  it('reads a packet at any offset into a larger buffer', () => {
    const buffer = new Uint8Array(32);
    buffer.set(packet(-250, 300, 1234, -1500), 7);
    expect(decodePosition(buffer.subarray(7, 7 + POSITION_BYTES))).toEqual({ x: -2.5, y: 3, z: 12.34, yaw: -1.5 });
    expect(decodePosition(new Uint8Array(buffer.buffer, 7, POSITION_BYTES))).toEqual({ x: -2.5, y: 3, z: 12.34, yaw: -1.5 });
  });

  it('never throws, and whatever it accepts is somewhere a camera can be', () => {
    const next = seeded(0x10bb1);
    let accepted = 0;
    for (let i = 0; i < 20000; i += 1) {
      const bytes = new Uint8Array(POSITION_BYTES);
      for (let b = 0; b < POSITION_BYTES; b += 1) {
        bytes[b] = Math.floor(next() * 256);
      }
      if (i % 2 === 0) {
        bytes[0] = POSITION_VERSION;
        // Mostly-plausible values, so the bounds checks see traffic on both sides.
        const view = new DataView(bytes.buffer);
        view.setInt16(1, Math.round((next() - 0.5) * 6000), true);
        view.setInt16(3, Math.round((next() - 0.1) * 26000), true);
        view.setInt16(5, Math.round((next() - 0.5) * 6000), true);
        view.setInt16(7, Math.round((next() - 0.5) * 7000), true);
      }
      const decoded = decodePosition(bytes);
      if (decoded !== null) {
        accepted += 1;
        expect(Math.hypot(decoded.x, decoded.z)).toBeLessThanOrEqual(CAMERA_LIMITS.radius + 0.01);
        expect(decoded.y).toBeGreaterThanOrEqual(CAMERA_LIMITS.minY - 0.01);
        expect(decoded.y).toBeLessThanOrEqual(CAMERA_LIMITS.maxY + 0.01);
        expect(Math.abs(decoded.yaw)).toBeLessThanOrEqual(Math.PI);
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(accepted).toBeLessThan(10000);
  });
});

describe('sendPolicy', () => {
  it('sends the first state straight away', () => {
    expect(sendPolicy(null, 0, 0, HERE)).toBe(true);
    expect(sendPolicy(null, Number.NaN, Number.NaN, HERE)).toBe(true);
  });

  it('holds a still state until the 1 Hz heartbeat', () => {
    for (const now of [0, FRAME_MS, 99, SEND_INTERVAL_MS, 500, 999.9]) {
      expect(sendPolicy(HERE, 0, now, HERE)).toBe(false);
    }
    expect(sendPolicy(HERE, 0, HEARTBEAT_MS, HERE)).toBe(true);
    expect(sendPolicy(HERE, 0, 5000, HERE)).toBe(true);
    expect(sendPolicy(HERE, -Infinity, 0, HERE)).toBe(true);
  });

  it('sends a move at most every 100 ms', () => {
    const moved = { ...HERE, x: 0.5 };
    expect(sendPolicy(HERE, 1000, 1000 + FRAME_MS, moved)).toBe(false);
    expect(sendPolicy(HERE, 1000, 1099.9, moved)).toBe(false);
    expect(sendPolicy(HERE, 1000, 1100, moved)).toBe(true);
    expect(sendPolicy(HERE, 1000, 1116.7, moved)).toBe(true);
  });

  it('counts a move beyond 1 cm, in any direction', () => {
    const at = (state: SelfState): boolean => sendPolicy(HERE, 0, SEND_INTERVAL_MS, state);
    expect(at({ ...HERE, x: 0.01 })).toBe(false);
    expect(at({ ...HERE, x: 0.011 })).toBe(true);
    expect(at({ ...HERE, y: HERE.y - 0.02 })).toBe(true);
    expect(at({ ...HERE, z: -0.011 })).toBe(true);
    // 0.8 cm on two axes is 1.13 cm: a move.
    expect(at({ ...HERE, x: 0.008, z: 0.008 })).toBe(true);
    expect(at({ ...HERE, x: 0.005, z: -0.005 })).toBe(false);
  });

  it('counts a turn beyond 5 mrad, the short way round', () => {
    const at = (lastYaw: number, yaw: number): boolean =>
      sendPolicy({ ...HERE, yaw: lastYaw }, 0, SEND_INTERVAL_MS, { ...HERE, yaw });
    expect(at(0, 0.004)).toBe(false);
    expect(at(0, 0.005)).toBe(false);
    expect(at(0, 0.006)).toBe(true);
    expect(at(1, 1 - 0.006)).toBe(true);
    // Across ±π: 2 mrad, not 6.28 rad.
    expect(at(Math.PI - 0.001, -Math.PI + 0.001)).toBe(false);
    expect(at(Math.PI - 0.001, -Math.PI + 0.01)).toBe(true);
    expect(at(-Math.PI + 0.001, Math.PI - 0.001)).toBe(false);
    expect(at(-Math.PI + 0.001, Math.PI - 0.01)).toBe(true);
    expect(at(0, 2 * Math.PI)).toBe(false);
  });

  it('sends when the clock went backwards, and never when the elapsed time is not a number', () => {
    expect(sendPolicy(HERE, 5000, 10, HERE)).toBe(true);
    expect(sendPolicy(HERE, 0, Number.NaN, HERE)).toBe(false);
    expect(sendPolicy(HERE, Number.NaN, 5000, HERE)).toBe(false);
    expect(sendPolicy(HERE, Infinity, Infinity, HERE)).toBe(false);
  });

  it('holds a member walking at 60 fps to 10 Hz, and a still one to 1 Hz', () => {
    const simulate = (move: (t: number) => SelfState): number[] => {
      const sent: number[] = [];
      let last: SelfState | null = null;
      let lastAt = 0;
      for (let frame = 0; frame <= 600; frame += 1) {
        const now = frame * FRAME_MS;
        const state = move(now);
        if (sendPolicy(last, lastAt, now, state)) {
          sent.push(now);
          last = state;
          lastAt = now;
        }
      }
      return sent;
    };
    const walking = simulate((t) => ({ x: Math.sin(t / 1000) * 10, y: 1.7, z: t / 1000, yaw: t / 2000 }));
    expect(walking.length).toBeGreaterThanOrEqual(80);
    expect(walking.length).toBeLessThanOrEqual(101);
    walking.slice(1).forEach((t, i) => expect(t - (walking[i] as number)).toBeGreaterThanOrEqual(SEND_INTERVAL_MS - 1e-9));

    const still = simulate(() => HERE);
    expect(still.length).toBeGreaterThanOrEqual(10);
    expect(still.length).toBeLessThanOrEqual(11);
    still.slice(1).forEach((t, i) => expect(t - (still[i] as number)).toBeGreaterThanOrEqual(HEARTBEAT_MS - 1e-9));
  });
});

describe('near and gainFor', () => {
  it('uses the contract’s ranges', () => {
    expect(AUDIBLE_RANGE).toBe(9);
    expect(SUBSCRIBE_RANGE).toBe(14);
    expect(SUBSCRIBE_RANGE).toBeGreaterThan(AUDIBLE_RANGE);
  });

  it('is the contract’s clamp(1 − (dist − 2) / (9 − 2), 0, 1)', () => {
    for (let dist = -5; dist <= 30; dist += 0.25) {
      const expected = Math.min(1, Math.max(0, 1 - (dist - 2) / (9 - 2)));
      expect(near(dist)).toBeCloseTo(expected, 12);
    }
    expect(near(0)).toBe(1);
    expect(near(2)).toBe(1);
    expect(near(5.5)).toBe(0.5);
    expect(near(AUDIBLE_RANGE)).toBe(0);
    expect(near(SUBSCRIBE_RANGE)).toBe(0);
  });

  it('is 0 for a distance that is not a number, and handles infinities', () => {
    expect(near(Number.NaN)).toBe(0);
    expect(near(Infinity)).toBe(0);
    expect(near(-Infinity)).toBe(1);
  });

  it('never grows with distance', () => {
    let previous = near(0);
    for (let dist = 0; dist <= 20; dist += 0.1) {
      expect(near(dist)).toBeLessThanOrEqual(previous);
      previous = near(dist);
    }
  });

  it('maps nearness to a volume in [0, 1], silent at the edge of earshot', () => {
    expect(gainFor(0)).toBe(0);
    expect(gainFor(0.25)).toBe(0.25);
    expect(gainFor(1)).toBe(1);
    expect(gainFor(1.5)).toBe(1);
    expect(gainFor(-0.5)).toBe(0);
    expect(gainFor(Number.NaN)).toBe(0);
    expect(gainFor(near(2))).toBe(1);
    expect(gainFor(near(AUDIBLE_RANGE))).toBe(0);
    expect(gainFor(near(AUDIBLE_RANGE - 0.5))).toBeGreaterThan(0);
  });
});

describe('sanitizeName', () => {
  it('keeps ordinary names', () => {
    for (const name of ['octocat', 'mara', 'devon-kit', 'a', 'José', 'Zoë 🦊', 'the practice account']) {
      expect(sanitizeName(name)).toBe(name);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeName('  mara  ')).toBe('mara');
    expect(sanitizeName(' mara　')).toBe('mara');
  });

  it('strips control and format characters and line separators, then trims what they hid', () => {
    expect(sanitizeName('ma\u0000ra')).toBe('mara');
    expect(sanitizeName('line\nbreak\r')).toBe('linebreak');
    expect(sanitizeName('\ttab')).toBe('tab');
    expect(sanitizeName('del\u007f')).toBe('del');
    expect(sanitizeName('\u0085c1\u009b')).toBe('c1');
    expect(sanitizeName('‮evil‬')).toBe('evil');
    expect(sanitizeName('⁦iso⁩‎‏')).toBe('iso');
    expect(sanitizeName('​m‍ara﻿')).toBe('mara');
    expect(sanitizeName('para graph ')).toBe('paragraph');
    expect(sanitizeName(' \u0000 kit \u0007 ')).toBe('kit');
  });

  it('clamps to 39 code points without splitting a character', () => {
    expect(NAME_MAX_LENGTH).toBe(39);
    expect(sanitizeName('a'.repeat(39))).toBe('a'.repeat(39));
    expect(sanitizeName('a'.repeat(40))).toBe('a'.repeat(39));
    expect(sanitizeName('b'.repeat(5000))).toBe('b'.repeat(39));
    const foxes = sanitizeName('🦊'.repeat(40));
    expect(foxes).toBe('🦊'.repeat(39));
    expect([...foxes]).toHaveLength(39);
    expect(foxes).toHaveLength(78);
    // Clamping never leaves trailing whitespace behind.
    expect(sanitizeName(`${'a'.repeat(38)} b`)).toBe('a'.repeat(38));
  });

  it('falls back to "member" when nothing is left, or for anything but a string', () => {
    for (const name of ['', '   ', '\u0000\u0001', '‮', '​  ', null, undefined, 42, {}, [], ['mara']]) {
      expect(sanitizeName(name)).toBe('member');
    }
  });
});

describe('acceptPacket', () => {
  it('accepts at most 30 packets a second from one sender', () => {
    expect(MAX_PACKETS_PER_SECOND).toBe(30);
    const limiter = createPacketLimiter();
    for (let i = 0; i < MAX_PACKETS_PER_SECOND; i += 1) {
      expect(acceptPacket(limiter, 'gh:1', 0)).toBe(true);
    }
    expect(acceptPacket(limiter, 'gh:1', 0)).toBe(false);
    expect(acceptPacket(limiter, 'gh:1', 999)).toBe(false);
    expect(acceptPacket(limiter, 'gh:1', 1000)).toBe(true);
  });

  it('limits each sender on its own', () => {
    const limiter = createPacketLimiter();
    for (let i = 0; i < 40; i += 1) {
      acceptPacket(limiter, 'gh:1', 10);
    }
    expect(acceptPacket(limiter, 'gh:1', 10)).toBe(false);
    expect(acceptPacket(limiter, 'gh:2', 10)).toBe(true);
    expect(acceptPacket(createPacketLimiter(), 'gh:1', 10)).toBe(true);
  });

  it('slides the window rather than resetting it each second', () => {
    const limiter = createPacketLimiter();
    const burst = (now: number, count: number): number => {
      let accepted = 0;
      for (let i = 0; i < count; i += 1) {
        accepted += acceptPacket(limiter, 'gh:1', now) ? 1 : 0;
      }
      return accepted;
    };
    expect(burst(0, 15)).toBe(15);
    expect(burst(500, 30)).toBe(15);
    // The packets from t=0 have left the window; those from t=500 have not.
    expect(burst(1000, 30)).toBe(15);
    expect(burst(1499, 30)).toBe(0);
    expect(burst(1500, 30)).toBe(15);
  });

  it('does not count rejected packets against the sender', () => {
    const limiter = createPacketLimiter();
    let accepted = 0;
    for (let i = 0; i < 500; i += 1) {
      accepted += acceptPacket(limiter, 'gh:1', i) ? 1 : 0;
    }
    expect(accepted).toBe(30);
    expect(acceptPacket(limiter, 'gh:1', 1030)).toBe(true);
    expect(limiter.recent.get('gh:1')?.length).toBeLessThanOrEqual(MAX_PACKETS_PER_SECOND);
  });

  it('never limits a member sending at 10 Hz plus a 1 Hz hello', () => {
    const limiter = createPacketLimiter();
    for (let now = 0; now < 10_000; now += SEND_INTERVAL_MS) {
      expect(acceptPacket(limiter, 'practice-a1b2c3', now)).toBe(true);
      if (now % HEARTBEAT_MS === 0) {
        expect(acceptPacket(limiter, 'practice-a1b2c3', now + 1)).toBe(true);
      }
    }
  });

  it('starts over when the clock goes backwards', () => {
    const limiter = createPacketLimiter();
    for (let i = 0; i < MAX_PACKETS_PER_SECOND; i += 1) {
      acceptPacket(limiter, 'gh:1', 5000);
    }
    expect(acceptPacket(limiter, 'gh:1', 5000)).toBe(false);
    expect(acceptPacket(limiter, 'gh:1', 100)).toBe(true);
    expect(limiter.recent.get('gh:1')).toEqual([100]);
  });

  it('rejects a time that is not a finite number, without recording anything', () => {
    const limiter = createPacketLimiter();
    expect(acceptPacket(limiter, 'gh:1', Number.NaN)).toBe(false);
    expect(acceptPacket(limiter, 'gh:1', Infinity)).toBe(false);
    expect(acceptPacket(limiter, 'gh:1', -Infinity)).toBe(false);
    expect(limiter.recent.has('gh:1')).toBe(false);
  });

  it('forgets a sender that left', () => {
    const limiter = createPacketLimiter();
    for (let i = 0; i < MAX_PACKETS_PER_SECOND; i += 1) {
      acceptPacket(limiter, 'gh:1', 0);
    }
    acceptPacket(limiter, 'gh:2', 0);
    forgetSender(limiter, 'gh:1');
    forgetSender(limiter, 'gh:404');
    expect(limiter.recent.has('gh:1')).toBe(false);
    expect(limiter.recent.has('gh:2')).toBe(true);
    expect(acceptPacket(limiter, 'gh:1', 0)).toBe(true);
  });
});
