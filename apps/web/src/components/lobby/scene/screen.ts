/**
 * The lit panels: one screen per lit app at its registry slot, what each one
 * shows, and the light it throws (the prototype's `drawScreen`, video
 * texture, `sampleTV` and `applyTV`).
 *
 * A screen starts on the shared ember canvas, the prototype's fallback, and
 * loads nothing until the scene first wants it (its slot within 40 m of the
 * camera, or in view). Then a video app shows its poster as soon as that
 * decodes, and the video once its first frame is ready. On a light client
 * (a phone, a low-end machine, Save-Data) the video is the registry's
 * lighter `srcLow` encode where there is one. Seen only from afar, the video
 * preloads its metadata alone; within 40 m it loads in full. The video is
 * muted, inline and looping; it plays when wanted and pauses when not, and a
 * user gesture retries a play the browser refused. Media is same-origin (the
 * registry allows nothing else), so no CORS attribute is needed to sample it.
 */

import * as THREE from 'three';
import { WALL, slotIndex, slotPose } from '@forge/lobby';
import type { AppEntry } from '@forge/lobby';

/** The screen's own pixel size: the prototype's canvas, and the lobby video's. */
const SCREEN_W = 1280;
const SCREEN_H = 720;
/** How far a screen stands in front of its grid cell. */
export const SCREEN_INSET = 0.05;
/** The prototype's first guess at the light colour, before anything is sampled. */
const WARM = 0xff6a24;
/** The TV light's resting colour. */
const TEAL = 0x408f96;

export type ScreenSource = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

// ---------- the ember fallback ----------

export interface Embers {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  /** Paints the next frame; call once per animation frame while any screen shows it. */
  draw(t: number, dt: number): void;
  dispose(): void;
}

interface Ember {
  x: number;
  y: number;
  v: number;
  s: number;
  p: number;
}

/** The prototype's generated screen: a warm gradient with embers drifting up it. */
export function createEmbers(): Embers {
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const embers: Ember[] = Array.from({ length: 160 }, () => ({
    x: Math.random(),
    y: Math.random(),
    v: 0.02 + Math.random() * 0.06,
    s: 0.6 + Math.random() * 2.6,
    p: Math.random() * 6,
  }));

  function draw(t: number, dt: number): void {
    if (!ctx) {
      return;
    }
    const W = SCREEN_W;
    const H = SCREEN_H;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0e0302');
    g.addColorStop(0.55, '#2a0a02');
    g.addColorStop(1, '#5a1804');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W * 0.62, H * 0.6, 10, W * 0.62, H * 0.6, W * 0.6);
    rg.addColorStop(0, 'rgba(255,120,40,0.75)');
    rg.addColorStop(0.35, 'rgba(200,60,10,0.35)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const e of embers) {
      e.y -= e.v * dt;
      e.x += Math.sin(t * 0.6 + e.p) * 0.0006;
      if (e.y < -0.02) {
        e.y = 1.02;
        e.x = Math.random();
      }
      const a = 0.35 + 0.35 * Math.sin(t * 3 + e.p * 4);
      ctx.fillStyle = `rgba(255,${150 + ((e.p * 15) | 0)},60,${a})`;
      ctx.beginPath();
      ctx.arc(e.x * W, e.y * H, e.s, 0, 7);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    texture.needsUpdate = true;
  }

  draw(0, 0);
  return { canvas, texture, draw, dispose: () => texture.dispose() };
}

// ---------- a lit panel ----------

export interface ScreenPanel {
  readonly slug: string;
  readonly slot: number;
  /** The column's group: rotated to the slot, holding the screen, its halo and (on the floor row) its skirt. */
  readonly group: THREE.Group;
  /** What the picker raycasts. */
  readonly mesh: THREE.Mesh;
  /** The strip of light under a floor-row screen, tinted by the TV light; null higher up. */
  readonly skirt: THREE.MeshBasicMaterial | null;
  /** The screen's centre in world space, and a sphere around it, for range and frustum checks. */
  readonly bounds: THREE.Sphere;
  /** The group's `rotation.y` and the screen centre's height, so the light lattice can follow it. */
  readonly rotationY: number;
  readonly centerY: number;
  /** The pixels on the screen right now, for TV sampling, or null when there is nothing sampleable yet. */
  source(): ScreenSource | null;
  /** True while the ember canvas is on the screen, so the scene knows to animate it. */
  showsEmbers(): boolean;
  /**
   * Starts loading media the first time it is wanted; plays or pauses the
   * video to match. `near`: within media range, so the whole video may load.
   */
  setWanted(wanted: boolean, near: boolean): void;
  /** A user gesture happened: retry a play the browser refused. */
  kick(): void;
  dispose(): void;
}

/**
 * One screen, built at the app's registry slot exactly as the prototype
 * builds its one screen at slot 0. `light`: a phone, a low-end machine or a
 * Save-Data connection, which gets the video's lighter encode.
 */
export function createScreenPanel(app: AppEntry, embers: Embers, light: boolean): ScreenPanel {
  const slot = slotIndex(app.slot);
  const pose = slotPose(slot);
  const centerY = pose.position[1];
  const depth = -(WALL.ringRadius - SCREEN_INSET);

  const group = new THREE.Group();
  group.name = `screen:${app.slug}`;
  group.rotation.y = pose.rotationY;

  const material = new THREE.MeshBasicMaterial({ name: 'screen', map: embers.texture, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WALL.panelWidth, WALL.panelHeight), material);
  mesh.name = 'screen';
  mesh.position.set(0, centerY, depth);
  group.add(mesh);

  // The halo: built as in the prototype, which keeps it switched off.
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = haloCanvas.height = 256;
  const haloCtx = haloCanvas.getContext('2d');
  if (haloCtx) {
    const rg = haloCtx.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0, 'rgba(255,255,255,0.55)');
    rg.addColorStop(0.4, 'rgba(255,255,255,0.14)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    haloCtx.fillStyle = rg;
    haloCtx.fillRect(0, 0, 256, 256);
  }
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(WALL.panelWidth * 3.2, WALL.panelHeight * 4.2),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      color: new THREE.Color(WARM),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.2,
    }),
  );
  halo.name = 'halo';
  halo.visible = false;
  halo.position.set(0, centerY, depth - 0.02);
  group.add(halo);

  // The skirt: a strip of light between a floor-row screen and the floor.
  let skirt: THREE.MeshBasicMaterial | null = null;
  if (app.slot.row === 0) {
    const skirtCanvas = document.createElement('canvas');
    skirtCanvas.width = 4;
    skirtCanvas.height = 128;
    const skirtCtx = skirtCanvas.getContext('2d');
    if (skirtCtx) {
      const g = skirtCtx.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      skirtCtx.fillStyle = g;
      skirtCtx.fillRect(0, 0, 4, 128);
    }
    skirt = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(skirtCanvas),
      color: new THREE.Color(WARM),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.5,
    });
    const skirtMesh = new THREE.Mesh(new THREE.PlaneGeometry(WALL.panelWidth, WALL.y0), skirt);
    skirtMesh.name = 'skirt';
    skirtMesh.position.set(0, WALL.y0 / 2, depth + 0.01);
    skirtMesh.renderOrder = 3;
    group.add(skirtMesh);
  }

  group.updateMatrixWorld(true);
  const bounds = new THREE.Sphere(
    mesh.getWorldPosition(new THREE.Vector3()),
    Math.hypot(WALL.panelWidth, WALL.panelHeight) / 2,
  );

  // ---- media ----
  let started = false;
  let wanted = false;
  let near = false;
  let disposed = false;
  let current: ScreenSource | null = embers.canvas;
  let texture: THREE.Texture | null = null;
  let video: HTMLVideoElement | null = null;
  let videoReady = false;

  function show(next: THREE.Texture, source: ScreenSource): void {
    next.colorSpace = THREE.SRGBColorSpace;
    next.anisotropy = 8;
    const previous = texture;
    texture = next;
    current = source;
    material.map = next;
    material.needsUpdate = true;
    previous?.dispose();
  }

  function loadImage(src: string, onLoad: (image: HTMLImageElement) => void): void {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!disposed) {
        onLoad(image);
      }
    };
    image.src = src;
  }

  function play(): void {
    if (video && videoReady && wanted && video.paused) {
      video.play().catch(() => undefined);
    }
  }

  function start(): void {
    started = true;
    const media = app.media;
    if (media.kind === 'image') {
      loadImage(media.src, (image) => {
        const next = new THREE.Texture(image);
        next.needsUpdate = true;
        show(next, image);
      });
      return;
    }
    if (media.kind !== 'video') {
      return;
    }
    loadImage(media.poster, (image) => {
      if (!videoReady) {
        const next = new THREE.Texture(image);
        next.needsUpdate = true;
        show(next, image);
      }
    });
    const element = document.createElement('video');
    element.muted = true;
    element.defaultMuted = true;
    element.loop = true;
    element.playsInline = true;
    element.preload = near ? 'auto' : 'metadata';
    element.addEventListener('loadeddata', () => {
      if (disposed || videoReady) {
        return;
      }
      videoReady = true;
      show(new THREE.VideoTexture(element), element);
      play();
    });
    element.src = light && media.srcLow !== undefined ? media.srcLow : media.src;
    element.load();
    video = element;
  }

  return {
    slug: app.slug,
    slot,
    group,
    mesh,
    skirt,
    bounds,
    rotationY: pose.rotationY,
    centerY,
    source: () => {
      if (current instanceof HTMLVideoElement) {
        return current.readyState >= 2 ? current : null;
      }
      return current;
    },
    showsEmbers: () => current === embers.canvas,
    setWanted(next, inRange) {
      wanted = next;
      if (inRange && !near) {
        near = true;
        if (video) {
          video.preload = 'auto';
        }
      }
      if (wanted && !started) {
        start();
      }
      if (!video || !videoReady) {
        return;
      }
      if (wanted) {
        play();
      } else if (!video.paused) {
        video.pause();
      }
    },
    kick: play,
    dispose() {
      disposed = true;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video = null;
      }
      texture?.dispose();
      // The group's geometries and materials are disposed with the scene.
    },
  };
}

// ---------- the TV light ----------

export interface TvLight {
  /** The smoothed light colour and intensity (0..1) the screen throws. */
  readonly color: THREE.Color;
  readonly intensity: number;
  /** Samples the source at most every 100 ms: its average colour, and its luminance for brightness. */
  sampleTV(nowMs: number, source: ScreenSource | null): void;
  /** Eases the light toward the last sample, frame-rate independent (the prototype's per-frame lerps at 60 fps). */
  step(dt: number): void;
}

export interface TvTargets {
  spots: readonly THREE.SpotLight[];
  /** Per-spot intensity for a fully bright frame. */
  spotMax: number;
  bounce: THREE.HemisphereLight;
  skirt: THREE.MeshBasicMaterial | null;
  dust: THREE.PointsMaterial;
}

const srgbToLinear = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** The prototype's TV light: a 16×9 sample of the screen, ten times a second. */
export function createTvLight(): TvLight {
  const color = new THREE.Color(TEAL);
  const target = new THREE.Color(TEAL);
  let intensity = 0;
  let desired = 0;
  let lastSampleMs = -Infinity;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 9;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return {
    color,
    get intensity() {
      return intensity;
    },
    sampleTV(nowMs, source) {
      if (!ctx || !source || nowMs - lastSampleMs < 100) {
        return;
      }
      lastSampleMs = nowMs;
      let data: Uint8ClampedArray;
      try {
        ctx.drawImage(source, 0, 0, 16, 9);
        data = ctx.getImageData(0, 0, 16, 9).data;
      } catch {
        // A frame that can't be drawn (still decoding, or broken) keeps the last sample.
        return;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += srgbToLinear(data[i] ?? 0);
        g += srgbToLinear(data[i + 1] ?? 0);
        b += srgbToLinear(data[i + 2] ?? 0);
      }
      const n = data.length / 4;
      r /= n;
      g /= n;
      b /= n;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b, 1e-4);
      target.setRGB(0.2 + (0.8 * r) / mx, 0.2 + (0.8 * g) / mx, 0.2 + (0.8 * b) / mx);
      desired = THREE.MathUtils.clamp(lum / 0.15, 0, 1);
    },
    step(dt) {
      color.lerp(target, 1 - Math.pow(1 - 0.18, dt * 60));
      intensity = THREE.MathUtils.lerp(intensity, desired, 1 - Math.pow(1 - 0.15, dt * 60));
    },
  };
}

/** Throws the TV light onto everything it tints: the spot lattice, the bounce, the skirt and the dust. */
export function applyTV(tv: TvLight, targets: TvTargets): void {
  for (const spot of targets.spots) {
    spot.color.copy(tv.color);
    spot.intensity = targets.spotMax * tv.intensity;
  }
  targets.bounce.color.copy(tv.color);
  targets.bounce.intensity = 0.06 * tv.intensity;
  if (targets.skirt) {
    targets.skirt.color.copy(tv.color);
    targets.skirt.opacity = 0.35 * tv.intensity;
  }
  targets.dust.color.copy(tv.color);
  targets.dust.opacity = 0.3 * tv.intensity;
}
