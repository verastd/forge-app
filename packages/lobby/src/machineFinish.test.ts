import { describe, expect, it } from 'vitest';

import { MACHINE_FINISHES, machineFinish, partWords } from './machineFinish.js';

const kind = (name: string): string => machineFinish(name).kind;

describe('a machine part’s finish, from its name', () => {
  it('reads names the way CAD writes them', () => {
    expect(partWords('Cylinder_Head-2')).toEqual(['cylinder', 'head']);
    expect(partWords('mainBearingCap')).toEqual(['main', 'bearing', 'cap']);
    expect(partWords('  ')).toEqual([]);
  });

  it('knows each kind of part', () => {
    expect(kind('Engine Block')).toBe('castIron');
    expect(kind('Cylinder_Head')).toBe('castIron');
    expect(kind('Crank_Case')).toBe('castIron');
    expect(kind('Piston_3')).toBe('aluminium');
    expect(kind('ValveCover')).toBe('aluminium');
    expect(kind('Crankshaft')).toBe('steel');
    expect(kind('M8 Bolts')).toBe('steel');
    expect(kind('Brass_Fitting')).toBe('brass');
    expect(kind('Coil')).toBe('copper');
    expect(kind('Timing Belt')).toBe('rubber');
  });

  it('takes the last word that names a part: a head bolt is a bolt, a piston pin a pin', () => {
    expect(kind('Head_Bolt')).toBe('steel');
    expect(kind('Piston_Pin')).toBe('steel');
    expect(kind('Bolted_Plate')).toBe('aluminium');
    expect(kind('Plate_Bolted')).toBe('aluminium');
  });

  it('reads an o-ring as one word, and a plain ring as steel', () => {
    expect(kind('O-Ring 12mm')).toBe('rubber');
    expect(kind('ORing')).toBe('rubber');
    expect(kind('Retaining Ring')).toBe('steel');
  });

  it('is steel when the name says nothing, and doesn’t read words inside words', () => {
    expect(kind('Part1')).toBe('steel');
    expect(kind('')).toBe('steel');
    expect(kind('Camera')).toBe('steel');
    expect(kind('gas')).toBe('steel');
  });

  it('keeps a colour the designer chose as paint, and ignores CAD’s default greys', () => {
    const red = machineFinish('Engine Block', [0.8, 0.05, 0.04]);
    expect(red.kind).toBe('painted');
    expect(red.color).toEqual([0.8, 0.05, 0.04]);
    expect(red.grain).toBe('peel');
    expect(machineFinish('Engine Block', [0.6, 0.6, 0.62]).kind).toBe('castIron');
    expect(machineFinish('Engine Block', null).kind).toBe('castIron');
  });

  it('hands out a copy of its preset, never the preset itself', () => {
    const steel = machineFinish('Bolt');
    expect(steel.color).toEqual(MACHINE_FINISHES.steel.color);
    steel.color[0] = 1;
    expect(MACHINE_FINISHES.steel.color[0]).toBeLessThan(1);
    expect(machineFinish('Hose').grain).toBe('none');
  });
});
