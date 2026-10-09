/**
 * The third-person view: a camera on a boom behind the member's own robot,
 * over its right shoulder, so they can see what they're wearing. The member
 * (their eye, their heading and pitch) moves exactly as in first person; only
 * where the camera sits changes, and it always looks the way the member does.
 *
 * Front swings the boom round (`yaw + π`, no shoulder) to look the robot in
 * the face: the head and chestplate everyone else sees.
 *
 * The boom never passes through anything: it shortens, keeping its direction,
 * to stay inside the cave (short of the panels), above the floor and out of
 * everyone else's body. Same axes and angles as camera.ts.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */
import type { Vec3 } from './attenuation.js';
import { CAMERA_LIMITS } from './camera.js';
import { BODY } from './collide.js';

/**
 * First person (the eye is the camera), third person (the camera behind the
 * robot) or front (swung round to face it: how everyone else sees you).
 */
export type CameraView = 'first' | 'third' | 'front';

/** In the order V steps through them. */
export const CAMERA_VIEWS: readonly CameraView[] = Object.freeze(['first', 'third', 'front'] as const);

/** The view after `view`, as V steps: first, third, front, and round again. */
export function nextCameraView(view: CameraView): CameraView {
  return CAMERA_VIEWS[(CAMERA_VIEWS.indexOf(view) + 1) % CAMERA_VIEWS.length] ?? 'first';
}

/** The boom, in metres from the member's eye, and how the view moves. Frozen. */
export const THIRD_PERSON = Object.freeze({
  /** Behind the eye, along the way the member looks. */
  back: 3.6,
  /** Above the eye. */
  up: 0.45,
  /** How much further down the camera looks than the member, radians: the whole robot in frame, not just its head. */
  tilt: 0.12,
  /** To the right, so the robot stands a little left of centre. */
  side: 0.55,
  /** Steps the boom is shortened in when something is in the way. */
  steps: 50,
  /** The pitch the boom swings through: steeper and it would dive into the floor or flip overhead. */
  minPitch: -0.9,
  maxPitch: 1.2,
  /** The lowest the camera goes, metres above the floor. */
  floor: 0.35,
  /** How far inside the walking disk's edge the camera may go: still short of the panels. */
  wallMargin: 1.6,
  /** A body's shell, a little fattened, so the camera never shows the inside of someone's head. */
  bodyPad: 0.15,
  /** Seconds to glide between views. */
  blend: 0.4,
  /** Seconds to swing round between behind and in front. */
  swing: 0.5,
  /** How fast the boom grows back once a squeeze is past (per second, exponential). */
  ease: 6,
});

/** Where the third-person camera goes: `position`, and how much of the boom is out (0..1]. */
export interface Chase {
  position: Vec3;
  fraction: number;
}

/**
 * The boom's full offset from the eye for this heading and pitch (the
 * camera's own: `yaw + π` faces the robot), before anything shortens it.
 * `side` is the shoulder offset, to the camera's right.
 */
export function boomOffset(yaw: number, pitch: number, side: number = THIRD_PERSON.side): Vec3 {
  const p = Math.min(THIRD_PERSON.maxPitch, Math.max(THIRD_PERSON.minPitch, Number.isFinite(pitch) ? pitch : 0));
  const y = Number.isFinite(yaw) ? yaw : 0;
  // The way the member looks (pitch positive is down), and their right.
  const forward = { x: Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
  const right = { x: Math.cos(y), z: Math.sin(y) };
  return {
    x: -forward.x * THIRD_PERSON.back + right.x * side,
    y: -forward.y * THIRD_PERSON.back + THIRD_PERSON.up,
    z: -forward.z * THIRD_PERSON.back + right.z * side,
  };
}

/** Whether the camera may be at `at`: inside the cave, above the floor, outside everyone's body. */
export function clearAt(at: Vec3, bodies: readonly Vec3[]): boolean {
  if (Math.hypot(at.x, at.z) > CAMERA_LIMITS.radius + THIRD_PERSON.wallMargin) return false;
  if (at.y < THIRD_PERSON.floor) return false;
  const reach = BODY.radius + THIRD_PERSON.bodyPad;
  for (const body of bodies) {
    const inside =
      Math.hypot(at.x - body.x, at.z - body.z) < reach &&
      at.y > body.y - BODY.below - THIRD_PERSON.bodyPad &&
      at.y < body.y + BODY.above + THIRD_PERSON.bodyPad;
    if (inside) return false;
  }
  return true;
}

/**
 * The third-person camera for a member whose eye is at `eye`, heading `yaw`
 * and pitch `pitch`, with everyone else's eyes at `bodies`: the boom as long
 * as it can be, up to its full length, with the whole of it from the eye out
 * clear. However tight the space, never longer than that: with someone right
 * behind you the camera comes all the way in to your eye (the scene hides your
 * robot that close) rather than end up inside them. With your eye inside
 * someone already, it starts from the first clear point out along the boom;
 * with nowhere clear at all, it stays at your eye.
 */
export function chaseCamera(
  eye: Vec3,
  yaw: number,
  pitch: number,
  bodies: readonly Vec3[] = [],
  side: number = THIRD_PERSON.side,
): Chase {
  const offset = boomOffset(yaw, pitch, side);
  const at = (fraction: number): Vec3 => ({
    x: eye.x + offset.x * fraction,
    y: eye.y + offset.y * fraction,
    z: eye.z + offset.z * fraction,
  });
  const { steps } = THIRD_PERSON;
  // Where the clear stretch starts: the eye, or, with the eye inside someone (for the frame
  // before a bump parts you), the first step out along the boom that's clear of them.
  let first = 0;
  while (first <= steps && !clearAt(at(first / steps), bodies)) first += 1;
  if (first > steps) return { position: at(0), fraction: 0 };
  // Out from there: the first step that isn't clear stops the boom one step short of it.
  let fraction = 1;
  for (let i = first + 1; i <= steps; i += 1) {
    if (!clearAt(at(i / steps), bodies)) {
      fraction = (i - 1) / steps;
      break;
    }
  }
  return { position: at(fraction), fraction };
}

/** The view a stored value names, or null for anything else. */
export function parseCameraView(raw: string | null): CameraView | null {
  return raw === 'first' || raw === 'third' || raw === 'front' ? raw : null;
}

/** localStorage: the view each visitor last chose, kept across visits. */
export const CAMERA_VIEW_STORAGE_ITEM = 'forge.lobby.view.v1' as const;
