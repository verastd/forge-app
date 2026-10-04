/**
 * Free roam, as the prototype drives it: drag to look, WASD or the touch
 * stick to walk, Space/Shift or the lift buttons to rise and fall, the wheel
 * to bob up and down, arrow keys to turn and tilt. A tap (a press that moved
 * less than 8 px) picks whatever panel is under it. The mouse's place over
 * the canvas is kept for the scene's hover (the cursor, and an empty slot's
 * readout).
 *
 * Angles follow @forge/lobby's camera.ts: yaw grows turning right, pitch
 * grows looking down. A drag takes hold of the cave and pulls it, as a
 * photo sphere or a map does: drag right and the view turns left, drag down
 * and it tilts up (the operator found the camera-steering way round
 * unintuitive). The arrow keys still steer: → turns right. The look eases
 * toward its target (faster when the visitor asked for reduced motion);
 * walking is an acceleration with drag, clamped into the cave each step.
 */

import * as THREE from 'three';
import { CAMERA_LIMITS } from '@forge/lobby';

/** What a tap or the crosshair lands on: a lit app's panel, or an empty slot by index. */
export type Hit = { slug: string; lit: true } | { slot: number; lit: false };

/** The camera's moving parts. Yaw here is unwrapped, so easing never takes the long way round. */
export interface Motion {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  tYaw: number;
  tPitch: number;
}

export interface ControlsOptions {
  canvas: HTMLCanvasElement;
  /** The touch stick and its knob, and the rise and fall buttons (shown only on coarse pointers). */
  stick: HTMLElement | null;
  knob: HTMLElement | null;
  rise: HTMLElement | null;
  fall: HTMLElement | null;
  /** Hit-tests a point in client coordinates. */
  pick(clientX: number, clientY: number): Hit | null;
  /** A tap landed on something, from a mouse, a finger or a pen. */
  onTap(hit: Hit, pointerType: string): void;
}

/** Where the mouse is over the canvas, in client coordinates, or null once it has left. */
export interface HoverChange {
  at: { x: number; y: number } | null;
}

export interface Controls {
  /** Advances the look and the walk by `dt` seconds. */
  step(dt: number, reducedMotion: boolean): void;
  /** The mouse's latest move over the canvas (or its leaving it), once; null when nothing changed. */
  takeHover(): HoverChange | null;
  /** A drag has gone past a tap's slop: the visitor is looking around, not pointing. */
  looking(): boolean;
  dispose(): void;
}

const LOOK_PER_PIXEL = 0.0032;
const TAP_SLOP = 8;
const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

/** Typing somewhere: the keys belong to the field, not the camera. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest('input, textarea, select') !== null;
}

/** A focused link or button keeps Space and Enter for activating itself. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('a[href], button, summary, [role="button"]') !== null;
}

export function createControls(motion: Motion, opts: ControlsOptions): Controls {
  const { canvas, stick, knob, rise, fall } = opts;
  const keys = new Map<string, boolean>();
  const joy = { x: 0, y: 0 };
  let drag: { id: number; x: number; y: number; sx: number; sy: number; looking: boolean } | null = null;
  let hover: HoverChange | null = null;
  let stickPointer: number | null = null;
  const cleanups: Array<() => void> = [];

  function on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  function onWindow<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void {
    window.addEventListener(type, listener);
    cleanups.push(() => window.removeEventListener(type, listener));
  }

  const capture = (element: Element, pointerId: number): void => {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone; its up/cancel events will tidy up.
    }
  };

  // ---- drag to look, tap to open ----
  on(canvas, 'pointerdown', (event) => {
    if (drag || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      sx: event.clientX,
      sy: event.clientY,
      looking: false,
    };
    capture(canvas, event.pointerId);
  });
  on(canvas, 'pointermove', (event) => {
    if (drag && event.pointerId === drag.id) {
      // Grab and pull: the view turns against the drag.
      motion.tYaw -= (event.clientX - drag.x) * LOOK_PER_PIXEL;
      motion.tPitch = THREE.MathUtils.clamp(
        motion.tPitch - (event.clientY - drag.y) * LOOK_PER_PIXEL,
        CAMERA_LIMITS.minPitch,
        CAMERA_LIMITS.maxPitch,
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.looking && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) >= TAP_SLOP) {
        drag.looking = true;
      }
    }
    if (event.pointerType === 'mouse') {
      hover = { at: { x: event.clientX, y: event.clientY } };
    }
  });
  on(canvas, 'pointerup', (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const tap = Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < TAP_SLOP;
    drag = null;
    if (event.pointerType === 'mouse') {
      hover = { at: { x: event.clientX, y: event.clientY } };
    }
    if (tap) {
      const hit = opts.pick(event.clientX, event.clientY);
      if (hit) {
        opts.onTap(hit, event.pointerType);
      }
    }
  });
  const endDrag = (event: PointerEvent): void => {
    if (drag && event.pointerId === drag.id) {
      drag = null;
    }
  };
  on(canvas, 'pointercancel', endDrag);
  on(canvas, 'lostpointercapture', endDrag);
  on(canvas, 'pointerleave', (event) => {
    if (event.pointerType === 'mouse') {
      hover = { at: null };
    }
    canvas.style.cursor = '';
  });

  // ---- the wheel bobs you up and down ----
  on(
    canvas,
    'wheel',
    (event) => {
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight || 800 : 1;
      motion.vel.y -= event.deltaY * scale * 0.02;
    },
    { passive: true },
  );

  // ---- keys ----
  onWindow('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !MOVE_KEYS.has(event.code) || isTextEntry(event.target)) {
      return;
    }
    if (event.code === 'Space' && isControl(event.target)) {
      return;
    }
    keys.set(event.code, true);
    if (event.code === 'Space' || event.code.startsWith('Arrow')) {
      event.preventDefault();
    }
  });
  onWindow('keyup', (event) => {
    keys.delete(event.code);
  });
  // A key held while the window loses focus never sends its keyup: let go of everything.
  onWindow('blur', () => {
    keys.clear();
    joy.x = joy.y = 0;
    drag = null;
  });

  // ---- the touch stick ----
  if (stick) {
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== stickPointer) {
        return;
      }
      stickPointer = null;
      joy.x = joy.y = 0;
      if (knob) {
        knob.style.transform = '';
      }
    };
    on(stick, 'pointerdown', (event) => {
      stickPointer = event.pointerId;
      capture(stick, event.pointerId);
    });
    on(stick, 'pointermove', (event) => {
      if (event.pointerId !== stickPointer) {
        return;
      }
      const rect = stick.getBoundingClientRect();
      const radius = rect.width / 2;
      if (radius <= 0) {
        return;
      }
      let dx = event.clientX - (rect.left + radius);
      let dy = event.clientY - (rect.top + radius);
      const length = Math.hypot(dx, dy);
      if (length > radius) {
        dx *= radius / length;
        dy *= radius / length;
      }
      joy.x = dx / radius;
      joy.y = -dy / radius;
      if (knob) {
        knob.style.transform = `translate(${dx}px,${dy}px)`;
      }
    });
    on(stick, 'pointerup', release);
    on(stick, 'pointercancel', release);
    on(stick, 'lostpointercapture', release);
  }

  // ---- rise and fall ----
  const hold = (button: HTMLElement | null, code: string): void => {
    if (!button) {
      return;
    }
    const up = (): void => {
      keys.delete(code);
    };
    on(button, 'pointerdown', (event) => {
      keys.set(code, true);
      capture(button, event.pointerId);
    });
    on(button, 'pointerup', up);
    on(button, 'pointercancel', up);
    on(button, 'lostpointercapture', up);
  };
  hold(rise, 'Space');
  hold(fall, 'ShiftLeft');

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const acc = new THREE.Vector3();

  return {
    step(dt, reducedMotion) {
      const ease = 1 - Math.pow(1 - (reducedMotion ? 0.5 : 0.18), dt * 60);
      motion.yaw += (motion.tYaw - motion.yaw) * ease;
      motion.pitch += (motion.tPitch - motion.pitch) * ease;
      if (keys.get('ArrowLeft')) motion.tYaw -= dt * 1.4;
      if (keys.get('ArrowRight')) motion.tYaw += dt * 1.4;
      if (keys.get('ArrowUp')) motion.tPitch = Math.max(CAMERA_LIMITS.minPitch, motion.tPitch - dt);
      if (keys.get('ArrowDown')) motion.tPitch = Math.min(CAMERA_LIMITS.maxPitch, motion.tPitch + dt);

      fwd.set(Math.sin(motion.yaw), 0, -Math.cos(motion.yaw));
      right.set(Math.cos(motion.yaw), 0, Math.sin(motion.yaw));
      acc.set(0, 0, 0);
      if (keys.get('KeyW')) acc.add(fwd);
      if (keys.get('KeyS')) acc.sub(fwd);
      if (keys.get('KeyD')) acc.add(right);
      if (keys.get('KeyA')) acc.sub(right);
      acc.addScaledVector(fwd, joy.y).addScaledVector(right, joy.x);
      if (keys.get('Space')) acc.y += 1;
      if (keys.get('ShiftLeft') || keys.get('ShiftRight')) acc.y -= 1;

      motion.vel.addScaledVector(acc, dt * 22);
      motion.vel.multiplyScalar(Math.pow(0.02, dt));
      motion.pos.addScaledVector(motion.vel, dt);

      const r = Math.hypot(motion.pos.x, motion.pos.z);
      if (r > CAMERA_LIMITS.radius) {
        motion.pos.x *= CAMERA_LIMITS.radius / r;
        motion.pos.z *= CAMERA_LIMITS.radius / r;
      }
      motion.pos.y = THREE.MathUtils.clamp(motion.pos.y, CAMERA_LIMITS.minY, CAMERA_LIMITS.maxY);
    },
    takeHover() {
      const change = hover;
      hover = null;
      return change;
    },
    looking() {
      return drag !== null && drag.looking;
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      keys.clear();
    },
  };
}

// ---------- hit-testing ----------

export interface Picker {
  /** What is under a point in client coordinates. */
  pick(clientX: number, clientY: number): Hit | null;
  /** What is under a point in normalised device coordinates ((0, 0) is the crosshair). */
  pickNdc(x: number, y: number): Hit | null;
}

/**
 * The prototype's hit test: a ray against the lit screens first, then the
 * dark grid's `InstancedMesh`, whose instance id is the slot index. A ray
 * that clips a lit slot's own grid cell (the screen stands 5 cm in front of
 * it) still counts as that app.
 */
export function createPicker(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  screens: ReadonlyArray<{ slug: string; slot: number; mesh: THREE.Object3D }>,
  grid: THREE.InstancedMesh,
): Picker {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const meshes = screens.map((screen) => screen.mesh);
  const slugByMesh = new Map(screens.map((screen) => [screen.mesh, screen.slug]));
  const slugBySlot = new Map(screens.map((screen) => [screen.slot, screen.slug]));

  function pickNdc(x: number, y: number): Hit | null {
    ndc.set(x, y);
    ray.setFromCamera(ndc, camera);
    const lit = ray.intersectObjects(meshes, false)[0];
    const litSlug = lit ? slugByMesh.get(lit.object) : undefined;
    if (litSlug !== undefined) {
      return { slug: litSlug, lit: true };
    }
    const cell = ray.intersectObject(grid, false)[0];
    if (!cell || cell.instanceId === undefined) {
      return null;
    }
    const slug = slugBySlot.get(cell.instanceId);
    return slug !== undefined ? { slug, lit: true } : { slot: cell.instanceId, lit: false };
  }

  return {
    pickNdc,
    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return pickNdc(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    },
  };
}
