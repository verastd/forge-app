/**
 * The wall: 32 columns × 90 rows of 16:9 panels standing on a ring around the
 * cave's axis, as the operator's cave prototype builds it. Pure geometry: the
 * scene turns these numbers into meshes, and the shell turns them into input.
 *
 * Coordinates follow three.js, so the scene can use every number as it is:
 * right-handed, +Y up, the floor at y = 0 and the cave's axis at x = z = 0.
 *
 * - Column `col` sits at the angle `th = col·2π/columns`. Column 0 is
 *   straight down −Z from the axis, and the angle grows turning RIGHT, so
 *   column 8 of 32 is at +X. The camera's yaw uses the same angle (camera.ts):
 *   yaw `th` looks straight at column `col` from the axis.
 * - Row 0 stands on the floor, `y0` above it, and rows stack upward, edge to
 *   edge, one `panelHeight` apart.
 * - A slot's index is `row·columns + col`: 0 is the bottom panel straight
 *   ahead, and the indices run right around the ring before climbing a row.
 *   The scene's dark-slot `InstancedMesh` uses the same order, so a
 *   raycast's `instanceId` is the slot index.
 *
 * Each panel is a `PlaneGeometry(panelWidth, panelHeight)` centred on the
 * ring of radius `ringRadius` and posed with `rotation.y = rotationY`, which
 * turns its front face (+Z) back toward the axis. `panelWidth` is the chord
 * of the cave's radius, so neighbouring panels meet exactly: together they
 * form a regular 32-gon inscribed in the radius.
 */

/** The wall's inputs, and the three sizes derived from them (see `deriveWall`). */
export interface WallSpec {
  readonly columns: number;
  readonly rows: number;
  /** The cave's radius, in metres: the panels' outer corners touch it. */
  readonly radius: number;
  /** The gap between the floor and the bottom row. */
  readonly y0: number;
  /** A standing visitor's eye height above the floor. */
  readonly eye: number;
  /** `2·radius·sin(π/columns)`: the chord, so neighbouring panels meet. */
  readonly panelWidth: number;
  /** `panelWidth·9/16`. */
  readonly panelHeight: number;
  /** `radius·cos(π/columns)`: how far each panel's centre stands from the axis. */
  readonly ringRadius: number;
}

/** A place on the wall: `col` 0..columns−1 around the ring, `row` 0..rows−1 up from the floor. */
export interface SlotRef {
  col: number;
  row: number;
}

/** Where a panel's centre goes, and its `rotation.y` (see the module comment). */
export interface SlotPose {
  position: [number, number, number];
  rotationY: number;
}

type WallInputs = Pick<WallSpec, 'columns' | 'rows' | 'radius' | 'y0' | 'eye'>;

const TAU = 2 * Math.PI;

/** A frozen wall with its derived sizes filled in from the five inputs. */
export function deriveWall(inputs: WallInputs): WallSpec {
  const { columns, rows, radius, y0, eye } = inputs;
  const panelWidth = 2 * radius * Math.sin(Math.PI / columns);
  return Object.freeze({
    columns,
    rows,
    radius,
    y0,
    eye,
    panelWidth,
    panelHeight: (panelWidth * 9) / 16,
    ringRadius: radius * Math.cos(Math.PI / columns),
  });
}

/** The wall every consumer shares. Frozen. */
export const WALL: WallSpec = deriveWall({ columns: 32, rows: 90, radius: 28, y0: 0.3, eye: 1.7 });

/** True for a whole number naming a slot on the wall: 0 ≤ value < columns·rows. */
export function isSlotIndex(value: unknown, wall: WallSpec = WALL): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < wall.columns * wall.rows;
}

/** True for a slot that exists as written: whole numbers inside the grid, no wrapping. */
export function isGridSlot(slot: SlotRef, wall: WallSpec = WALL): boolean {
  return (
    Number.isInteger(slot.col) &&
    Number.isInteger(slot.row) &&
    slot.col >= 0 &&
    slot.col < wall.columns &&
    slot.row >= 0 &&
    slot.row < wall.rows
  );
}

/** A slot's index, `row·columns + col`. Throws a RangeError for a slot outside the grid. */
export function slotIndex(slot: SlotRef, wall: WallSpec = WALL): number {
  if (!isGridSlot(slot, wall)) {
    throw new RangeError(
      `slotIndex: col ${String(slot.col)}, row ${String(slot.row)} is not on the ${gridName(wall)} wall`,
    );
  }
  return slot.row * wall.columns + slot.col;
}

/** The slot at an index. Throws a RangeError unless `isSlotIndex(index)`. */
export function slotFromIndex(index: number, wall: WallSpec = WALL): SlotRef {
  if (!isSlotIndex(index, wall)) {
    throw new RangeError(`slotFromIndex: ${String(index)} is not a slot index on the ${gridName(wall)} wall`);
  }
  return { col: index % wall.columns, row: Math.floor(index / wall.columns) };
}

/**
 * Where the panel at a slot index goes: centred on the ring at the column's
 * angle `th`, `y0 + panelHeight/2 + row·panelHeight` above the floor, with
 * `rotationY = −th` so its front faces the axis. Throws a RangeError unless
 * `isSlotIndex(index)`.
 */
export function slotPose(index: number, wall: WallSpec = WALL): SlotPose {
  const { col, row } = slotFromIndex(index, wall);
  const th = (col * TAU) / wall.columns;
  return {
    position: [
      Math.sin(th) * wall.ringRadius + 0,
      wall.y0 + wall.panelHeight / 2 + row * wall.panelHeight,
      -Math.cos(th) * wall.ringRadius + 0,
    ],
    // `+ 0` turns column 0's -0 into 0.
    rotationY: -th + 0,
  };
}

/** True when both refs name the same place: rows equal, columns equal once wrapped around the ring. */
export function sameSlot(a: SlotRef, b: SlotRef, wall: WallSpec = WALL): boolean {
  return wrapColumn(a.col, wall) === wrapColumn(b.col, wall) && a.row === b.row;
}

/** Any whole column wrapped onto 0..columns−1. */
function wrapColumn(col: number, wall: WallSpec): number {
  return (((col % wall.columns) + wall.columns) % wall.columns) + 0;
}

/**
 * Throws, listing every problem, unless the wall is buildable: at least 3
 * whole columns and 1 whole row, a positive radius and eye height, a floor
 * gap that is not negative, and derived sizes that match their formulas
 * (so a hand-edited spec can't drift from what the scene draws).
 */
export function validateWall(wall: WallSpec = WALL): void {
  const problems: string[] = [];
  if (!Number.isInteger(wall.columns) || wall.columns < 3) {
    problems.push(`columns must be a whole number of at least 3 (got ${String(wall.columns)})`);
  }
  if (!Number.isInteger(wall.rows) || wall.rows < 1) {
    problems.push(`rows must be a whole number of at least 1 (got ${String(wall.rows)})`);
  }
  for (const [name, value] of [
    ['radius', wall.radius],
    ['eye', wall.eye],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`${name} must be a positive number (got ${String(value)})`);
    }
  }
  if (!Number.isFinite(wall.y0) || wall.y0 < 0) {
    problems.push(`y0 must be a number of at least 0 (got ${String(wall.y0)})`);
  }
  if (problems.length === 0) {
    const derived = deriveWall(wall);
    for (const name of ['panelWidth', 'panelHeight', 'ringRadius'] as const) {
      // The tolerance only forgives float noise in a value written out by hand.
      if (!(Math.abs(wall[name] - derived[name]) <= 1e-9 * Math.max(1, Math.abs(derived[name])))) {
        problems.push(`${name} must be ${derived[name]} for this radius and column count (got ${String(wall[name])})`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid wall: ${problems.join('; ')}`);
  }
}

function gridName(wall: WallSpec): string {
  return `${wall.columns}×${wall.rows}`;
}
