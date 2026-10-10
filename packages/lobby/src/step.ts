/**
 * STEP blueprints for the mechanic: what the CAD reader (occt-import-js, in
 * the browser) hands back, checked and boiled down to one mesh per part, each
 * with its name and colour, ready to be written out as a binary glTF.
 *
 * STEP (ISO 10303) is how CAD tools share a design: an engine is an assembly
 * of named solids (block, heads, pistons, bolts…), so each becomes a real
 * part of the build rather than a chunk cut out of a fused mesh.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

/** The most bytes of a STEP file the browser reads (the glTF it makes must still fit MACHINE_BLUEPRINT_MAX_BYTES). */
export const STEP_MAX_BYTES = 80 * 1024 * 1024;
/** The most parts a STEP file may have (more, and it's refused rather than built short of parts). */
export const STEP_MAX_PARTS = 2000;

/** A part, as the CAD reader meshed it: positions in the file's own units, its triangles, its colour (linear RGB, 0–1). */
export interface StepMesh {
  name: string;
  color: [number, number, number] | null;
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array;
}

export interface StepRead {
  meshes: StepMesh[];
  /** Parts left out because they have nothing sound to draw. */
  skipped: number;
}

/** Why a STEP file can't be a blueprint. */
export type StepError = 'not-step' | 'no-parts' | 'too-big' | 'too-many';

export const STEP_ERROR_TEXT: Readonly<Record<StepError, string>> = Object.freeze({
  'not-step': 'That file isn’t a STEP model the CAD reader can open.',
  'no-parts': 'That STEP file has no solid parts to build.',
  'too-big': `That STEP file is too big (the most is ${STEP_MAX_BYTES / 1024 / 1024} MB).`,
  'too-many': `That STEP file has too many parts (the most is ${STEP_MAX_PARTS.toLocaleString('en')}): export the main assembly without its small hardware.`,
});

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => typeof value === 'object' && value !== null && !Array.isArray(value);

function numbers(value: unknown): ArrayLike<number> | null {
  if (!isRecord(value)) return null;
  const array = value.array;
  if (array instanceof Float32Array || array instanceof Float64Array || array instanceof Uint32Array || array instanceof Uint16Array) return array;
  if (Array.isArray(array) && array.every((n) => typeof n === 'number' && Number.isFinite(n))) return array as number[];
  return null;
}

function colour(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b] = value as unknown[];
  if (![r, g, b].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return [clamp(r as number), clamp(g as number), clamp(b as number)];
}

/** One mesh of the reader's answer, checked; null when it has nothing sound to draw. */
function mesh(raw: unknown, n: number): StepMesh | null {
  if (!isRecord(raw) || !isRecord(raw.attributes)) return null;
  const positions = numbers(raw.attributes.position);
  const index = numbers(raw.index);
  if (!positions || !index || positions.length < 9 || positions.length % 3 !== 0 || index.length < 3 || index.length % 3 !== 0) return null;
  const vertices = positions.length / 3;
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= vertices) return null;
  }
  for (let i = 0; i < positions.length; i += 1) if (!Number.isFinite(positions[i]!)) return null;
  const normals = numbers(raw.attributes.normal);
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 60) : `Part ${n + 1}`;
  return {
    name,
    color: colour(raw.color),
    positions: Float32Array.from(positions),
    normals: normals && normals.length === positions.length ? Float32Array.from(normals) : null,
    index: Uint32Array.from(index),
  };
}

/** The CAD reader's answer (occt-import-js `ReadStepFile`), as parts; an error when it isn't one. */
export function stepMeshes(result: unknown): StepRead | StepError {
  if (!isRecord(result) || result.success !== true || !Array.isArray(result.meshes)) return 'not-step';
  const meshes: StepMesh[] = [];
  let skipped = 0;
  for (const [n, raw] of result.meshes.entries()) {
    const read = mesh(raw, n);
    if (!read) skipped += 1;
    else if (meshes.length === STEP_MAX_PARTS) return 'too-many';
    else meshes.push(read);
  }
  return meshes.length === 0 ? 'no-parts' : { meshes, skipped };
}

/** About how many bytes a binary glTF of these parts takes (their buffers, and a little for each part's JSON). */
export function stepBytes(meshes: readonly StepMesh[]): number {
  return meshes.reduce((total, m) => total + m.positions.byteLength + (m.normals?.byteLength ?? m.positions.byteLength) + m.index.byteLength + 512, 1024);
}

/** A STEP file's name without its extension, for the library. */
export function stepName(fileName: string): string {
  return fileName.replace(/\.(step|stp)$/i, '');
}

/** Whether a file looks like STEP: by its name, or by its first bytes (`ISO-10303-21;`). */
export function isStepFile(fileName: string, head: Uint8Array | null = null): boolean {
  if (/\.(step|stp)$/i.test(fileName)) return true;
  if (!head) return false;
  const text = String.fromCharCode(...head.subarray(0, 32)).trimStart();
  return text.startsWith('ISO-10303-21');
}
