import { describe, expect, it } from 'vitest';

import {
  BLUEPRINT_ERROR_TEXT,
  BLUEPRINT_MAX,
  BLUEPRINT_MAX_BYTES,
  BLUEPRINT_PARTS,
  blueprintProblems,
  fitBrick,
  parseBlueprint,
  placeBlueprint,
  skippedText,
  turnBlueprint,
} from './blueprint.js';
import type { Blueprint } from './blueprint.js';
import { brickCells } from './bricks.js';
import type { BrickAt } from './bricks.js';

const UP = '1 0 0 0 1 0 0 0 1';
/** An LDraw type-1 line: colour, position, matrix, part. */
const part = (colour: number, x: number, y: number, z: number, file: string, m = UP): string => `1 ${colour} ${x} ${y} ${z} ${m} ${file}`;
const read = (...lines: string[]): Blueprint => {
  const result = parseBlueprint(lines.join('\n'), 'test.ldr');
  if (typeof result === 'string') throw new Error(result);
  return result;
};

describe('parseBlueprint', () => {
  it('reads a 2×4 brick, red, at the corner', () => {
    const blueprint = read('0 Name: Single', part(4, 0, 0, 0, '3001.dat'));
    expect(blueprint.name).toBe('Single');
    expect(blueprint.bricks).toEqual([{ shape: 'brick-2x4', x: 0, y: 0, z: 0, rot: 0, color: 'red' }]);
    expect(blueprint.size).toEqual([4, 2, 3]);
    expect(blueprint.recoloured).toBe(0);
    expect(skippedText(blueprint)).toBeNull();
  });

  it('stacks: LDraw’s −Y is up, a brick is 24 units, a plate 8', () => {
    const blueprint = read(part(4, 0, 0, 0, '3001.dat'), part(1, 0, -24, 0, '3003.dat'), part(14, 0, -32, 0, '3022.dat'));
    expect(blueprint.bricks.map((b) => [b.shape, b.x, b.y, b.z, b.color])).toEqual([
      ['brick-2x4', 0, 0, 0, 'red'],
      ['brick-2x2', 1, 3, 0, 'blue'],
      ['plate-2x2', 1, 6, 0, 'yellow'],
    ]);
    expect(blueprint.size).toEqual([4, 2, 7]);
  });

  it('turns a part a quarter, keeping it on the grid', () => {
    const blueprint = read(part(15, 0, 0, 0, '3001.dat', '0 0 1 0 1 0 -1 0 0'));
    expect(brickCells(blueprint.bricks[0]!)).toHaveLength(8);
    expect(blueprint.size).toEqual([2, 4, 3]);
    expect(blueprint.bricks[0]!.rot % 2).toBe(1);
  });

  it('a slope’s studs stay on its high row, which LDraw puts at +z (ours −z)', () => {
    const blueprint = read(part(19, 0, 0, 0, '3039.dat'));
    expect(blueprint.bricks[0]).toMatchObject({ shape: 'slope-2x2', rot: 0, color: 'tan' });
    const turned = read(part(19, 0, 0, 0, '3039.dat', '-1 0 0 0 1 0 0 0 -1'));
    expect(turned.bricks[0]).toMatchObject({ shape: 'slope-2x2', rot: 2 });
  });

  it('builds an MPD’s submodels where they’re placed, in their placer’s colour', () => {
    const blueprint = read(
      '0 FILE tower.ldr',
      '0 Name: Tower',
      part(2, 0, 0, 0, 'pillar.ldr'),
      part(14, 40, 0, 0, 'pillar.ldr'),
      '0 FILE pillar.ldr',
      part(16, 0, 0, 0, '3005.dat'),
      part(16, 0, -24, 0, '3005.dat'),
    );
    expect(blueprint.name).toBe('Tower');
    expect(blueprint.bricks).toHaveLength(4);
    expect(blueprint.bricks.map((b) => b.color).sort()).toEqual(['green', 'green', 'yellow', 'yellow']);
    expect(blueprint.size).toEqual([3, 1, 6]);
  });

  it('leaves out, and counts, what it can’t build', () => {
    const blueprint = read(
      part(4, 0, 0, 0, '3001.dat'),
      part(4, 0, -24, 0, '3062b.dat'),
      part(4, 0, -24, 0, '3001.dat', '1 0 0 0 0 -1 0 1 0'),
      part(4, 5, -24, 0, '3005.dat'),
      part(999, 10, -24, 10, '3005.dat'),
      '2 24 0 0 0 1 1 1',
      '1 bad line',
    );
    expect(blueprint.bricks).toHaveLength(2);
    expect(blueprint.skipped).toEqual({ unknown: 1, tilted: 1, offGrid: 1, tooMany: 0 });
    expect(blueprint.recoloured).toBe(1);
    expect(blueprint.bricks[1]!.color).toBe('grey');
    expect(skippedText(blueprint)).toBe('3 parts skipped: 1 not one of our shapes, 1 tilted or upside down, 1 off the stud grid.');
  });

  it('stops at the most a blueprint may build', () => {
    const lines = Array.from({ length: BLUEPRINT_MAX + 2 }, (_, i) => part(4, (i % 40) * 20, -Math.floor(i / 40) * 24, 0, '3005.dat'));
    const blueprint = read(...lines);
    expect(blueprint.bricks).toHaveLength(BLUEPRINT_MAX);
    expect(blueprint.skipped.tooMany).toBe(2);
    expect(skippedText(blueprint)).toContain('past the 1,000-brick limit');
  });

  it('says why a file isn’t a blueprint', () => {
    expect(parseBlueprint('0 just a comment')).toBe('empty');
    expect(parseBlueprint(part(4, 0, 0, 0, 'minifig.dat'))).toBe('no-bricks');
    expect(parseBlueprint(part(4, 0, 0, 0, '3005.dat', '1 0 0 0 0 1 0 1 0'))).toBe('no-bricks');
    expect(parseBlueprint('x'.repeat(BLUEPRINT_MAX_BYTES + 1))).toBe('too-big');
    for (const error of ['empty', 'no-bricks', 'too-big'] as const) expect(BLUEPRINT_ERROR_TEXT[error]).toBeTruthy();
    // Unnamed: the file's name.
    expect((parseBlueprint(part(4, 0, 0, 0, '3005.dat'), 'castle.ldr') as Blueprint).name).toBe('castle');
    expect(BLUEPRINT_PARTS).toHaveLength(9);
  });
});

describe('fitBrick', () => {
  it('finds the turn that covers the cells with the studs where they are', () => {
    expect(fitBrick('brick-1x2', [[0, 0], [0, 1]], [[0, 0], [0, 1]], 0)?.rot).toBe(1);
    expect(fitBrick('brick-1x2', [[0, 0], [1, 0], [2, 0]], [], 0)).toBeNull();
    expect(fitBrick('nope', [], [], 0)).toBeNull();
    expect(fitBrick('slope-2x2', [[0, 0], [1, 0], [0, 1], [1, 1]], [[5, 5]], 0)).toBeNull();
  });
});

describe('turning and placing', () => {
  it('turns a quarter at a time, and four turns are no turn', () => {
    const blueprint = read(part(4, 0, 0, 0, '3001.dat'), part(19, -20, -24, 10, '3039.dat'));
    const once = turnBlueprint(blueprint);
    expect(once.size).toEqual([2, 4, 6]);
    let back = blueprint;
    for (let i = 0; i < 4; i += 1) back = turnBlueprint(back);
    expect(back.bricks).toEqual(blueprint.bricks);
    expect(placeBlueprint(blueprint, 10, 3, -2)[0]).toMatchObject({ x: 10, y: 3, z: -2 });
  });
});

describe('blueprintProblems', () => {
  const at = (shape: string, x: number, y: number, z: number, rot: 0 | 1 | 2 | 3 = 0): BrickAt => ({ shape, x, y, z, rot });

  it('stands on the floor, on placed bricks, and on itself', () => {
    expect(blueprintProblems([at('brick-2x4', 0, 0, 0), at('brick-2x2', 1, 3, 0)], [])).toEqual([null, null]);
    expect(blueprintProblems([at('brick-2x2', 0, 3, 0), at('brick-1x1', 0, 6, 0)], [at('brick-2x4', 0, 0, 0)])).toEqual([null, null]);
    // Hanging under the build's own brick, which stands on the floor through another.
    const bridge = [at('brick-1x1', 0, 0, 0), at('brick-1x4', 0, 3, 0), at('plate-1x2', 2, 2, 0)];
    expect(blueprintProblems(bridge, [])).toEqual([null, null, null]);
  });

  it('needs no support: a brick whose support was a part we skipped stays where the model puts it', () => {
    expect(blueprintProblems([at('brick-2x2', 0, 6, 0), at('brick-1x1', 0, 9, 0)], [])).toEqual([null, null]);
    expect(blueprintProblems([at('brick-2x4', 0, 0, 0), at('brick-2x2', 10, 3, 10)], [])).toEqual([null, null]);
  });

  it('refuses overlaps (its own and the cave’s), and bad bricks', () => {
    expect(blueprintProblems([at('brick-2x2', 0, 0, 0), at('brick-2x2', 1, 0, 1)], [])).toEqual(['overlap', 'overlap']);
    expect(blueprintProblems([at('brick-1x1', 0, 0, 0)], [at('brick-2x2', 0, 0, 0)])).toEqual(['overlap']);
    expect(blueprintProblems([at('nope', 0, 0, 0), at('brick-1x1', 500, 0, 0), at('brick-1x1', 0, -3, 0)], [])).toEqual([
      'shape',
      'outside',
      'outside',
    ]);
    expect(blueprintProblems([at('brick-1x1', 0, 0, 0, 7 as 0)], [])).toEqual(['shape']);
  });
});
