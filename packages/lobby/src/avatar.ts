/**
 * The lobby's robot avatars, the pure half: how the shared robot body
 * (apps/web/public/lobby/robot.glb) splits into paint zones, the head
 * library's anchor, and the look a member has before anyone has customised it.
 * No three.js: the scene hands in the mesh's typed arrays and gets typed
 * arrays back, so vitest can prove the segmentation against the real asset.
 *
 * The body is one skinned mesh of 60 disconnected parts (islands), each moved
 * almost entirely by one bone group, with a single grey material and no
 * usable UVs. That makes the split deterministic: find the islands, then name
 * each one by the bone that owns most of it and where it sits in the bind
 * pose. Every island takes exactly one zone, so a zone never bleeds across a
 * part's edge. The original head (the box and its two ear discs) keeps zones
 * of its own: it is every robot's head until one from the library replaces
 * it, and then the scene hides it.
 */

import { hashId } from './avatarMotion.js';

// Axes are the asset's: metres, +Y up, the robot facing +Z, its feet (the
// thruster's tip) at y = 0 and the top of its old head at y = 1.

/** Paint zones, as the value of the body's `zone` vertex attribute. */
export const ZONE = Object.freeze({
  /** Armour: the hover pod, the forearm gauntlets, the shoulder pads. The primary colour. */
  shell: 0,
  /** Secondary panels: the hip ring, the upper arms, the palms. */
  trim: 1,
  /** Mechanics: neck, waist, struts, elbows and fingers. A fixed dark gunmetal. */
  joint: 2,
  /** The torso: shell paint, with the chestplate on its flat front panel. */
  torso: 3,
  /** The pod's tip: the hover thruster's glow. */
  thruster: 4,
  /** The original head's box: shell paint, with the face screen on its flat front. */
  head: 5,
  /** The original head's ear discs: trim paint. */
  headTrim: 6,
});
export type Zone = (typeof ZONE)[keyof typeof ZONE];

/**
 * The torso's flat front panel in the bind pose, where the chestplate image
 * goes: x and y in metres, at z = `z`, facing +Z. The plate is drawn inside
 * it with a margin for the frame.
 */
export const CHEST_PANEL = Object.freeze({ minX: -0.115, maxX: 0.115, minY: 0.515, maxY: 0.758, z: 0.112 });

/**
 * The original head's flat front face, where its face screen and eyes go
 * (bind pose, metres, facing +Z at z = `z`).
 */
export const FACE_PANEL = Object.freeze({ minX: -0.138, maxX: 0.138, minY: 0.815, maxY: 0.977, z: 0.115 });

/**
 * Where a head sits on the neck, in the body's bind pose. A head from the
 * library is modelled with its origin here (+Y up, facing +Z, metres), so it
 * drops onto every robot the same way.
 */
export const HEAD_ANCHOR = Object.freeze({ x: 0, y: 0.8, z: 0 });

/**
 * Where something worn on the back sits, in the body's bind pose: on the
 * torso's back plate, between the shoulder blades (it follows the spine). A
 * back model is modelled with its origin here (+Y up, facing +Z, its front
 * against the back), and the cape hangs from just above it.
 */
export const BACK_ANCHOR = Object.freeze({ x: 0, y: 0.7, z: -0.116 });

/** The torso's back plate (bind pose, metres) and the shoulders' reach either side of it. */
export const BACK_PANEL = Object.freeze({ minX: -0.138, maxX: 0.138, minY: 0.479, maxY: 0.783, z: -0.116, shoulders: 0.2 });

/** The hover pod below the torso: a round body this far across, from this low to this high (bind pose). */
export const HOVER_POD = Object.freeze({ radius: 0.11, minY: 0.125, maxY: 0.405 });

/** One part of the body and what it was classified as. */
export interface Island {
  /** The island's vertices, ascending. */
  vertices: number[];
  /** The bone (CC_Base_ prefix removed) that is the strongest influence on most of its vertices. */
  bone: string;
  min: [number, number, number];
  max: [number, number, number];
  zone: Zone;
}

/** The skinned mesh's arrays, straight from the GLB accessors. */
export interface RobotMesh {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /** Four joint indices per vertex (JOINTS_0). */
  joints: ArrayLike<number>;
  /** Four weights per vertex (WEIGHTS_0). */
  weights: ArrayLike<number>;
  /** Triangle list. */
  index: ArrayLike<number>;
  /** The skin's joint names, in JOINTS_0 order. */
  jointNames: readonly string[];
}

export interface RobotSegmentation {
  /** One zone per vertex. */
  zone: Float32Array;
  islands: Island[];
}

const BONE_PREFIX = 'CC_Base_';

/** Disjoint-set over the vertices: two vertices of one triangle are one part. */
function findIslands(vertexCount: number, index: ArrayLike<number>): number[][] {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = find(index[t] as number);
    const b = find(index[t + 1] as number);
    const c = find(index[t + 2] as number);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const groups = new Map<number, number[]>();
  for (let v = 0; v < vertexCount; v += 1) {
    const r = find(v);
    const g = groups.get(r);
    if (g) g.push(v);
    else groups.set(r, [v]);
  }
  return [...groups.values()];
}

/** The joint with the largest weight on vertex `v`. */
function strongestJoint(mesh: RobotMesh, v: number): string {
  let best = 0;
  let bestWeight = -1;
  for (let k = 0; k < 4; k += 1) {
    const w = mesh.weights[v * 4 + k] as number;
    if (w > bestWeight) {
      bestWeight = w;
      best = mesh.joints[v * 4 + k] as number;
    }
  }
  const name = mesh.jointNames[best] ?? '';
  return name.startsWith(BONE_PREFIX) ? name.slice(BONE_PREFIX.length) : name;
}

/**
 * Names one part. The rules read the bind pose: what owns it, how big it is
 * and where it sits. They are written for this robot, and the tests pin the
 * count of every zone against the real asset, so a new robot.glb that breaks
 * them fails loudly rather than painting itself wrong.
 */
export function classifyIsland(bone: string, min: readonly number[], max: readonly number[]): Zone {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const width = x1 - x0;
  const height = y1 - y0;
  const depth = z1 - z0;
  const centreX = (x0 + x1) / 2;

  if (bone === 'Head') return Math.abs(centreX) < 0.02 ? ZONE.head : ZONE.headTrim;
  if (y1 < 0.17) return ZONE.thruster;
  // The torso box: centred, tall, above the waist.
  if (Math.abs(centreX) < 0.02 && y0 > 0.45 && height > 0.25) return ZONE.torso;
  if (bone === 'Pelvis' || bone === 'Hip') {
    // The hover pod itself, then the wide flat ring at its top.
    if (height > 0.25 && width > 0.2) return ZONE.shell;
    if (width > 0.25 && height < 0.06) return ZONE.trim;
    return ZONE.joint;
  }
  if (bone.includes('Forearm')) {
    // The gauntlet is the one long forearm part; the palm the one wide part; the rest are fingers.
    if (height > 0.1) return ZONE.shell;
    if (width > 0.09 && depth > 0.09) return ZONE.trim;
    return ZONE.joint;
  }
  if (bone.includes('Upperarm') || bone.includes('Clavicle')) {
    // The pad over the shoulder reaches highest; the bicep between it and the elbow is trim.
    if (y1 > 0.76) return ZONE.shell;
    if (y0 > 0.6) return ZONE.trim;
    return ZONE.joint;
  }
  return ZONE.joint;
}

/** Splits the robot body into its paint zones. */
export function segmentRobot(mesh: RobotMesh): RobotSegmentation {
  const vertexCount = Math.floor(mesh.positions.length / 3);
  const zone = new Float32Array(vertexCount);
  const islands: Island[] = [];

  for (const vertices of findIslands(vertexCount, mesh.index)) {
    const votes = new Map<string, number>();
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const v of vertices) {
      const bone = strongestJoint(mesh, v);
      votes.set(bone, (votes.get(bone) ?? 0) + 1);
      for (let k = 0; k < 3; k += 1) {
        const p = mesh.positions[v * 3 + k] as number;
        if (p < min[k]!) min[k] = p;
        if (p > max[k]!) max[k] = p;
      }
    }
    let bone = '';
    let most = 0;
    for (const [name, count] of votes) {
      if (count > most) {
        most = count;
        bone = name;
      }
    }
    const z = classifyIsland(bone, min, max);
    for (const v of vertices) zone[v] = z;
    islands.push({ vertices, bone, min, max, zone: z });
  }
  return { zone, islands };
}

/** A robot's paint: `#rrggbb` each. */
export interface AvatarColors {
  /** Armour and the torso (and the original head's box). */
  shell: string;
  /** Secondary panels (and the original head's ear discs). */
  trim: string;
  /** The chestplate's frame and the face screen's rim. */
  accent: string;
  /** The eyes, and the thruster's glow (with `eyeRight`, the eye on the left as you look at the robot). */
  eye: string;
  /** The eye on the right as you look at the robot (the robot's own left), when it differs from `eye`. */
  eyeRight?: string;
}

/** What a robot's armour is made of. The shell colour tints chrome and ice. */
export type AvatarFinish = 'paint' | 'chrome' | 'ice';

export const AVATAR_FINISHES: readonly AvatarFinish[] = Object.freeze(['paint', 'chrome', 'ice'] as const);

/**
 * How a finish renders, per surface: the shell (armour), the trim and the
 * joints, each [shell, trim, joint]. `lift` mixes the base colour toward white
 * (chrome stays bright whatever its tint); `alpha` below 1 lets the body be
 * seen into (ice); `rim` is a glow round the silhouette in the lifted shell
 * colour (ice's edge light); `env` is how much of the room the body reflects.
 */
export interface FinishLook {
  metalness: readonly [number, number, number];
  roughness: readonly [number, number, number];
  alpha: readonly [number, number, number];
  lift: number;
  rim: number;
  env: number;
  /** Drawn see-through (after everything solid). */
  transparent: boolean;
}

const FINISH_LOOKS: Readonly<Record<AvatarFinish, FinishLook>> = Object.freeze({
  // Today's look, exactly.
  paint: { metalness: [0.25, 0.55, 0.85], roughness: [0.4, 0.3, 0.34], alpha: [1, 1, 1], lift: 0, rim: 0, env: 0.55, transparent: false },
  // Mirror-bright: all metal, barely rough, reflecting the room.
  chrome: { metalness: [1, 1, 1], roughness: [0.06, 0.12, 0.2], alpha: [1, 1, 1], lift: 0.12, rim: 0, env: 1.4, transparent: false },
  // Clear and glossy, seen into, with light caught at the edges.
  ice: { metalness: [0, 0, 0.2], roughness: [0.12, 0.15, 0.22], alpha: [0.72, 0.78, 0.9], lift: 0.05, rim: 1, env: 0.5, transparent: true },
});

/** How `finish` renders; anything else (absent, or one this client doesn't know) is paint. */
export function finishLook(finish: AvatarFinish | null | undefined): FinishLook {
  return finish && Object.hasOwn(FINISH_LOOKS, finish) ? FINISH_LOOKS[finish] : FINISH_LOOKS.paint;
}

/**
 * Curated paints for members nobody has customised yet: each reads on the
 * cave's near-black, with eyes that stand clear of the shell. A member's id
 * picks one, so their robot looks the same on every screen and every visit.
 */
export const AVATAR_PALETTES: readonly AvatarColors[] = Object.freeze([
  { shell: '#e8e4da', trim: '#3a7bd5', accent: '#ffc23d', eye: '#5ee7ff' },
  { shell: '#d6452f', trim: '#2b2d33', accent: '#ffd36e', eye: '#ffe066' },
  { shell: '#2f6f5e', trim: '#c9b48a', accent: '#7cf2c4', eye: '#7cf2c4' },
  { shell: '#f2b134', trim: '#3d3d46', accent: '#ffffff', eye: '#ff6b3d' },
  { shell: '#4b4fd6', trim: '#d9dbe8', accent: '#9fa8ff', eye: '#b4f8ff' },
  { shell: '#f4f1ea', trim: '#e0457b', accent: '#ff8fb5', eye: '#ff4f8b' },
  { shell: '#1f2a44', trim: '#ff8a3d', accent: '#ffb27a', eye: '#ffae42' },
  { shell: '#7a8a99', trim: '#e3c04a', accent: '#ffe27a', eye: '#9dff6b' },
  { shell: '#8c2f39', trim: '#e6d3b3', accent: '#f6c56b', eye: '#ffd27a' },
  { shell: '#e0e7ef', trim: '#5b6b7c', accent: '#46d2ff', eye: '#46d2ff' },
  { shell: '#3c8d40', trim: '#f1e9d2', accent: '#c6ff6b', eye: '#eaff5e' },
  { shell: '#5a3d8c', trim: '#f0b429', accent: '#d7b7ff', eye: '#c18bff' },
  { shell: '#d98e04', trim: '#1d1d22', accent: '#ffcf5a', eye: '#ff3d3d' },
  { shell: '#0f6d8a', trim: '#f4e3c1', accent: '#6fe3ff', eye: '#a6ffef' },
  { shell: '#b5b9bf', trim: '#b03a2e', accent: '#ff7b5c', eye: '#ff5f4a' },
  { shell: '#262a30', trim: '#3fbf9b', accent: '#5dffd0', eye: '#5dffd0' },
]);

/** `#rrggbb`, lower or upper case. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** The paint a member's robot wears until someone customises it: picked by their id. */
export function defaultColors(id: string): AvatarColors {
  return AVATAR_PALETTES[paletteIndex(id)] as AvatarColors;
}

/** Which of AVATAR_PALETTES a member's id picks. */
export function paletteIndex(id: string): number {
  return hashId(id) % AVATAR_PALETTES.length;
}

/**
 * The letters on a generated chest emblem, for members without an uploaded
 * chestplate: the initials of the first two words of their name (or its
 * first two letters), upper case; '?' for a name with no letters at all.
 */
export function emblemInitials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '?';
  const [first, second] = words as [string, string | undefined];
  const letters = second ? [...first][0]! + [...second][0]! : [...first].slice(0, 2).join('');
  return letters.toLocaleUpperCase('en');
}
