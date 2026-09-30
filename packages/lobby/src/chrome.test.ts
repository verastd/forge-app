import { describe, expect, it } from 'vitest';

import { chromeModeFor } from './chrome.js';

describe('chromeModeFor', () => {
  it("is 'lobby' for exactly /apps and /apps/", () => {
    expect(chromeModeFor('/apps')).toBe('lobby');
    expect(chromeModeFor('/apps/')).toBe('lobby');
  });

  it("is 'app' for anything under /apps/<slug>", () => {
    expect(chromeModeFor('/apps/data')).toBe('app');
    expect(chromeModeFor('/apps/data/')).toBe('app');
    expect(chromeModeFor('/apps/data/sales')).toBe('app');
    expect(chromeModeFor('/apps/nope')).toBe('app');
    expect(chromeModeFor('/apps//')).toBe('app');
  });

  it("is 'site' for everything else, including look-alikes", () => {
    for (const path of ['/', '', '/contribute', '/propose', '/me', '/me/settings', '/signin', '/appsx', '/apps-data', '/Apps', '/x/apps', 'apps']) {
      expect(chromeModeFor(path)).toBe('site');
    }
  });

  it('strips the query and hash first, so a full href gets the same answer', () => {
    expect(chromeModeFor('/apps?from=data')).toBe('lobby');
    expect(chromeModeFor('/apps/?from=data')).toBe('lobby');
    expect(chromeModeFor('/apps#wall')).toBe('lobby');
    expect(chromeModeFor('/apps/data?tab=sales')).toBe('app');
    expect(chromeModeFor('/apps/data#top')).toBe('app');
    expect(chromeModeFor('/me?next=/apps/data')).toBe('site');
    expect(chromeModeFor('/?x=/apps')).toBe('site');
    expect(chromeModeFor('?/apps/data')).toBe('site');
    expect(chromeModeFor('#/apps')).toBe('site');
  });
});
