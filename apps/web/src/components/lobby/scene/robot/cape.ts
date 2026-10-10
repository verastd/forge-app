/**
 * The built-in cape: one cloth mesh hung from the shoulders in the back slot,
 * shaped every frame by @forge/lobby's cape.ts from the robot's own motion
 * (it streams back in flight, swings out of turns, ripples as it goes). Two
 * colours on one surface: the outside where it faces away from the robot, the
 * lining where it faces it. It's this robot's own (its colours and its shape
 * are), so it is disposed with the robot.
 */

import * as THREE from 'three';
import { CAPE, capePoints, capePose } from '@forge/lobby';
import type { CapeInput } from '@forge/lobby';

export interface CapeView {
  /** Add this to the back slot. */
  readonly mesh: THREE.Mesh;
  setColors(outer: string, lining: string): void;
  /** Shapes it for the robot's motion now. */
  update(input: CapeInput): void;
  dispose(): void;
}

/** The grid's triangles, shared by every cape (its points are each cape's own). */
let indices: number[] | null = null;

function gridIndices(): number[] {
  if (indices) return indices;
  const out: number[] = [];
  const across = CAPE.cols + 1;
  for (let i = 0; i < CAPE.rows; i += 1) {
    for (let j = 0; j < CAPE.cols; j += 1) {
      const a = i * across + j;
      const b = a + across;
      // Wound to face the robot (+Z): the front face is the lining, the back the outside.
      out.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  indices = out;
  return out;
}

export function createCape(envMap: THREE.Texture | null): CapeView {
  const geometry = new THREE.BufferGeometry();
  const positions = capePoints(capePose({ t: 0, speed: 0, climb: 0, turnRate: 0, reducedMotion: true }));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const uv: number[] = [];
  for (let i = 0; i <= CAPE.rows; i += 1) for (let j = 0; j <= CAPE.cols; j += 1) uv.push(j / CAPE.cols, 1 - i / CAPE.rows);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(gridIndices());
  geometry.computeVertexNormals();

  const outer = { value: new THREE.Color(0x111114) };
  const lining = { value: new THREE.Color(0x9b1020) };
  const material = new THREE.MeshStandardMaterial({
    name: 'cape',
    side: THREE.DoubleSide,
    roughness: 0.62,
    metalness: 0,
    envMap,
    envMapIntensity: 0.35,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCapeOuter = outer;
    shader.uniforms.uCapeLining = lining;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCapeOuter;\nuniform vec3 uCapeLining;')
      // The lining faces the robot (front faces), the outside faces away; a velvet sheen at grazing angles.
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( gl_FrontFacing ? uCapeLining : uCapeOuter, opacity );')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 capeNormal = normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
          float grazing = pow( 1.0 - abs( dot( capeNormal, normalize( vViewPosition ) ) ), 3.0 );
          totalEmissiveRadiance += ( gl_FrontFacing ? uCapeLining : uCapeOuter + vec3( 0.06 ) ) * grazing * 0.35;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'forge-cape-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cape';
  // It moves every frame and never leaves the robot: no bounds to keep up to date.
  mesh.frustumCulled = false;
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;

  return {
    mesh,
    setColors(outerHex, liningHex) {
      outer.value.set(outerHex);
      lining.value.set(liningHex);
    },
    update(input) {
      capePoints(capePose(input), attribute.array as Float32Array);
      attribute.needsUpdate = true;
      geometry.computeVertexNormals();
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
