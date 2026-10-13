/**
 * Real surfaces for machine parts that bring no texture of their own (a STEP
 * file never does): @forge/lobby's `machineFinish` says what each part is made
 * of from its name; this paints it so: the metal's colour, shine and a grain
 * that reads at a glance (brushed streaks on steel and aluminium, sand-cast
 * speckle on iron, orange-peel on paint).
 *
 * CAD meshes have no UVs, so the grain is laid on triplanar: three projections
 * of the part's own (normalised) position, blended by its normal. The grain
 * textures are made once, on canvases, from a fixed seed, and shared.
 */

import * as THREE from 'three';
import type { MachineFinish, MachineGrain } from '@forge/lobby';

const SIZE = 256;
/** Grain tiles per unit of the normalised model (its longest side is 1). */
const TILES: Record<Exclude<MachineGrain, 'none'>, number> = { brushed: 9, cast: 6, peel: 4 };

/** A small seeded random number source (the same grain for everyone). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tileable grain, 0–1 around 0.5, as a single channel. */
function grainValues(grain: Exclude<MachineGrain, 'none'>): Float32Array {
  const rand = random(grain === 'brushed' ? 11 : grain === 'cast' ? 23 : 37);
  const out = new Float32Array(SIZE * SIZE);
  if (grain === 'brushed') {
    // Streaks along x: each row its own tone, smeared along the row, with fine scratches.
    for (let y = 0; y < SIZE; y += 1) {
      const row = 0.5 + (rand() - 0.5) * 0.5;
      let run = row;
      for (let x = 0; x < SIZE * 2; x += 1) {
        run = run * 0.94 + (row + (rand() - 0.5) * 0.9) * 0.06;
        if (x >= SIZE) out[y * SIZE + (x - SIZE)] = run;
      }
    }
  } else {
    // Value noise: a few octaves on a wrapping lattice; cast iron adds hard pits.
    const octaves = grain === 'cast' ? [[64, 0.45], [32, 0.3], [8, 0.25]] : [[8, 0.6], [4, 0.4]];
    for (const [cells, weight] of octaves as [number, number][]) {
      const lattice = Array.from({ length: cells * cells }, () => rand());
      const at = (i: number, j: number): number => lattice[((j + cells) % cells) * cells + ((i + cells) % cells)]!;
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const fx = (x / SIZE) * cells;
          const fy = (y / SIZE) * cells;
          const i = Math.floor(fx);
          const j = Math.floor(fy);
          const u = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
          const v = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
          const top = at(i, j) * (1 - u) + at(i + 1, j) * u;
          const bottom = at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u;
          out[y * SIZE + x]! += (top * (1 - v) + bottom * v) * weight;
        }
      }
    }
    if (grain === 'cast') for (let k = 0; k < SIZE * SIZE * 0.02; k += 1) out[Math.floor(rand() * SIZE * SIZE)] = 0.08;
  }
  return out;
}

const textures = new Map<Exclude<MachineGrain, 'none'>, THREE.Texture>();

/** The shared grain texture (made on first use; never disposed). */
function grainTexture(grain: Exclude<MachineGrain, 'none'>): THREE.Texture {
  let texture = textures.get(grain);
  if (texture) return texture;
  const values = grainValues(grain);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let k = 0; k < SIZE * SIZE; k += 1) {
    const g = Math.round(Math.min(1, Math.max(0, values[k]!)) * 255);
    data[k * 4] = g;
    data[k * 4 + 1] = g;
    data[k * 4 + 2] = g;
    data[k * 4 + 3] = 255;
  }
  texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  textures.set(grain, texture);
  return texture;
}

/**
 * Paints `material` (a part's own copy) with `finish`: its colour, metalness
 * and roughness, lit by the cave's `envMap`, and its grain laid on triplanar.
 * Like every machine part, a little of its own colour glows (less than a
 * textured model's: real metal colours are darker), so iron still reads in the cave.
 */
export function applyFinish(material: THREE.MeshStandardMaterial, finish: MachineFinish, envMap: THREE.Texture | null): void {
  material.color.setRGB(finish.color[0], finish.color[1], finish.color[2], THREE.LinearSRGBColorSpace);
  material.metalness = finish.metalness;
  material.roughness = finish.roughness;
  material.envMap = envMap;
  material.envMapIntensity = 1.15;
  const grain = finish.grain;
  const texture = grain === 'none' ? null : grainTexture(grain);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.07;',
    );
    if (!texture || grain === 'none') return;
    shader.uniforms.mfGrain = { value: texture };
    shader.uniforms.mfTiles = { value: TILES[grain] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMfPos;\nvarying vec3 vMfNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvMfPos = transformed;\n\tvMfNormal = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D mfGrain;
uniform float mfTiles;
varying vec3 vMfPos;
varying vec3 vMfNormal;
float mfSample() {
  vec3 w = pow(abs(normalize(vMfNormal)), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  vec3 p = vMfPos * mfTiles;
  return texture2D(mfGrain, p.zy).r * w.x + texture2D(mfGrain, p.xz).r * w.y + texture2D(mfGrain, p.xy).r * w.z;
}`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tfloat mfG = mfSample();\n\tdiffuseColor.rgb *= 0.86 + 0.28 * mfG;')
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(roughnessFactor + (mfG - 0.5) * 0.5, 0.05, 1.0);',
      );
  };
  material.customProgramCacheKey = () => `machine-finish-${grain}`;
  material.needsUpdate = true;
}
