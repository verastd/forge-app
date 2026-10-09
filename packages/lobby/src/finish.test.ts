import { describe, expect, it } from 'vitest';

import { AVATAR_FINISHES, finishLook } from './avatar.js';

describe('finishLook', () => {
  it('knows paint, chrome and ice, and nothing else', () => {
    expect([...AVATAR_FINISHES]).toEqual(['paint', 'chrome', 'ice']);
  });

  it('is today’s painted look for paint, for none, and for a finish this client doesn’t know', () => {
    const paint = finishLook('paint');
    expect(paint.alpha).toEqual([1, 1, 1]);
    expect(paint.transparent).toBe(false);
    expect(paint.lift).toBe(0);
    expect(paint.env).toBe(0.55);
    expect(finishLook(undefined)).toBe(paint);
    expect(finishLook(null)).toBe(paint);
    expect(finishLook('gold' as never)).toBe(paint);
  });

  it('makes chrome all metal, mirror-smooth and bright, and solid', () => {
    const chrome = finishLook('chrome');
    expect(chrome.metalness).toEqual([1, 1, 1]);
    expect(Math.max(...chrome.roughness)).toBeLessThan(0.25);
    expect(chrome.env).toBeGreaterThan(finishLook('paint').env);
    expect(chrome.transparent).toBe(false);
    expect(chrome.alpha).toEqual([1, 1, 1]);
  });

  it('makes ice see-through (the armour most, the joints least), glossy and rimmed with light', () => {
    const ice = finishLook('ice');
    expect(ice.transparent).toBe(true);
    const [shell, trim, joint] = ice.alpha;
    expect(shell).toBeLessThan(trim);
    expect(trim).toBeLessThan(joint);
    expect(joint).toBeLessThan(1);
    expect(ice.metalness[0]).toBe(0);
    expect(ice.rim).toBeGreaterThan(0);
  });
});
