/**
 * A talking mouth on a worn head: the plate that shuts the model's mouth
 * opening, and the stream of green blocks that pours out while its wearer
 * talks (@forge/lobby's mouth.ts says when, how open, and where each block is).
 *
 * The plate rides the head: it lives in the head file's own frame, sized to
 * the opening the fit marked (fractions of the file's bounding box), and
 * hinges down into the jaw about its bottom edge to open. The blocks fly in
 * the cave's frame (an instanced mesh beside the robot), so a head that turns
 * doesn't drag the ones already in the air.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MOUTH, blockFrame, blockShot, createMouthState, spewDue, stepMouth } from '@forge/lobby';
import type { BlockShot, MouthState } from '@forge/lobby';
import type { AvatarHeadMouth } from '@forge/shared';

/** How far the plate swings into the jaw when open, radians. */
const OPEN_ANGLE = 1.5;
/** The plate's depth, against its height. */
const PLATE_DEPTH = 0.35;
/** How much bigger than the opening the plate is (so no gap shows round it). */
const PLATE_OVERLAP = 1.04;
/** A block's size against the mouth's height. */
const BLOCK_SIZE = 1.25;

export type MouthLook = 'shut' | 'open' | 'spewing';

export interface TalkingMouth {
  /** Add to the head model (its file's frame). */
  readonly plate: THREE.Group;
  /** Add to the cave (or whatever the robot stands in). */
  readonly stream: THREE.InstancedMesh;
  /** Fits the plate to the marked opening, given the head file's bounding box. */
  fit(mouth: AvatarHeadMouth, fileBox: THREE.Box3): void;
  /** One frame: `now` and `dt` in seconds. */
  update(talking: boolean, now: number, dt: number, still: boolean): MouthLook;
  dispose(): void;
}

/** The block every stream shares: a chunky slab with a raised step at its back, like the art's. */
let blockGeometry: THREE.BufferGeometry | null = null;
function sharedBlock(): THREE.BufferGeometry {
  if (!blockGeometry) {
    const slab = new THREE.BoxGeometry(1, 0.34, 1).translate(0, -0.17, 0);
    const step = new THREE.BoxGeometry(1, 0.42, 0.42).translate(0, 0.21, -0.29);
    blockGeometry = mergeGeometries([slab.toNonIndexed(), step.toNonIndexed()]) ?? slab;
    slab.dispose();
    step.dispose();
  }
  return blockGeometry;
}

interface Flying {
  n: number;
  /** When it left (seconds). */
  at: number;
  from: THREE.Vector3;
  forward: THREE.Vector3;
  shot: BlockShot;
  /** Its size in the cave, metres. */
  size: number;
}

export function createTalkingMouth(envMap: THREE.Texture | null, seed: number): TalkingMouth {
  const plate = new THREE.Group();
  plate.name = 'mouth-plate';
  const hinge = new THREE.Group();
  plate.add(hinge);
  const plateMaterial = new THREE.MeshStandardMaterial({ color: 0x8a4b2c, metalness: 0.55, roughness: 0.42, envMap, envMapIntensity: 1.1 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), plateMaterial);
  // A darker seam along its top, where it meets the face.
  const seamMaterial = new THREE.MeshStandardMaterial({ color: 0x1a0d08, metalness: 0.3, roughness: 0.7 });
  const seam = new THREE.Mesh(new THREE.BoxGeometry(1, 0.08, 0.02), seamMaterial);
  hinge.add(slab, seam);

  const blockMaterial = new THREE.MeshStandardMaterial({
    color: 0x86d42a,
    emissive: 0x2f6a00,
    emissiveIntensity: 0.35,
    metalness: 0.05,
    roughness: 0.32,
    envMap,
    envMapIntensity: 0.9,
  });
  const stream = new THREE.InstancedMesh(sharedBlock(), blockMaterial, MOUTH.pool);
  stream.name = 'mouth-stream';
  stream.count = 0;
  stream.frustumCulled = false;
  stream.castShadow = true;
  // The stream isn't under the robot (its blocks fly in the cave), so it doesn't hide with it:
  // while the robot is hidden (your own, in first person) it draws nothing, until it's back.
  stream.onBeforeRender = () => {
    for (let o: THREE.Object3D | null = plate; o; o = o.parent) {
      if (!o.visible) {
        stream.count = 0;
        return;
      }
    }
  };

  let state: MouthState = createMouthState();
  let height = 0;
  const flying: Flying[] = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const lip = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const plateScale = new THREE.Vector3();

  return {
    plate,
    stream,
    fit(mouth, box) {
      const size = box.getSize(new THREE.Vector3());
      const [fx, fy, fz] = mouth.center;
      const w = mouth.size[0] * size.x * PLATE_OVERLAP;
      const h = mouth.size[1] * size.y * PLATE_OVERLAP;
      const d = h * PLATE_DEPTH;
      height = mouth.size[1] * size.y;
      // The hinge runs along the opening's bottom edge, at the face.
      plate.position.set(box.min.x + fx * size.x, box.min.y + fy * size.y - h / 2, box.min.z + fz * size.z);
      slab.scale.set(w, h, d);
      slab.position.set(0, h / 2, -d / 2 - h * 0.02);
      seam.scale.set(w, h, 1);
      seam.position.set(0, h * 0.97, -h * 0.01);
      plateMaterial.color.set(mouth.color);
      seamMaterial.color.set(mouth.color).multiplyScalar(0.28);
    },
    update(talking, now, dt, still) {
      state = stepMouth(state, talking, dt);
      // Open: the plate's top swings back and down into the jaw.
      hinge.rotation.x = -state.open * OPEN_ANGLE;
      plate.updateWorldMatrix(true, true);
      // The lip, in the cave: the middle of the opening, a little out from the face.
      lip.set(0, height / 2, height * 0.3).applyMatrix4(plate.matrixWorld);
      plate.matrixWorld.decompose(position, quaternion, plateScale);
      const worldHeight = height * plateScale.y;
      forward.set(0, 0, 1).applyQuaternion(quaternion);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
      forward.normalize();
      const size = worldHeight * BLOCK_SIZE;

      if (still) {
        // Less motion: no stream, just one block hanging at the lip while it talks.
        flying.length = 0;
        state = { ...state, next: null };
        if (talking && state.open > MOUTH.spewFrom) {
          quaternion.identity();
          matrix.compose(lip, quaternion, scale.setScalar(size));
          stream.setMatrixAt(0, matrix);
          stream.count = 1;
        } else stream.count = 0;
        stream.instanceMatrix.needsUpdate = true;
        return stream.count > 0 ? 'spewing' : state.open > 0.05 ? 'open' : 'shut';
      }

      const due = spewDue(state, talking, now);
      state = due.state;
      for (const block of due.blocks) {
        if (flying.length >= MOUTH.pool) flying.shift();
        flying.push({ n: block.n, at: block.at, from: lip.clone(), forward: forward.clone(), shot: blockShot(seed, block.n), size });
      }
      let count = 0;
      for (let i = flying.length - 1; i >= 0; i -= 1) {
        const block = flying[i]!;
        const f = blockFrame(now - block.at, block.from, block.forward, block.shot);
        if (f.gone) {
          flying.splice(i, 1);
          continue;
        }
        axis.set(block.shot.axis.x, block.shot.axis.y, block.shot.axis.z);
        quaternion.setFromAxisAngle(axis, f.turn);
        matrix.compose(position.set(f.at.x, f.at.y, f.at.z), quaternion, scale.setScalar(block.size * f.scale));
        stream.setMatrixAt(count, matrix);
        count += 1;
      }
      stream.count = count;
      stream.instanceMatrix.needsUpdate = true;
      if (talking && count > 0) return 'spewing';
      return state.open > 0.05 ? 'open' : 'shut';
    },
    dispose() {
      plate.removeFromParent();
      stream.removeFromParent();
      slab.geometry.dispose();
      seam.geometry.dispose();
      plateMaterial.dispose();
      seamMaterial.dispose();
      blockMaterial.dispose();
      stream.dispose();
    },
  };
}
