/**
 * The lobby camera, free to roam the cave: where the visitor stands and which
 * way they look. Axes and angles follow layout.ts (three.js, +Y up).
 *
 * - `x`, `y`, `z` is the eye, in metres. The visitor walks a disk around the
 *   axis that stays 2.5 m short of the panels, and flies between eye height
 *   and 220 m.
 * - `yaw` is the heading: 0 looks down −Z, and it grows turning RIGHT, so the
 *   scene applies it as `camera.rotateY(−yaw)` and walks forward along
 *   `(sin yaw, 0, −cos yaw)`. Canonical form is (−π, π].
 * - `pitch` tilts the view: positive looks DOWN (the scene applies
 *   `camera.rotateX(−pitch)` after the yaw), negative looks up.
 *
 * Every function here is pure and returns a new state.
 */

import { WALL, slotFromIndex } from './layout.js';

export interface CameraState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/**
 * Where the camera may be: `radius` from the axis at most (the panels' ring
 * less 2.5 m), `y` from eye height to 220 m, and `pitch` from −1.45 (up)
 * to 1.5 (down). Yaw is never clamped, only wrapped. Frozen.
 */
export const CAMERA_LIMITS: Readonly<{
  radius: number;
  minY: number;
  maxY: number;
  minPitch: number;
  maxPitch: number;
}> = Object.freeze({
  radius: WALL.ringRadius - 2.5,
  minY: WALL.eye,
  maxY: 220,
  minPitch: -1.45,
  maxPitch: 1.5,
});

/** The centre of the cave at eye height, looking down −Z (at slot 0) and a touch down. Frozen. */
export const INITIAL_CAMERA: CameraState = Object.freeze({ x: 0, y: WALL.eye, z: 0, yaw: 0, pitch: 0.04 });

/**
 * The fastest the camera moves, in metres a second. `walk` is across the
 * floor: the keys and the touch stick together, on a diagonal, come to 15.9.
 * `rise` is up or down: Space and Shift come to 5.6, and the wheel is held to
 * it. The scene's controls hold the camera to both, so a peer whose packets
 * place them farther apart than this allows (presence.ts `plausibleStep`) is
 * not taken at their word. Frozen.
 */
export const CAMERA_SPEED: Readonly<{ walk: number; rise: number }> = Object.freeze({ walk: 16, rise: 24 });

const TAU = 2 * Math.PI;

/**
 * The canonical form of a yaw: the same direction, in (−π, π], never −0. A
 * non-finite yaw becomes 0 rather than poisoning the camera with NaN.
 */
export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) {
    return 0;
  }
  let wrapped = yaw % TAU;
  if (wrapped <= -Math.PI) {
    wrapped += TAU;
  } else if (wrapped > Math.PI) {
    wrapped -= TAU;
  }
  // `+ 0` turns -0 into 0, so a stored or displayed yaw never reads "-0".
  return wrapped + 0;
}

/**
 * The same state inside the cave: the eye pulled straight in toward the axis
 * onto the walking disk's edge if it is past it, `y` and `pitch` clamped to
 * CAMERA_LIMITS, and the yaw normalised. A field that is not a finite number
 * takes INITIAL_CAMERA's value instead, so a corrupt state still lands
 * somewhere sensible.
 */
export function clampCamera(s: CameraState): CameraState {
  let x = finiteOr(s.x, INITIAL_CAMERA.x);
  let z = finiteOr(s.z, INITIAL_CAMERA.z);
  // Divide by the larger component first, so huge finite values can't overflow hypot to Infinity.
  const largest = Math.max(Math.abs(x), Math.abs(z));
  const distance = largest === 0 ? 0 : largest * Math.hypot(x / largest, z / largest);
  if (distance > CAMERA_LIMITS.radius) {
    x = (x / distance) * CAMERA_LIMITS.radius;
    z = (z / distance) * CAMERA_LIMITS.radius;
  }
  return {
    x: x + 0,
    y: clamp(finiteOr(s.y, INITIAL_CAMERA.y), CAMERA_LIMITS.minY, CAMERA_LIMITS.maxY),
    z: z + 0,
    yaw: normalizeYaw(s.yaw),
    pitch: clamp(finiteOr(s.pitch, INITIAL_CAMERA.pitch), CAMERA_LIMITS.minPitch, CAMERA_LIMITS.maxPitch),
  };
}

/**
 * The yaw that looks straight at a slot's column from the axis: the
 * column's angle, `col·2π/columns`, normalised. Every row of a column shares
 * it. Throws a RangeError unless `slotIndex` names a slot (layout.ts).
 */
export function facing(slotIndex: number): number {
  const { col } = slotFromIndex(slotIndex);
  return normalizeYaw((col * TAU) / WALL.columns);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value)) + 0;
}
