import { describe, expect, it } from 'vitest';

import { BACK_ANCHOR, BACK_PANEL, HOVER_POD } from './avatar.js';
import { HEAD_FIT, autoPlacement } from './headFit.js';

/** A box's eight corners, x, y, z in turn. */
function box(min: [number, number, number], max: [number, number, number]): number[] {
  const out: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return out;
}

describe('a back model’s first fit', () => {
  it('fits wide wings across the back, centred, front against the back plate', () => {
    // Wings as a modeller exports them: 2 m across, 1 m tall, off-centre, origin at their feet.
    const wings = box([-0.8, 0, -0.1], [1.2, 1, 0.1]);
    const { scale, offset } = autoPlacement('back', wings);
    expect(scale).toBeCloseTo(HEAD_FIT.backWidth / 2);
    // Centred left to right and up and down on the anchor.
    expect(scale * -0.8 + offset[0]).toBeCloseTo(-HEAD_FIT.backWidth / 2);
    expect(scale * 1.2 + offset[0]).toBeCloseTo(HEAD_FIT.backWidth / 2);
    expect(scale * 0.5 + offset[1]).toBeCloseTo(0);
    // Its front (+Z) just behind the plate (the anchor is on it).
    expect(scale * 0.1 + offset[2]).toBeCloseTo(-0.002);
  });

  it('fits a tall jetpack by its height', () => {
    const jetpack = box([-0.1, 0, -0.2], [0.1, 2, 0]);
    const { scale } = autoPlacement('back', jetpack);
    expect(scale).toBeCloseTo(HEAD_FIT.backHeight / 2);
  });

  it('wears a model with nothing to measure as it is', () => {
    expect(autoPlacement('back', [])).toEqual({ scale: 1, offset: [0, 0, 0] });
  });
});

describe('the back frame', () => {
  it('sits on the back plate, between the shoulder blades, above the hover pod', () => {
    expect(BACK_ANCHOR.z).toBe(BACK_PANEL.z);
    expect(BACK_ANCHOR.y).toBeGreaterThan(BACK_PANEL.minY);
    expect(BACK_ANCHOR.y).toBeLessThan(BACK_PANEL.maxY);
    expect(BACK_ANCHOR.y).toBeGreaterThan(HOVER_POD.maxY);
    // The pod is narrower than the back is deep: a cape hung behind the plate clears it.
    expect(-HOVER_POD.radius).toBeGreaterThan(BACK_PANEL.z);
  });
});
