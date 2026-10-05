/**
 * Lobby presence, the pure half of multiplayer: the position packet members
 * exchange, when to send one, what a display name may contain, and how many
 * packets a sender may deliver. No DOM, no clock and no transport: the
 * presence feeds in apps/web pass the time in and move the bytes. How loud a
 * voice is at a distance, and who may hear it, is voice.ts's, on Fable's
 * attenuation and acoustics (attenuation.ts, acoustics.ts).
 *
 * Everything a peer sends is untrusted input, so decoding rejects rather than
 * repairs. A packet of the wrong size or version, or one placing its sender
 * somewhere no visitor's camera can go, is dropped whole, never clamped into
 * something plausible.
 */

import { CAMERA_LIMITS, CAMERA_SPEED } from './camera.js';

/**
 * A member's position and heading, on three.js axes (+Y up): metres, with yaw
 * in radians, 0 looking down −Z and increasing turning right. The same shape
 * as the presence feed's `SelfState`.
 */
export interface SelfState {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** The first byte of every position packet. A new layout takes a new number, and older peers drop it. */
export const POSITION_VERSION = 1;
/** The version byte, then little-endian int16s: x, y and z in centimetres, and yaw in milliradians. */
export const POSITION_BYTES = 9;

/**
 * Where a packet may place its sender: inside CAMERA_LIMITS (the walking
 * disk, and eye height to 220 m), give or take a centimetre, the packet's own
 * resolution. Anywhere else is a place no camera can reach, so no honest
 * client sends it.
 */
const POSITION_SLACK = 0.01;
const MAX_RADIUS = CAMERA_LIMITS.radius + POSITION_SLACK;
const MIN_Y = CAMERA_LIMITS.minY - POSITION_SLACK;
const MAX_Y = CAMERA_LIMITS.maxY + POSITION_SLACK;
const CM_PER_M = 100;
const MRAD_PER_RAD = 1000;
/**
 * π in milliradians, rounded down: the largest yaw either way that
 * `encodePosition` writes. 3142 would read back as 3.142 rad, past π.
 */
const MAX_YAW_MRAD = 3141;
const INT16_MIN = -0x8000;
const INT16_MAX = 0x7fff;
const TAU = 2 * Math.PI;

/**
 * The 9-byte packet for `state`. The yaw is normalised to (−π, π] first,
 * then every value is rounded to the nearest centimetre or milliradian (a
 * yaw within 0.6 mrad of ±π is written as ±3141 mrad, so it reads back
 * inside [−π, π]). A position past the int16 range saturates instead of
 * wrapping around, and a value that is not a finite number is written as the
 * int16 minimum. Either way the packet is one `decodePosition` rejects, so a
 * broken state never reaches peers as a wrong position.
 */
export function encodePosition(state: SelfState): Uint8Array {
  const bytes = new Uint8Array(POSITION_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, POSITION_VERSION);
  view.setInt16(1, toInt16(state.x * CM_PER_M), true);
  view.setInt16(3, toInt16(state.y * CM_PER_M), true);
  view.setInt16(5, toInt16(state.z * CM_PER_M), true);
  view.setInt16(7, toYawMrad(state.yaw), true);
  return bytes;
}

/**
 * The state in a position packet, or null unless the packet is one
 * `encodePosition` could have written for a camera inside CAMERA_LIMITS:
 * exactly 9 bytes, this version, no farther from the axis than the walking
 * disk's radius, a height from eye height to 220 m (each give or take 1 cm),
 * and a yaw within ±3141 mrad (π, to the milliradian). Nothing is clamped.
 * Reads a view at any offset into its buffer, and never throws.
 */
export function decodePosition(bytes: Uint8Array): SelfState | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== POSITION_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== POSITION_VERSION) {
    return null;
  }
  const x = view.getInt16(1, true) / CM_PER_M;
  const y = view.getInt16(3, true) / CM_PER_M;
  const z = view.getInt16(5, true) / CM_PER_M;
  const yaw = view.getInt16(7, true);
  if (Math.hypot(x, z) > MAX_RADIUS || y < MIN_Y || y > MAX_Y || Math.abs(yaw) > MAX_YAW_MRAD) {
    return null;
  }
  return { x, y, z, yaw: yaw / MRAD_PER_RAD };
}

/** At most ten position packets a second while moving… */
export const SEND_INTERVAL_MS = 100;
/** …and one a second otherwise, so a member who joins late, or missed a packet, still finds you. */
export const HEARTBEAT_MS = 1000;
/** A move worth sending: more than a centimetre… */
const MOVE_THRESHOLD = 0.01;
/** …or a turn of more than 5 milliradians. */
const TURN_THRESHOLD = 0.005;

/**
 * Whether to send `current` now, given the state last sent (null: nothing
 * yet) and when it went. `lastSentAt` and `now` are milliseconds on one
 * monotonic clock. Sends at most every SEND_INTERVAL_MS while the position
 * moved more than 1 cm or the yaw turned more than 5 mrad since the last
 * packet, and every HEARTBEAT_MS regardless. A clock that went backwards
 * sends (and so starts over); an elapsed time that is not a number never does.
 */
export function sendPolicy(lastSent: SelfState | null, lastSentAt: number, now: number, current: SelfState): boolean {
  if (lastSent === null) {
    return true;
  }
  const elapsed = now - lastSentAt;
  if (Number.isNaN(elapsed)) {
    return false;
  }
  if (elapsed < 0 || elapsed >= HEARTBEAT_MS) {
    return true;
  }
  if (elapsed < SEND_INTERVAL_MS) {
    return false;
  }
  const moved = Math.hypot(current.x - lastSent.x, current.y - lastSent.y, current.z - lastSent.z);
  const turned = Math.abs(wrapAngle(current.yaw - lastSent.yaw));
  return moved > MOVE_THRESHOLD || turned > TURN_THRESHOLD;
}

/** GitHub's login limit, and the most a name tag shows. */
export const NAME_MAX_LENGTH = 39;
const FALLBACK_NAME = 'member';
/**
 * Control characters (C0 and C1), format characters (bidirectional overrides
 * and isolates, zero-width characters) and line or paragraph separators:
 * anything that could hide, reorder or break a name tag, or make one name
 * pass for another.
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/**
 * Letters and symbols that draw nothing: the Hangul fillers (U+3164, U+115F,
 * U+1160, the halfwidth U+FFA0) and the Braille blank (U+2800). A name made
 * of them is as empty as one made of spaces, so they count as spaces.
 */
const BLANK_CHARACTERS = /[ᅟᅠ⠀ㅤﾠ]/gu;
/** Combining marks a base character may carry; more would only stack up over the row and the name tag. */
const MAX_MARKS_PER_BASE = 2;
const MARK = /^\p{M}$/u;
const VISIBLE = /[\p{L}\p{N}]/u;

/**
 * A display name that is safe to show: unsafe characters stripped, the blank
 * ones made spaces, at most two combining marks on any one character,
 * surrounding whitespace trimmed, at most NAME_MAX_LENGTH code points (a
 * character outside the Basic Multilingual Plane is never split), and
 * "member" when no letter or number is left to see or the input is not a
 * string. Render it with `textContent` all the same: this is not HTML
 * escaping.
 */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') {
    return FALLBACK_NAME;
  }
  let clamped = '';
  let count = 0;
  let marks = 0;
  for (const character of name.replace(UNSAFE_CHARACTERS, '').replace(BLANK_CHARACTERS, ' ').trim()) {
    if (count === NAME_MAX_LENGTH) {
      break;
    }
    if (MARK.test(character)) {
      marks += 1;
      if (marks > MAX_MARKS_PER_BASE) {
        continue;
      }
    } else {
      marks = 0;
    }
    clamped += character;
    count += 1;
  }
  clamped = clamped.trimEnd();
  return VISIBLE.test(clamped) ? clamped : FALLBACK_NAME;
}

/** The most packets one sender may deliver in any one second: three times the ten a well-behaved peer sends. */
export const MAX_PACKETS_PER_SECOND = 30;
const RATE_WINDOW_MS = 1000;

/** Inbound packet history per sender. One per feed, from `createPacketLimiter()`. */
export interface PacketLimiter {
  /** Arrival times (ms) of each sender's packets accepted within the last second, oldest first. */
  readonly recent: Map<string, number[]>;
}

export function createPacketLimiter(): PacketLimiter {
  return { recent: new Map() };
}

/**
 * Whether to accept a packet from `identity` arriving at `now` (ms, a
 * monotonic clock). Accepts at most MAX_PACKETS_PER_SECOND in any one-second
 * window per sender. A rejected packet does not count against its sender,
 * a time that is not a finite number is rejected, and a clock that went
 * backwards starts that sender's window over.
 */
export function acceptPacket(state: PacketLimiter, identity: string, now: number): boolean {
  if (!Number.isFinite(now)) {
    return false;
  }
  let times = state.recent.get(identity);
  if (times === undefined) {
    times = [];
    state.recent.set(identity, times);
  }
  const newest = times[times.length - 1];
  if (newest !== undefined && now < newest) {
    times.length = 0;
  }
  let expired = 0;
  while (expired < times.length && (times[expired] as number) <= now - RATE_WINDOW_MS) {
    expired += 1;
  }
  times.splice(0, expired);
  if (times.length >= MAX_PACKETS_PER_SECOND) {
    return false;
  }
  times.push(now);
  return true;
}

/** Drops a sender's history: call it when the sender leaves, so the limiter never outgrows the room. */
export function forgetSender(state: PacketLimiter, identity: string): void {
  state.recent.delete(identity);
}

/**
 * Metres any step may cover on top of CAMERA_SPEED's: packets that left a
 * sender a tenth of a second apart can arrive together.
 */
export const STEP_SLACK = 3;

/**
 * Whether a peer could have walked from `from`, heard at `fromAt`, to `to`,
 * heard at `at` (milliseconds on one monotonic clock): no faster across the
 * floor or up and down than CAMERA_SPEED allows, give or take STEP_SLACK
 * metres. A peer's first position (`from` null) is always plausible; a time
 * that went backwards, or isn't a number, allows the slack alone; a position
 * that isn't a number never is. A packet that fails is ignored, which keeps
 * a modified client from flipping between two places faster than anyone can
 * walk.
 */
export function plausibleStep(from: SelfState | null, fromAt: number, to: SelfState, at: number): boolean {
  if (from === null) {
    return true;
  }
  const elapsed = at - fromAt;
  const seconds = elapsed > 0 ? elapsed / 1000 : 0;
  const across = Math.hypot(to.x - from.x, to.z - from.z);
  const up = Math.abs(to.y - from.y);
  return across <= CAMERA_SPEED.walk * seconds + STEP_SLACK && up <= CAMERA_SPEED.rise * seconds + STEP_SLACK;
}

/** `angle` in (−π, π]; NaN for anything that is not a finite number. */
function wrapAngle(angle: number): number {
  const turned = angle % TAU;
  if (turned > Math.PI) {
    return turned - TAU;
  }
  if (turned <= -Math.PI) {
    return turned + TAU;
  }
  return turned;
}

function toInt16(value: number): number {
  if (!Number.isFinite(value)) {
    return INT16_MIN;
  }
  return Math.min(INT16_MAX, Math.max(INT16_MIN, Math.round(value)));
}

function toYawMrad(yaw: number): number {
  const mrad = toInt16(wrapAngle(yaw) * MRAD_PER_RAD);
  return mrad === INT16_MIN ? mrad : Math.min(MAX_YAW_MRAD, Math.max(-MAX_YAW_MRAD, mrad));
}
