import { describe, expect, it } from 'vitest';

import { constantTimeEqual, randomToken } from './index.js';

describe('constantTimeEqual', () => {
  it('is true for equal strings', () => {
    const state = randomToken();

    expect(constantTimeEqual(state, state.slice())).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('héllo wörld 😀', 'héllo wörld 😀')).toBe(true);
  });

  it.each([
    ['first', 'Xbcdef'],
    ['middle', 'abcXef'],
    ['last', 'abcdeX'],
  ])('is false when same-length strings differ in the %s byte', (_where, other) => {
    expect(constantTimeEqual('abcdef', other)).toBe(false);
    expect(constantTimeEqual(other, 'abcdef')).toBe(false);
  });

  it('is false for two different random states', () => {
    expect(constantTimeEqual(randomToken(), randomToken())).toBe(false);
  });

  it('is false on a length mismatch, a prefix included', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('compares UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is one UTF-16 unit but two UTF-8 bytes, as long as 'ab' in bytes.
    expect(constantTimeEqual('é', 'ab')).toBe(false);
    // Precomposed and decomposed é render alike, but they are different strings.
    expect(constantTimeEqual('é', 'é')).toBe(false);
  });

  it('never matches an ill-formed string, which TextEncoder would collapse to U+FFFD', () => {
    const encoder = new TextEncoder();
    // The hazard: two different lone surrogates encode to the same bytes.
    expect(encoder.encode('\uD800')).toEqual(encoder.encode('\uDC00'));

    expect(constantTimeEqual('\uD800', '\uDC00')).toBe(false);
    expect(constantTimeEqual('�', '\uD800')).toBe(false);
    expect(constantTimeEqual('a\uDC00', 'a�')).toBe(false);
    // Fails closed even against itself.
    expect(constantTimeEqual('\uD800', '\uD800')).toBe(false);
  });

  it('is false for a non-string instead of coercing it', () => {
    expect(constantTimeEqual(null as unknown as string, 'null')).toBe(false);
    expect(constantTimeEqual('undefined', undefined as unknown as string)).toBe(false);
    expect(constantTimeEqual(1 as unknown as string, '1')).toBe(false);
  });
});
