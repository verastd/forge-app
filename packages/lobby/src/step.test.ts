import { describe, expect, it } from 'vitest';

import { STEP_ERROR_TEXT, STEP_MAX_PARTS, isStepFile, stepBytes, stepMeshes, stepName } from './step.js';

/** A triangle as the CAD reader hands one back. */
const tri = (name: unknown = 'Bolt', extra: Record<string, unknown> = {}) => ({
  name,
  color: [0.5, 0.25, 2],
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, normal: { array: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) } },
  index: { array: new Uint32Array([0, 1, 2]) },
  ...extra,
});

describe('a STEP file read by the CAD reader', () => {
  it('becomes one mesh per part, named and coloured', () => {
    const read = stepMeshes({ success: true, meshes: [tri(), tri('  Piston 3  ')] });
    expect(read).not.toBeTypeOf('string');
    if (typeof read === 'string') return;
    expect(read.skipped).toBe(0);
    expect(read.meshes.map((m) => m.name)).toEqual(['Bolt', 'Piston 3']);
    const [bolt] = read.meshes;
    expect(bolt!.color).toEqual([0.5, 0.25, 1]);
    expect(bolt!.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(bolt!.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(bolt!.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(bolt!.index)).toEqual([0, 1, 2]);
  });

  it('names an unnamed part, and does without a colour or normals it can’t use', () => {
    const read = stepMeshes({
      success: true,
      meshes: [tri('', { color: 'red', attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, normal: { array: [0, 0, 1] } } })],
    });
    if (typeof read === 'string') throw new Error(read);
    expect(read.meshes[0]).toMatchObject({ name: 'Part 1', color: null, normals: null });
    const nan = stepMeshes({ success: true, meshes: [tri(7, { color: [0, Number.NaN, 0] })] });
    if (typeof nan === 'string') throw new Error(nan);
    expect(nan.meshes[0]).toMatchObject({ name: 'Part 1', color: null });
  });

  it('leaves out parts with nothing sound to draw, and counts them', () => {
    const bad = [
      null,
      { attributes: null },
      tri('Short', { attributes: { position: { array: [0, 0, 0] } } }),
      tri('Odd', { index: { array: [0, 1] } }),
      tri('Out of range', { index: { array: [0, 1, 9] } }),
      tri('Fraction', { index: { array: [0, 1, 1.5] } }),
      tri('Not finite', { attributes: { position: { array: new Float64Array([0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY, 0]) } } }),
      tri('Strings', { attributes: { position: { array: ['0', 0, 0, 1, 0, 0, 0, 1, 0] } } }),
      tri('No index', { index: { array: 'nope' } }),
    ];
    const read = stepMeshes({ success: true, meshes: [...bad, tri()] });
    if (typeof read === 'string') throw new Error(read);
    expect(read.meshes.map((m) => m.name)).toEqual(['Bolt']);
    expect(read.skipped).toBe(bad.length);
  });

  it('refuses more than STEP_MAX_PARTS rather than building it short of parts', () => {
    expect(stepMeshes({ success: true, meshes: Array.from({ length: STEP_MAX_PARTS + 1 }, () => tri()) })).toBe('too-many');
    const most = stepMeshes({ success: true, meshes: [...Array.from({ length: STEP_MAX_PARTS }, () => tri()), null] });
    if (typeof most === 'string') throw new Error(most);
    expect(most.meshes).toHaveLength(STEP_MAX_PARTS);
    expect(STEP_ERROR_TEXT['too-many']).toMatch(/2,000/);
  });

  it('says about how big its glTF will be, before it’s written', () => {
    const read = stepMeshes({ success: true, meshes: [tri(), tri('No normals', { attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } } })] });
    if (typeof read === 'string') throw new Error(read);
    // 36 bytes of positions, 36 of normals (or room for them), 12 of index, 512 of JSON each, and 1024 more.
    expect(stepBytes(read.meshes)).toBe(1024 + 2 * (36 + 36 + 12 + 512));
  });

  it('says why a file can’t be a blueprint', () => {
    expect(stepMeshes(null)).toBe('not-step');
    expect(stepMeshes({ success: false, meshes: [] })).toBe('not-step');
    expect(stepMeshes({ success: true })).toBe('not-step');
    expect(stepMeshes({ success: true, meshes: [] })).toBe('no-parts');
    expect(STEP_ERROR_TEXT['too-big']).toMatch(/80 MB/);
  });
});

describe('telling a STEP file', () => {
  it('by its name or its first bytes', () => {
    expect(isStepFile('V8.step')).toBe(true);
    expect(isStepFile('v8.STP')).toBe(true);
    expect(isStepFile('v8.glb')).toBe(false);
    expect(isStepFile('engine', new TextEncoder().encode('  ISO-10303-21;\nHEADER;'))).toBe(true);
    expect(isStepFile('engine', new TextEncoder().encode('glTF'))).toBe(false);
    expect(stepName('Small block V8.STEP')).toBe('Small block V8');
    expect(stepName('cam.stp')).toBe('cam');
  });
});
