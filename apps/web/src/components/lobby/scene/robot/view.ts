/**
 * One robot: a clone of the shared body (its own skeleton, the shared
 * geometry), its own body material, a head slot on the neck, blinking eyes, a
 * thruster flame, and the procedural pose (@forge/lobby's `robotPose`).
 *
 * Heads come in two fits (AvatarHead.fit):
 * - `replace`: the robot's own head is hidden and the library head sits on
 *   the neck; the eyes go on its EyeL/EyeR empties (their position,
 *   rotation and scale), or nowhere if it has none.
 * - `accessory`: a face accessory worn over the robot's own head (a mask, a
 *   visor, a helmet). The face screen and the eyes stay where they always
 *   are; the eyes and their glow are depth-tested, so whatever the accessory
 *   puts in front of them covers them, and an eye hole shows them through.
 *
 * Library heads are worn by their placement (AvatarHead.placement, set in
 * the editor): the file scaled about its origin, then moved, in HEAD_ANCHOR's
 * frame (origin on the neck, +Y up, facing +Z, metres, the robot's unscaled
 * size). A replacing head's eyes go where the placement says, or else on the
 * file's EyeL/EyeR, wherever its scale and move put them. A head's
 * materials named `shell…`, `trim…`, `accent…`, `joint…` or `eye…` take
 * this robot's colours (any other material keeps its own), and every one is
 * lit by the robots' environment map.
 *
 * Until a library head or a chest image arrives, the robot wears its own
 * head and the chestplate shows its loading scan; neither ever leaves a gap.
 * One that fails to load (offline for a moment, a 5xx) is tried again every
 * RETRY_MS while the robot still wears it, keeping the fallback meanwhile.
 */

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { FACE_PANEL, HEAD_ANCHOR, HEAD_FIT, createBlinker, eyeRotations, hashId, robotPose, rotateAbout } from '@forge/lobby';
import type { AvatarColors, Blinker, MotionInput, MotionPose } from '@forge/lobby';
import type { AvatarHead } from '@forge/shared';

import type { RobotAssets, RobotBody } from './assets';
import { JOINT_COLOR, createBodyMaterial, paint } from './material';

/**
 * After a head or chest image fails to load, how long before trying again: a
 * little longer than robot/assets.ts keeps a failure cached.
 */
export const RETRY_MS = 35_000;

/** The robot's size in the lobby: 1.4 m tall, so it hovers about a third of a metre up at eye height. */
export const ROBOT_SCALE = 1.4;
/** Where its eyes sit below the member's own eye height, metres. */
export const EYE_DROP = 0.08;
/** The robot's eye height in its own (unscaled) frame. */
const EYE_Y = (FACE_PANEL.minY + FACE_PANEL.maxY) / 2 + 0.01;
/** How high above the robot's root its name tag goes. */
export const TAG_HEIGHT = 1.12 * ROBOT_SCALE;
/** Where the body leans and banks around (unscaled), about its middle. */
const PIVOT_Y = 0.55;
/** The robot's own eyes, on its face screen (unscaled, from HEAD_ANCHOR). */
const OWN_EYES = [-1, 1].map((side) => new THREE.Vector3(side * 0.058, EYE_Y - HEAD_ANCHOR.y, FACE_PANEL.z + 0.004));

/** What a robot looks like: who it is, its paint, its head and its chestplate. */
export interface RobotLook {
  id: string;
  name: string;
  colors: AvatarColors;
  head: AvatarHead | null;
  /** A face accessory worn over the head (its own or a library one); absent or null: none. */
  accessory?: AvatarHead | null;
  /** The chest image's sha256; null wears the generated emblem. */
  chest: string | null;
}

/** A look's identity, to tell when it changed. */
export function lookKey(look: RobotLook): string {
  const { colors: c } = look;
  const accessory = look.accessory ?? null;
  return [
    look.name,
    c.shell,
    c.trim,
    c.accent,
    c.eye,
    look.head?.sha256 ?? '',
    look.head?.fit ?? '',
    placementKey(look.head),
    accessory?.sha256 ?? '',
    placementKey(accessory),
    look.chest ?? '',
  ].join('|');
}

/** A head's placement, to tell when only that changed. */
function placementKey(head: AvatarHead | null): string {
  if (!head) return '';
  const { scale, offset, eyes, eyeAngles, angles, eyeScale, screen } = head.placement;
  return JSON.stringify([scale, offset, eyes ?? null, eyeAngles ?? null, angles ?? null, eyeScale ?? null, screen ?? null]);
}

/** Where `node` sits in `ancestor`'s frame (ancestor's own transform left out). */
function positionIn(ancestor: THREE.Object3D, node: THREE.Object3D): THREE.Vector3 {
  const at = node.position.clone();
  for (let up = node.parent; up && up !== ancestor; up = up.parent) {
    up.updateMatrix();
    at.applyMatrix4(up.matrix);
  }
  return at;
}

/** What drives one frame of a robot, besides its pose inputs. */
export interface RobotFrame extends Omit<MotionInput, 'phase'> {
  dt: number;
  talking: boolean;
}

export interface RobotView {
  /** Add this to the scene; position and rotate it (yaw: rotation.y). */
  readonly root: THREE.Group;
  readonly look: RobotLook;
  /** 'loading' while a head or chest image it wears is still on its way. */
  readonly state: 'loading' | 'ready';
  setLook(look: RobotLook): void;
  /** Shows the chestplate's loading scan (an upload on its way), or lets the image back. */
  holdChest(loading: boolean): void;
  update(frame: RobotFrame): MotionPose;
  /**
   * Where `raycaster` meets the head it wears (for the editor's fitting): on
   * the model, or else on the face screen's plane (what an eye hole shows),
   * in the head frame and in the file's own frame. Null with no head worn.
   */
  pickHead(raycaster: THREE.Raycaster, target?: 'head' | 'accessory'): HeadPick | null;
  dispose(): void;
}

/** A spot picked on a worn head. */
export interface HeadPick {
  /**
   * In the head frame (metres from the neck). On a head: unangled, as its placement's eyes
   * are given; on an accessory: where it really is, as the eyes it lines up with are.
   */
  head: [number, number, number];
  /** In the head file's own frame (before its placement). */
  file: [number, number, number];
  /** Whether it is on the model itself, not seen through it. */
  onModel: boolean;
  /** Which way the model's surface faces there (head frame, unit length; facing out), when on it. */
  normal: [number, number, number] | null;
}

/** The eye shape every robot shares: a softly rounded pill. */
let eyeGeometry: THREE.ShapeGeometry | null = null;
function sharedEyeGeometry(): THREE.ShapeGeometry {
  if (!eyeGeometry) {
    const w = 0.042;
    const h = 0.058;
    const r = 0.019;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    eyeGeometry = new THREE.ShapeGeometry(shape, 6);
  }
  return eyeGeometry;
}

/** A head material's role, from its name. */
function roleOf(name: string): keyof AvatarColors | 'joint' | null {
  const lower = name.toLowerCase();
  for (const role of ['shell', 'trim', 'accent', 'joint', 'eye'] as const) {
    if (lower.startsWith(role)) return role;
  }
  return null;
}

/** A shiny black LED face screen: a rounded panel, the same for every robot (sized per head). */
let screenGeometry: THREE.ShapeGeometry | null = null;
function sharedScreenGeometry(): THREE.ShapeGeometry {
  if (!screenGeometry) {
    // A unit panel (1 x 1, corners rounded as on a 0.25 m screen), scaled to each screen's size.
    const r = 0.06;
    const shape = new THREE.Shape();
    shape.moveTo(-0.5 + r, -0.5);
    shape.lineTo(0.5 - r, -0.5);
    shape.quadraticCurveTo(0.5, -0.5, 0.5, -0.5 + r);
    shape.lineTo(0.5, 0.5 - r);
    shape.quadraticCurveTo(0.5, 0.5, 0.5 - r, 0.5);
    shape.lineTo(-0.5 + r, 0.5);
    shape.quadraticCurveTo(-0.5, 0.5, -0.5, 0.5 - r);
    shape.lineTo(-0.5, -0.5 + r);
    shape.quadraticCurveTo(-0.5, -0.5, -0.5 + r, -0.5);
    screenGeometry = new THREE.ShapeGeometry(shape, 4);
  }
  return screenGeometry;
}

/**
 * The cut a face screen makes in its head (the head file's frame): whatever
 * of the model stands in front of the screen inside its opening is not drawn,
 * so the model's own sculpted eyes don't poke through. Shared by a head's
 * materials; `on` 0 cuts nothing.
 */
interface HeadCut {
  on: { value: number };
  rect: { value: THREE.Vector4 };
  z: { value: number };
}

/** Teaches a head material the screen's cut; `toRoot` is its mesh's transform within the head file. */
function cutHeadMaterial(material: THREE.Material, cut: HeadCut, toRoot: THREE.Matrix4): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCutOn = cut.on;
    shader.uniforms.uCutRect = cut.rect;
    shader.uniforms.uCutZ = cut.z;
    shader.uniforms.uMeshToRoot = { value: toRoot };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uMeshToRoot;\nvarying vec3 vHeadPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeadPos = (uMeshToRoot * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uCutOn;\nuniform vec4 uCutRect;\nuniform float uCutZ;\nvarying vec3 vHeadPos;',
      )
      .replace(
        'void main() {',
        'void main() {\n  if (uCutOn > 0.5 && vHeadPos.z > uCutZ && vHeadPos.x > uCutRect.x && vHeadPos.x < uCutRect.z && vHeadPos.y > uCutRect.y && vHeadPos.y < uCutRect.w) discard;',
      );
  };
  material.customProgramCacheKey = () => 'forge-head-cut';
  material.needsUpdate = true;
}

interface Bones {
  head: THREE.Bone | null;
  spine: THREE.Bone | null;
  arms: { upper: THREE.Bone; fore: THREE.Bone | null; side: 1 | -1 }[];
}

/** A bone's rest rotation, and the robot's axes expressed in the bone's own frame. */
interface Rest {
  bone: THREE.Bone;
  bind: THREE.Quaternion;
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}

function restOf(bone: THREE.Bone): Rest {
  const world = new THREE.Quaternion();
  bone.getWorldQuaternion(world);
  const inverse = world.invert();
  return {
    bone,
    bind: bone.quaternion.clone(),
    x: new THREE.Vector3(1, 0, 0).applyQuaternion(inverse),
    y: new THREE.Vector3(0, 1, 0).applyQuaternion(inverse),
    z: new THREE.Vector3(0, 0, 1).applyQuaternion(inverse),
  };
}

const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

/** Turns a bone from its rest by angles about the robot's own X, Y and Z axes. */
function pose(rest: Rest | null, ax: number, ay = 0, az = 0): void {
  if (!rest) return;
  rest.bone.quaternion.copy(rest.bind);
  if (ay) rest.bone.quaternion.multiply(q1.setFromAxisAngle(rest.y, ay));
  if (ax) rest.bone.quaternion.multiply(q2.setFromAxisAngle(rest.x, ax));
  if (az) rest.bone.quaternion.multiply(q1.setFromAxisAngle(rest.z, az));
}

export interface RobotDeps {
  assets: RobotAssets;
  body: RobotBody;
  /** The soft radial glow peers.ts already draws orbs with. */
  glow: THREE.Texture;
  /** Shown on the chestplate until an image is ready (a 1×1 black texture). */
  blank: THREE.Texture;
}

export function createRobot(deps: RobotDeps, initial: RobotLook): RobotView {
  const { assets, body, glow, blank } = deps;
  const seed = hashId(initial.id);
  const phase = ((seed % 10_000) / 10_000) * Math.PI * 2;
  const blinker: Blinker = createBlinker(seed);

  const root = new THREE.Group();
  root.name = 'robot';
  const tilt = new THREE.Group();
  tilt.position.y = PIVOT_Y * ROBOT_SCALE;
  root.add(tilt);
  const lift = new THREE.Group();
  lift.position.y = -PIVOT_Y * ROBOT_SCALE;
  lift.scale.setScalar(ROBOT_SCALE);
  tilt.add(lift);

  const model = cloneSkinned(body.scene) as THREE.Group;
  lift.add(model);
  let mesh: THREE.SkinnedMesh | null = null;
  model.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh;
  });
  const skinned = mesh as THREE.SkinnedMesh | null;
  const { material, uniforms } = createBodyMaterial(assets.envMap, blank);
  if (skinned) {
    skinned.material = material;
    skinned.frustumCulled = false;
  }

  // Bones, and the head slot: a frame on the head bone that is the model's
  // own frame at HEAD_ANCHOR in the bind pose.
  model.updateMatrixWorld(true);
  const find = (name: string): THREE.Bone | null => {
    const found = model.getObjectByName(name);
    return found && (found as THREE.Bone).isBone ? (found as THREE.Bone) : null;
  };
  const bones: Bones = {
    head: find('CC_Base_Head'),
    spine: find('CC_Base_Spine02'),
    arms: (
      [
        ['L', 1],
        ['R', -1],
      ] as const
    ).flatMap(([s, side]) => {
      const upper = find(`CC_Base_${s}_Upperarm`);
      return upper ? [{ upper, fore: find(`CC_Base_${s}_Forearm`), side }] : [];
    }),
  };
  const rest = {
    head: bones.head ? restOf(bones.head) : null,
    spine: bones.spine ? restOf(bones.spine) : null,
    arms: bones.arms.map((arm) => ({ side: arm.side, upper: restOf(arm.upper), fore: arm.fore ? restOf(arm.fore) : null })),
  };
  const slot = new THREE.Group();
  slot.name = 'head-slot';
  slot.matrixAutoUpdate = false;
  if (bones.head) {
    const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const headInModel = new THREE.Matrix4().multiplyMatrices(modelInverse, bones.head.matrixWorld);
    slot.matrix
      .copy(headInModel)
      .invert()
      .multiply(new THREE.Matrix4().makeTranslation(HEAD_ANCHOR.x, HEAD_ANCHOR.y, HEAD_ANCHOR.z));
    bones.head.add(slot);
  } else {
    slot.matrix.makeTranslation(HEAD_ANCHOR.x, HEAD_ANCHOR.y, HEAD_ANCHOR.z);
    model.add(slot);
  }

  // Eyes: a pill and its glow each. Depth-tested, so a face accessory covers them.
  const eyeMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
  const haloMaterial = new THREE.SpriteMaterial({
    map: glow,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.5,
  });
  const eyes = [0, 1].map(() => {
    const group = new THREE.Group();
    const pill = new THREE.Mesh(sharedEyeGeometry(), eyeMaterial);
    pill.renderOrder = 2;
    const halo = new THREE.Sprite(haloMaterial);
    halo.scale.setScalar(0.15);
    halo.position.z = 0.004;
    halo.renderOrder = 3;
    group.add(pill, halo);
    return { group, pill, halo };
  });
  const ownSockets = OWN_EYES.map((at) => {
    const socket = new THREE.Group();
    socket.position.copy(at);
    slot.add(socket);
    return socket;
  });
  // A replacing head's face screen, and the cut it makes in the head.
  const headCut: HeadCut = { on: { value: 0 }, rect: { value: new THREE.Vector4() }, z: { value: 0 } };
  const screenMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x030305,
    roughness: 0.16,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMap: assets.envMap,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  });
  // A worn head turns as a whole (its placement's angles) about its offset: the
  // model, its face screen and its eyes ride this pivot, set at the offset.
  const headPivot = new THREE.Group();
  headPivot.name = 'head-pivot';
  slot.add(headPivot);
  const accessoryPivot = new THREE.Group();
  accessoryPivot.name = 'accessory-pivot';
  slot.add(accessoryPivot);

  const screen = new THREE.Mesh(sharedScreenGeometry(), screenMaterial);
  screen.name = 'face-screen';
  screen.visible = false;
  headPivot.add(screen);

  // A replacing head's eyes: where its placement, or its EyeL/EyeR, put them.
  const fittedSockets = [0, 1].map(() => {
    const socket = new THREE.Group();
    headPivot.add(socket);
    return socket;
  });

  /** Sets a pivot at a placement's offset, angled as it says. */
  const turnPivot = (pivot: THREE.Object3D, placement: AvatarHead['placement']): void => {
    const [tilt, turn, slant] = placement.angles ?? [0, 0, 0];
    pivot.position.set(placement.offset[0], placement.offset[1], placement.offset[2]);
    pivot.rotation.set(tilt, turn, slant, 'YXZ');
  };

  // The thruster's flame, under the pod's tip.
  const flameMaterial = new THREE.SpriteMaterial({
    map: glow,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flame = new THREE.Sprite(flameMaterial);
  flame.position.set(0, -0.02, 0);
  lift.add(flame);

  let look = initial;
  let key = '';
  let headObject: THREE.Object3D | null = null;
  let headMaterials: THREE.Material[] = [];
  let pendingHead: string | null = null;
  let accessoryObject: THREE.Object3D | null = null;
  let accessoryMaterials: THREE.Material[] = [];
  let pendingAccessory: string | null = null;
  let accessoryRetryAt: number | null = null;
  let pendingChest: string | null = null;
  /** When to try a failed head or chest image again (performance.now() ms), or null. */
  let headRetryAt: number | null = null;
  let chestRetryAt: number | null = null;
  let chestFadeTarget = 0;
  let talk = 0;
  let holding = false;
  let disposed = false;

  const placeEyes = (sockets: THREE.Object3D[]): void => {
    eyes.forEach((eye, i) => {
      const socket = sockets[i];
      eye.group.removeFromParent();
      if (socket) socket.add(eye.group);
    });
  };

  const tintHead = (): void => {
    tint(headMaterials);
    tint(accessoryMaterials);
  };

  /**
   * Paints a worn model's materials: those named for a colour take it; a plain
   * model (no texture, no material named for a colour, as a modeller's
   * untextured export comes) takes the robot's armour colour; a textured one
   * keeps its own look.
   */
  const tint = (materials: THREE.Material[]): void => {
    const plain = materials.every((each) => !roleOf(each.name) && !(each as THREE.MeshStandardMaterial).map);
    for (const each of materials) {
      const role = roleOf(each.name) ?? (plain ? 'shell' : null);
      const standard = each as THREE.MeshStandardMaterial;
      if (!role || !standard.color) continue;
      const hex = role === 'joint' ? JOINT_COLOR : look.colors[role];
      standard.color.set(hex);
      if (role === 'eye' && standard.emissive) standard.emissive.set(hex);
    }
  };

  /** Scales and moves the worn head as `head.placement` says, and puts a replacing head's eyes. */
  const placeHead = (head: AvatarHead): void => {
    if (!headObject) return;
    const { scale, offset, eyes, eyeAngles, eyeScale, screen: panel } = head.placement;
    const turns = eyeRotations(eyeAngles);
    const eyeSize = eyeScale ?? 1;
    // The pivot sits at the offset, so everything on it is placed relative to that.
    turnPivot(headPivot, head.placement);
    headObject.scale.setScalar(scale);
    headObject.position.set(0, 0, 0);
    const face = head.fit === 'replace' ? panel : null;
    screen.visible = Boolean(face);
    headCut.on.value = face ? 1 : 0;
    if (face) {
      const [w, h] = face.size;
      screen.position.set(face.center[0] - offset[0], face.center[1] - offset[1], face.center[2] - offset[2]);
      screen.scale.set(w, h, 1);
      // Cut the opening only (the screen tucks behind the frame round it), in the file's frame.
      const tuck = HEAD_FIT.screenTuck;
      const toFile = (v: number, axis: 0 | 1 | 2): number => (v - offset[axis]) / scale;
      headCut.rect.value.set(
        toFile(face.center[0] - w / 2 + tuck, 0),
        toFile(face.center[1] - h / 2 + tuck, 1),
        toFile(face.center[0] + w / 2 - tuck, 0),
        toFile(face.center[1] + h / 2 - tuck, 1),
      );
      // Just behind the screen: a screen laid on a closed face shows through it, as one closing a hollow does.
      headCut.z.value = toFile(face.center[2] - HEAD_FIT.screenCut, 2);
    }
    if (head.fit !== 'replace') return;
    if (eyes) {
      eyes.forEach((eye, i) => {
        const socket = fittedSockets[i]!;
        socket.position.set(eye[0] - offset[0], eye[1] - offset[1], eye[2] - offset[2]);
        const [x, y, z] = turns[i]!;
        socket.rotation.set(x, y, z, 'YXZ');
        socket.scale.setScalar(eyeSize);
      });
      placeEyes(fittedSockets);
      return;
    }
    const object = headObject;
    const marks = ['EyeL', 'EyeR'].map((name) => object.getObjectByName(name)).filter((o) => o !== undefined);
    if (marks.length !== 2) {
      placeEyes([]);
      return;
    }
    marks.forEach((mark, i) => {
      const socket = fittedSockets[i]!;
      socket.position.copy(positionIn(object, mark)).multiplyScalar(scale);
      if (eyeAngles) {
        const [x, y, z] = turns[i]!;
        socket.rotation.set(x, y, z, 'YXZ');
      } else {
        socket.quaternion.copy(mark.quaternion);
      }
      socket.scale.copy(mark.scale).multiplyScalar(eyeSize);
    });
    placeEyes(fittedSockets);
  };

  const dropHead = (): void => {
    if (headObject) {
      headObject.removeFromParent();
      // Geometry and textures belong to the cached head; the materials are this robot's.
      for (const each of headMaterials) each.dispose();
      headObject = null;
      headMaterials = [];
    }
    uniforms.uHideHead.value = 0;
    headPivot.position.set(0, 0, 0);
    headPivot.rotation.set(0, 0, 0);
    screen.visible = false;
    headCut.on.value = 0;
    placeEyes(ownSockets);
  };

  /** Loads a library model's own copy for this robot: its materials cloned, double-sided, lit by the robots' map. */
  const cloneModel = (
    scene: THREE.Object3D,
    prepare: (material: THREE.Material, toRoot: THREE.Matrix4) => void,
  ): { object: THREE.Object3D; materials: THREE.Material[] } => {
    const object = scene.clone(true);
    const materials: THREE.Material[] = [];
    object.updateMatrixWorld(true);
    const rootInverse = object.matrixWorld.clone().invert();
    object.traverse((child) => {
      const meshChild = child as THREE.Mesh;
      if (!meshChild.isMesh) return;
      // Where this mesh sits within the model's file.
      const toRoot = rootInverse.clone().multiply(meshChild.matrixWorld);
      const list = Array.isArray(meshChild.material) ? meshChild.material : [meshChild.material];
      const cloned = list.map((m) => {
        const copy = m.clone();
        // Modellers' meshes often face some triangles inward: drawn from both sides, a model never shows holes.
        copy.side = THREE.DoubleSide;
        prepare(copy, toRoot);
        const standard = copy as THREE.MeshStandardMaterial;
        if ('envMap' in standard) {
          standard.envMap = assets.envMap;
          standard.envMapIntensity = 0.55;
        }
        materials.push(copy);
        return copy;
      });
      meshChild.material = Array.isArray(meshChild.material) ? cloned : cloned[0]!;
    });
    return { object, materials };
  };

  const placeAccessory = (accessory: AvatarHead): void => {
    if (!accessoryObject) return;
    turnPivot(accessoryPivot, accessory.placement);
    accessoryObject.scale.setScalar(accessory.placement.scale);
    accessoryObject.position.set(0, 0, 0);
  };

  const dropAccessory = (): void => {
    if (!accessoryObject) return;
    accessoryObject.removeFromParent();
    for (const each of accessoryMaterials) each.dispose();
    accessoryObject = null;
    accessoryMaterials = [];
  };

  const wearAccessory = (accessory: AvatarHead): void => {
    pendingAccessory = accessory.sha256;
    assets.head(accessory.sha256).then(
      (gltf) => {
        if (disposed || pendingAccessory !== accessory.sha256) return;
        pendingAccessory = null;
        dropAccessory();
        const { object, materials } = cloneModel(gltf.scene, () => undefined);
        accessoryObject = object;
        accessoryMaterials = materials;
        tint(accessoryMaterials);
        accessoryPivot.add(object);
        placeAccessory(look.accessory?.sha256 === accessory.sha256 ? look.accessory : accessory);
      },
      () => {
        // It didn't load: none for now, tried again in a while.
        if (disposed || pendingAccessory !== accessory.sha256) return;
        pendingAccessory = null;
        accessoryRetryAt = performance.now() + RETRY_MS;
      },
    );
  };

  const wearHead = (head: AvatarHead): void => {
    pendingHead = head.sha256;
    assets.head(head.sha256).then(
      (gltf) => {
        if (disposed || pendingHead !== head.sha256) return;
        pendingHead = null;
        dropHead();
        // The face screen's cut, in the head file's frame.
        const { object, materials } = cloneModel(gltf.scene, (material, toRoot) => cutHeadMaterial(material, headCut, toRoot));
        headObject = object;
        headMaterials = materials;
        tintHead();
        headPivot.add(object);
        if (head.fit === 'replace') uniforms.uHideHead.value = 1;
        // The placement as it is now: it may have changed while the file loaded.
        placeHead(look.head?.sha256 === head.sha256 ? look.head : head);
      },
      () => {
        // The head didn't load: the robot keeps its own, and tries again in a while.
        if (disposed || pendingHead !== head.sha256) return;
        pendingHead = null;
        headRetryAt = performance.now() + RETRY_MS;
      },
    );
  };

  /** `retry`: the emblem stays up while the image is tried again, rather than the loading scan. */
  const wearChest = (next: RobotLook, retry = false): void => {
    if (!retry) {
      uniforms.uChestFade.value = 0;
      chestFadeTarget = 0;
    }
    const emblem = (): void => {
      uniforms.uChest.value = assets.emblem(next.id, next.name, next.colors);
      uniforms.uChestAspect.value = 1;
      uniforms.uChestFull.value = 0;
      chestFadeTarget = 1;
    };
    if (!next.chest) {
      pendingChest = null;
      emblem();
      return;
    }
    const sha = next.chest;
    pendingChest = sha;
    if (!retry) uniforms.uChest.value = blank;
    assets.chest(sha).then(
      (texture) => {
        if (disposed || pendingChest !== sha) return;
        pendingChest = null;
        if (retry) uniforms.uChestFade.value = 0;
        const image = texture.image as { width?: number; height?: number } | undefined;
        uniforms.uChest.value = texture;
        uniforms.uChestAspect.value = image?.width && image.height ? image.width / image.height : 1;
        uniforms.uChestFull.value = 1;
        chestFadeTarget = 1;
      },
      () => {
        if (disposed || pendingChest !== sha) return;
        pendingChest = null;
        // The emblem meanwhile, and the image again in a while.
        if (!retry) emblem();
        chestRetryAt = performance.now() + RETRY_MS;
      },
    );
  };

  const setLook = (next: RobotLook): void => {
    const nextKey = lookKey(next);
    if (nextKey === key) return;
    const previous = look;
    const first = key === '';
    key = nextKey;
    look = next;
    paint(uniforms, next.colors);
    eyeMaterial.color.set(next.colors.eye).multiplyScalar(1.6);
    haloMaterial.color.set(next.colors.eye);
    flameMaterial.color.set(next.colors.eye);
    if (first || previous.head?.sha256 !== next.head?.sha256 || previous.head?.fit !== next.head?.fit) {
      pendingHead = null;
      headRetryAt = null;
      dropHead();
      if (next.head) wearHead(next.head);
    } else {
      tintHead();
      if (next.head && placementKey(previous.head) !== placementKey(next.head)) placeHead(next.head);
    }
    const before = previous.accessory ?? null;
    const after = next.accessory ?? null;
    if (first || before?.sha256 !== after?.sha256) {
      pendingAccessory = null;
      accessoryRetryAt = null;
      dropAccessory();
      if (after) wearAccessory(after);
    } else if (after && placementKey(before) !== placementKey(after)) {
      placeAccessory(after);
    }
    const emblemChanged = !next.chest && (previous.name !== next.name || previous.colors.accent !== next.colors.accent || previous.colors.eye !== next.colors.eye);
    if (first || previous.chest !== next.chest || emblemChanged) {
      chestRetryAt = null;
      wearChest(next);
    }
  };

  setLook(initial);

  const pickHead = (raycaster: THREE.Raycaster, target: 'head' | 'accessory' = 'head'): HeadPick | null => {
    const head = target === 'head' ? look.head : (look.accessory ?? null);
    const object = target === 'head' ? headObject : accessoryObject;
    if (!head || !object) return null;
    root.updateMatrixWorld(true);
    const { offset } = head.placement;
    // The frame a pick is told in: a head's own (unangled, its pivot's plus the offset), or the slot's.
    const toFrame =
      target === 'head'
        ? new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]).multiply(headPivot.matrixWorld.clone().invert())
        : slot.matrixWorld.clone().invert();
    const hit = raycaster.intersectObject(object, true)[0];
    let world: THREE.Vector3 | null;
    let normal: [number, number, number] | null = null;
    if (hit) {
      world = hit.point.clone();
      if (hit.face) {
        // The face's normal into that frame, by the normal matrix (the inverse transpose) of the
        // hit object's transform there, so a non-uniformly scaled model still gives the true angle.
        const toHeadFrame = toFrame.clone().multiply(hit.object.matrixWorld);
        const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(toHeadFrame)).normalize();
        if (n.z < 0) n.negate();
        normal = [n.x, n.y, n.z];
      }
    } else {
      // Seen through (an eye hole): where the eyes are, on a replacing head's face or the robot's own.
      const worn = look.head?.fit === 'replace' && look.head.placement.eyes ? look.head : null;
      let faceZ = FACE_PANEL.z + 0.004;
      if (worn?.placement.eyes) {
        const [left, right] = worn.placement.eyes;
        faceZ = target === 'head' ? Math.min(left[2], right[2]) : Math.min(rotateAbout(worn.placement, left)[2], rotateAbout(worn.placement, right)[2]);
      }
      const ray = raycaster.ray.clone().applyMatrix4(toFrame);
      const at = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -faceZ), new THREE.Vector3());
      world = at ? at.applyMatrix4(toFrame.clone().invert()) : null;
    }
    if (!world) return null;
    const at = world.clone().applyMatrix4(toFrame);
    // The file's own frame is the model's: its transform undone, angles and all.
    const file = object.worldToLocal(world.clone());
    const round = (v: number): number => Math.round(v * 10_000) / 10_000 + 0;
    return {
      head: [round(at.x), round(at.y), round(at.z)],
      file: [round(file.x), round(file.y), round(file.z)],
      onModel: Boolean(hit),
      normal,
    };
  };

  return {
    root,
    pickHead,
    get look() {
      return look;
    },
    get state() {
      return pendingHead !== null || pendingAccessory !== null || pendingChest !== null || holding ? 'loading' : 'ready';
    },
    setLook,
    holdChest(loading) {
      holding = loading;
    },
    update(frame) {
      if (headRetryAt !== null || accessoryRetryAt !== null || chestRetryAt !== null) {
        const now = performance.now();
        if (accessoryRetryAt !== null && now >= accessoryRetryAt) {
          accessoryRetryAt = null;
          if (look.accessory) wearAccessory(look.accessory);
        }
        if (headRetryAt !== null && now >= headRetryAt) {
          headRetryAt = null;
          if (look.head) wearHead(look.head);
        }
        if (chestRetryAt !== null && now >= chestRetryAt) {
          chestRetryAt = null;
          if (look.chest) wearChest(look, true);
        }
      }
      const p = robotPose({ ...frame, phase });
      uniforms.uTime.value = frame.t;
      uniforms.uThrust.value = p.thrust;
      talk += ((frame.talking ? 1 : 0) - talk) * (1 - Math.exp(-frame.dt * 10));
      uniforms.uTalk.value = talk;
      const fade = uniforms.uChestFade.value;
      const shown = holding ? 0 : chestFadeTarget;
      uniforms.uChestFade.value = fade + (shown - fade) * (1 - Math.exp(-frame.dt * (holding ? 8 : 4)));

      lift.position.y = -PIVOT_Y * ROBOT_SCALE + p.bob;
      tilt.rotation.set(p.pitch, 0, p.roll);
      pose(rest.spine, p.breath);
      pose(rest.head, p.headPitch, p.headYaw);
      for (const arm of rest.arms) {
        pose(arm.upper, p.armSwing + arm.side * p.armSway);
        pose(arm.fore, p.armSwing * 0.45 + 0.08);
      }

      const open = blinker.openness(frame.t);
      for (const eye of eyes) {
        eye.pill.scale.y = open;
        eye.halo.material.opacity = 0.18 + 0.32 * open + 0.25 * talk;
      }
      const flicker = frame.reducedMotion ? 1 : 0.9 + 0.1 * Math.sin(frame.t * 47 + phase * 13);
      flame.scale.set(0.18 + 0.1 * p.thrust, (0.22 + 0.45 * p.thrust) * flicker, 1);
      flame.position.y = -0.04 - 0.1 * p.thrust;
      flameMaterial.opacity = 0.35 + 0.55 * p.thrust;
      return p;
    },
    dispose() {
      disposed = true;
      dropHead();
      dropAccessory();
      root.removeFromParent();
      material.dispose();
      eyeMaterial.dispose();
      haloMaterial.dispose();
      flameMaterial.dispose();
      screenMaterial.dispose();
      // The skeleton's bone texture is this robot's own.
      skinned?.skeleton.dispose();
    },
  };
}
