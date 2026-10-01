import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeNext } from './index.js';

type Row = [label: string, input: string | null | undefined, expected: string];

/** `!` to `~` without the backslash: every character a path may hold. */
const PRINTABLE = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i))
  .filter((char) => char !== '\\')
  .join('');

/** A consent URL the way an agent's OAuth client builds one, padded out to 600 characters by its client_id. */
const CONSENT_HEAD =
  '/oauth/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
  '&code_challenge=test-only-challenge&code_challenge_method=S256&state=test-only-state&scope=forge.tasks' +
  '&resource=https%3A%2F%2Fforge.example%2Fmcp&client_id=';
const CONSENT_600 = `${CONSENT_HEAD}${'c'.repeat(600 - CONSENT_HEAD.length)}`;

const ACCEPTED: Row[] = [
  ['the root', '/', '/'],
  ['a page', '/me', '/me'],
  ['a query and a fragment', '/apps/data?x=1#y', '/apps/data?x=1#y'],
  ['encoded slashes, which stay same-origin', '/%2F%2Fevil.com', '/%2F%2Fevil.com'],
  ['dot segments that stay in the site', '/a/../b', '/a/../b'],
  ['an @ in the path', '/@evil.com', '/@evil.com'],
  ['a percent-encoded non-ASCII path', '/caf%C3%A9', '/caf%C3%A9'],
  ['a percent-encoded fullwidth solidus', '/%EF%BC%8Fx', '/%EF%BC%8Fx'],
  ['every printable ASCII character but the backslash', `/${PRINTABLE}`, `/${PRINTABLE}`],
  ['a 600-character connector consent URL', CONSENT_600, CONSENT_600],
  ['exactly 2048 characters', `/${'a'.repeat(2047)}`, `/${'a'.repeat(2047)}`],
];

const REJECTED: Row[] = [
  ['a protocol-relative URL', '//evil.com', '/'],
  ['three slashes', '///evil.com', '/'],
  ['a backslash after the slash', '/\\evil.com', '/'],
  ['a backslash first', '\\/evil.com', '/'],
  ['a backslash anywhere', '/a\\b', '/'],
  ['a tab between the slashes', '/\t/evil.com', '/'],
  ['a newline', '/a\nb', '/'],
  ['a carriage return', '/a\rb', '/'],
  ['NUL', '/ok\u0000', '/'],
  ['DEL', '/ok\u007f', '/'],
  ['a C1 control (NEL)', '/ok\u0085', '/'],
  ['a space', '/a b', '/'],
  ['a leading space', ' /leading-space', '/'],
  ['a no-break space', '/a b', '/'],
  ['a line separator', '/a b', '/'],
  // Non-ASCII would reach a Location header, where Node throws (a 500).
  ['a non-ASCII path', '/café', '/'],
  ['a Latin-1 character', '/\u00ff', '/'],
  ['a fullwidth solidus', '/\uff0fx', '/'],
  ['a fullwidth solidus in the query', '/me?x=\uff0f', '/'],
  ['a non-ASCII fragment', '/me#caf\u00e9', '/'],
  ['a zero-width space', '/\u200bx', '/'],
  ['a byte order mark', '/\ufeffx', '/'],
  ['an astral character', '/\u{1f600}', '/'],
  ['a lone surrogate', '/\ud800', '/'],
  ['an absolute URL', 'https://evil.com', '/'],
  ['a javascript: URL', 'javascript:alert(1)', '/'],
  ['a data: URL', 'data:text/html,hi', '/'],
  ['a relative path', 'me', '/'],
  ['dot segments that normalize to //', '/..//evil.com', '/'],
  ['a dot segment that normalizes to //', '/.//evil.com', '/'],
  ['2049 characters', `/${'a'.repeat(2048)}`, '/'],
  ['an empty string', '', '/'],
  ['null', null, '/'],
  ['undefined', undefined, '/'],
];

describe('safeNext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ACCEPTED)('accepts %s', (_label, input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each(REJECTED)('rejects %s', (_label, input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it('returns every accepted value unchanged, so safeNext(x) === x holds', () => {
    for (const [, input] of ACCEPTED) {
      expect(safeNext(input, '/fallback')).toBe(input);
      expect(safeNext(safeNext(input))).toBe(safeNext(input));
    }
  });

  it('falls back to a safe fallback of the caller’s choosing', () => {
    expect(safeNext('//evil.com', '/me')).toBe('/me');
    expect(safeNext(null, '/apps/data?x=1')).toBe('/apps/data?x=1');
    expect(safeNext('/upland', '/me')).toBe('/upland');
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', '', 'me'])(
    'replaces an unsafe fallback (%j) with /',
    (fallback) => {
      expect(safeNext('https://evil.com', fallback)).toBe('/');
      expect(safeNext(undefined, fallback)).toBe('/');
    },
  );

  it('accepts exactly the printable ASCII characters but the backslash', () => {
    for (let code = 0; code <= 0x2ff; code += 1) {
      const path = `/a${String.fromCharCode(code)}b`;
      const printable = code >= 0x21 && code <= 0x7e && code !== 0x5c;

      expect(safeNext(path), `U+${code.toString(16).padStart(4, '0')}`).toBe(printable ? path : '/');
    }
  });

  it('only ever returns printable ASCII, which any Location header can carry', () => {
    const inputs = [...ACCEPTED, ...REJECTED].map(([, input]) => input);
    for (const input of [...inputs, '/\u0100', '/\uffff', '/\u{10ffff}', '/\u0000\u00ff']) {
      expect(safeNext(input)).toMatch(/^[\x21-\x7e]+$/);
      expect(() => new Headers({ location: safeNext(input) })).not.toThrow();
    }
  });

  it('falls back on a non-string input', () => {
    expect(safeNext(42 as unknown as string)).toBe('/');
    expect(safeNext({ toString: () => '/me' } as unknown as string)).toBe('/');
  });

  it('fails closed if the URL parser throws', () => {
    vi.stubGlobal(
      'URL',
      class {
        constructor() {
          throw new TypeError('Invalid URL');
        }
      },
    );

    expect(safeNext('/me', '/fallback')).toBe('/');
  });
});
