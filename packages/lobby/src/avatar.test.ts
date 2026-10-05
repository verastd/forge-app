import { describe, expect, it } from 'vitest';

import {
  AVATAR_PALETTES,
  CHEST_PANEL,
  FACE_PANEL,
  ZONE,
  classifyIsland,
  defaultColors,
  emblemInitials,
  isHexColor,
  paletteIndex,
  segmentRobot,
} from './avatar.js';
import type { Zone } from './avatar.js';

/**
 * Every part of apps/web/public/lobby/robot.glb as the segmentation sees it:
 * vertex count, the bone owning most of it, and its bind-pose bounds. Read
 * from the asset itself (this package's tests cannot open files), so a change
 * to the robot shows up here as a failing zone count, not as a robot painted
 * wrong.
 */
const ROBOT_ISLANDS: ReadonlyArray<[number, string, number[], number[]]> = [
  [74, 'R_ForearmTwist02', [-0.334, 0.358, 0.027], [-0.289, 0.406, 0.067]],
  [69, 'R_ForearmTwist02', [-0.344, 0.356, -0.015], [-0.287, 0.411, 0.025]],
  [50, 'R_ForearmTwist02', [-0.337, 0.397, 0.03], [-0.299, 0.437, 0.07]],
  [50, 'R_ForearmTwist02', [-0.352, 0.394, -0.005], [-0.316, 0.437, 0.03]],
  [51, 'R_ForearmTwist02', [-0.35, 0.426, -0.007], [-0.314, 0.463, 0.032]],
  [48, 'R_ForearmTwist02', [-0.331, 0.424, 0.024], [-0.293, 0.463, 0.063]],
  [46, 'R_ForearmTwist02', [-0.349, 0.428, -0.049], [-0.249, 0.506, 0.059]],
  [50, 'R_ForearmTwist02', [-0.284, 0.433, 0.025], [-0.241, 0.471, 0.065]],
  [75, 'R_ForearmTwist02', [-0.275, 0.395, 0.019], [-0.23, 0.447, 0.062]],
  [80, 'R_ForearmTwist02', [-0.341, 0.474, -0.064], [-0.198, 0.597, 0.065]],
  [121, 'Pelvis', [-0.094, 0, -0.073], [0.094, 0.16, 0.072]],
  [165, 'Pelvis', [-0.132, 0.27, 0.004], [-0.102, 0.382, 0.062]],
  [101, 'Pelvis', [-0.141, 0.379, 0.008], [-0.118, 0.426, 0.055]],
  [196, 'Hip', [-0.135, 0.383, -0.101], [0.135, 0.435, 0.101]],
  [59, 'Pelvis', [-0.138, 0.479, -0.116], [0.138, 0.783, 0.112]],
  [60, 'Hip', [-0.058, 0.449, -0.052], [0.058, 0.508, 0.052]],
  [196, 'R_UpperarmTwist02', [-0.278, 0.563, -0.036], [-0.18, 0.693, 0.031]],
  [197, 'R_UpperarmTwist02', [-0.233, 0.635, -0.06], [-0.123, 0.755, 0.059]],
  [137, 'R_UpperarmTwist01', [-0.242, 0.625, -0.07], [-0.149, 0.768, 0.07]],
  [181, 'Head', [-0.198, 0.844, -0.027], [-0.157, 0.953, 0.083]],
  [66, 'R_ForearmTwist02', [-0.342, 0.364, -0.046], [-0.287, 0.414, -0.013]],
  [64, 'R_ForearmTwist02', [-0.325, 0.373, -0.074], [-0.28, 0.423, -0.043]],
  [50, 'R_ForearmTwist02', [-0.348, 0.398, -0.042], [-0.315, 0.439, -0.005]],
  [53, 'R_ForearmTwist02', [-0.343, 0.431, -0.037], [-0.305, 0.47, 0.001]],
  [50, 'R_ForearmTwist02', [-0.329, 0.408, -0.072], [-0.295, 0.451, -0.033]],
  [59, 'R_ForearmTwist02', [-0.324, 0.436, -0.056], [-0.288, 0.473, -0.019]],
  [185, 'Pelvis', [-0.132, 0.27, -0.062], [-0.102, 0.382, -0.004]],
  [101, 'Hip', [-0.141, 0.379, -0.055], [-0.118, 0.426, -0.008]],
  [165, 'Pelvis', [0.102, 0.27, 0.004], [0.132, 0.382, 0.062]],
  [101, 'Pelvis', [0.118, 0.379, 0.008], [0.141, 0.426, 0.055]],
  [75, 'L_ForearmTwist02', [0.23, 0.395, 0.02], [0.275, 0.447, 0.063]],
  [50, 'L_ForearmTwist02', [0.242, 0.433, 0.026], [0.285, 0.472, 0.065]],
  [80, 'L_ForearmTwist02', [0.198, 0.474, -0.064], [0.341, 0.597, 0.065]],
  [74, 'L_ForearmTwist02', [0.289, 0.358, 0.027], [0.335, 0.407, 0.067]],
  [69, 'L_ForearmTwist02', [0.287, 0.356, -0.015], [0.344, 0.411, 0.025]],
  [51, 'L_ForearmTwist02', [0.3, 0.397, 0.03], [0.338, 0.437, 0.07]],
  [44, 'L_ForearmTwist02', [0.249, 0.422, -0.048], [0.349, 0.507, 0.059]],
  [48, 'L_ForearmTwist02', [0.293, 0.425, 0.025], [0.331, 0.463, 0.063]],
  [51, 'L_ForearmTwist02', [0.316, 0.394, -0.005], [0.352, 0.434, 0.03]],
  [51, 'L_ForearmTwist02', [0.314, 0.426, -0.007], [0.351, 0.463, 0.032]],
  [199, 'L_UpperarmTwist02', [0.123, 0.635, -0.06], [0.233, 0.755, 0.059]],
  [196, 'L_UpperarmTwist02', [0.18, 0.563, -0.036], [0.278, 0.693, 0.031]],
  [137, 'L_UpperarmTwist01', [0.149, 0.625, -0.07], [0.242, 0.768, 0.07]],
  [181, 'Head', [0.156, 0.844, -0.027], [0.197, 0.953, 0.083]],
  [185, 'Pelvis', [0.102, 0.27, -0.062], [0.132, 0.382, -0.004]],
  [101, 'Hip', [0.118, 0.379, -0.055], [0.141, 0.426, -0.008]],
  [63, 'L_ForearmTwist02', [0.287, 0.364, -0.046], [0.342, 0.414, -0.013]],
  [64, 'L_ForearmTwist02', [0.28, 0.373, -0.073], [0.323, 0.422, -0.043]],
  [50, 'L_ForearmTwist02', [0.295, 0.407, -0.072], [0.329, 0.451, -0.033]],
  [59, 'L_ForearmTwist02', [0.288, 0.436, -0.056], [0.324, 0.473, -0.019]],
  [55, 'L_ForearmTwist02', [0.305, 0.431, -0.037], [0.343, 0.47, 0.001]],
  [50, 'L_ForearmTwist02', [0.315, 0.398, -0.042], [0.348, 0.439, -0.005]],
  [48, 'R_ForearmTwist02', [-0.295, 0.446, 0.017], [-0.254, 0.488, 0.059]],
  [220, 'Pelvis', [-0.107, 0.125, -0.11], [0.107, 0.405, 0.11]],
  [60, 'Pelvis', [-0.113, 0.433, -0.02], [-0.078, 0.484, 0.02]],
  [40, 'Hip', [-0.044, 0.422, -0.042], [0.044, 0.46, 0.042]],
  [84, 'Head', [-0.159, 0.799, -0.11], [0.159, 1, 0.115]],
  [40, 'Spine02', [-0.06, 0.758, -0.042], [0.06, 0.813, 0.042]],
  [60, 'Pelvis', [0.078, 0.433, -0.02], [0.113, 0.484, 0.02]],
  [48, 'L_ForearmTwist02', [0.255, 0.446, 0.017], [0.296, 0.488, 0.06]],
];

const zoneName = (z: Zone): string => Object.entries(ZONE).find(([, v]) => v === z)?.[0] ?? '?';

describe('classifyIsland, on the real robot', () => {
  const zones = ROBOT_ISLANDS.map(([, bone, min, max]) => classifyIsland(bone, min, max));
  const count = (z: Zone): number => zones.filter((v) => v === z).length;

  it('finds the one torso, thruster and head box, and the two ear discs', () => {
    expect(count(ZONE.torso)).toBe(1);
    expect(count(ZONE.thruster)).toBe(1);
    expect(count(ZONE.head)).toBe(1);
    expect(count(ZONE.headTrim)).toBe(2);
  });

  it('paints the pod, both gauntlets and both shoulder pads as armour', () => {
    expect(count(ZONE.shell)).toBe(5);
  });

  it('paints the hip ring, both biceps and both palms as trim', () => {
    expect(count(ZONE.trim)).toBe(5);
  });

  it('leaves every other part (struts, neck, waist, elbows, fingers) as joints', () => {
    expect(count(ZONE.joint)).toBe(45);
    expect(zones).toHaveLength(60);
  });

  it('is mirror-symmetric: a part and its mirror image take the same zone', () => {
    for (const [i, [n, , min, max]] of ROBOT_ISLANDS.entries()) {
      if (Math.abs(min[0]! + max[0]!) < 0.04) continue;
      // Its twin: the part whose bounds' centre is nearest this one's, mirrored in x.
      const centre = (mn: number[], mx: number[]): number[] => mn.map((v, k) => (v + mx[k]!) / 2);
      const mine = centre(min, max);
      let twin = -1;
      let best = Infinity;
      for (const [j, [, , mn, mx]] of ROBOT_ISLANDS.entries()) {
        const c = centre(mn, mx);
        const d = Math.hypot(c[0]! + mine[0]!, c[1]! - mine[1]!, c[2]! - mine[2]!);
        if (d < best) {
          best = d;
          twin = j;
        }
      }
      expect(best, `island ${i} (${n} vertices)`).toBeLessThan(0.01);
      expect(twin, `island ${i}`).toBeGreaterThanOrEqual(0);
      expect(zoneName(zones[twin]!)).toBe(zoneName(zones[i]!));
    }
  });

  it('puts the chest and face panels on the torso and the head box', () => {
    const torso = ROBOT_ISLANDS[zones.indexOf(ZONE.torso)]!;
    expect(torso[2][0]).toBeLessThan(CHEST_PANEL.minX);
    expect(torso[3][0]).toBeGreaterThan(CHEST_PANEL.maxX);
    expect(torso[3][2]).toBeCloseTo(CHEST_PANEL.z, 3);
    const head = ROBOT_ISLANDS[zones.indexOf(ZONE.head)]!;
    expect(head[2][1]).toBeLessThan(FACE_PANEL.minY);
    expect(head[3][1]).toBeGreaterThan(FACE_PANEL.maxY);
  });
});

describe('classifyIsland, rule by rule', () => {
  it('names an unknown bone a joint', () => {
    expect(classifyIsland('Spine01', [-0.1, 0.3, -0.1], [-0.05, 0.4, 0])).toBe(ZONE.joint);
  });
  it('splits forearm parts into gauntlet, palm and finger', () => {
    expect(classifyIsland('L_ForearmTwist02', [0.2, 0.47, -0.06], [0.34, 0.6, 0.06])).toBe(ZONE.shell);
    expect(classifyIsland('L_ForearmTwist02', [0.25, 0.42, -0.05], [0.35, 0.51, 0.06])).toBe(ZONE.trim);
    expect(classifyIsland('L_ForearmTwist02', [0.29, 0.36, 0.03], [0.33, 0.41, 0.07])).toBe(ZONE.joint);
  });
  it('splits shoulder parts into pad, bicep and elbow', () => {
    expect(classifyIsland('L_UpperarmTwist01', [0.15, 0.62, -0.07], [0.24, 0.77, 0.07])).toBe(ZONE.shell);
    expect(classifyIsland('L_Clavicle', [0.12, 0.63, -0.06], [0.23, 0.75, 0.06])).toBe(ZONE.trim);
    expect(classifyIsland('L_UpperarmTwist02', [0.18, 0.56, -0.04], [0.28, 0.69, 0.03])).toBe(ZONE.joint);
  });
});

describe('segmentRobot', () => {
  // Two separate triangles: one owned by the head bone, centred (the head
  // box), one by the pelvis below the thruster line (the tip), plus a vertex
  // no triangle uses.
  const mesh = {
    positions: [-0.1, 0.9, 0.1, 0.1, 0.9, 0.1, 0, 1, 0.1, -0.05, 0, 0, 0.05, 0, 0, 0, 0.15, 0, 0.5, 0.5, 0.5],
    joints: [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0],
    weights: [1, 0, 0, 0, 0.9, 0.1, 0, 0, 0.2, 0.8, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    index: [0, 1, 2, 3, 4, 5],
    jointNames: ['CC_Base_Head', 'CC_Base_Pelvis', 'Spine02'],
  };

  it('gives every vertex of a part its part’s zone', () => {
    const { zone, islands } = segmentRobot(mesh);
    expect([...zone]).toEqual([ZONE.head, ZONE.head, ZONE.head, ZONE.thruster, ZONE.thruster, ZONE.thruster, ZONE.joint]);
    expect(islands).toHaveLength(3);
  });

  it('names a part by the bone that owns most of its vertices, without the CC_Base_ prefix', () => {
    const { islands } = segmentRobot(mesh);
    expect(islands.map((i) => i.bone)).toEqual(['Head', 'Pelvis', 'Spine02']);
    expect(islands[0]!.min).toEqual([-0.1, 0.9, 0.1]);
    expect(islands[0]!.max).toEqual([0.1, 1, 0.1]);
  });

  it('treats a missing joint name as no bone', () => {
    const { islands } = segmentRobot({ ...mesh, jointNames: ['CC_Base_Head'] });
    expect(islands[1]!.bone).toBe('');
  });
});

describe('the default look', () => {
  it('has sixteen palettes, all valid colours, all different', () => {
    expect(AVATAR_PALETTES).toHaveLength(16);
    for (const p of AVATAR_PALETTES) {
      for (const c of [p.shell, p.trim, p.accent, p.eye]) expect(isHexColor(c)).toBe(true);
    }
    expect(new Set(AVATAR_PALETTES.map((p) => JSON.stringify(p))).size).toBe(16);
  });

  it('picks the same palette for the same id, every time', () => {
    expect(defaultColors('gh:42')).toEqual(defaultColors('gh:42'));
    expect(defaultColors('gh:42')).toBe(AVATAR_PALETTES[paletteIndex('gh:42')]);
  });

  it('spreads ids across the palettes', () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => paletteIndex(`gh:${i}`)));
    expect(used.size).toBe(16);
  });

  it('checks colours strictly', () => {
    expect(isHexColor('#A1b2C3')).toBe(true);
    for (const bad of ['#abc', 'abcdef', '#abcdeg', '#abcdef0', 7, null]) expect(isHexColor(bad)).toBe(false);
  });
});

describe('emblemInitials', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['grace', 'GR'],
    ['x', 'X'],
    ['  rémi   dupont-roux ', 'RD'],
    ['李小龙', '李小'],
    ['42', '42'],
    ['--- !!', '?'],
    ['', '?'],
  ])('%j → %j', (name, initials) => {
    expect(emblemInitials(name)).toBe(initials);
  });
});
