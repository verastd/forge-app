import { describe, expect, it } from 'vitest';

import {
  TICK_SPIKE,
  TICK_WINDOW,
  acceptIntent,
  createBehaviorMeter,
  forgetMember,
  isBudget,
  pauseBehavior,
  recordTick,
  resumeBehavior,
  setEntityCount,
} from './budget.js';
import type { BehaviorBudget } from './budget.js';

const budget: BehaviorBudget = { entities: 2, bytesPerSecond: 1000, msPerTick: 2, intentsPerSecond: 3 };

describe('acceptIntent', () => {
  it('takes up to intentsPerSecond from one member in any one second, and more once the window moves on', () => {
    const meter = createBehaviorMeter(budget);
    expect(acceptIntent(meter, 'gh:1', 10, 0)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:1', 10, 100)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:1', 10, 200)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:1', 10, 300)).toBe('member-rate');
    expect(acceptIntent(meter, 'gh:2', 10, 300)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:1', 10, 1000)).toBe('accepted');
  });

  it('a refused intent counts against nothing', () => {
    const meter = createBehaviorMeter(budget);
    for (let i = 0; i < 10; i += 1) acceptIntent(meter, 'gh:1', 10, i);
    expect(meter.recentByMember.get('gh:1')).toHaveLength(3);
  });

  it('holds the room to bytesPerSecond across members', () => {
    const meter = createBehaviorMeter(budget);
    expect(acceptIntent(meter, 'gh:1', 600, 0)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:2', 500, 10)).toBe('bytes');
    expect(acceptIntent(meter, 'gh:2', 400, 10)).toBe('accepted');
    expect(acceptIntent(meter, 'gh:3', 1, 20)).toBe('bytes');
    expect(acceptIntent(meter, 'gh:3', 1, 1001)).toBe('accepted');
  });

  it('refuses everything while paused, and a time or size that is not a number', () => {
    const meter = createBehaviorMeter(budget);
    expect(acceptIntent(meter, 'gh:1', NaN, 0)).toBe('member-rate');
    expect(acceptIntent(meter, 'gh:1', -1, 0)).toBe('member-rate');
    expect(acceptIntent(meter, 'gh:1', 1, NaN)).toBe('member-rate');
    pauseBehavior(meter, 'operator', 5);
    expect(acceptIntent(meter, 'gh:1', 1, 10)).toBe('paused');
  });

  it('a clock that went backwards starts the windows over', () => {
    const meter = createBehaviorMeter(budget);
    acceptIntent(meter, 'gh:1', 900, 500);
    acceptIntent(meter, 'gh:1', 1, 500);
    acceptIntent(meter, 'gh:1', 1, 500);
    expect(acceptIntent(meter, 'gh:1', 1, 500)).toBe('member-rate');
    expect(acceptIntent(meter, 'gh:1', 900, 100)).toBe('accepted');
  });

  it('forgets a member who left', () => {
    const meter = createBehaviorMeter(budget);
    acceptIntent(meter, 'gh:1', 1, 0);
    forgetMember(meter, 'gh:1');
    expect(meter.recentByMember.has('gh:1')).toBe(false);
  });
});

describe('recordTick', () => {
  it('pauses on one step far over budget', () => {
    const meter = createBehaviorMeter(budget);
    expect(recordTick(meter, budget.msPerTick * TICK_SPIKE, 1)).toBeNull();
    expect(recordTick(meter, budget.msPerTick * TICK_SPIKE + 0.1, 2)).toEqual({ reason: 'tick', at: 2 });
  });

  it('pauses on a run of steps over budget, not on one', () => {
    const meter = createBehaviorMeter(budget);
    for (let i = 1; i < TICK_WINDOW; i += 1) expect(recordTick(meter, budget.msPerTick + 0.5, i)).toBeNull();
    expect(recordTick(meter, 1, TICK_WINDOW)).toBeNull();
    for (let i = 1; i < TICK_WINDOW; i += 1) expect(recordTick(meter, budget.msPerTick + 0.5, 10 + i)).toBeNull();
    expect(recordTick(meter, budget.msPerTick + 0.5, 20)).toEqual({ reason: 'tick', at: 20 });
    expect(meter.ticks).toHaveLength(TICK_WINDOW);
  });

  it('keeps the first pause and its reason, and ignores a time that is not a number', () => {
    const meter = createBehaviorMeter(budget);
    pauseBehavior(meter, 'flag', 3);
    expect(recordTick(meter, 1000, 4)).toEqual({ reason: 'flag', at: 3 });
    expect(pauseBehavior(meter, 'operator', 5)).toEqual({ reason: 'flag', at: 3 });
    const fresh = createBehaviorMeter(budget);
    expect(recordTick(fresh, NaN, 1)).toBeNull();
    expect(recordTick(fresh, -1, 1)).toBeNull();
    expect(fresh.ticks).toEqual([]);
  });
});

describe('setEntityCount', () => {
  it('pauses past the entity budget, and ignores a count that is not one', () => {
    const meter = createBehaviorMeter(budget);
    expect(setEntityCount(meter, 2, 1)).toBeNull();
    expect(setEntityCount(meter, -1, 1)).toBeNull();
    expect(meter.entities).toBe(2);
    expect(setEntityCount(meter, 3, 7)).toEqual({ reason: 'entities', at: 7 });
  });
});

describe('resumeBehavior', () => {
  it('clears the pause and every window', () => {
    const meter = createBehaviorMeter(budget);
    acceptIntent(meter, 'gh:1', 999, 0);
    recordTick(meter, 100, 0);
    expect(meter.paused).not.toBeNull();
    resumeBehavior(meter);
    expect(meter.paused).toBeNull();
    expect(meter.ticks).toEqual([]);
    expect(acceptIntent(meter, 'gh:1', 999, 1)).toBe('accepted');
  });
});

describe('isBudget', () => {
  it('accepts four finite non-negative numbers with at least one intent a second and a whole number of entities', () => {
    expect(isBudget(budget)).toBe(true);
    expect(isBudget({ ...budget, entities: 0, bytesPerSecond: 0, msPerTick: 0, intentsPerSecond: 1 })).toBe(true);
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      {},
      { ...budget, intentsPerSecond: 0 },
      { ...budget, entities: 1.5 },
      { ...budget, bytesPerSecond: -1 },
      { ...budget, msPerTick: Infinity },
      { ...budget, extra: 1 },
      { ...budget, entities: '2' },
    ]) {
      expect(isBudget(value)).toBe(false);
    }
  });
});
