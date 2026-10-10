/**
 * A back model that moves like an arm (`placement.motion: 'arm'`): rigged
 * here, when it's worn, whatever its file has. Its meshes become skinned
 * meshes over a chain of bones laid along it (@forge/lobby's `armAxis` and
 * `armWeights`), from where it's mounted to its far end, and every frame the
 * chain bends (cyclic coordinate descent, each joint held to ARM.jointLimit
 * from straight) to put its tip, its camera, toward what `stepArmLook` aims
 * at: someone near, or a spot it hops to. Taken off (`dispose`), the model's
 * own meshes go back as they were.
 */

import * as THREE from 'three';
import { ARM, armAxis, armWeights, createArmLook, stepArmLook } from '@forge/lobby';
import type { Vec3 } from '@forge/lobby';

export interface BackArm {
  /** Bends it for this frame: `people` are whom it may look at (their eyes, in the cave). */
  update(t: number, dt: number, people: readonly Vec3[], reducedMotion: boolean): void;
  /** Puts the model's own meshes back and lets the rig go. */
  dispose(): void;
}

/** The most vertices measured to find the arm's length (more are skipped evenly). */
const MEASURE_MAX = 30_000;
/** How many passes the bend takes each frame. */
const PASSES = 5;
/** How far along its reach a far-off person is aimed at (it points rather than stretching). */
const REACH = 0.92;

/**
 * Rigs `model` (in its place, its matrices current) as an arm mounted at
 * `mount` (in the cave). Null when there's nothing to rig (no meshes, or no
 * length to them).
 */
export function createBackArm(model: THREE.Object3D, mount: THREE.Vector3, seed: number): BackArm | null {
  model.updateWorldMatrix(true, true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry.getAttribute('position')) meshes.push(mesh);
  });
  if (meshes.length === 0) return null;

  // Every vertex in the model's own frame, mesh by mesh.
  const inModel = meshes.map((mesh) => {
    const position = mesh.geometry.getAttribute('position');
    const toFrame = toModel.clone().multiply(mesh.matrixWorld);
    const out = new Float32Array(position.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(toFrame);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    return out;
  });
  const total = inModel.reduce((sum, each) => sum + each.length / 3, 0);
  const every = Math.max(1, Math.ceil(total / MEASURE_MAX));
  const sample: number[] = [];
  let n = 0;
  for (const each of inModel) {
    for (let i = 0; i < each.length / 3; i += 1, n += 1) if (n % every === 0) sample.push(each[i * 3]!, each[i * 3 + 1]!, each[i * 3 + 2]!);
  }
  const anchor = model.worldToLocal(mount.clone());
  const axis = armAxis(sample, anchor);
  if (!axis) return null;

  // The chain: bone 0 at the base, one more at each joint, the last at the tip.
  const base = new THREE.Vector3(axis.base.x, axis.base.y, axis.base.z);
  const step = new THREE.Vector3(axis.tip.x, axis.tip.y, axis.tip.z).sub(base).divideScalar(ARM.segments);
  const bones: THREE.Bone[] = [];
  for (let k = 0; k <= ARM.segments; k += 1) {
    const bone = new THREE.Bone();
    bone.name = `arm-${k}`;
    if (k === 0) bone.position.copy(base);
    else bone.position.copy(step);
    (k === 0 ? model : bones[k - 1]!).add(bone);
    bones.push(bone);
  }
  model.updateWorldMatrix(false, true);
  const skeleton = new THREE.Skeleton(bones);

  // Each mesh swapped for a skinned copy (its geometry cloned, its material shared).
  const swaps = meshes.map((mesh, i) => {
    const { joints, weights } = armWeights(inModel[i]!, axis, ARM.segments);
    const geometry = mesh.geometry.clone();
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
    skinned.name = mesh.name;
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    skinned.renderOrder = mesh.renderOrder;
    // Bent, it reaches past its bind-pose bounds.
    skinned.frustumCulled = false;
    const parent = mesh.parent!;
    parent.add(skinned);
    mesh.removeFromParent();
    skinned.updateMatrixWorld(true);
    skinned.bind(skeleton);
    return { mesh, skinned, parent };
  });

  const look = createArmLook(seed);
  // Which way it points at rest, in the model's frame.
  const restInModel = step.clone().normalize();
  const baseAt = new THREE.Vector3();
  const tipAt = new THREE.Vector3();
  const jointAt = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const parentTurn = new THREE.Quaternion();
  const rest = new THREE.Vector3();
  const IDENTITY = new THREE.Quaternion();

  return {
    update(t, dt, people, reducedMotion) {
      for (const bone of bones) bone.quaternion.identity();
      model.updateWorldMatrix(true, true);
      bones[0]!.getWorldPosition(baseAt);
      bones[ARM.segments]!.getWorldPosition(tipAt);
      const reach = baseAt.distanceTo(tipAt);
      rest.copy(restInModel).transformDirection(model.matrixWorld);
      const aim = stepArmLook(look, {
        t,
        dt,
        base: { x: baseAt.x, y: baseAt.y, z: baseAt.z },
        rest: { x: rest.x, y: rest.y, z: rest.z },
        reach,
        people,
        reducedMotion,
      });
      if (!aim || reach < 1e-6) return;
      // Toward the aim, as far as it reaches.
      goal.set(aim.x, aim.y, aim.z).sub(baseAt);
      const far = goal.length();
      if (far < 1e-6) return;
      goal.multiplyScalar(Math.min(far, reach * REACH) / far).add(baseAt);
      for (let pass = 0; pass < PASSES; pass += 1) {
        for (let k = ARM.segments - 1; k >= 0; k -= 1) {
          const bone = bones[k]!;
          bone.getWorldPosition(jointAt);
          bones[ARM.segments]!.getWorldPosition(tipAt);
          from.subVectors(tipAt, jointAt);
          to.subVectors(goal, jointAt);
          if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
          // The turn that brings the tip in line with the goal, in the bone's parent's frame.
          turn.setFromUnitVectors(from.normalize(), to.normalize());
          bone.parent!.getWorldQuaternion(parentTurn);
          turn.premultiply(parentTurn.clone().invert()).multiply(parentTurn);
          bone.quaternion.premultiply(turn);
          const angle = bone.quaternion.angleTo(IDENTITY);
          if (angle > ARM.jointLimit) bone.quaternion.slerpQuaternions(IDENTITY, bone.quaternion.clone(), ARM.jointLimit / angle);
          bone.updateWorldMatrix(false, true);
        }
      }
    },
    dispose() {
      for (const { mesh, skinned, parent } of swaps) {
        skinned.removeFromParent();
        skinned.geometry.dispose();
        parent.add(mesh);
      }
      bones[0]!.removeFromParent();
      skeleton.dispose();
    },
  };
}
