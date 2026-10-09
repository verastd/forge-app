/**
 * Shared things in the cave, and who may say where they are.
 *
 * Every shared object is an entity: a stable id, a kind, an owner, whose word
 * on it is final (the owner's client today, the world participant once it
 * exists), an epoch that grows with every change of hands, a pose and whether
 * it outlives the session. The ball is the first. Nothing here moves anything:
 * behaviours do that, through world.ts, and the feeds carry the result.
 *
 * Cells are the cave cut into pieces for interest management (ADR-009,
 * decision 4): today everything is one broadcast, and every message is still
 * keyed by its cell so that the day it becomes one LiveKit data track per cell,
 * nothing on the wire changes shape.
 */

import type { Vec3 } from '../attenuation.js';
import { CAMERA_LIMITS } from '../camera.js';

/** The owner whose decisions come from the world participant rather than a member's client. */
export const WORLD_OWNER = 'world';

/** `<kind>:<name>`: a short lowercase kind, then up to 32 safe characters. `ball:1`, `crate:k7Qx`. */
export const ENTITY_ID = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9_-]{1,32}$/;

/** A member's id as the room gives it (`gh:123`, `practice-0a1b2c`), or `world`. An entity nobody holds has the empty owner. */
export const OWNER_ID = /^[A-Za-z0-9:_.-]{1,64}$/;

/** Who decides an entity's state. */
export type Authority = 'owner' | 'world';

export interface Entity {
  id: string;
  kind: string;
  /** Who holds it: a member's id, `world`, or `''` for nobody. */
  owner: string;
  authority: Authority;
  /** Grows by one every time the entity changes hands. A claim names the epoch it saw. */
  epoch: number;
  pose: Vec3;
  /** Whether it is written to the event log and survives the session. Balls never are. */
  persistent: boolean;
}

/**
 * The cave in cells: `sectors` wedges around the axis by `bands` of height.
 * 8 × 4 is 32 cells over a 56 m disk 220 m tall: a wedge is about 22 m wide
 * at the wall, a band 55 m tall, so a member's own cell and its neighbours
 * cover more than a voice carries (35 m) in every direction.
 */
export const CELLS = Object.freeze({ sectors: 8, bands: 4 });

const TAU = 2 * Math.PI;
const BAND_HEIGHT = CAMERA_LIMITS.maxY / CELLS.bands;

/** The cell `pose` is in: `band * sectors + sector`, 0 ≤ cell < 32. A pose that isn't a number is cell 0. */
export function cellOf(pose: Vec3): number {
  const x = Number.isFinite(pose.x) ? pose.x : 0;
  const y = Number.isFinite(pose.y) ? pose.y : 0;
  const z = Number.isFinite(pose.z) ? pose.z : 0;
  // `0 - z`, not `-z`: atan2(0, -0) is π, and a pose on the axis belongs in sector 0.
  const angle = (Math.atan2(x, 0 - z) + TAU) % TAU;
  const sector = Math.min(CELLS.sectors - 1, Math.floor((angle / TAU) * CELLS.sectors));
  const band = Math.min(CELLS.bands - 1, Math.max(0, Math.floor(y / BAND_HEIGHT)));
  return band * CELLS.sectors + sector;
}

/** The cells around `cell` (the sectors either side, wrapping, in this band and the bands above and below), sorted, without `cell` itself. Empty for a cell that doesn't exist. */
export function neighbours(cell: number): number[] {
  const total = CELLS.sectors * CELLS.bands;
  if (!Number.isInteger(cell) || cell < 0 || cell >= total) {
    return [];
  }
  const sector = cell % CELLS.sectors;
  const band = Math.floor(cell / CELLS.sectors);
  const found = new Set<number>();
  for (const db of [-1, 0, 1]) {
    const b = band + db;
    if (b < 0 || b >= CELLS.bands) continue;
    for (const ds of [-1, 0, 1]) {
      const s = (sector + ds + CELLS.sectors) % CELLS.sectors;
      const other = b * CELLS.sectors + s;
      if (other !== cell) found.add(other);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** A member's word that an entity is theirs now: which entity, who, and the epoch they saw it at. */
export interface Claim {
  entity: string;
  claimant: string;
  epoch: number;
}

/**
 * Which of two claims on the same entity stands. The one that saw the later
 * epoch wins (it knew more); at the same epoch the lower claimant id wins, a
 * tie-break with no meaning but the same on every client, so two honest
 * clients that hear both claims in either order agree. Identical claims are
 * one claim.
 */
export function resolveClaim(a: Claim, b: Claim): Claim {
  if (a.epoch !== b.epoch) {
    return a.epoch > b.epoch ? a : b;
  }
  if (a.claimant === b.claimant) {
    return a;
  }
  return a.claimant < b.claimant ? a : b;
}

/** Whether `entity` is one this module would store: well-formed ids, a finite pose, a non-negative integer epoch. */
export function isEntity(value: unknown): value is Entity {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const pose = e.pose as Record<string, unknown> | undefined;
  return (
    typeof e.id === 'string' &&
    ENTITY_ID.test(e.id) &&
    typeof e.kind === 'string' &&
    e.id.startsWith(`${e.kind}:`) &&
    typeof e.owner === 'string' &&
    (e.owner === '' || OWNER_ID.test(e.owner)) &&
    (e.authority === 'owner' || e.authority === 'world') &&
    Number.isInteger(e.epoch) &&
    (e.epoch as number) >= 0 &&
    typeof pose === 'object' &&
    pose !== null &&
    ['x', 'y', 'z'].every((axis) => Number.isFinite(pose[axis])) &&
    typeof e.persistent === 'boolean'
  );
}
