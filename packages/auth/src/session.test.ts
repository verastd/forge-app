import { base64url, CompactEncrypt, decodeProtectedHeader, EncryptJWT, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError, openSession, sealSession, sealTransaction, SESSION_TTL_SECONDS } from './index.js';
import type { SessionInput } from './index.js';
import { deriveKey } from './session.js';

const NOW = 1_800_000_000;
const SECRET = 'current-session-secret-0123456789abcdef';
const PREVIOUS = 'previous-session-secret-0123456789abcdef';
const UNRELATED = 'unrelated-session-secret-0123456789abcdef';

const USER: SessionInput = {
  sub: '583231',
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  demo: false,
};
const PRACTICE: SessionInput = { sub: 'demo', login: 'you', name: 'Practice account', avatarUrl: null, demo: true };

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A valid session payload with `overrides` applied (`undefined` drops a claim). */
const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  ...USER,
  iat: NOW,
  exp: NOW + SESSION_TTL_SECONDS,
  ...overrides,
});

/**
 * Seals `claims` exactly as the package does (dir + A256GCM under the HKDF key
 * for `info`) but without its checks, to reach the reader with any payload.
 */
async function forge(
  claims: Record<string, unknown>,
  { secret = SECRET, info = 'forge-session-v1' } = {},
): Promise<string> {
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await deriveKey(secret, info));
}

/** Flips one bit in the middle of JWE segment `index`, or gives an empty segment a byte. */
function tamper(token: string, index: number): string {
  const segments = token.split('.');
  const bytes = base64url.decode(segments[index] ?? '');
  if (bytes.length === 0) {
    segments[index] = base64url.encode(Uint8Array.of(0));
  } else {
    const middle = bytes.length >> 1;
    bytes[middle] = (bytes[middle] ?? 0) ^ 0x01;
    segments[index] = base64url.encode(bytes);
  }
  return segments.join('.');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveKey', () => {
  it('is HKDF-SHA256 with an empty salt (RFC 5869 test case 3, first 32 bytes)', async () => {
    const key = await deriveKey('\x0b'.repeat(22), '');

    expect(hex(key)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d');
  });

  it('derives the known session and transaction keys', async () => {
    // Expected values from an independent HKDF (Python hmac, cross-checked
    // with Node's hkdfSync), which pins both info strings.
    expect(hex(await deriveKey(SECRET, 'forge-session-v1'))).toBe(
      '9755b8fdcf78c922c8ab1f68fe8b019626ff501982846062782592d4427781fc',
    );
    expect(hex(await deriveKey(SECRET, 'forge-oauth-tx-v1'))).toBe(
      'ad7e7f7873d2040535aeb0a2e6ec7c8c13ecce5aebb080647280bf49937c70a1',
    );
  });
});

describe('sealSession and openSession', () => {
  it('open what they seal, adding v, iat and a 7-day exp', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(token, [SECRET], { now: NOW })).resolves.toEqual({
      v: 1,
      ...USER,
      iat: NOW,
      exp: NOW + 604_800,
    });
  });

  it.each([
    ['the practice account', PRACTICE],
    ['a user without a name or avatar', { ...USER, name: null, avatarUrl: null }],
  ])('round-trip %s', async (_label, claims) => {
    const token = await sealSession(claims, SECRET, { now: NOW });

    await expect(openSession(token, [SECRET], { now: NOW })).resolves.toEqual({
      v: 1,
      ...claims,
      iat: NOW,
      exp: NOW + SESSION_TTL_SECONDS,
    });
  });

  it('seal only the identity fields, dropping any other key', async () => {
    const extra = { ...USER, id: 583231, admin: true } as SessionInput;
    const token = await sealSession(extra, SECRET, { now: NOW });
    const claims = await openSession(token, [SECRET], { now: NOW });

    expect(Object.keys(claims ?? {}).sort()).toEqual(
      ['avatarUrl', 'demo', 'exp', 'iat', 'login', 'name', 'sub', 'v'],
    );
  });

  it('write a compact JWE: dir + A256GCM, no encrypted key, a fresh IV each time', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });
    const segments = token.split('.');

    expect(segments).toHaveLength(5);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'dir', enc: 'A256GCM' });
    expect(segments[1]).toBe('');
    expect(base64url.decode(segments[2] ?? '')).toHaveLength(12);
    expect(base64url.decode(segments[4] ?? '')).toHaveLength(16);
    await expect(sealSession(USER, SECRET, { now: NOW })).resolves.not.toBe(token);
  });

  it('keep the claims confidential', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });
    const decoded = token.split('.').map((segment) => new TextDecoder().decode(base64url.decode(segment)));

    for (const text of [token, ...decoded]) {
      expect(text).not.toContain('octocat');
      expect(text).not.toContain('583231');
    }
  });

  it('use the wall clock when no time is given', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 999);
    const token = await sealSession(USER, SECRET);

    await expect(openSession(token, [SECRET])).resolves.toMatchObject({ iat: NOW, exp: NOW + SESSION_TTL_SECONDS });
  });
});

describe('openSession expiry and clock skew', () => {
  it('opens until the last second before exp, and not at exp', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });
    const exp = NOW + SESSION_TTL_SECONDS;

    await expect(openSession(token, [SECRET], { now: exp - 1 })).resolves.toMatchObject({ exp });
    await expect(openSession(token, [SECRET], { now: exp })).resolves.toBeNull();
    await expect(openSession(token, [SECRET], { now: exp + 1 })).resolves.toBeNull();
  });

  it('tolerates an iat up to 60 seconds ahead, and no further', async () => {
    const skewed = await sealSession(USER, SECRET, { now: NOW + 60 });
    const ahead = await sealSession(USER, SECRET, { now: NOW + 61 });

    await expect(openSession(skewed, [SECRET], { now: NOW })).resolves.toMatchObject({ iat: NOW + 60 });
    await expect(openSession(ahead, [SECRET], { now: NOW })).resolves.toBeNull();
  });
});

describe('openSession secrets and rotation', () => {
  it('refuses a token sealed with another secret', async () => {
    const token = await sealSession(USER, UNRELATED, { now: NOW });

    await expect(openSession(token, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('opens a token sealed with the previous secret when given [current, previous]', async () => {
    const token = await sealSession(USER, PREVIOUS, { now: NOW });

    await expect(openSession(token, [SECRET, PREVIOUS], { now: NOW })).resolves.toMatchObject(USER);
  });

  it('refuses that token once the previous secret is retired', async () => {
    const token = await sealSession(USER, PREVIOUS, { now: NOW });

    await expect(openSession(token, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('opens a current-secret token with [current, previous] too', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(token, [SECRET, PREVIOUS], { now: NOW })).resolves.toMatchObject(USER);
  });

  it('skips a secret shorter than 32 characters instead of trying it', async () => {
    const short = 'x'.repeat(31);
    const underShort = await forge(payload(), { secret: short });
    const underCurrent = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(underShort, [short], { now: NOW })).resolves.toBeNull();
    await expect(openSession(underCurrent, [short, SECRET], { now: NOW })).resolves.toMatchObject(USER);
  });

  it('skips missing secrets, as unset environment variables arrive', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(token, [undefined, null, '', SECRET], { now: NOW })).resolves.toMatchObject(USER);
    await expect(openSession(token, [SECRET, undefined], { now: NOW })).resolves.toMatchObject(USER);
  });

  it.each([
    ['no secrets', []],
    ['only missing secrets', [undefined, null]],
    ['only short secrets', ['', 'x'.repeat(31)]],
    ['a bare string instead of a list', SECRET],
    ['no list at all', undefined],
  ])('is null with %s', async (_label, secrets) => {
    const token = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(token, secrets as string[], { now: NOW })).resolves.toBeNull();
  });
});

describe('openSession on tampered and malformed tokens', () => {
  it.each([
    [0, 'the protected header'],
    [1, 'the (empty) encrypted key'],
    [2, 'the IV'],
    [3, 'the ciphertext'],
    [4, 'the tag'],
  ])('refuses a token with a byte changed in segment %i, %s', async (index) => {
    const token = await sealSession(USER, SECRET, { now: NOW });
    const tampered = tamper(token, index);

    expect(tampered).not.toBe(token);
    await expect(openSession(token, [SECRET], { now: NOW })).resolves.not.toBeNull();
    await expect(openSession(tampered, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('refuses a header swapped for other valid JSON: the header is authenticated', async () => {
    const [, ...rest] = (await sealSession(USER, SECRET, { now: NOW })).split('.');
    const header = base64url.encode(JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid: 'x' }));

    await expect(openSession([header, ...rest].join('.'), [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('refuses any algorithm but dir + A256GCM, even under the right key', async () => {
    const key = await deriveKey(SECRET, 'forge-session-v1');
    const wrapped = await new EncryptJWT(payload())
      .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
      .encrypt(key);
    const cbc = await new EncryptJWT(payload())
      .setProtectedHeader({ alg: 'dir', enc: 'A128CBC-HS256' })
      .encrypt(key);
    const signed = await new SignJWT(payload()).setProtectedHeader({ alg: 'HS256' }).sign(key);

    for (const token of [wrapped, cbc, signed]) {
      await expect(openSession(token, [SECRET], { now: NOW })).resolves.toBeNull();
    }
  });

  it('refuses a compressed (zip) token, even under the right key', async () => {
    const key = await deriveKey(SECRET, 'forge-session-v1');
    const zipped = await new EncryptJWT(payload())
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', zip: 'DEF' })
      .encrypt(key);

    // jose alone would inflate and open it; `maxDecompressedLength: 0` refuses it.
    expect(decodeProtectedHeader(zipped)).toMatchObject({ zip: 'DEF' });
    await expect(openSession(await forge(payload()), [SECRET], { now: NOW })).resolves.not.toBeNull();
    await expect(openSession(zipped, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('refuses a payload that is not a JSON object', async () => {
    const key = await deriveKey(SECRET, 'forge-session-v1');
    const seal = (text: string): Promise<string> =>
      new CompactEncrypt(new TextEncoder().encode(text)).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);

    for (const text of ['[1,2]', '"octocat"', 'null', 'not json']) {
      await expect(openSession(await seal(text), [SECRET], { now: NOW })).resolves.toBeNull();
    }
  });

  it.each([
    ['an empty string', ''],
    ['garbage', 'not-a-token'],
    ['five empty segments', '....'],
    ['five junk segments', 'a.b.c.d.e'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ])('is null for %s', async (_label, token) => {
    await expect(openSession(token as string, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('is null for a truncated or extended token', async () => {
    const token = await sealSession(USER, SECRET, { now: NOW });

    await expect(openSession(token.slice(0, -5), [SECRET], { now: NOW })).resolves.toBeNull();
    await expect(openSession(`${token}.x`, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it.each([Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, '1800000000'])(
    'is null, not an exception, for an invalid clock (%s)',
    async (now) => {
      const token = await sealSession(USER, SECRET, { now: NOW });

      await expect(openSession(token, [SECRET], { now: now as number })).resolves.toBeNull();
    },
  );
});

describe('openSession claim validation', () => {
  it('opens the untouched forged payload, so each refusal below is its own claim', async () => {
    await expect(openSession(await forge(payload()), [SECRET], { now: NOW })).resolves.toEqual(payload());
  });

  it.each<[string, Record<string, unknown>]>([
    ['v missing', { v: undefined }],
    ['v 2', { v: 2 }],
    ['v "1"', { v: '1' }],
    ['sub missing', { sub: undefined }],
    ['sub empty', { sub: '' }],
    ['sub 0', { sub: '0' }],
    ['sub with a leading zero', { sub: '0583231' }],
    ['sub negative', { sub: '-1' }],
    ['sub fractional', { sub: '1.5' }],
    ['sub 21 digits', { sub: '1'.repeat(21) }],
    ['sub a number', { sub: 583231 }],
    ['sub a login', { sub: 'octocat' }],
    ['sub "demo" on a non-demo session', { sub: 'demo' }],
    ['login missing', { login: undefined }],
    ['login empty', { login: '' }],
    ['login with a leading hyphen', { login: '-octocat' }],
    ['login 40 characters', { login: 'a'.repeat(40) }],
    ['login with an underscore', { login: 'octo_cat' }],
    ['login with a space', { login: 'octo cat' }],
    ['login a number', { login: 42 }],
    ['name missing', { name: undefined }],
    ['name 257 characters', { name: 'n'.repeat(257) }],
    ['name a number', { name: 7 }],
    ['avatarUrl missing', { avatarUrl: undefined }],
    ['avatarUrl over http', { avatarUrl: 'http://avatars.githubusercontent.com/u/583231' }],
    ['avatarUrl javascript:', { avatarUrl: 'javascript:alert(1)' }],
    ['avatarUrl relative', { avatarUrl: '/avatar.png' }],
    ['avatarUrl not a URL', { avatarUrl: 'not a url' }],
    ['avatarUrl 2049 characters', { avatarUrl: `https://a.example/${'x'.repeat(2049 - 18)}` }],
    ['avatarUrl an object', { avatarUrl: {} }],
    ['demo missing', { demo: undefined }],
    ['demo "false"', { demo: 'false' }],
    ['demo 1', { demo: 1 }],
    ['iat missing', { iat: undefined }],
    ['exp missing', { exp: undefined }],
    ['iat a string', { iat: String(NOW) }],
    ['iat fractional', { iat: NOW + 0.5 }],
    ['exp fractional', { exp: NOW + 100.5 }],
    ['iat negative', { iat: -1 }],
    ['exp equal to iat', { iat: NOW + 30, exp: NOW + 30 }],
    ['exp before iat', { iat: NOW + 30, exp: NOW + 10 }],
    ['a lifetime over 7 days', { exp: NOW + SESSION_TTL_SECONDS + 1 }],
    ['iat beyond the clock skew', { iat: NOW + 61, exp: NOW + 3600 }],
    ['an unknown claim', { admin: true }],
    ['a registered claim it never sets', { nbf: NOW }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(openSession(await forge(payload(overrides)), [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a 20-digit sub', { sub: '9'.repeat(20) }],
    ['a one-character login', { login: 'a' }],
    ['a 39-character login', { login: 'a'.repeat(39) }],
    ['hyphens inside and at the end of a login', { login: 'octo--cat-' }],
    ['an empty name', { name: '' }],
    ['a 256-character name', { name: 'n'.repeat(256) }],
    ['a 2048-character avatar URL', { avatarUrl: `https://a.example/${'x'.repeat(2048 - 18)}` }],
    ['a numeric sub on a demo session', { sub: '1', demo: true }],
    ['iat exactly at the clock skew', { iat: NOW + 60, exp: NOW + 3600 }],
    ['a one-second lifetime', { exp: NOW + 1 }],
  ])('accepts %s', async (_label, overrides) => {
    await expect(openSession(await forge(payload(overrides)), [SECRET], { now: NOW })).resolves.toEqual(
      payload(overrides),
    );
  });
});

describe('sealSession refusals', () => {
  it.each([
    ['an empty secret', ''],
    ['a 31-character secret', 'x'.repeat(31)],
    ['no secret', undefined],
    ['a non-string with a length', { length: 64 }],
  ])('throws weak_secret for %s', async (_label, secret) => {
    await expect(sealSession(USER, secret as string, { now: NOW })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'weak_secret',
    });
  });

  it('accepts a secret of exactly 32 characters', async () => {
    const secret = 's'.repeat(32);
    const token = await sealSession(USER, secret, { now: NOW });

    await expect(openSession(token, [secret], { now: NOW })).resolves.toMatchObject(USER);
  });

  it.each<[string, unknown]>([
    ['sub "demo" without demo: true', { ...USER, sub: 'demo' }],
    ['a non-numeric sub', { ...USER, sub: 'octocat' }],
    ['an invalid login', { ...USER, login: '-octocat' }],
    ['a name over 256 characters', { ...USER, name: 'n'.repeat(257) }],
    ['an http avatar', { ...USER, avatarUrl: 'http://avatars.githubusercontent.com/u/1' }],
    ['a non-boolean demo', { ...USER, demo: 'false' }],
    ['null', null],
    ['a string', 'octocat'],
  ])('throws invalid_claims for %s', async (_label, claims) => {
    const attempt = sealSession(claims as SessionInput, SECRET, { now: NOW });

    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toMatchObject({ code: 'invalid_claims' });
  });

  it.each([1.5, -1, Number.NaN])('throws a RangeError for an invalid clock (%s)', async (now) => {
    await expect(sealSession(USER, SECRET, { now })).rejects.toThrow(RangeError);
  });
});

describe('session and transaction tokens', () => {
  it('a transaction token never opens as a session', async () => {
    const tx = await sealTransaction(
      { state: 'S'.repeat(43), verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', next: '/me' },
      SECRET,
      { now: NOW },
    );

    await expect(openSession(tx, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('a session-shaped payload under the transaction key does not open either: the keys differ', async () => {
    const token = await forge(payload(), { info: 'forge-oauth-tx-v1' });

    await expect(openSession(token, [SECRET], { now: NOW })).resolves.toBeNull();
  });
});
