/**
 * The world: every shared entity the lobby knows, and the few things anyone
 * may do to one. The same functions run in a member's client (owner authority,
 * today) and in the world participant (world authority, ADR-009 step 3), so a
 * behaviour written once needs no second version when authority moves.
 *
 * Intents are refused rather than repaired: a move from someone other than the
 * owner, a claim on an entity that doesn't exist, a pose that isn't a number.
 * Nothing here knows about time or the wire.
 */

import type { Vec3 } from '../attenuation.js';
import { cellOf, isEntity, resolveClaim } from './entity.js';
import type { Claim, Entity } from './entity.js';

export interface World {
  readonly entities: Map<string, Entity>;
  /** The claim that gave each entity its current owner, so a rival claim heard later can still be resolved against it. */
  readonly claims: Map<string, Claim>;
}

export function createWorld(): World {
  return { entities: new Map(), claims: new Map() };
}

/** Puts `entity` in the world (new, or replacing the one with its id, and forgetting its claim). False, and nothing stored, for anything `isEntity` refuses. */
export function upsertEntity(world: World, entity: Entity): boolean {
  if (!isEntity(entity)) return false;
  world.entities.set(entity.id, { ...entity, pose: { ...entity.pose } });
  world.claims.delete(entity.id);
  return true;
}

export function removeEntity(world: World, id: string): boolean {
  world.claims.delete(id);
  return world.entities.delete(id);
}

export type ClaimOutcome =
  /** The claimant owns it now. */
  | { kind: 'won'; entity: Entity }
  /** A rival's claim at the same epoch stands: the entity as it is. */
  | { kind: 'lost'; entity: Entity }
  /** No such entity, or a claim on an epoch the world has moved past. */
  | { kind: 'stale' };

/**
 * Applies `claim`. A claim names the epoch at which the claimant saw the
 * entity: free, or in the hands it was in. The first claim at the entity's
 * epoch takes it, to the next epoch. A second claim at that same epoch is a
 * contest, resolved by `resolveClaim` against the claim that took it: the
 * winner owns the entity, whichever arrived first, so every client that hears
 * both ends with the same owner. A claim on any earlier epoch is `stale`. The
 * screen shows a `lost` or a claim overturned as `contested`.
 */
export function applyClaim(world: World, claim: Claim): ClaimOutcome {
  const entity = world.entities.get(claim.entity);
  if (entity === undefined) return { kind: 'stale' };
  if (claim.epoch === entity.epoch) {
    const next: Entity = { ...entity, owner: claim.claimant, epoch: entity.epoch + 1 };
    world.entities.set(next.id, next);
    world.claims.set(next.id, claim);
    return { kind: 'won', entity: next };
  }
  const standing = world.claims.get(claim.entity);
  if (standing === undefined || claim.epoch !== standing.epoch || claim.epoch !== entity.epoch - 1) {
    return { kind: 'stale' };
  }
  const winner = resolveClaim(standing, claim);
  if (winner.claimant !== claim.claimant) {
    return { kind: 'lost', entity };
  }
  const next: Entity = { ...entity, owner: claim.claimant };
  world.entities.set(next.id, next);
  world.claims.set(next.id, claim);
  return { kind: 'won', entity: next };
}

/** The owner lets go: the entity stays where it is, owned by nobody (`''`), at the next epoch. False unless `by` owns it. */
export function releaseEntity(world: World, id: string, by: string): boolean {
  const entity = world.entities.get(id);
  if (entity === undefined || entity.owner !== by) return false;
  world.entities.set(id, { ...entity, owner: '', epoch: entity.epoch + 1 });
  world.claims.delete(id);
  return true;
}

/** Moves an entity. Only its owner may, and only to a finite pose. */
export function moveEntity(world: World, id: string, pose: Vec3, by: string): boolean {
  const entity = world.entities.get(id);
  if (entity === undefined || entity.owner !== by) return false;
  if (![pose.x, pose.y, pose.z].every((n) => Number.isFinite(n))) return false;
  world.entities.set(id, { ...entity, pose: { x: pose.x, y: pose.y, z: pose.z } });
  return true;
}

/** The entities in any of `cells`, by id. What a member in those cells should be told about. */
export function entitiesInCells(world: World, cells: readonly number[]): Entity[] {
  const wanted = new Set(cells);
  return [...world.entities.values()]
    .filter((entity) => wanted.has(cellOf(entity.pose)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How many entities of `kind` are in the world: what `setEntityCount` is told. */
export function countEntities(world: World, kind: string): number {
  let count = 0;
  for (const entity of world.entities.values()) {
    if (entity.kind === kind) count += 1;
  }
  return count;
}
