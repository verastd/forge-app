/**
 * The lobby camera, saved when a panel opens and read back when the visitor
 * returns (`/apps?from=<slug>`), so they land where they left. The shell does
 * the storage reads and writes, and this module only encodes. Stored values
 * are untrusted input (another tab, an older build, a curious user), so
 * parsing never throws: it rejects what it can't read and clamps the rest
 * into the cave.
 */

import { clampCamera } from './camera.js';
import type { CameraState } from './camera.js';

/**
 * The Web Storage item the camera is saved under. Versioned in the name
 * itself: the prototype's unversioned `forge.lobby.pos`, and anything a
 * future shape writes, are simply never read.
 */
export const CAMERA_STORAGE_ITEM = 'forge.lobby.pos.v2' as const;

/** Far above any real value (about 110 characters). Anything longer is not ours. */
const MAX_LENGTH = 256;

/** `{"x":…,"y":…,"z":…,"yaw":…,"pitch":…}`, clamped into the cave first so it always reads back. */
export function serializeCameraState(s: CameraState): string {
  const { x, y, z, yaw, pitch } = clampCamera(s);
  return JSON.stringify({ x, y, z, yaw, pitch });
}

/**
 * The saved camera, or null when there is nothing usable: no value, a value
 * too long to be ours, unreadable JSON, anything but an object, or any of
 * the five fields missing or not a finite number. Otherwise the state comes
 * back clamped into the cave (`clampCamera`), extra fields dropped. Never
 * throws.
 */
export function parseCameraState(raw: string | null): CameraState | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) {
    return null;
  }
  const { x, y, z, yaw, pitch } = data;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z) || !isFiniteNumber(yaw) || !isFiniteNumber(pitch)) {
    return null;
  }
  return clampCamera({ x, y, z, yaw, pitch });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
