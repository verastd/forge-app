/**
 * How bricks look: each shape built in code (a body with a hair of a gap all
 * round, so neighbours show their seams, and studs on top; a slope's body
 * falls from its studded row to a plate's height), in shiny plastic. The
 * cave's placed bricks are one InstancedMesh per shape, coloured per brick,
 * so a full cave is nine draw calls.
 *
 * Every geometry has its origin at the brick's lowest corner, along +X and
 * +Z before turning, as @forge/lobby's bricks.ts lays out the grid.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BRICK, BRICK_COLORS, BRICK_SHAPES, brickShape } from '@forge/lobby';
import type { BrickAt, BrickShape } from '@forge/lobby';

/** The gap left all round a brick, metres, so two side by side read as two. */
const GAP = 0.003;
/** A stud: 0.6 of the pitch across, 0.2125 of it tall (as the real thing). */
const STUD_RADIUS = BRICK.stud * 0.3;
const STUD_HEIGHT = BRICK.stud * 0.2125;

function body(shape: BrickShape): THREE.BufferGeometry {
  const w = shape.sx * BRICK.stud - GAP * 2;
  const d = shape.sz * BRICK.stud - GAP * 2;
  const h = shape.h * BRICK.plate;
  if (!shape.slope) {
    const box = new THREE.BoxGeometry(w, h, d);
    box.translate(w / 2 + GAP, h / 2, d / 2 + GAP);
    return box;
  }
  // The profile across z (the high row at z = 0), extruded along x.
  const profile = new THREE.Shape();
  profile.moveTo(0, 0);
  profile.lineTo(d, 0);
  profile.lineTo(d, BRICK.plate);
  profile.lineTo(BRICK.stud - GAP, h);
  profile.lineTo(0, h);
  profile.closePath();
  const slope = new THREE.ExtrudeGeometry(profile, { depth: w, bevelEnabled: false });
  slope.rotateY(-Math.PI / 2);
  slope.translate(w + GAP, 0, GAP);
  return slope;
}

const geometries = new Map<string, THREE.BufferGeometry>();

/** A shape's geometry, built once and shared. */
export function brickGeometry(shape: BrickShape): THREE.BufferGeometry {
  const cached = geometries.get(shape.id);
  if (cached) return cached;
  const parts: THREE.BufferGeometry[] = [body(shape).toNonIndexed()];
  const top = shape.h * BRICK.plate;
  for (let i = 0; i < shape.sx; i += 1) {
    for (let j = 0; j < (shape.slope ? 1 : shape.sz); j += 1) {
      const stud = new THREE.CylinderGeometry(STUD_RADIUS, STUD_RADIUS, STUD_HEIGHT, 18);
      stud.translate((i + 0.5) * BRICK.stud, top + STUD_HEIGHT / 2, (j + 0.5) * BRICK.stud);
      parts.push(stud.toNonIndexed());
    }
  }
  for (const part of parts) {
    // ExtrudeGeometry's uvs and the others' agree on the attributes merge needs.
    for (const name of Object.keys(part.attributes)) if (name !== 'position' && name !== 'normal') part.deleteAttribute(name);
  }
  const merged = mergeGeometries(parts) ?? parts[0]!;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  geometries.set(shape.id, merged);
  return merged;
}

/**
 * The plastic: a little shiny, lit by the robots' environment map, and
 * glowing faintly in its own colour so a build reads across the dark cave.
 */
export function brickMaterial(envMap: THREE.Texture | null): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0, envMap, envMapIntensity: 1.1 });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.22;',
    );
  };
  material.customProgramCacheKey = () => 'brick-plastic';
  return material;
}

const colourCache = new Map<string, THREE.Color>();
export function brickColour(id: string): THREE.Color {
  let colour = colourCache.get(id);
  if (!colour) {
    colour = new THREE.Color(BRICK_COLORS.find((c) => c.id === id)?.hex ?? '#a0a5a9');
    colourCache.set(id, colour);
  }
  return colour;
}

const UP = new THREE.Vector3(0, 1, 0);
const turn = new THREE.Quaternion();
const spot = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** Where a brick's geometry goes for it to sit at `brick`: turned about its corner, then moved there. */
export function brickMatrix(brick: BrickAt, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
  const shape = brickShape(brick.shape);
  const sx = shape?.sx ?? 1;
  const sz = shape?.sz ?? 1;
  // After turning, the footprint's corner is back at the origin by these (studs).
  const [tx, tz] = [
    [0, 0],
    [sz, 0],
    [sx, sz],
    [0, sx],
  ][brick.rot]!;
  turn.setFromAxisAngle(UP, (-brick.rot * Math.PI) / 2);
  spot.set((brick.x + tx!) * BRICK.stud, brick.y * BRICK.plate, (brick.z + tz!) * BRICK.stud);
  return out.compose(spot, turn, ONE);
}

/** A placed brick to draw. */
export interface DrawnBrick extends BrickAt {
  color: string;
}

export interface BrickLayer {
  /** Draws exactly these. */
  set(bricks: readonly DrawnBrick[]): void;
  dispose(): void;
}

/** The cave's placed bricks: one InstancedMesh per shape, grown as needed. */
export function createBrickLayer(scene: THREE.Scene, envMap: THREE.Texture | null): BrickLayer {
  const material = brickMaterial(envMap);
  const meshes = new Map<string, THREE.InstancedMesh>();
  const matrix = new THREE.Matrix4();

  const meshFor = (shape: BrickShape, count: number): THREE.InstancedMesh => {
    let mesh = meshes.get(shape.id);
    if (!mesh || mesh.instanceMatrix.count < count) {
      let capacity = 16;
      while (capacity < count) capacity *= 2;
      if (mesh) {
        scene.remove(mesh);
        mesh.dispose();
      }
      mesh = new THREE.InstancedMesh(brickGeometry(shape), material, capacity);
      mesh.name = `bricks:${shape.id}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      meshes.set(shape.id, mesh);
      scene.add(mesh);
    }
    return mesh;
  };

  return {
    set(bricks) {
      const byShape = new Map<string, DrawnBrick[]>();
      for (const brick of bricks) {
        const list = byShape.get(brick.shape);
        if (list) list.push(brick);
        else byShape.set(brick.shape, [brick]);
      }
      for (const shape of BRICK_SHAPES) {
        const list = byShape.get(shape.id) ?? [];
        if (list.length === 0 && !meshes.has(shape.id)) continue;
        const mesh = meshFor(shape, list.length);
        list.forEach((brick, index) => {
          mesh.setMatrixAt(index, brickMatrix(brick, matrix));
          mesh.setColorAt(index, brickColour(brick.color));
        });
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      for (const mesh of meshes.values()) {
        scene.remove(mesh);
        mesh.dispose();
      }
      meshes.clear();
      material.dispose();
    },
  };
}

/** One brick on its own (held in a hand, or the ghost), centred on its middle when `centred`. */
export function createLoneBrick(shapeId: string, material: THREE.Material, centred: boolean): THREE.Group {
  const group = new THREE.Group();
  const shape = brickShape(shapeId);
  if (!shape) return group;
  const mesh = new THREE.Mesh(brickGeometry(shape), material);
  if (centred) mesh.position.set((-shape.sx * BRICK.stud) / 2, (-shape.h * BRICK.plate) / 2, (-shape.sz * BRICK.stud) / 2);
  group.add(mesh);
  return group;
}
