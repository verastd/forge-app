/**
 * An empty slot's readout, and the light it throws on the rock behind it.
 *
 * While the mouse is over an empty slot (or for READOUT_TAP_MS after a finger
 * tapped one, since a touch screen has no hover), that slot's panel shows a
 * small readout drawn inside it, in the hologram's own colour and additive
 * look: its number (the registry's slot index, `row·columns + col`, the same
 * number `data-focus` and the registry use, four digits), its row and
 * column, that it is empty, and how high its centre stands above the floor.
 * One plane with one CanvasTexture serves every slot: it moves to the slot,
 * just in front of the grid's cell and facing in, and redraws only when the
 * slot changes. The mono face is the site's (`--font-mono`), and nothing is
 * drawn before it has loaded: the readout waits for it, for FONT_WAIT_MS at
 * most (a face that never comes can't keep the readout away; it is drawn
 * again if the face turns up later).
 *
 * Behind it a warm point light, a little in from the wall and below the
 * panel's centre, rakes across the rock around that slot (the rock is a
 * displaced, normal-mapped standard material, so it shows its relief), so
 * the cave's rock shows through the translucent grid. Its reach covers the
 * slot and a panel or so around it. The light is made once, with the scene,
 * and only its intensity ever changes (0 when idle): adding or removing a
 * light would make three.js recompile every lit material, which is also why
 * peers.ts pools its lights.
 *
 * Both fade in and out over FADE_S, by the clock rather than by frames; with
 * reduced motion they just switch.
 */

import * as THREE from 'three';
import { WALL, slotFromIndex, slotPose } from '@forge/lobby';

/** How long a finger's tap on an empty slot shows its readout. */
export const READOUT_TAP_MS = 3000;
const FADE_S = 0.15;
const TEX_W = 1024;
const TEX_H = 576;
/** How far in front of its grid cell (toward the cave's axis) the readout stands: clear of it, so no z-fighting. */
const LIFT = 0.03;
/** The light: this far in from the panel, toward the axis, and this far under its centre, so it rakes the rock. */
const GLOW_IN = 1.2;
const GLOW_DROP = 0.35;
/** Its reach, in metres, and its intensity at full, in candela (three.js's physical units). */
const GLOW_RANGE = 8;
const GLOW_INTENSITY = 45;
const MONO_FALLBACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** The longest the readout waits for its face before drawing with what there is. */
const FONT_WAIT_MS = 1500;

const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

/** The site's mono face (globals.css's `--font-mono`) as a canvas font family list. */
function monoFamily(): string {
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return family === '' ? MONO_FALLBACK : family;
}

/** The readout's three lines for a slot. */
export function readoutLines(slot: number): [string, string, string] {
  const { col, row } = slotFromIndex(slot);
  const height = slotPose(slot).position[1];
  return [`SLOT ${pad(slot, 4)}`, `R${pad(row, 2)} · C${pad(col, 2)}`, `EMPTY · ${height.toFixed(1)} M UP`];
}

export interface SlotReadoutOptions {
  /** The grid's colour and time uniforms' values, shared so the readout matches the grid exactly. */
  color: THREE.Color;
  time: { value: number };
  /** The light's colour. */
  glow: number;
}

export interface SlotReadout {
  /** Puts the readout on `slot`, or takes it away (null). Redraws only when the slot changes. */
  show(slot: number | null): void;
  /** The slot it is on or coming on to, or null while it is off or going. */
  readonly slot: number | null;
  /** Advances the fade by `seconds` of wall-clock time. */
  step(seconds: number, reducedMotion: boolean): void;
  dispose(): void;
}

export function createSlotReadout(scene: THREE.Scene, opts: SlotReadoutOptions): SlotReadout {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;

  const uOpacity = { value: 0 };
  const material = new THREE.ShaderMaterial({
    name: 'slot-readout',
    uniforms: { uMap: { value: texture }, uColor: { value: opts.color }, uOpacity, uTime: opts.time },
    vertexShader: `
      varying vec2 vUv; varying float vDist;
      void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.); vDist=length(mv.xyz); gl_Position=projectionMatrix*mv; }`,
    // The grid's look: its colour, added to whatever is behind, with its scan lines; drawn white, so alpha is coverage.
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
      varying vec2 vUv; varying float vDist;
      void main(){
        float a=texture2D(uMap,vUv).a;
        float scan=0.86+0.14*sin(vUv.y*160.-uTime*2.4);
        float fade=0.55+0.45*exp(-vDist*0.03);
        gl_FragColor=vec4(uColor*(a*scan*fade*uOpacity*1.35),1.);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const geometry = new THREE.PlaneGeometry(WALL.panelWidth, WALL.panelHeight);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'slot-readout';
  // After the grid (2), which it sits on.
  mesh.renderOrder = 3;
  mesh.visible = false;
  scene.add(mesh);

  const light = new THREE.PointLight(opts.glow, 0, GLOW_RANGE, 2);
  light.name = 'slot-glow';
  scene.add(light);

  const family = monoFamily();
  let target: number | null = null;
  let drawn: number | null = null;
  let fade = 0;
  let disposed = false;
  /** The face has loaded, or the wait for it is over. */
  let fontSettled = false;

  const draw = (slot: number): void => {
    drawn = slot;
    if (!ctx) {
      return;
    }
    const [number, place, status] = readoutLines(slot);
    ctx.clearRect(0, 0, TEX_W, TEX_H);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.85)';
    ctx.shadowBlur = 16;
    // Corner ticks, inside the cell's own border.
    ctx.lineWidth = 6;
    const inset = 54;
    const tick = 64;
    for (const [x, y, dx, dy] of [
      [inset, inset, 1, 1],
      [TEX_W - inset, inset, -1, 1],
      [inset, TEX_H - inset, 1, -1],
      [TEX_W - inset, TEX_H - inset, -1, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * tick);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * tick, y);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Sized to read from the spawn point, 25 m off: the longest third line (row 89, 276.6 m) still clears the ticks.
    ctx.font = `700 148px ${family}`;
    ctx.fillText(number, TEX_W / 2, TEX_H * 0.37);
    ctx.font = `600 96px ${family}`;
    ctx.fillText(place, TEX_W / 2, TEX_H * 0.6);
    ctx.globalAlpha = 0.85;
    ctx.font = `600 72px ${family}`;
    ctx.fillText(status, TEX_W / 2, TEX_H * 0.79);
    ctx.restore();
    texture.needsUpdate = true;
  };

  const place = (slot: number): void => {
    const { position, rotationY } = slotPose(slot);
    const [x, y, z] = position;
    const r = Math.hypot(x, z);
    // Toward the cave's axis, along the floor.
    const inX = -x / r;
    const inZ = -z / r;
    mesh.position.set(x + inX * LIFT, y, z + inZ * LIFT);
    mesh.rotation.set(0, rotationY, 0);
    light.position.set(x + inX * GLOW_IN, y - GLOW_DROP, z + inZ * GLOW_IN);
  };

  // The face first. Once it has loaded (or the wait is over), the slot waiting for it is drawn;
  // a face that arrives after the wait redraws what is on screen.
  const settle = (): void => {
    if (disposed) {
      return;
    }
    fontSettled = true;
    const slot = target ?? drawn;
    if (slot !== null) {
      draw(slot);
    }
  };
  if ('fonts' in document) {
    const timer = window.setTimeout(settle, FONT_WAIT_MS);
    document.fonts.load(`700 64px ${family}`).then(
      () => {
        window.clearTimeout(timer);
        settle();
      },
      () => {
        window.clearTimeout(timer);
        settle();
      },
    );
  } else {
    fontSettled = true;
  }

  return {
    show(slot) {
      if (slot === target) {
        return;
      }
      target = slot;
      if (slot !== null) {
        // Straight from one slot to the next: no fade between them, just the new slot.
        if (fontSettled && slot !== drawn) {
          draw(slot);
        }
        place(slot);
      }
    },
    get slot() {
      return target;
    },
    step(seconds, reducedMotion) {
      // Shown once its slot is drawn: not before the face has loaded.
      const goal = target !== null && drawn === target ? 1 : 0;
      if (reducedMotion) {
        fade = goal;
      } else if (fade < goal) {
        fade = Math.min(goal, fade + seconds / FADE_S);
      } else if (fade > goal) {
        fade = Math.max(goal, fade - seconds / FADE_S);
      }
      uOpacity.value = fade;
      mesh.visible = fade > 0;
      light.intensity = GLOW_INTENSITY * fade;
    },
    dispose() {
      disposed = true;
      scene.remove(mesh);
      scene.remove(light);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      light.dispose();
    },
  };
}
