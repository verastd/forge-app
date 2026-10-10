/**
 * A back model that moves like an arm (`placement.motion: 'arm'`): rigged
 * here, when it's worn, whatever its file has. Its meshes become skinned
 * meshes over a chain of bones from where it's mounted to its far end,
 * jointed where the model narrows (@forge/lobby's `armAxis`, `armJoints`),
 * every vertex wholly on one bone (`armWeights`): each part of the arm,
 * its camera head among them, moves as one solid piece and only turns at a
 * joint. Every frame the chain bends (cyclic coordinate descent, each joint
 * held to ARM.jointLimit from straight) to put its tip, its camera, toward
 * what `stepArmLook` aims at: someone near, or a spot it hops to. Its camera
 * (the piece past its last joint) always faces the way the robot's eyes do,
 * and only that way: it turns at its last joint to the model's own forward,
 * turned as far as the head is turned (`gaze`), whatever the rest is doing.
 * Its lens (the front of the camera, the way it faces) zooms in and out on a
 * bone of its own (@forge/lobby's `armLens`, `lensZoom`): the lens moves
 * wholly and the barrel behind it stretches.
 *
 * It keeps out of the robot wearing it: `keepOut` gives boxes (the torso,
 * the head) in the robot body's own frame (`body`). A wander never picks a
 * spot straight through them, and a bend that would put any of the arm in
 * them (beyond what the arm's own rest pose already does) is undone for the
 * last clear one, and something else is picked. Taken off (`dispose`), the
 * model's own meshes go back as they were.
 */

import * as THREE from 'three';
import { ARM, armAxis, armJoints, armLens, armWeights, clearOf, createArmLook, lensShare, lensZoom, stepArmLook } from '@forge/lobby';
import type { ArmBox, Vec3 } from '@forge/lobby';

export interface BackArm {
  /**
   * Bends it for this frame: `people` are whom it may reach toward (their eyes, in the cave);
   * `gaze` is how far the robot's head (its eyes) is turned from rest, in the cave.
   */
  update(t: number, dt: number, people: readonly Vec3[], reducedMotion: boolean, gaze: THREE.Quaternion): void;
  /** Puts the model's own meshes back and lets the rig go. */
  dispose(): void;
}

/** Where the arm may not go: boxes in `body`'s own frame, asked for again now and then (a head can arrive late). */
export interface ArmKeepOut {
  body: THREE.Object3D;
  boxes(): ArmBox[];
}

/** The most vertices measured to find the arm's length and joints (more are skipped evenly). */
const MEASURE_MAX = 30_000;
/** How many passes the bend takes each frame. */
const PASSES = 5;
/** How far along its reach a far-off person is aimed at (it points rather than stretching). */
const REACH = 0.92;
/** How close the arm's middle line may come to the robot, besides its own thickness (in the body's frame). */
const MARGIN = 0.02;
/** How often the keep-out boxes are asked for again (seconds). */
const KEEP_OUT_EVERY = 1;

/**
 * Rigs `model` (in its place, its matrices current) as an arm mounted at
 * `mount` (in the cave). Null when there's nothing to rig (no meshes, or no
 * length to them).
 */
export function createBackArm(model: THREE.Object3D, mount: THREE.Vector3, seed: number, keepOut: ArmKeepOut | null = null): BackArm | null {
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
  const bends = armJoints(sample, axis);
  const lens = armLens(sample, axis, bends);
  // How thick it is, about its middle line (the average distance of its points from the axis), in its own frame.
  const along = new THREE.Vector3(axis.tip.x - axis.base.x, axis.tip.y - axis.base.y, axis.tip.z - axis.base.z).normalize();
  const point = new THREE.Vector3();
  let around = 0;
  for (let i = 0; i < sample.length; i += 3) {
    point.set(sample[i]! - axis.base.x, sample[i + 1]! - axis.base.y, sample[i + 2]! - axis.base.z);
    around += point.sub(along.clone().multiplyScalar(point.dot(along))).length();
  }
  const thickness = around / (sample.length / 3);

  // The chain: bone 0 at the base, one at each joint, the last at the tip (where it's aimed from).
  const base = new THREE.Vector3(axis.base.x, axis.base.y, axis.base.z);
  const span = new THREE.Vector3(axis.tip.x, axis.tip.y, axis.tip.z).sub(base);
  const stops = [0, ...bends, 1];
  const bones: THREE.Bone[] = [];
  stops.forEach((t, k) => {
    const bone = new THREE.Bone();
    bone.name = `arm-${k}`;
    bone.position.copy(k === 0 ? base : span.clone().multiplyScalar(t - stops[k - 1]!));
    (k === 0 ? model : bones[k - 1]!).add(bone);
    bones.push(bone);
  });
  const last = bones.length - 1;
  model.updateWorldMatrix(false, true);
  // The lens: on the camera piece, at its joint, slid out along its forward (+z) as it zooms.
  const lensBone = new THREE.Bone();
  lensBone.name = 'arm-lens';
  bones[last - 1]!.add(lensBone);
  model.updateWorldMatrix(false, true);
  const skeleton = new THREE.Skeleton([...bones, lensBone]);

  // Each mesh swapped for a skinned copy (its geometry cloned, its material shared).
  const swaps = meshes.map((mesh, i) => {
    const { joints, weights } = armWeights(inModel[i]!, axis, bends);
    // The camera piece's front shares in the lens's zoom (the lens wholly, the barrel eased).
    if (lens) {
      const positions = inModel[i]!;
      for (let v = 0; v < joints.length / 4; v += 1) {
        if (joints[v * 4] !== last - 1) continue;
        const share = lensShare(positions[v * 3 + 2]!, lens);
        if (share <= 0) continue;
        joints[v * 4 + 1] = bones.length;
        weights[v * 4] = 1 - share;
        weights[v * 4 + 1] = share;
      }
    }
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
  const restInModel = span.clone().normalize();
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

  // ---- keeping out of the robot ----
  let boxes: ArmBox[] = [];
  let boxesAt = -Infinity;
  // Its thickness and the margin, in the body's frame (the two can be scaled differently).
  const scaleOf = (object: THREE.Object3D): number => object.getWorldScale(new THREE.Vector3()).x;
  let margin = MARGIN;
  /** Which of the arm's sample points are already in the robot at rest (the model's own fit: let be). */
  let restInside: boolean[] = [];
  const probe = new THREE.Vector3();
  const toBody = new THREE.Matrix4();
  const inBody = (world: THREE.Vector3): Vec3 => {
    probe.copy(world).applyMatrix4(toBody);
    return { x: probe.x, y: probe.y, z: probe.z };
  };
  /** Where the arm is, to test: each joint past the base, the middle of each part, and the tip. */
  const samples = (): THREE.Vector3[] => {
    const out: THREE.Vector3[] = [];
    for (let k = 1; k <= last; k += 1) {
      const end = bones[k]!.getWorldPosition(new THREE.Vector3());
      const start = bones[k - 1]!.getWorldPosition(new THREE.Vector3());
      out.push(start.clone().lerp(end, 0.5), end);
    }
    return out;
  };
  const inside = (): boolean[] => samples().map((p) => !clearOf(inBody(p), boxes, margin));
  const clear = (): boolean => inside().every((hit, i) => !hit || restInside[i] === true);
  const lastClear = bones.map(() => new THREE.Quaternion());

  /** Bends the chain so its tip comes to `goal` (cyclic coordinate descent, each joint held to ARM.jointLimit). */
  const bend = (): void => {
    for (let pass = 0; pass < PASSES; pass += 1) {
      for (let k = last - 1; k >= 0; k -= 1) {
        const bone = bones[k]!;
        bone.getWorldPosition(jointAt);
        bones[last]!.getWorldPosition(tipAt);
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
  };

  /**
   * Turns the camera (the piece past the last joint) to face the eyes' way: the model's own
   * orientation (its forward the robot's, as fitted) turned by `gaze`, in the cave.
   */
  const camera = bones[last - 1]!;
  const wanted = new THREE.Quaternion();
  const face = (gaze: THREE.Quaternion): void => {
    model.getWorldQuaternion(wanted).premultiply(gaze);
    camera.parent!.getWorldQuaternion(parentTurn);
    camera.quaternion.copy(parentTurn.invert().multiply(wanted));
    camera.updateWorldMatrix(false, true);
  };

  return {
    update(t, dt, people, reducedMotion, gaze) {
      lensBone.position.set(0, 0, lens && !reducedMotion ? lens.reach * lensZoom(t, seed) : 0);
      for (const bone of bones) bone.quaternion.identity();
      model.updateWorldMatrix(true, true);
      if (keepOut) {
        toBody.copy(keepOut.body.matrixWorld).invert();
        if (t - boxesAt >= KEEP_OUT_EVERY || t < boxesAt) {
          boxesAt = t;
          boxes = keepOut.boxes();
          margin = MARGIN + (thickness * scaleOf(model)) / Math.max(1e-6, scaleOf(keepOut.body));
          restInside = inside();
        }
      }
      bones[0]!.getWorldPosition(baseAt);
      bones[last]!.getWorldPosition(tipAt);
      const reach = baseAt.distanceTo(tipAt);
      rest.copy(restInModel).transformDirection(model.matrixWorld);
      const blocked = (dir: Vec3): boolean => {
        if (!keepOut) return false;
        // Along the straight line out to its reach (past the first stretch, which starts on the robot's back).
        for (let s = 1; s <= 4; s += 1) {
          to.set(dir.x, dir.y, dir.z).multiplyScalar((reach * s) / 4).add(baseAt);
          if (!clearOf(inBody(to), boxes, margin)) return true;
        }
        return false;
      };
      const aim = stepArmLook(look, {
        t,
        dt,
        base: { x: baseAt.x, y: baseAt.y, z: baseAt.z },
        rest: { x: rest.x, y: rest.y, z: rest.z },
        reach,
        people,
        reducedMotion,
        blocked,
      });
      if (aim && reach > 1e-6) {
        // Toward the aim, as far as it reaches.
        goal.set(aim.x, aim.y, aim.z).sub(baseAt);
        const far = goal.length();
        if (far > 1e-6) {
          goal.multiplyScalar(Math.min(far, reach * REACH) / far).add(baseAt);
          bend();
        }
      }
      face(gaze);
      if (!keepOut || clear()) {
        bones.forEach((bone, k) => lastClear[k]!.copy(bone.quaternion));
        return;
      }
      // Into the robot: back to the last clear pose (its camera still the eyes' way), and on to something else.
      bones.forEach((bone, k) => bone.quaternion.copy(lastClear[k]!));
      bones[0]!.updateWorldMatrix(false, true);
      face(gaze);
      look.until = t;
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
