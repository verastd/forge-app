/**
 * A machine blueprint, ready to build: its binary glTF read, every mesh baked
 * into one frame (the model's), split into parts (@forge/lobby's
 * `machineParts`), and set up so the lobby can draw it at MACHINE.size: its
 * middle over the origin, standing on the floor (y = 0).
 *
 * A part is a group of meshes that share the model's own geometry buffers
 * (each mesh draws only its part's triangles), pivoted at the part's middle,
 * so a build can fly it in and spin it without copying anything.
 */

import * as THREE from 'three';
import { MACHINE, machineParts } from '@forge/lobby';
import type { MachineMesh, MachinePart } from '@forge/lobby';

import { disposeObject, gltfLoader } from '../robot/assets';

export interface MachineModel {
  /** Its size along x, y and z in its own units (what the API stores). */
  size: [number, number, number];
  parts: MachinePart[];
  /** Each part, in the normalised frame (longest side 1 unit, middle over the origin, on the floor): a group pivoted at its middle. */
  build(): { root: THREE.Group; parts: THREE.Group[] };
  /** The whole model as one thing (for the ghost), in the normalised frame. */
  ghost(material: THREE.Material): THREE.Group;
  /** Where each part's middle sits in the normalised frame. */
  centres: THREE.Vector3[];
  dispose(): void;
}

interface Baked {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

/**
 * Lights a model's material the way the cave lights robots and bricks: by its
 * environment map (the cave has no lamps), with a little of its own colour
 * added so dark paint still reads as a shape.
 */
function light(material: THREE.Material, envMap: THREE.Texture | null): void {
  const lit = material as THREE.MeshStandardMaterial;
  if (!lit.isMeshStandardMaterial) return;
  lit.envMap = envMap;
  lit.envMapIntensity = 1.15;
  lit.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.18;',
    );
  };
  lit.customProgramCacheKey = () => 'machine-lit';
  lit.needsUpdate = true;
}

/** Reads a blueprint's file. Rejects if it isn't a model, or has nothing to draw. */
export async function readMachineModel(data: ArrayBuffer, envMap: THREE.Texture | null = null): Promise<MachineModel> {
  const gltf = await gltfLoader().parseAsync(data, '');
  gltf.scene.updateMatrixWorld(true);
  const baked: Baked[] = [];
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    // A copy in the model's frame (a skinned or morphing mesh as it rests).
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color' && name !== 'tangent') geometry.deleteAttribute(name);
    }
    geometry.morphAttributes = {};
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) light(material, envMap);
    baked.push({ geometry, material: mesh.material });
  });
  if (baked.length === 0) throw new Error('no meshes');

  const meshes: MachineMesh[] = baked.map(({ geometry }) => ({
    positions: geometry.getAttribute('position').array,
    index: geometry.getIndex()?.array ?? null,
  }));
  const split = machineParts(meshes);
  if (split.parts.length === 0) throw new Error('no triangles');

  const box = new THREE.Box3();
  for (const { geometry } of baked) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
  }
  const extent = box.getSize(new THREE.Vector3());
  const longest = Math.max(extent.x, extent.y, extent.z, 1e-9);
  const size: [number, number, number] = [
    Math.max(extent.x, longest * 1e-3),
    Math.max(extent.y, longest * 1e-3),
    Math.max(extent.z, longest * 1e-3),
  ];
  // The normalised frame: longest side 1, middle over the origin, on the floor.
  const normalise = new THREE.Matrix4()
    .makeScale(1 / longest, 1 / longest, 1 / longest)
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  for (const { geometry } of baked) {
    geometry.applyMatrix4(normalise);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  }
  const centres = split.parts.map((part) => new THREE.Vector3(part.centre.x, part.centre.y, part.centre.z).applyMatrix4(normalise));

  // Each part's triangles, per mesh: an index into that mesh's own buffers.
  const pieces: { mesh: number; geometry: THREE.BufferGeometry }[][] = split.parts.map(() => []);
  baked.forEach(({ geometry }, m) => {
    const parts = split.triangleParts[m]!;
    const source = geometry.getIndex();
    const lists = new Map<number, number[]>();
    for (let tri = 0; tri < parts.length; tri += 1) {
      const p = parts[tri]!;
      let list = lists.get(p);
      if (!list) lists.set(p, (list = []));
      for (let k = 0; k < 3; k += 1) list.push(source ? source.getX(tri * 3 + k) : tri * 3 + k);
    }
    for (const [p, list] of lists) {
      const piece = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) piece.setAttribute(name, attribute);
      piece.setIndex(list);
      piece.computeBoundingSphere();
      pieces[p]!.push({ mesh: m, geometry: piece });
    }
  });

  const materialOf = (m: number): THREE.Material | THREE.Material[] => {
    const material = baked[m]!.material;
    // Group-indexed materials don't survive the re-indexing: their first stands in.
    return Array.isArray(material) ? material[0]! : material;
  };

  return {
    size,
    parts: split.parts,
    centres,
    build() {
      const root = new THREE.Group();
      const parts = pieces.map((list, p) => {
        const group = new THREE.Group();
        group.position.copy(centres[p]!);
        const inner = new THREE.Group();
        inner.position.copy(centres[p]!).negate();
        for (const { mesh, geometry } of list) {
          const drawn = new THREE.Mesh(geometry, materialOf(mesh));
          drawn.castShadow = true;
          drawn.receiveShadow = true;
          inner.add(drawn);
        }
        group.add(inner);
        root.add(group);
        return group;
      });
      return { root, parts };
    },
    ghost(material) {
      const root = new THREE.Group();
      for (const { geometry } of baked) root.add(new THREE.Mesh(geometry, material));
      return root;
    },
    dispose() {
      for (const list of pieces) for (const { geometry } of list) geometry.dispose();
      for (const { geometry } of baked) geometry.dispose();
      disposeObject(gltf.scene);
    },
  };
}

/** The scale that draws a normalised model (longest side 1) at MACHINE.size times `scale`. */
export const drawScale = (scale: number): number => MACHINE.size * scale;
