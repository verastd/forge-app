/**
 * What every robot shares, loaded once per lobby: the body (robot.glb, split
 * into paint zones by @forge/lobby's `segmentRobot`), the library's heads and
 * chestplate images (by sha256, from the avatars BFF), the generated chest
 * emblems, and the environment map only robots are lit by.
 *
 * Every load is a promise cached by its key, so a hundred robots wearing one
 * head fetch it once; a failed load is forgotten after a while so the next
 * robot to ask tries again.
 *
 * The page's CSP allows connections to this origin and the API only.
 * GLTFLoader reads a GLB's embedded images through `fetch(blob:…)`, which
 * that forbids, so heads load their textures through <img> instead
 * (`imageTexturesPlugin`): the same pixels, by a route the CSP allows.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { emblemInitials, segmentRobot } from '@forge/lobby';
import type { AvatarColors } from '@forge/lobby';

export const ROBOT_URL = '/lobby/robot.glb';
/** Where the avatars BFF serves a stored file. */
export const assetUrl = (sha256: string): string => `/bff/avatars/assets/${sha256}`;
/** After a failed load, how long before a robot may try that file again. */
const RETRY_MS = 30_000;

/** The body, ready to clone: its scene (one skinned mesh) with the zone attribute set. */
export interface RobotBody {
  scene: THREE.Group;
  mesh: THREE.SkinnedMesh;
}

function imageTexturesPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  // GLTFParser picks ImageBitmapLoader where it can; <img> works everywhere.
  (parser as unknown as { textureLoader: THREE.Loader }).textureLoader = new THREE.TextureLoader(
    parser.options.manager,
  );
  return { name: 'forge_image_textures' };
}

function loader(): GLTFLoader {
  return new GLTFLoader().register(imageTexturesPlugin);
}

/** A GLTFLoader that reads embedded images the way the CSP allows (for machines' blueprints too). */
export const gltfLoader = loader;

/** Loads and segments the body. Rejects if the asset isn't the robot it expects. */
export async function loadBody(url = ROBOT_URL): Promise<RobotBody> {
  const gltf = await loader().loadAsync(url);
  let mesh: THREE.SkinnedMesh | null = null;
  gltf.scene.traverse((object) => {
    if (!mesh && (object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh;
  });
  if (mesh === null) throw new Error('robot.glb has no skinned mesh');
  const body: THREE.SkinnedMesh = mesh;
  const { geometry } = body;
  const position = geometry.getAttribute('position');
  const joints = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const index = geometry.getIndex();
  if (!position || !joints || !weights || !index) throw new Error('robot.glb is missing skinning data');
  const { zone } = segmentRobot({
    positions: position.array,
    joints: joints.array,
    weights: weights.array,
    index: index.array,
    jointNames: body.skeleton.bones.map((bone) => bone.name),
  });
  geometry.setAttribute('zone', new THREE.BufferAttribute(zone, 1));
  // The bob, lean and arm swing stay well inside a generous fixed box.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.2);
  body.frustumCulled = false;
  // The clip is a single bind-pose frame: every robot moves procedurally.
  gltf.animations.length = 0;
  return { scene: gltf.scene, mesh: body };
}

/** A promise cache whose failures expire, so a flaky file is tried again later. */
class Cache<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; failedAt: number | null }>();

  get(key: string, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && (entry.failedAt === null || performance.now() - entry.failedAt < RETRY_MS)) {
      return entry.promise;
    }
    const fresh = { promise: load(), failedAt: null as number | null };
    fresh.promise.catch(() => {
      fresh.failedAt = performance.now();
    });
    this.entries.set(key, fresh);
    return fresh.promise;
  }

  values(): Promise<T>[] {
    return [...this.entries.values()].map((entry) => entry.promise);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * A chestplate clip, shared by every robot wearing it: one video, decoded
 * once. It plays while any of them wants it to (`want`), and holds its frame
 * while none does.
 */
export interface ChestClip {
  readonly texture: THREE.VideoTexture;
  readonly video: HTMLVideoElement;
  /** Whether `viewer` (a robot) wants it playing now. */
  want(viewer: object, playing: boolean): void;
}

export interface RobotAssets {
  /** The shared body; resolves once, or rejects (the lobby keeps its orbs). */
  body: Promise<RobotBody>;
  /** A library head's scene, by its GLB's sha256: clone it before use. */
  head(sha256: string): Promise<GLTF>;
  /**
   * A head from a file not uploaded yet (the editor's fitting), parsed from
   * its bytes and kept under `key`, which then works like a sha256 in
   * `head()` and in a look.
   */
  localHead(key: string, bytes: ArrayBuffer): Promise<GLTF>;
  /** A chestplate image, by sha256. */
  chest(sha256: string): Promise<THREE.Texture>;
  /** A chestplate clip, by sha256: loaded whole (no streaming), muted, looping, paused until wanted. */
  chestVideo(sha256: string): Promise<ChestClip>;
  /** A member's generated emblem, by id and name (cached per both). */
  emblem(id: string, name: string, colors: AvatarColors): THREE.Texture;
  /** The environment map robots (and only robots) are lit by. */
  envMap: THREE.Texture;
  dispose(): void;
}

/** Draws a member's chest emblem: their initials over a ring, in their own colours. */
export function drawEmblem(canvas: HTMLCanvasElement, name: string, colors: AvatarColors): void {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const g = ctx.createRadialGradient(size / 2, size * 0.42, size * 0.05, size / 2, size / 2, size * 0.75);
  g.addColorStop(0, '#26303d');
  g.addColorStop(1, '#07090c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Fine scanlines: it reads as a lit panel, not a sticker.
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < size; y += 4) ctx.fillRect(0, y, size, 1);
  ctx.lineWidth = size * 0.035;
  ctx.strokeStyle = colors.accent;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.43, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const initials = emblemInitials(name);
  ctx.fillStyle = colors.eye;
  ctx.shadowColor = colors.eye;
  ctx.shadowBlur = size * 0.06;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(size * (initials.length > 1 ? 0.3 : 0.38))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(initials, size / 2, size / 2 + size * 0.015);
}

export function createRobotAssets(renderer: THREE.WebGLRenderer): RobotAssets {
  const heads = new Cache<GLTF>();
  const chests = new Cache<THREE.Texture>();
  const clips = new Cache<ChestClip & { dispose(): void }>();
  const emblems = new Map<string, THREE.Texture>();
  const textureLoader = new THREE.TextureLoader();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();

  const body = loadBody();
  // Never an unhandled rejection: whoever awaits it handles the failure.
  body.catch(() => undefined);

  return {
    body,
    head(sha256) {
      return heads.get(sha256, () => loader().loadAsync(assetUrl(sha256)));
    },
    localHead(key, bytes) {
      return heads.get(key, () => loader().parseAsync(bytes, ''));
    },
    chest(sha256) {
      return chests.get(sha256, async () => {
        const texture = await textureLoader.loadAsync(assetUrl(sha256));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        return texture;
      });
    },
    chestVideo(sha256) {
      return clips.get(sha256, async () => {
        // Fetched whole and played from memory: the asset route sends the file in one piece
        // (no byte ranges), which Safari's <video> won't play from directly.
        const response = await fetch(assetUrl(sha256));
        if (!response.ok) throw new Error(`chest clip ${response.status}`);
        const url = URL.createObjectURL(await response.blob());
        const video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        try {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadeddata', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('chest clip would not play')), { once: true });
            video.src = url;
            video.load();
          });
        } catch (error) {
          URL.revokeObjectURL(url);
          throw error;
        }
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        // Its first frame, before it ever plays (a paused video has no frames to announce).
        texture.needsUpdate = true;
        const wanting = new Set<object>();
        return {
          texture,
          video,
          want(viewer, playing) {
            if (playing) wanting.add(viewer);
            else wanting.delete(viewer);
            if (wanting.size > 0 && video.paused) {
              // Muted and inline, so it may play without a gesture; if a browser still says no, it holds its frame.
              video.play().catch(() => undefined);
            } else if (wanting.size === 0 && !video.paused) {
              video.pause();
            }
          },
          dispose() {
            wanting.clear();
            video.pause();
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(url);
            texture.dispose();
          },
        };
      });
    },
    emblem(id, name, colors) {
      const key = `${id}\u0000${name}\u0000${colors.accent}${colors.eye}`;
      let texture = emblems.get(key);
      if (!texture) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        drawEmblem(canvas, name, colors);
        texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        emblems.set(key, texture);
      }
      return texture;
    },
    envMap,
    dispose() {
      envMap.dispose();
      for (const texture of emblems.values()) texture.dispose();
      emblems.clear();
      const disposeLater = <T>(promises: Promise<T>[], each: (value: T) => void): void => {
        for (const promise of promises) promise.then(each, () => undefined);
      };
      disposeLater(chests.values(), (texture) => texture.dispose());
      disposeLater(clips.values(), (clip) => clip.dispose());
      disposeLater(heads.values(), (gltf) => disposeObject(gltf.scene));
      disposeLater([body], (b) => disposeObject(b.scene));
      chests.clear();
      clips.clear();
      heads.clear();
    },
  };
}

/**
 * What fitting needs from a head's model, node transforms applied: every
 * vertex, every triangle (x, y, z × 3 each, for where the face is), and
 * whether it has EyeL and EyeR.
 */
export interface HeadMeasure {
  positions: Float32Array;
  triangles: Float32Array;
  hasEyes: boolean;
}

/** Measures a loaded head's scene (its own frame: the scene root left as it is). */
export function measureHead(scene: THREE.Object3D): HeadMeasure {
  const root = scene.clone(true);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.setScalar(1);
  root.updateMatrixWorld(true);
  const chunks: Float32Array[] = [];
  const triangleChunks: Float32Array[] = [];
  const at = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const out = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      at.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      out[i * 3] = at.x;
      out[i * 3 + 1] = at.y;
      out[i * 3 + 2] = at.z;
    }
    chunks.push(out);
    const index = mesh.geometry.getIndex();
    const corners = index ? index.count : position.count;
    const tris = new Float32Array(corners * 3);
    for (let k = 0; k < corners; k += 1) {
      const v = index ? index.getX(k) : k;
      tris.set(out.subarray(v * 3, v * 3 + 3), k * 3);
    }
    triangleChunks.push(tris);
  });
  const join = (parts: Float32Array[]): Float32Array => {
    const all = new Float32Array(parts.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return all;
  };
  const hasEyes = Boolean(root.getObjectByName('EyeL') && root.getObjectByName('EyeR'));
  return { positions: join(chunks), triangles: join(triangleChunks), hasEyes };
}

/** Frees an object tree's geometries, materials and their textures. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
