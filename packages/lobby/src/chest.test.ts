import { describe, expect, it } from 'vitest';

import { CHEST_VIDEO, chestPlays, chestVideoProblem } from './chest.js';

const CLIP = { type: 'video/mp4', bytes: 900_000, width: 512, height: 512, duration: 6 };

describe('chestVideoProblem', () => {
  it('takes a short, small MP4 or WebM', () => {
    expect(chestVideoProblem(CLIP)).toBeNull();
    expect(chestVideoProblem({ ...CLIP, type: 'video/webm' })).toBeNull();
    expect(chestVideoProblem({ ...CLIP, duration: CHEST_VIDEO.maxSeconds, width: CHEST_VIDEO.maxPixels })).toBeNull();
  });

  it('refuses anything that is not MP4 or WebM', () => {
    for (const type of ['video/quicktime', 'image/gif', '']) expect(chestVideoProblem({ ...CLIP, type })).toEqual({ reason: 'type' });
  });

  it('says how big, how long or how many pixels, and the most', () => {
    expect(chestVideoProblem({ ...CLIP, bytes: CHEST_VIDEO.maxBytes + 1 })).toEqual({
      reason: 'too_big',
      bytes: CHEST_VIDEO.maxBytes + 1,
      max: CHEST_VIDEO.maxBytes,
    });
    expect(chestVideoProblem({ ...CLIP, duration: 22.5 })).toEqual({ reason: 'too_long', seconds: 22.5, max: CHEST_VIDEO.maxSeconds });
    expect(chestVideoProblem({ ...CLIP, height: 1920 })).toEqual({ reason: 'too_many_pixels', width: 512, height: 1920, max: CHEST_VIDEO.maxPixels });
  });

  it('calls a clip the browser could not size or time unreadable', () => {
    for (const bad of [{ width: 0 }, { height: Number.NaN }, { duration: Number.POSITIVE_INFINITY }, { duration: 0 }]) {
      expect(chestVideoProblem({ ...CLIP, ...bad })).toEqual({ reason: 'unreadable' });
    }
  });
});

describe('chestPlays', () => {
  it('plays near, holds its frame far off or with reduced motion', () => {
    expect(chestPlays({ viewerDistance: 2, reducedMotion: false })).toBe(true);
    expect(chestPlays({ viewerDistance: CHEST_VIDEO.playDistance, reducedMotion: false })).toBe(true);
    expect(chestPlays({ viewerDistance: CHEST_VIDEO.playDistance + 0.1, reducedMotion: false })).toBe(false);
    expect(chestPlays({ viewerDistance: 2, reducedMotion: true })).toBe(false);
    expect(chestPlays({ viewerDistance: Number.NaN, reducedMotion: false })).toBe(false);
  });
});
