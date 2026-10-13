/**
 * What a machine part looks like when its model brings no texture of its own
 * (a STEP file never does: CAD carries shapes and at most a flat colour). The
 * finish is guessed from the part's CAD name, the way a mechanic would: a
 * block or a cylinder head is cast iron, a piston or a cover is aluminium, a
 * bolt or a shaft is steel, a fitting is brass, a hose or a belt is rubber.
 *
 * Names are read the English way: the last word is the thing ("Head_Bolt" is a
 * bolt, "Cylinder_Head" is a head). A colour the designer clearly chose (not a
 * CAD default grey) is kept as paint. Pure and deterministic, so every viewer
 * paints a part the same.
 */

/** The surface grain a finish is drawn with (the lobby makes one texture of each). */
export type MachineGrain = 'brushed' | 'cast' | 'peel' | 'none';

export type MachineFinishKind = 'castIron' | 'steel' | 'aluminium' | 'brass' | 'copper' | 'rubber' | 'painted';

export interface MachineFinish {
  kind: MachineFinishKind;
  /** Linear RGB, 0–1. */
  color: [number, number, number];
  metalness: number;
  roughness: number;
  grain: MachineGrain;
}

type Preset = Omit<MachineFinish, 'kind'>;

export const MACHINE_FINISHES: Readonly<Record<Exclude<MachineFinishKind, 'painted'>, Preset>> = Object.freeze({
  castIron: { color: [0.045, 0.045, 0.05], metalness: 0.6, roughness: 0.8, grain: 'cast' },
  steel: { color: [0.2, 0.21, 0.235], metalness: 0.95, roughness: 0.42, grain: 'brushed' },
  aluminium: { color: [0.62, 0.62, 0.63], metalness: 0.7, roughness: 0.34, grain: 'brushed' },
  brass: { color: [0.56, 0.36, 0.09], metalness: 0.9, roughness: 0.32, grain: 'brushed' },
  copper: { color: [0.55, 0.22, 0.11], metalness: 0.9, roughness: 0.34, grain: 'brushed' },
  rubber: { color: [0.02, 0.02, 0.022], metalness: 0, roughness: 0.92, grain: 'none' },
});

/** Paint: the designer's colour, satin, with a faint orange-peel. */
const PAINT: Omit<Preset, 'color'> = { metalness: 0.15, roughness: 0.48, grain: 'peel' };

/** The words that name each finish's parts (singular, lower case). */
const WORDS: Readonly<Record<Exclude<MachineFinishKind, 'painted'>, readonly string[]>> = Object.freeze({
  castIron: [
    'block', 'head', 'cylinder', 'crankcase', 'case', 'casing', 'housing', 'manifold', 'flywheel', 'bellhousing',
    'frame', 'base', 'bed', 'body', 'gearbox', 'transmission', 'differential', 'knuckle', 'caliper', 'rotor', 'disc', 'drum',
  ],
  steel: [
    'bolt', 'nut', 'screw', 'washer', 'stud', 'shaft', 'crankshaft', 'camshaft', 'rod', 'pin', 'spring', 'gear', 'cam',
    'valve', 'axle', 'bearing', 'chain', 'sprocket', 'pulley', 'link', 'lever', 'arm', 'beam', 'tube', 'pipe', 'rail',
    'hinge', 'clip', 'key', 'rivet', 'chassis', 'blade', 'spindle', 'bracket', 'clamp', 'spacer', 'collar', 'coupling',
    'ring', 'crank', 'driveshaft', 'exhaust', 'muffler', 'turbo', 'impeller', 'shim', 'dowel',
  ],
  aluminium: [
    'piston', 'cover', 'sump', 'pan', 'intake', 'plate', 'cap', 'panel', 'fin', 'radiator', 'heatsink', 'rim', 'wheel',
    'carburetor', 'carburettor', 'throttle', 'pump', 'alternator', 'starter', 'motor', 'fan', 'shroud', 'guard', 'tank',
  ],
  brass: ['fitting', 'bushing', 'bush', 'nozzle', 'union', 'jet', 'nipple', 'bung', 'plug', 'tap'],
  copper: ['wire', 'coil', 'winding', 'busbar', 'line', 'terminal'],
  rubber: [
    'belt', 'hose', 'seal', 'gasket', 'tyre', 'tire', 'grommet', 'oring', 'boot', 'bellows', 'bumper', 'pad', 'mount', 'isolator', 'diaphragm',
  ],
});

const KIND_OF = new Map<string, Exclude<MachineFinishKind, 'painted'>>();
for (const [kind, words] of Object.entries(WORDS) as [Exclude<MachineFinishKind, 'painted'>, readonly string[]][]) {
  for (const word of words) KIND_OF.set(word, kind);
}

/** A name's words, lower case: split on anything not a letter, and between a small and a capital letter. */
export function partWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
}

/** A word's finish, if it names one: as written, or singular. */
function kindOf(word: string): Exclude<MachineFinishKind, 'painted'> | undefined {
  return KIND_OF.get(word) ?? (word.length > 3 && word.endsWith('s') ? KIND_OF.get(word.slice(0, -1)) : undefined);
}

/** Whether a CAD colour was chosen (a hue, or far from the greys CAD gives by default). */
function chosen(color: readonly [number, number, number]): boolean {
  const max = Math.max(...color);
  const min = Math.min(...color);
  return max - min > 0.12;
}

/** The finish for a part named `name`, whose CAD colour (linear RGB 0–1) is `cadColor`, if it had one. */
export function machineFinish(name: string, cadColor: readonly [number, number, number] | null = null): MachineFinish {
  if (cadColor && chosen(cadColor)) return { kind: 'painted', color: [cadColor[0], cadColor[1], cadColor[2]], ...PAINT };
  const words = partWords(name);
  let kind: Exclude<MachineFinishKind, 'painted'> = 'steel';
  // The last word that names a finish is the thing (Head_Bolt is a bolt); "o ring" is one word.
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const joined = i > 0 ? kindOf(words[i - 1]! + words[i]!) : undefined;
    const found = joined ?? kindOf(words[i]!);
    if (found) {
      kind = found;
      break;
    }
  }
  const preset = MACHINE_FINISHES[kind];
  return { kind, color: [...preset.color], metalness: preset.metalness, roughness: preset.roughness, grain: preset.grain };
}
