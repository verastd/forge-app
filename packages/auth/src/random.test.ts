import { afterEach, describe, expect, it, vi } from 'vitest';

// Through the package entry, as the other workspace packages' tests do: this
// also proves the helper is reachable from `@forge/auth` itself.
import { randomToken } from './index.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Unpadded base64 length of `bytes` bytes: 6 bits per character, rounded up. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 8) / 6);

describe('randomToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to 32 bytes, i.e. 43 characters', () => {
    expect(randomToken()).toHaveLength(43);
  });

  it.each([1, 2, 3, 16, 32, 48, 64, 65_536])(
    'encodes %i bytes to the unpadded base64url length',
    (bytes) => {
      expect(randomToken(bytes)).toHaveLength(encodedLength(bytes));
    },
  );

  it('uses only the URL-safe alphabet, with no padding', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(randomToken()).toMatch(BASE64URL);
    }
  });

  it('encodes exactly the bytes crypto.getRandomValues produced', () => {
    // 0xfb 0xff is "+/8=" in standard base64, so this pins both URL-safe
    // substitutions and the stripped padding.
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).set([0xfb, 0xff]);
      return array;
    });

    expect(randomToken(2)).toBe('-_8');
    expect(spy).toHaveBeenCalledTimes(1);
    const requested = spy.mock.calls[0]?.[0];
    expect(requested).toBeInstanceOf(Uint8Array);
    expect((requested as Uint8Array).length).toBe(2);
  });

  it('does not repeat itself', () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => randomToken()));
    expect(tokens.size).toBe(1_000);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65_537])(
    'rejects %s bytes with a RangeError',
    (bytes) => {
      expect(() => randomToken(bytes)).toThrow(RangeError);
    },
  );
});
