/**
 * The Apps lobby's cave: the operator's prototype (Cave.html) as a plain
 * three.js module, with no React. `createCave(canvas, opts)` builds the scene
 * on a canvas the caller owns and runs its own frame loop until `dispose()`.
 *
 * What it draws, as the prototype does: a basalt rock wall, an obsidian
 * floor, the holographic grid of 2,880 dark slots (one `InstancedMesh`), a
 * lit screen per lit app at its registry slot, a lattice of spotlights that
 * throws the nearest screen's light onto the floor, dust drifting in that
 * light, and the other people in the lobby (peers.ts). The heavy parts (the
 * wall's displacement and two normal maps) are built one per animation frame
 * before the first render, so the page stays responsive behind the veil.
 *
 * The mouse over an empty slot (or a finger's tap on one, for a few
 * seconds) puts that slot's readout in its panel and lights the rock behind
 * it (readout.ts). Every colour comes from palette.ts.
 *
 * Reduced motion: no dust drift, no light flicker, a still grid, no bobbing
 * orbs, a readout that switches rather than fades, and the look eases
 * faster (controls.ts).
 *
 * The shell hears about it through callbacks: ready after the first frame,
 * lost when the WebGL context goes, error when a frame throws, and the
 * focus, peer count and picks as they change. Position is written straight
 * onto the lobby root as `data-x/y/z/yaw`, ten times a second, and the
 * readout's slot as `data-hover-slot` (empty when none) and its light as
 * `data-hover-glow` (on or off) whenever they change.
 */

import * as THREE from 'three';
import { WALL, clampCamera, normalizeYaw, slotPose } from '@forge/lobby';
import type { AppEntry, CameraState } from '@forge/lobby';

import type { PeerState, PresenceFeed, SelfState } from '../presence/types';
import { createControls, createPicker } from './controls';
import type { Hit, Motion } from './controls';
import { CAVE_PALETTE, shaderColor } from './palette';
import { createPeers } from './peers';
import type { PeerClasses } from './peers';
import { READOUT_TAP_MS, createSlotReadout } from './readout';
import { SCREEN_INSET, applyTV, createEmbers, createScreenPanel, createTvLight } from './screen';
import type { ScreenPanel } from './screen';

const R = WALL.radius;
const PW = WALL.panelWidth;
const PH = WALL.panelHeight;
const RC = WALL.ringRadius;
const WALL_H = 300;
/** A lit screen loads its media once it is this close, or in view. */
const MEDIA_RANGE = 40;
const WARM = 0xff6a24;
const NO_PEERS: ReadonlyMap<string, PeerState> = new Map();

/** The visitor's browser asked for less data (Save-Data; Chromium's `navigator.connection.saveData`). */
function savesData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

// ---------- noise (the prototype's, verbatim) ----------

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const wrap = (a: number, p: number): number => (p ? ((a % p) + p) % p : a);

function noise3(x: number, y: number, z: number, px = 0, py = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const zf = smooth(z - zi);
  let v = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const h = hash3(wrap(xi + i, px), wrap(yi + j, py), zi + k);
        v += h * (i ? xf : 1 - xf) * (j ? yf : 1 - yf) * (k ? zf : 1 - zf);
      }
    }
  }
  return v * 2 - 1;
}

function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x, y, z);
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    a *= 0.5;
  }
  return s;
}

/** Periodic fBm, so the normal maps tile. */
function fbm2p(x: number, y: number, px: number, py: number, octaves: number, seed: number): number {
  let a = 0.5;
  let s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x, y, seed + i * 17, px, py);
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    a *= 0.5;
  }
  return s;
}

/** How many frames each heavy build job is spread over, so no one frame blocks for long. */
const SLICES = 4;

/**
 * A tiling normal map from a height function over the unit square, as build
 * steps: the height field a slice of rows per step, then the normals.
 */
function normalTexSteps(
  size: number,
  heightFn: (u: number, v: number) => number,
  strength: number,
  done: (texture: THREE.Texture) => void,
): Array<() => void> {
  const hgt = new Float32Array(size * size);
  const steps: Array<() => void> = [];
  for (let slice = 0; slice < SLICES; slice++) {
    steps.push(() => {
      const end = Math.round(((slice + 1) * size) / SLICES);
      for (let y = Math.round((slice * size) / SLICES); y < end; y++) {
        for (let x = 0; x < size; x++) {
          hgt[y * size + x] = heightFn(x / size, y / size);
        }
      }
    });
  }
  steps.push(() => done(normalTex(size, hgt, strength)));
  return steps;
}

/** The normal map for a finished height field. */
function normalTex(size: number, hgt: Float32Array, strength: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Flat: the material still renders, just without relief.
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    flat.needsUpdate = true;
    return flat;
  }
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number): number => hgt[y * size + x] ?? 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = at((x - 1 + size) % size, y);
      const r = at((x + 1) % size, y);
      const u = at(x, (y - 1 + size) % size);
      const d = at(x, (y + 1) % size);
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      nz /= length;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

const rockHeight = (u: number, v: number): number => {
  const strata = fbm2p(u * 4, v * 48, 4, 48, 4, 3);
  const grain = fbm2p(u * 32, v * 32, 32, 32, 3, 9);
  return strata * 1.0 + grain * 0.35 + Math.abs(fbm2p(u * 8, v * 24, 8, 24, 3, 21)) * 0.8;
};

const floorHeight = (u: number, v: number): number => {
  const base = fbm2p(u * 5, v * 5, 5, 5, 5, 41) * 0.7;
  const slab = fbm2p(u * 7, v * 7, 7, 7, 3, 77);
  const crack = Math.pow(1 - Math.min(1, Math.abs(slab) * 14), 3) * -0.05;
  const grain = fbm2p(u * 40, v * 40, 40, 40, 2, 55) * 0.12;
  return base + crack + grain;
};

/**
 * The rock, as build steps: an open cylinder, pushed outward by layered
 * noise into ledges and strata a slice of vertices per step, then shaded.
 */
function rockSteps(lowTier: boolean, done: (geometry: THREE.CylinderGeometry) => void): Array<() => void> {
  const geometry = new THREE.CylinderGeometry(R, R, WALL_H, lowTier ? 160 : 384, lowTier ? 220 : 520, true);
  const p = geometry.attributes.position as THREE.BufferAttribute;
  const steps: Array<() => void> = [];
  for (let slice = 0; slice < SLICES; slice++) {
    steps.push(() => {
      const end = Math.round(((slice + 1) * p.count) / SLICES);
      for (let i = Math.round((slice * p.count) / SLICES); i < end; i++) {
        const x = p.getX(i);
        const y = p.getY(i) + WALL_H / 2;
        const z = p.getZ(i);
        const th = Math.atan2(z, x);
        const cx = Math.cos(th);
        const cz = Math.sin(th);
        const big = fbm3(cx * 3, y * 0.05, cz * 3, 3) * 0.55;
        const ledge = fbm3(cx * 9, y * 1.6, cz * 9, 4);
        const strata = Math.sign(ledge) * Math.pow(Math.abs(ledge), 0.6) * 0.32;
        const chip = fbm3(cx * 40, y * 1.2, cz * 40, 2) * 0.12;
        const r = Math.max(R + 0.1, R + 0.5 + big + strata + chip);
        p.setXYZ(i, cx * r, y, cz * r);
      }
    });
  }
  steps.push(() => {
    geometry.computeVertexNormals();
    done(geometry);
  });
  return steps;
}

// ---------- the module ----------

export interface CaveHud {
  /** The lobby root: gets `data-x`, `data-y`, `data-z` and `data-yaw`. */
  root: HTMLElement;
  /** The layer the peers' name tags live in, laid exactly over the canvas. */
  people: HTMLElement;
  /** The mic button, whose `--lvl` shows the mic level. */
  mic: HTMLElement | null;
  stick: HTMLElement | null;
  knob: HTMLElement | null;
  rise: HTMLElement | null;
  fall: HTMLElement | null;
}

export interface CaveOptions {
  /** The registry; each lit app gets a screen at its slot. */
  apps: readonly AppEntry[];
  /** Where the camera starts (already clamped into the cave). */
  initial: CameraState;
  reducedMotion: boolean;
  /** The presence feed, read every frame; null while there is none. */
  feed(): PresenceFeed | null;
  hud: CaveHud;
  classes: PeerClasses;
  onReady(): void;
  onLost(): void;
  onError(error: unknown): void;
  /** A tap landed on a panel; `pose` is the camera at that moment, for saving. */
  onPick(hit: Hit, pose: CameraState): void;
  /** What the crosshair (or the last tap) is on: a slug, `empty:<index>`, or ''. */
  onFocus(focus: string): void;
  onPeers(count: number): void;
}

export interface Cave {
  setState(next: { reducedMotion?: boolean }): void;
  /** The camera now, clamped into the cave. */
  pose(): CameraState;
  dispose(): void;
}

const fixed = (value: number): string => {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
};

export function createCave(canvas: HTMLCanvasElement, opts: CaveOptions): Cave {
  const lowTier = window.matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  let reducedMotion = opts.reducedMotion;

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowTier ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.011);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 600);
  camera.rotation.order = 'YXZ';

  // ---------- holographic grid: every slot, one instance each, in slot-index order ----------
  const uTime = { value: 0 };
  const hologram = shaderColor(CAVE_PALETTE.accent);
  const gridMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: hologram },
      uTime,
      uSize: { value: new THREE.Vector2(PW, PH) },
    },
    vertexShader: `
      attribute float aSeed; varying vec2 vUv; varying float vSeed; varying float vDist; varying float vY;
      void main(){ vUv=uv; vSeed=aSeed; vec4 wp=modelMatrix*instanceMatrix*vec4(position,1.); vY=wp.y;
        vec4 mv=viewMatrix*wp; vDist=length(mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform vec2 uSize;
      varying vec2 vUv; varying float vSeed; varying float vDist; varying float vY;
      void main(){
        vec2 p=vUv*uSize; float d=min(min(p.x,uSize.x-p.x),min(p.y,uSize.y-p.y));
        float fw=fwidth(d); float w=max(0.016,fw*0.55);
        float line=1.-smoothstep(w,w+fw*1.5,d);
        float glow=exp(-d*7.)*0.1;
        float scan=0.5+0.5*sin(p.y*34.-uTime*1.6+vSeed*6.);
        float fill=0.018+0.012*scan;
        float flick=0.82+0.18*sin(uTime*(0.4+vSeed*1.7)+vSeed*50.);
        float pulse=smoothstep(4.,0.,abs(mod(abs(vY)-uTime*7.,160.)-3.));
        float fade=exp(-vDist*0.02);
        float a=(line*(0.5+pulse*1.2)+glow+fill)*flick*fade;
        gl_FragColor=vec4(uColor*a,1.);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const slotCount = WALL.columns * WALL.rows;
  const gridGeo = new THREE.PlaneGeometry(PW, PH);
  const seeds = new Float32Array(slotCount);
  const grid = new THREE.InstancedMesh(gridGeo, gridMat, slotCount);
  grid.name = 'hologrid';
  {
    const m = new THREE.Object3D();
    for (let index = 0; index < slotCount; index++) {
      const pose = slotPose(index);
      m.position.fromArray(pose.position);
      m.rotation.set(0, pose.rotationY, 0);
      m.updateMatrix();
      grid.setMatrixAt(index, m.matrix);
      seeds[index] = Math.random();
    }
  }
  gridGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  grid.frustumCulled = false;
  grid.renderOrder = 2;
  scene.add(grid);

  // An empty slot's readout and its light on the rock: made once, shown on hover or a tap.
  const readout = createSlotReadout(scene, { color: hologram, time: uTime, glow: CAVE_PALETTE.glow });

  // ---------- the screens: one per lit app ----------
  const embers = createEmbers();
  const light = lowTier || savesData();
  const screens: ScreenPanel[] = opts.apps.filter((app) => app.lit).map((app) => createScreenPanel(app, embers, light));
  for (const screen of screens) {
    scene.add(screen.group);
  }
  const wanted = new Set<ScreenPanel>();

  // ---------- light: the screen is the only source ----------
  // Rect-area approximation: a lattice of narrow forward-facing spots across
  // the screen face (no backward spill), driven together by the screen's
  // smoothed linear luminance and average colour. The lattice and the dust
  // follow whichever lit screen is nearest.
  const LX = lowTier ? 3 : 6;
  const LY = lowTier ? 2 : 3;
  const floorRowY = WALL.y0 + PH / 2;
  const lattice = new THREE.Group();
  lattice.name = 'tv-light';
  const spots: THREE.SpotLight[] = [];
  for (let j = 0; j < LY; j++) {
    for (let i = 0; i < LX; i++) {
      const spot = new THREE.SpotLight(0x408f96, 0, 9, 0.75, 0.6, 2);
      const u = (i + 0.5) / LX;
      const v = (j + 0.5) / LY;
      spot.position.set((u - 0.5) * PW, floorRowY + (0.5 - v) * PH, -(RC - SCREEN_INSET - 0.12));
      spot.target.position.set((u - 0.5) * PW * 1.1, -1, -(RC - 2.5));
      lattice.add(spot, spot.target);
      spots.push(spot);
    }
  }
  // Per-spot intensity at a fully bright frame (tuned against the floor, not the screen).
  const spotMax = 14 * (18 / (LX * LY));
  const bounce = new THREE.HemisphereLight(0x408f96, 0x000000, 0);
  scene.add(bounce);
  scene.add(new THREE.AmbientLight(CAVE_PALETTE.ambient, 0.022));

  // Dust in the light.
  const dustCount = lowTier ? 120 : 500;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 12;
    dustPos[i * 3 + 1] = Math.random() * 7;
    dustPos[i * 3 + 2] = -RC + 0.6 + Math.random() * 9;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: WARM,
    size: 0.03,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  lattice.add(dust);
  scene.add(lattice);
  const tv = createTvLight();
  const skirts = screens.map((screen) => screen.skirt).filter((skirt) => skirt !== null);
  let primary: ScreenPanel | null = null;

  // Reflections in obsidian: a mirrored copy of the emissive layer. Built as
  // in the prototype, which keeps it switched off.
  const mirror = new THREE.Group();
  mirror.name = 'mirror';
  mirror.scale.y = -1;
  mirror.visible = false;
  const gridMirror = grid.clone();
  gridMirror.renderOrder = 0;
  mirror.add(gridMirror);
  for (const screen of screens) {
    const copy = screen.group.clone();
    copy.traverse((object) => {
      object.renderOrder = 0;
    });
    mirror.add(copy);
  }
  scene.add(mirror);

  // ---------- people ----------
  const peers = createPeers(scene, opts.hud.people, opts.classes);

  // ---------- controls ----------
  const { initial } = opts;
  const motion: Motion = {
    pos: new THREE.Vector3(initial.x, initial.y, initial.z),
    vel: new THREE.Vector3(),
    yaw: initial.yaw,
    pitch: initial.pitch,
    tYaw: initial.yaw,
    tPitch: initial.pitch,
  };
  const pose = (): CameraState =>
    clampCamera({ x: motion.pos.x, y: motion.pos.y, z: motion.pos.z, yaw: motion.yaw, pitch: motion.pitch });

  const picker = createPicker(camera, canvas, screens, grid);
  let focus = '';
  let focusKey = '';
  const poseKey = (): string =>
    `${fixed(motion.pos.x)},${fixed(motion.pos.y)},${fixed(motion.pos.z)},${motion.yaw.toFixed(3)},${motion.pitch.toFixed(3)}`;
  const setFocus = (hit: Hit | null): void => {
    const next = hit === null ? '' : hit.lit ? hit.slug : `empty:${hit.slot}`;
    if (next !== focus) {
      focus = next;
      opts.onFocus(next);
    }
  };

  // ---------- hover: the cursor, and an empty slot's readout ----------
  /** Where the mouse is over the canvas (client coordinates), or null. */
  let mouseAt: { x: number; y: number } | null = null;
  let hoverStale = false;
  let hoverKey = '';
  /** The empty slot under the mouse, or null. */
  let hoverSlot: number | null = null;
  /** The empty slot a finger last tapped, shown until `tapUntil` (no hover on a touch screen). */
  let tapSlot: number | null = null;
  let tapUntil = 0;
  /** What the root says the readout is on. */
  let shownSlot: number | null = null;
  const root = opts.hud.root;
  root.dataset.hoverSlot = '';
  root.dataset.hoverGlow = 'off';

  /** What is under the mouse now, for the cursor and the readout. Nothing while it drags to look. */
  const pickHover = (key: string): void => {
    hoverStale = false;
    hoverKey = key;
    if (mouseAt === null || controls.looking()) {
      hoverSlot = null;
      canvas.style.cursor = '';
      return;
    }
    const hit = picker.pick(mouseAt.x, mouseAt.y);
    canvas.style.cursor = hit ? 'pointer' : '';
    hoverSlot = hit !== null && !hit.lit ? hit.slot : null;
  };

  const controls = createControls(motion, {
    canvas,
    stick: opts.hud.stick,
    knob: opts.hud.knob,
    rise: opts.hud.rise,
    fall: opts.hud.fall,
    pick: picker.pick,
    onTap(hit, pointerType) {
      setFocus(hit);
      // The tap wins over the crosshair until the camera moves again.
      focusKey = poseKey();
      if (!hit.lit && pointerType !== 'mouse') {
        tapSlot = hit.slot;
        tapUntil = performance.now() + READOUT_TAP_MS;
      }
      opts.onPick(hit, pose());
    },
  });

  // Muted inline video may autoplay, but a browser that refused gets another try on each gesture.
  const kick = (): void => {
    for (const screen of screens) {
      screen.kick();
    }
  };
  window.addEventListener('pointerdown', kick);
  window.addEventListener('keydown', kick);

  let disposed = false;
  let running = true;
  let raf = 0;
  const stop = (): void => {
    running = false;
    cancelAnimationFrame(raf);
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed || !running) {
      return;
    }
    stop();
    opts.onLost();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  // ---------- the heavy parts, a slice per frame ----------
  let rockNormal: THREE.Texture | null = null;
  let floorNormal: THREE.Texture | null = null;
  let rock: THREE.CylinderGeometry | null = null;
  const build: Array<() => void> = [
    ...normalTexSteps(512, rockHeight, 6, (texture) => {
      rockNormal = texture;
      texture.repeat.set(14, 40);
    }),
    ...rockSteps(lowTier, (geometry) => {
      rock = geometry;
    }),
    ...normalTexSteps(512, floorHeight, 3, (texture) => {
      floorNormal = texture;
      texture.repeat.set(10, 10);
    }),
    () => {
      const wall = new THREE.Mesh(
        rock ?? undefined,
        new THREE.MeshStandardMaterial({
          name: 'basalt',
          color: 0x2a2a2c,
          roughness: 0.7,
          metalness: 0.02,
          normalMap: rockNormal,
          normalScale: new THREE.Vector2(1.4, 1.4),
          side: THREE.BackSide,
        }),
      );
      wall.name = 'wall';
      scene.add(wall);
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(R + 1.5, 160),
        new THREE.MeshStandardMaterial({
          name: 'obsidian',
          color: 0x26262a,
          roughness: 0.72,
          metalness: 0.0,
          normalMap: floorNormal,
          normalScale: new THREE.Vector2(0.45, 0.45),
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.renderOrder = 1;
      floor.name = 'floor';
      scene.add(floor);
    },
  ];

  // ---------- the frame loop ----------
  let last = performance.now();
  let t = 0;
  let gridTime = 0;
  let ready = false;
  let nextHudAt = 0;
  let nextMediaAt = 0;
  let peerCount = -1;
  let micLevel = -1;
  let rw = 0;
  let rh = 0;
  const self: SelfState = { x: 0, y: 0, z: 0, yaw: 0 };
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();

  const fit = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || (w === rw && h === rh)) {
      return;
    }
    rw = w;
    rh = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  /** Which screens want their media (within range or in view), and which one lights the room. */
  const updateScreens = (): void => {
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    let nearest: ScreenPanel | null = null;
    let nearestDistance = Infinity;
    for (const screen of screens) {
      const distance = screen.bounds.center.distanceTo(camera.position);
      const near = distance <= MEDIA_RANGE;
      const wants = near || frustum.intersectsSphere(screen.bounds);
      screen.setWanted(wants, near);
      if (wants) {
        wanted.add(screen);
      } else {
        wanted.delete(screen);
      }
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = screen;
      }
    }
    if (nearest !== primary && nearest !== null) {
      primary = nearest;
      lattice.rotation.y = primary.rotationY;
      lattice.position.y = primary.centerY - floorRowY;
    }
  };

  const frame = (now: number): void => {
    if (!running) {
      return;
    }
    raf = requestAnimationFrame(frame);
    try {
      const step = build.shift();
      if (step) {
        step();
        last = now;
        return;
      }
      const elapsed = Math.max((now - last) / 1000, 0);
      const dt = Math.min(elapsed, 0.05);
      last = now;
      t += dt;
      fit();

      controls.step(dt, reducedMotion);
      camera.position.copy(motion.pos);
      camera.rotation.set(-motion.pitch, -motion.yaw, 0);
      camera.updateMatrixWorld();

      // Presence: publish where we are, hear from where we are, draw everyone
      // else. The feed only records the state here; when to send it, and the
      // voices, run on the feed's own timer, so a hidden tab (no frames) still
      // hears and is heard.
      const feed = opts.feed();
      self.x = motion.pos.x;
      self.y = motion.pos.y;
      self.z = motion.pos.z;
      self.yaw = normalizeYaw(motion.yaw);
      let others = NO_PEERS;
      if (feed) {
        feed.publish(self);
        feed.setListener(self);
        others = feed.peers();
      }
      peers.update(dt, t, camera, others, reducedMotion);
      if (others.size !== peerCount) {
        peerCount = others.size;
        opts.onPeers(peerCount);
      }
      const level = feed ? feed.micLevel() : 0;
      if (opts.hud.mic && Math.abs(level - micLevel) > 0.004) {
        micLevel = level;
        opts.hud.mic.style.setProperty('--lvl', level.toFixed(3));
      }

      const hover = controls.takeHover();
      if (hover) {
        mouseAt = hover.at;
        hoverStale = true;
      }
      if (hoverStale) {
        pickHover(poseKey());
      }
      if (tapSlot !== null && now >= tapUntil) {
        tapSlot = null;
      }
      const readoutSlot = hoverSlot ?? tapSlot;
      readout.show(readoutSlot);
      readout.step(elapsed, reducedMotion);
      if (readoutSlot !== shownSlot) {
        shownSlot = readoutSlot;
        root.dataset.hoverSlot = readoutSlot === null ? '' : String(readoutSlot);
        root.dataset.hoverGlow = readoutSlot === null ? 'off' : 'on';
      }

      if (!reducedMotion) {
        gridTime += dt;
      }
      uTime.value = gridTime;

      if (now >= nextMediaAt) {
        nextMediaAt = now + 250;
        updateScreens();
      }
      if (screens.some((screen) => wanted.has(screen) && screen.showsEmbers())) {
        embers.draw(t, dt);
      }
      tv.sampleTV(now, primary ? primary.source() : null);
      tv.step(dt);
      applyTV(tv, { spots, spotMax, bounce, skirt: null, dust: dustMat });
      for (const skirt of skirts) {
        skirt.color.copy(tv.color);
        skirt.opacity = 0.35 * tv.intensity;
      }
      if (!reducedMotion) {
        // TV flicker: slow scene-change swells plus fast frame jitter.
        const flick =
          0.85 +
          0.15 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1) +
          (Math.random() - 0.5) * 0.06 +
          Math.sin(t * 11.7) * 0.02;
        for (const spot of spots) {
          spot.intensity *= flick;
        }
        const drift = dustGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < dustCount; i++) {
          let y = drift.getY(i) + dt * 0.05;
          if (y > 9) {
            y = 0;
          }
          drift.setY(i, y);
        }
        drift.needsUpdate = true;
      }

      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        opts.onReady();
      }

      if (now >= nextHudAt) {
        nextHudAt = now + 100;
        root.dataset.x = fixed(motion.pos.x);
        root.dataset.y = fixed(motion.pos.y);
        root.dataset.z = fixed(motion.pos.z);
        root.dataset.yaw = fixed(normalizeYaw(motion.yaw));
        const key = poseKey();
        if (key !== focusKey) {
          focusKey = key;
          setFocus(picker.pickNdc(0, 0));
        }
        // The view moved under a still mouse (keys, the stick, a look easing in): so may what is under it.
        if (mouseAt !== null && key !== hoverKey) {
          pickHover(key);
        }
      }
    } catch (error) {
      stop();
      opts.onError(error);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    setState(next) {
      if (next.reducedMotion !== undefined) {
        reducedMotion = next.reducedMotion;
      }
    },
    pose,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      stop();
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      peers.dispose();
      readout.dispose();
      delete root.dataset.hoverSlot;
      delete root.dataset.hoverGlow;
      for (const screen of screens) {
        screen.dispose();
      }
      embers.dispose();
      rock?.dispose();
      rockNormal?.dispose();
      floorNormal?.dispose();
      // three r186 gives every renderer's standard materials (the wall's and
      // the floor's) one shared DFG lookup texture, and renderer.dispose()
      // leaves its dispose listener behind, which keeps this renderer (canvas,
      // context and all) alive. Disposing the texture drops that listener;
      // three uploads it again for the next renderer.
      const luts = new Set<THREE.Texture>();
      scene.traverse((object) => {
        const { material } = object as THREE.Mesh;
        for (const each of Array.isArray(material) ? material : material ? [material] : []) {
          const props = renderer.properties.get(each) as { uniforms?: { dfgLUT?: { value?: unknown } } };
          const lut = props.uniforms?.dfgLUT?.value;
          if (lut instanceof THREE.Texture) {
            luts.add(lut);
          }
        }
      });
      for (const lut of luts) {
        lut.dispose();
      }
      scene.traverse((object) => {
        const { geometry, material } = object as THREE.Mesh;
        geometry?.dispose();
        for (const each of Array.isArray(material) ? material : material ? [material] : []) {
          (each as THREE.MeshBasicMaterial).map?.dispose();
          each.dispose();
        }
      });
      grid.dispose();
      gridMirror.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
