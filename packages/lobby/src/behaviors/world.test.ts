import { describe, expect, it } from 'vitest';

import { cellOf, neighbours } from './entity.js';
import type { Claim, Entity } from './entity.js';
import {
  applyClaim,
  countEntities,
  createWorld,
  entitiesInCells,
  moveEntity,
  releaseEntity,
  removeEntity,
  upsertEntity,
} from './world.js';

function ball(changes: Partial<Entity> = {}): Entity {
  return {
    id: 'ball:1',
    kind: 'ball',
    owner: '',
    authority: 'owner',
    epoch: 0,
    pose: { x: 1, y: 0.1, z: -2 },
    persistent: false,
    ...changes,
  };
}

const claim = (claimant: string, epoch: number, entity = 'ball:1'): Claim => ({ entity, claimant, epoch });

describe('entities', () => {
  it('stores a copy of a well-formed entity and refuses anything else', () => {
    const world = createWorld();
    const original = ball();
    expect(upsertEntity(world, original)).toBe(true);
    original.pose.x = 99;
    expect(world.entities.get('ball:1')?.pose.x).toBe(1);
    expect(upsertEntity(world, { ...ball(), epoch: -1 })).toBe(false);
    expect(world.entities.size).toBe(1);
  });

  it('removes, and counts by kind', () => {
    const world = createWorld();
    upsertEntity(world, ball());
    upsertEntity(world, ball({ id: 'ball:2' }));
    upsertEntity(world, ball({ id: 'crate:1', kind: 'crate' }));
    expect(countEntities(world, 'ball')).toBe(2);
    expect(countEntities(world, 'crate')).toBe(1);
    expect(removeEntity(world, 'ball:2')).toBe(true);
    expect(removeEntity(world, 'ball:2')).toBe(false);
    expect(countEntities(world, 'ball')).toBe(1);
  });
});

describe('applyClaim', () => {
  it('the first claim at the entity’s epoch takes it, to the next epoch', () => {
    const world = createWorld();
    upsertEntity(world, ball());
    const outcome = applyClaim(world, claim('gh:2', 0));
    expect(outcome).toEqual({ kind: 'won', entity: ball({ owner: 'gh:2', epoch: 1 }) });
  });

  it('two claims at the same epoch end with the same owner whichever is heard first', () => {
    const a = claim('gh:1', 0);
    const b = claim('gh:2', 0);
    const first = createWorld();
    upsertEntity(first, ball());
    expect(applyClaim(first, a).kind).toBe('won');
    expect(applyClaim(first, b)).toEqual({ kind: 'lost', entity: ball({ owner: 'gh:1', epoch: 1 }) });

    const second = createWorld();
    upsertEntity(second, ball());
    expect(applyClaim(second, b).kind).toBe('won');
    expect(applyClaim(second, a)).toEqual({ kind: 'won', entity: ball({ owner: 'gh:1', epoch: 1 }) });

    expect(first.entities.get('ball:1')).toEqual(second.entities.get('ball:1'));
  });

  it('a claim on an entity that does not exist, or on an epoch the world has moved past, is stale', () => {
    const world = createWorld();
    expect(applyClaim(world, claim('gh:1', 0))).toEqual({ kind: 'stale' });
    upsertEntity(world, ball({ epoch: 3 }));
    expect(applyClaim(world, claim('gh:1', 1))).toEqual({ kind: 'stale' });
    expect(applyClaim(world, claim('gh:1', 4))).toEqual({ kind: 'stale' });
    expect(applyClaim(world, claim('gh:1', 3)).kind).toBe('won');
    // The epoch before the current one, but with the owner set by an upsert rather than a claim: no contest to resolve.
    const fresh = createWorld();
    upsertEntity(fresh, ball({ owner: 'gh:9', epoch: 1 }));
    expect(applyClaim(fresh, claim('gh:1', 0))).toEqual({ kind: 'stale' });
  });

  it('the same claimant claiming again at the old epoch keeps what they have', () => {
    const world = createWorld();
    upsertEntity(world, ball());
    applyClaim(world, claim('gh:1', 0));
    expect(applyClaim(world, claim('gh:1', 0))).toEqual({ kind: 'won', entity: ball({ owner: 'gh:1', epoch: 1 }) });
  });

  it('a release moves the epoch on, so an old claim is stale and a new one takes it', () => {
    const world = createWorld();
    upsertEntity(world, ball());
    applyClaim(world, claim('gh:1', 0));
    expect(releaseEntity(world, 'ball:1', 'gh:2')).toBe(false);
    expect(releaseEntity(world, 'ball:1', 'gh:1')).toBe(true);
    expect(world.entities.get('ball:1')).toEqual(ball({ owner: '', epoch: 2 }));
    expect(applyClaim(world, claim('gh:2', 1))).toEqual({ kind: 'stale' });
    expect(applyClaim(world, claim('gh:2', 2)).kind).toBe('won');
    expect(releaseEntity(world, 'ball:9', 'gh:2')).toBe(false);
  });
});

describe('moveEntity', () => {
  it('only the owner moves it, and only somewhere finite', () => {
    const world = createWorld();
    upsertEntity(world, ball({ owner: 'gh:1' }));
    expect(moveEntity(world, 'ball:1', { x: 2, y: 2, z: 2 }, 'gh:2')).toBe(false);
    expect(moveEntity(world, 'ball:1', { x: 2, y: NaN, z: 2 }, 'gh:1')).toBe(false);
    expect(moveEntity(world, 'ball:9', { x: 2, y: 2, z: 2 }, 'gh:1')).toBe(false);
    expect(moveEntity(world, 'ball:1', { x: 2, y: 2, z: 2 }, 'gh:1')).toBe(true);
    expect(world.entities.get('ball:1')?.pose).toEqual({ x: 2, y: 2, z: 2 });
  });
});

describe('entitiesInCells', () => {
  it('lists the entities in the given cells, by id', () => {
    const world = createWorld();
    const here = ball({ id: 'ball:b', pose: { x: 1, y: 1, z: -1 } });
    const also = ball({ id: 'ball:a', pose: { x: 1.1, y: 1, z: -1.1 } });
    const far = ball({ id: 'ball:c', pose: { x: -20, y: 200, z: 20 } });
    for (const entity of [here, also, far]) upsertEntity(world, entity);
    const cell = cellOf(here.pose);
    expect(entitiesInCells(world, [cell]).map((e) => e.id)).toEqual(['ball:a', 'ball:b']);
    expect(entitiesInCells(world, [cell, ...neighbours(cell)]).map((e) => e.id)).not.toContain('ball:c');
    expect(entitiesInCells(world, [])).toEqual([]);
  });
});
