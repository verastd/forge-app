import { describe, expect, it } from 'vitest';

import { MOUTH, blockFrame, blockShot, createMouthState, mouthRecess, spewDue, stepMouth } from './mouth.js';

describe('the mouth opening and shutting', () => {
  it('opens fast while talking and stays open a moment after', () => {
    let state = createMouthState();
    expect(state.open).toBe(0);
    state = stepMouth(state, true, MOUTH.open / 2);
    expect(state.open).toBeCloseTo(0.5);
    state = stepMouth(state, true, MOUTH.open);
    expect(state.open).toBe(1);
    // A gap between words: still open.
    state = stepMouth(state, false, MOUTH.hold / 2);
    expect(state.open).toBe(1);
    // Quiet for good: it shuts.
    state = stepMouth(state, false, MOUTH.hold);
    state = stepMouth(state, false, MOUTH.open / 2);
    expect(state.open).toBeLessThan(1);
    state = stepMouth(state, false, MOUTH.open);
    expect(state.open).toBe(0);
    expect(stepMouth(state, false, -1).open).toBe(0);
  });
});

describe('the stream', () => {
  it('sends a block every MOUTH.every while talking with the mouth open', () => {
    let state = { ...createMouthState(), open: 1 };
    let due = spewDue(state, true, 10);
    expect(due.blocks).toEqual([{ n: 0, at: 10 }]);
    state = due.state;
    due = spewDue(state, true, 10 + MOUTH.every * 2.5);
    expect(due.blocks.map((b) => b.n)).toEqual([1, 2]);
    expect(due.blocks[1]!.at).toBeCloseTo(10 + MOUTH.every * 2);
  });

  it('stops when the talking stops or the mouth is still opening, and starts afresh', () => {
    const open = { ...createMouthState(), open: 1, next: 5, count: 3 };
    expect(spewDue(open, false, 6)).toEqual({ state: { ...open, next: null }, blocks: [] });
    const opening = { ...open, open: MOUTH.spewFrom / 2 };
    expect(spewDue(opening, true, 6).blocks).toEqual([]);
    expect(spewDue({ ...open, next: null }, true, 9).blocks).toEqual([{ n: 3, at: 9 }]);
  });

  it('never floods after a long hitch', () => {
    const due = spewDue({ ...createMouthState(), open: 1, next: 0 }, true, 100);
    expect(due.blocks).toHaveLength(MOUTH.pool);
    expect(due.state.next).toBeCloseTo(100 + MOUTH.every);
  });
});

describe('a block', () => {
  it('has its own spread and spin, the same for everyone', () => {
    const shot = blockShot(42, 7);
    expect(blockShot(42, 7)).toEqual(shot);
    expect(blockShot(42, 8)).not.toEqual(shot);
    expect(Math.abs(shot.yaw)).toBeLessThanOrEqual(MOUTH.spread);
    expect(Math.abs(shot.pitch)).toBeLessThanOrEqual(MOUTH.spread);
    expect(Math.hypot(shot.axis.x, shot.axis.y, shot.axis.z)).toBeCloseTo(1);
    expect(shot.speed).toBeGreaterThanOrEqual(MOUTH.speed - MOUTH.speedSpread);
  });

  it('leaves the mouth small, flies out and down, and is gone at the floor', () => {
    const shot = { yaw: 0, pitch: 0, speed: 1.5, axis: { x: 1, y: 0, z: 0 }, spin: 1 };
    const from = { x: 0, y: 1.5, z: 0 };
    const forward = { x: 0, y: 0, z: 1 };
    const start = blockFrame(0, from, forward, shot);
    expect(start.at).toEqual(from);
    expect(start.scale).toBe(MOUTH.startScale);
    const later = blockFrame(0.3, from, forward, shot);
    expect(later.at.z).toBeCloseTo(0.45);
    expect(later.at.x).toBeCloseTo(0);
    expect(later.scale).toBe(1);
    expect(later.turn).toBeCloseTo(0.3 * 2 * Math.PI);
    expect(later.gone).toBe(false);
    expect(blockFrame(0.8, from, forward, shot).gone).toBe(true);
    // Turned: a yaw sends it off to the side.
    expect(blockFrame(0.3, from, forward, { ...shot, yaw: 0.3 }).at.x).toBeGreaterThan(0);
    // Up in the air, it's gone when it has lived its life.
    expect(blockFrame(MOUTH.life, { x: 0, y: 100, z: 0 }, forward, shot).gone).toBe(true);
    expect(blockFrame(-1, from, forward, shot).at).toEqual(from);
  });
});

/** A face 1 × 1 seen from the front, in tenths; the cells `sunk` set back to z = 0.5. */
function face(sunk: (x: number, y: number) => boolean, size = 10): number[] {
  return relief((x, y) => (sunk(x, y) ? 0.5 : 1), size);
}

/** A face 1 × 1 seen from the front, in tenths, each cell at its own depth. */
function relief(depthAt: (x: number, y: number) => number, size = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      const z = depthAt(i, j);
      const [x0, x1, y0, y1] = [i / size, (i + 1) / size, j / size, (j + 1) / size];
      out.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z);
    }
  }
  return out;
}

describe('finding the mouth', () => {
  it('finds the hollow round a click', () => {
    // A mouth from x 0.2 to 0.7, y 0.1 to 0.3.
    const mouth = mouthRecess(face((x, y) => x >= 2 && x < 7 && y >= 1 && y < 3), [0.45, 0.2, 0.5]);
    expect(mouth).not.toBeNull();
    expect(mouth!.center[0]).toBeCloseTo(0.45, 1);
    expect(mouth!.center[1]).toBeCloseTo(0.2, 1);
    expect(mouth!.center[2]).toBe(1);
    expect(mouth!.size[0]).toBeCloseTo(0.5, 1);
    expect(mouth!.size[1]).toBeCloseTo(0.2, 1);
  });

  it('measures the face at the hollow’s own walls, so a nose above it isn’t taken for the face', () => {
    // The mouth (y 0.1 to 0.3) under a nose sticking well out (y 0.4 to 0.6).
    const nosed = relief((x, y) => (x >= 2 && x < 7 && y >= 1 && y < 3 ? 0.5 : x >= 3 && x < 6 && y >= 4 && y < 6 ? 1.6 : 1));
    const mouth = mouthRecess(nosed, [0.45, 0.2, 0.5]);
    expect(mouth).not.toBeNull();
    expect(mouth!.center[2]).toBe(1);
    expect(mouth!.size[0]).toBeCloseTo(0.5, 1);
    expect(mouth!.size[1]).toBeCloseTo(0.2, 1);
    // Lips that slope up to the face all round: each wall is its top, not where it starts to rise.
    const sloped = relief((x, y) => {
      const out = Math.max(32 - x, x - 111, 16 - y, y - 47, 0);
      return out === 0 ? 0.5 : Math.min(1, 0.55 + 0.15 * out);
    }, 160);
    expect(mouthRecess(sloped, [0.45, 0.2, 0.5])!.center[2]).toBe(1);
    // A wide bevel, rising over six cells: climbed all the way to its top.
    const bevelled = relief((x, y) => {
      const out = Math.max(32 - x, x - 111, 16 - y, y - 47, 0);
      return Math.min(1, 0.5 + 0.075 * out);
    }, 160);
    const wide = mouthRecess(bevelled, [0.45, 0.2, 0.5])!;
    expect(wide.center[2]).toBe(1);
    expect(wide.size[0]).toBeGreaterThan(0.5);
  });

  it('finds nothing on a flat face, in the open air, or in a "hollow" that’s most of the model', () => {
    expect(mouthRecess([], [0, 0, 0])).toBeNull();
    expect(mouthRecess(face(() => false), [0.5, 0.5, 1])).toBeNull();
    // Two plates with nothing between them, clicked between.
    const plates = [...face(() => false, 2).map((v, i) => (i % 3 === 0 ? v * 0.2 : v)), ...face(() => false, 2).map((v, i) => (i % 3 === 0 ? 0.8 + v * 0.2 : v))];
    expect(mouthRecess(plates, [0.5, 0.5, 0])).toBeNull();
    expect(mouthRecess(face((x) => x < 7), [0.3, 0.5, 0.5])).toBeNull();
    // A sliver of a triangle is skipped.
    expect(mouthRecess([...face(() => false), 0, 0, 0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 1])).toBeNull();
  });
});
