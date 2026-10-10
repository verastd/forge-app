/**
 * Blueprints for the Lego bot: an LDraw model (.ldr, or .mpd with its
 * submodels), the format LEGO CAD tools export (BrickLink Studio, LeoCAD,
 * Mecabricks), read into the cave's bricks, and where such a build may go.
 *
 * Reading one: every placed part (an LDraw type-1 line, through any
 * submodels, their transforms composed) that is one of our nine shapes
 * becomes a brick, in the nearest of our twelve colours. A part we have no
 * shape for, one that isn't upright (tilted, upside down or mirrored), or one
 * off the stud grid is left out, and counted, so the Lego bot is told what
 * was skipped. The rest is moved so its lowest corner sits at (0, 0, 0).
 *
 * LDraw's frame: 20 units a stud across, 8 a plate up, −Y up; a brick's
 * origin is the middle of its top. Ours: x and z in studs, y in plates up
 * (bricks.ts); z is LDraw's −z, so a model isn't built mirrored.
 *
 * Pure and deterministic like the rest of the package: no DOM, no three.js.
 */

import { BRICK, BRICK_SHAPES, brickCells, brickHeight, brickShape, brickStuds } from './bricks.js';
import type { BrickAt, BrickProblem } from './bricks.js';

/** The most bricks one blueprint may build (the API's cap too). */
export const BLUEPRINT_MAX = 1000;
/** The biggest file read, in bytes. */
export const BLUEPRINT_MAX_BYTES = 2 * 1024 * 1024;

/** A brick of a blueprint: where it sits (relative to the blueprint's corner) and its colour. */
export interface BlueprintBrick extends BrickAt {
  color: string;
}

export interface Blueprint {
  /** Its name: the model's own (`0 Name:` / its first FILE), else the file's. */
  name: string;
  bricks: BlueprintBrick[];
  /** Its size: studs across x and z, plates tall. */
  size: [number, number, number];
  /** Parts left out, by why. */
  skipped: { unknown: number; tilted: number; offGrid: number; tooMany: number };
  /** Parts given our nearest colour because we have none like theirs. */
  recoloured: number;
}

/** Why a file can't be a blueprint at all. */
export type BlueprintError = 'empty' | 'no-bricks' | 'too-big';

export const BLUEPRINT_ERROR_TEXT: Readonly<Record<BlueprintError, string>> = Object.freeze({
  empty: 'That file has no LDraw parts in it.',
  'no-bricks': 'None of its parts are bricks we can make.',
  'too-big': `That file is too big (the most is ${BLUEPRINT_MAX_BYTES / 1024 / 1024} MB).`,
});

/** LDraw part numbers for our shapes. */
const PARTS: Readonly<Record<string, string>> = Object.freeze({
  '3005': 'brick-1x1',
  '3004': 'brick-1x2',
  '3010': 'brick-1x4',
  '3003': 'brick-2x2',
  '3001': 'brick-2x4',
  '3023': 'plate-1x2',
  '3022': 'plate-2x2',
  '3020': 'plate-2x4',
  '3039': 'slope-2x2',
});

/** LDraw colour codes, to ours. */
const COLOURS: Readonly<Record<number, string>> = Object.freeze({
  0: 'black',
  1: 'blue',
  2: 'green',
  4: 'red',
  5: 'pink',
  6: 'tan',
  7: 'grey',
  8: 'grey',
  9: 'azure',
  10: 'green',
  13: 'pink',
  14: 'yellow',
  15: 'white',
  19: 'tan',
  25: 'orange',
  27: 'lime',
  28: 'tan',
  29: 'pink',
  70: 'tan',
  71: 'grey',
  72: 'grey',
  73: 'azure',
  191: 'orange',
  226: 'yellow',
  320: 'red',
  321: 'azure',
  322: 'azure',
});
/** "The colour of whatever placed me": LDraw's main and edge colours. */
const INHERIT = new Set([16, 24]);

type Vec = [number, number, number];
/** A 3×3 matrix, row by row, and a move. */
interface Transform {
  m: number[];
  t: Vec;
}

const IDENTITY: Transform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function apply({ m, t }: Transform, [x, y, z]: Vec): Vec {
  return [m[0]! * x + m[1]! * y + m[2]! * z + t[0], m[3]! * x + m[4]! * y + m[5]! * z + t[1], m[6]! * x + m[7]! * y + m[8]! * z + t[2]];
}

function compose(outer: Transform, inner: Transform): Transform {
  const a = outer.m;
  const b = inner.m;
  const m: number[] = [];
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) m.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return { m, t: apply(outer, inner.t) };
}

/** Upright and unmirrored: Y stays Y, and the rest is a quarter turn about it. */
function upright({ m }: Transform): boolean {
  const near = (v: number, w: number): boolean => Math.abs(v - w) < 1e-3;
  if (!near(m[4]!, 1) || !near(m[1]!, 0) || !near(m[3]!, 0) || !near(m[5]!, 0) || !near(m[7]!, 0)) return false;
  const [a, c, g, i] = [m[0]!, m[2]!, m[6]!, m[8]!];
  if (![a, c, g, i].every((v) => near(v, 0) || near(Math.abs(v), 1))) return false;
  return near(a * i - c * g, 1);
}

/** A part's cells and stud cells in its own LDraw frame (centres, LDU; y is its top). */
function partCells(shapeId: string): { cells: [number, number][]; studs: [number, number][] } {
  const shape = brickShape(shapeId)!;
  if (shape.slope) {
    // 3039: studs along z = 0, the slope falls toward −z.
    return {
      cells: [
        [-10, 0],
        [10, 0],
        [-10, -20],
        [10, -20],
      ],
      studs: [
        [-10, 0],
        [10, 0],
      ],
    };
  }
  const cells: [number, number][] = [];
  for (let i = 0; i < shape.sx; i += 1) {
    for (let j = 0; j < shape.sz; j += 1) cells.push([(i - (shape.sx - 1) / 2) * 20, (j - (shape.sz - 1) / 2) * 20]);
  }
  return { cells, studs: cells };
}

const key = (x: number, z: number): string => `${x},${z}`;

/**
 * The brick of `shape` that covers exactly `cells` with studs on exactly
 * `studs` (our grid), at its lowest plate `y`; null when no turn of it does.
 */
export function fitBrick(shape: string, cells: readonly [number, number][], studs: readonly [number, number][], y: number): BrickAt | null {
  const kind = brickShape(shape);
  if (!kind || cells.length !== kind.sx * kind.sz) return null;
  const x = Math.min(...cells.map(([cx]) => cx));
  const z = Math.min(...cells.map(([, cz]) => cz));
  const want = new Set(cells.map(([cx, cz]) => key(cx, cz)));
  const wantStuds = new Set(studs.map(([cx, cz]) => key(cx, cz)));
  for (const rot of [0, 1, 2, 3] as const) {
    const at: BrickAt = { shape, x, y, z, rot };
    const got = brickCells(at);
    if (got.length !== want.size || !got.every(([cx, cz]) => want.has(key(cx, cz)))) continue;
    const gotStuds = brickStuds(at);
    if (gotStuds.length === wantStuds.size && gotStuds.every(([cx, cz]) => wantStuds.has(key(cx, cz)))) return at;
  }
  return null;
}

interface Placed {
  shape: string;
  color: string;
  /** Cell centres and stud centres in studs (our x, z), and its top in plates. */
  cells: [number, number][];
  studs: [number, number][];
  top: number;
}

/** Reads an LDraw file into a blueprint (or says why it can't be one). */
export function parseBlueprint(text: string, fileName = 'Blueprint'): Blueprint | BlueprintError {
  if (text.length > BLUEPRINT_MAX_BYTES) return 'too-big';
  // The files of an MPD (each `0 FILE name`), or the one model.
  const files = new Map<string, string[]>();
  let current: string[] = [];
  let first: string | null = null;
  let modelName: string | null = null;
  const main: string[] = current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const file = /^0\s+FILE\s+(.+)$/i.exec(line);
    if (file) {
      const name = file[1]!.trim().toLowerCase();
      current = [];
      files.set(name, current);
      first ??= name;
      continue;
    }
    const named = /^0\s+Name:\s*(.+)$/i.exec(line);
    if (named && modelName === null) modelName = named[1]!.trim();
    current.push(line);
  }
  const root = first !== null ? (files.get(first) ?? main) : main;
  const skipped = { unknown: 0, tilted: 0, offGrid: 0, tooMany: 0 };
  let recoloured = 0;
  const parts: Placed[] = [];
  let lines = 0;

  const walk = (body: string[], transform: Transform, colour: number, depth: number): void => {
    if (depth > 16) return;
    for (const line of body) {
      const fields = line.split(/\s+/);
      if (fields[0] !== '1' || fields.length < 15) continue;
      lines += 1;
      const numbers = fields.slice(1, 14).map(Number);
      if (numbers.some((n) => !Number.isFinite(n))) continue;
      const own = numbers[0]!;
      const partColour = INHERIT.has(own) ? colour : own;
      const local: Transform = {
        t: [numbers[1]!, numbers[2]!, numbers[3]!],
        m: numbers.slice(4, 13),
      };
      const placed = compose(transform, local);
      const ref = fields.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
      const sub = files.get(ref);
      if (sub) {
        walk(sub, placed, partColour, depth + 1);
        continue;
      }
      const shape = PARTS[ref.replace(/^.*\//, '').replace(/\.dat$/, '')];
      if (!shape) {
        skipped.unknown += 1;
        continue;
      }
      if (!upright(placed)) {
        skipped.tilted += 1;
        continue;
      }
      let ours = COLOURS[partColour];
      if (!ours) {
        ours = 'grey';
        recoloured += 1;
      }
      const { cells, studs } = partCells(shape);
      const toOurs = ([lx, lz]: [number, number]): [number, number] => {
        const [wx, , wz] = apply(placed, [lx, 0, lz]);
        return [wx / 20, -wz / 20];
      };
      parts.push({ shape, color: ours, cells: cells.map(toOurs), studs: studs.map(toOurs), top: -placed.t[1] / 8 });
    }
  };
  walk(root, IDENTITY, 7, 0);
  if (lines === 0) return 'empty';
  if (parts.length === 0) return 'no-bricks';

  // Onto our grid: cell centres at k + ½, bottoms on whole plates, as the first part sits.
  const frac = (v: number): number => v - Math.floor(v);
  const [ox, oz] = parts[0]!.cells[0]!.map((v) => frac(v - 0.5));
  const oy = frac(parts[0]!.top);
  const onGrid = (v: number): boolean => Math.abs(v - Math.round(v)) < 0.02;
  const bricks: BlueprintBrick[] = [];
  for (const part of parts) {
    const snap = ([x, z]: [number, number]): [number, number] | null =>
      onGrid(x - 0.5 - ox!) && onGrid(z - 0.5 - oz!) ? [Math.round(x - 0.5 - ox!), Math.round(z - 0.5 - oz!)] : null;
    const cells = part.cells.map(snap);
    const studs = part.studs.map(snap);
    const h = brickShape(part.shape)!.h;
    const bottom = part.top - oy - h;
    if (cells.some((c) => c === null) || studs.some((c) => c === null) || !onGrid(bottom)) {
      skipped.offGrid += 1;
      continue;
    }
    const at = fitBrick(part.shape, cells as [number, number][], studs as [number, number][], Math.round(bottom));
    if (!at) {
      skipped.offGrid += 1;
      continue;
    }
    if (bricks.length >= BLUEPRINT_MAX) {
      skipped.tooMany += 1;
      continue;
    }
    bricks.push({ ...at, color: part.color });
  }
  if (bricks.length === 0) return 'no-bricks';
  const name = (modelName ?? first ?? fileName).replace(/\.(ldr|mpd|dat)$/i, '').slice(0, 60) || 'Blueprint';
  return { ...normalise(bricks), name, skipped, recoloured };
}

/** Moves bricks so their lowest corner is (0, 0, 0); with the size they span. */
function normalise(bricks: BlueprintBrick[]): { bricks: BlueprintBrick[]; size: [number, number, number] } {
  let minX = Infinity;
  let minZ = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (const brick of bricks) {
    for (const [x, z] of brickCells(brick)) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x + 1);
      maxZ = Math.max(maxZ, z + 1);
    }
    minY = Math.min(minY, brick.y);
    maxY = Math.max(maxY, brick.y + brickHeight(brick));
  }
  return {
    bricks: bricks.map((brick) => ({ ...brick, x: brick.x - minX, y: brick.y - minY, z: brick.z - minZ })),
    size: [maxX - minX, maxZ - minZ, maxY - minY],
  };
}

/** The blueprint turned a quarter (as R turns a held brick), still at (0, 0, 0). */
export function turnBlueprint(blueprint: Blueprint): Blueprint {
  // A quarter turn of our grid: cell (x, z) to (−z − 1, x), as rot 1 turns a brick's own cells.
  const turn = ([x, z]: [number, number]): [number, number] => [-z - 1, x];
  const bricks = blueprint.bricks.map((brick) => {
    const at = fitBrick(brick.shape, brickCells(brick).map(turn), brickStuds(brick).map(turn), brick.y);
    return { ...at!, color: brick.color };
  });
  return { ...blueprint, ...normalise(bricks) };
}

/** The blueprint's bricks with its corner at (x, y, z) in the cave. */
export function placeBlueprint(blueprint: Blueprint, x: number, y: number, z: number): BlueprintBrick[] {
  return blueprint.bricks.map((brick) => ({ ...brick, x: brick.x + x, y: brick.y + y, z: brick.z + z }));
}

/**
 * Why each brick of a build can't go where it says, among the cave's
 * `placed` bricks (null where it can): a shape we don't have, out of the
 * build circle, overlapping a brick (of the cave or of the build), or part
 * of a group that rests on nothing (neither the floor nor a placed brick,
 * through the build's own fastenings).
 */
export function blueprintProblems(bricks: readonly BrickAt[], placed: readonly BrickAt[]): (BrickProblem | null)[] {
  const all: { brick: BrickAt; mine: number }[] = [...bricks.map((brick, mine) => ({ brick, mine })), ...placed.map((brick) => ({ brick, mine: -1 }))];
  // Who covers which column, to find neighbours without comparing every pair.
  const columns = new Map<string, number[]>();
  const valid = (brick: BrickAt): boolean => brickShape(brick.shape) !== null && [0, 1, 2, 3].includes(brick.rot);
  all.forEach(({ brick }, index) => {
    if (!valid(brick)) return;
    for (const [x, z] of brickCells(brick)) {
      const list = columns.get(key(x, z));
      if (list) list.push(index);
      else columns.set(key(x, z), [index]);
    }
  });
  const studSet = (brick: BrickAt): Set<string> => new Set(brickStuds(brick).map(([x, z]) => key(x, z)));
  const problems: (BrickProblem | null)[] = bricks.map(() => null);
  const links: number[][] = bricks.map(() => []);
  const grounded: boolean[] = bricks.map((brick) => brick.y === 0);
  bricks.forEach((brick, i) => {
    const shape = brickShape(brick.shape);
    if (!shape || !valid(brick)) {
      problems[i] = 'shape';
      return;
    }
    const top = brick.y + shape.h;
    if (brick.y < 0 || top > BRICK.maxPlates || ![brick.x, brick.y, brick.z].every(Number.isInteger)) {
      problems[i] = 'outside';
      return;
    }
    const reach = BRICK.radius / BRICK.stud;
    const cells = brickCells(brick);
    if (cells.some(([x, z]) => [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]].some(([cx, cz]) => Math.hypot(cx!, cz!) > reach))) {
      problems[i] = 'outside';
      return;
    }
    const mineStuds = studSet(brick);
    const seen = new Set<number>();
    for (const [x, z] of cells) {
      for (const j of columns.get(key(x, z)) ?? []) {
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        const other = all[j]!.brick;
        const otherTop = other.y + brickHeight(other);
        if (brick.y < otherTop && other.y < top) {
          problems[i] = 'overlap';
          continue;
        }
        // Fastened: it sits on the other's studs, or the other sits on its.
        const onIt = brick.y === otherTop && cells.some(([cx, cz]) => studSet(other).has(key(cx, cz)));
        const underIt = other.y === top && brickCells(other).some(([cx, cz]) => mineStuds.has(key(cx, cz)));
        if (!onIt && !underIt) continue;
        if (all[j]!.mine < 0) grounded[i] = true;
        else links[i]!.push(all[j]!.mine);
      }
    }
  });
  // Everything fastened (through the build) to something grounded stands.
  const stands = [...grounded];
  const queue = stands.flatMap((on, i) => (on ? [i] : []));
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (const j of links[i]!) {
      if (!stands[j]) {
        stands[j] = true;
        queue.push(j);
      }
    }
  }
  return problems.map((problem, i) => problem ?? (stands[i] ? null : 'floating'));
}

/** The shapes a blueprint can use, by LDraw part number (for the panel's help). */
export const BLUEPRINT_PARTS: readonly { part: string; label: string }[] = Object.freeze(
  Object.entries(PARTS).map(([part, shape]) => Object.freeze({ part, label: BRICK_SHAPES.find((s) => s.id === shape)!.label })),
);

/** What was left out, in words; null when nothing was. */
export function skippedText(blueprint: Blueprint): string | null {
  const { unknown, tilted, offGrid, tooMany } = blueprint.skipped;
  const parts = [
    unknown && `${unknown} not one of our shapes`,
    tilted && `${tilted} tilted or upside down`,
    offGrid && `${offGrid} off the stud grid`,
    tooMany && `${tooMany} past the ${BLUEPRINT_MAX.toLocaleString('en')}-brick limit`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const total = unknown + tilted + offGrid + tooMany;
  return `${total} part${total === 1 ? '' : 's'} skipped: ${parts.join(', ')}.`;
}

