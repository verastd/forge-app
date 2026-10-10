/**
 * A STEP file (CAD's own exchange format) made into a machine blueprint: the
 * CAD reader meshes it in a worker (stepWorker.ts), every solid becomes a mesh
 * of its own (named and coloured as the file has it, so each is a real part of
 * the build), and the lot is written out as a binary glTF, the format the
 * library keeps. Each step is reported, and it can be cancelled.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STEP_ERROR_TEXT, STEP_MAX_BYTES, stepMeshes } from '@forge/lobby';
import { MACHINE_BLUEPRINT_MAX_BYTES } from '@forge/shared';

/** Where a conversion is: the CAD reader loading, reading the file, or meshing its parts (and how many). */
export type StepStage = { stage: 'engine' } | { stage: 'reading' } | { stage: 'meshing'; parts: number };

/** A conversion that can't go on, in words. */
export class StepFailure extends Error {}

const metal = (color: [number, number, number] | null): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: color ? new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace) : 0x8a8f96,
    metalness: 0.55,
    roughness: 0.42,
  });

/** Reads a STEP file in the worker; resolves with the reader's raw answer. */
function read(buffer: ArrayBuffer, onStage: (stage: StepStage) => void, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stepWorker.ts', import.meta.url));
    const stop = (): void => {
      worker.terminate();
      reject(new DOMException('cancelled', 'AbortError'));
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    const done = (): void => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<{ stage?: 'engine' | 'reading'; result?: unknown; error?: string }>) => {
      const { stage, result, error } = event.data;
      if (stage) return onStage({ stage });
      done();
      if (error !== undefined) reject(new StepFailure(STEP_ERROR_TEXT['not-step']));
      else resolve(result);
    };
    worker.onerror = () => {
      done();
      reject(new StepFailure('Couldn’t load the CAD reader: check your connection and try again.'));
    };
    worker.postMessage({ buffer }, [buffer]);
  });
}

/** A STEP file as a binary glTF blueprint, one mesh per part. Rejects with a StepFailure that says why not. */
export async function stepToGlb(file: ArrayBuffer, onStage: (stage: StepStage) => void, signal: AbortSignal): Promise<{ glb: ArrayBuffer; parts: number }> {
  if (file.byteLength > STEP_MAX_BYTES) throw new StepFailure(STEP_ERROR_TEXT['too-big']);
  const raw = await read(file, onStage, signal);
  const parts = stepMeshes(raw);
  if (typeof parts === 'string') throw new StepFailure(STEP_ERROR_TEXT[parts]);
  onStage({ stage: 'meshing', parts: parts.meshes.length });
  const scene = new THREE.Scene();
  const materials: THREE.Material[] = [];
  for (const part of parts.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    if (part.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
    else geometry.computeVertexNormals();
    geometry.setIndex(new THREE.BufferAttribute(part.index, 1));
    const material = metal(part.color);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = part.name;
    scene.add(mesh);
  }
  try {
    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    if (glb.byteLength > MACHINE_BLUEPRINT_MAX_BYTES) {
      throw new StepFailure(
        `That model is too detailed (${Math.round(glb.byteLength / 1024 / 1024)} MB meshed; the most is ${MACHINE_BLUEPRINT_MAX_BYTES / 1024 / 1024} MB). Export it coarser, or with fewer parts.`,
      );
    }
    return { glb, parts: parts.meshes.length };
  } finally {
    scene.traverse((object) => (object as THREE.Mesh).geometry?.dispose());
    for (const material of materials) material.dispose();
  }
}
