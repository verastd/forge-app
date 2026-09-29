import { decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mintApiAssertion, openSession, sealSession } from './index.js';

const NOW = 1_800_000_000;
// Built at runtime and low-entropy on purpose: a key-shaped test literal trips the Gauntlet's secret scan.
const SECRET = 'x'.repeat(40);
const IDENTITY = { sub: '583231', login: 'octocat' };

const encoder = new TextEncoder();

/** Verifies as the API does: HS256 only, the agreed issuer and audience. */
const verify = (token: string, { secret = SECRET, now = NOW } = {}) =>
  jwtVerify(token, encoder.encode(secret), {
    algorithms: ['HS256'],
    issuer: 'forge-web',
    audience: 'forge-api',
    requiredClaims: ['sub', 'iat', 'exp'],
    currentDate: new Date(now * 1000),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mintApiAssertion', () => {
  it('mints an HS256 JWT the API can verify, with exactly the agreed header and claims', async () => {
    const token = await mintApiAssertion(IDENTITY, SECRET, { now: NOW });
    const { payload, protectedHeader } = await verify(token);

    expect(token.split('.')).toHaveLength(3);
    expect(protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toEqual({
      iss: 'forge-web',
      aud: 'forge-api',
      sub: '583231',
      login: 'octocat',
      iat: NOW,
      exp: NOW + 60,
    });
  });

  it('takes a whole session as the identity and carries only sub and login', async () => {
    const sessionSecret = 'current-session-secret-0123456789abcdef';
    const session = await openSession(
      await sealSession({ ...IDENTITY, name: 'The Octocat', avatarUrl: null, demo: false }, sessionSecret, { now: NOW }),
      [sessionSecret],
      { now: NOW },
    );
    const token = await mintApiAssertion(session!, SECRET, { now: NOW });
    const { payload } = await verify(token);

    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'login', 'sub']);
  });

  it.each([1, 60, 119, 120])('lives for ttlSeconds (%i)', async (ttlSeconds) => {
    const { payload } = await verify(await mintApiAssertion(IDENTITY, SECRET, { now: NOW, ttlSeconds }));

    expect(payload.exp! - payload.iat!).toBe(ttlSeconds);
  });

  it('expires: verification fails from exp on', async () => {
    const token = await mintApiAssertion(IDENTITY, SECRET, { now: NOW });

    await expect(verify(token, { now: NOW + 59 })).resolves.toBeTruthy();
    await expect(verify(token, { now: NOW + 60 })).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it('uses the wall clock when no time is given', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 999);
    const { payload } = await verify(await mintApiAssertion(IDENTITY, SECRET));

    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 60);
  });

  it('signs with the UTF-8 bytes of the secret', async () => {
    const unicode = 'ключ-для-проверки-подписи-012345';
    expect(unicode.length).toBe(32);
    const token = await mintApiAssertion(IDENTITY, unicode, { now: NOW });

    await expect(verify(token, { secret: unicode })).resolves.toBeTruthy();
    await expect(verify(token, { secret: 'another-secret-of-enough-length-0123' })).rejects.toBeInstanceOf(
      errors.JWSSignatureVerificationFailed,
    );
  });

  it.each([0, 121, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '60'])(
    'throws a RangeError for ttlSeconds %s',
    async (ttlSeconds) => {
      await expect(
        mintApiAssertion(IDENTITY, SECRET, { now: NOW, ttlSeconds: ttlSeconds as number }),
      ).rejects.toThrow(RangeError);
    },
  );

  it.each([
    ['empty', ''],
    ['31 characters', 'x'.repeat(31)],
    ['missing', undefined],
  ])('throws weak_secret for a secret that is %s', async (_label, secret) => {
    await expect(mintApiAssertion(IDENTITY, secret as string, { now: NOW })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'weak_secret',
    });
  });

  it('accepts a secret of exactly 32 characters', async () => {
    const secret = 's'.repeat(32);

    await expect(verify(await mintApiAssertion(IDENTITY, secret, { now: NOW }), { secret })).resolves.toBeTruthy();
  });

  it.each<[string, unknown]>([
    ['the practice account', 'demo'],
    ['0', '0'],
    ['a leading zero', '0583231'],
    ['a negative id', '-1'],
    ['21 digits', '1'.repeat(21)],
    ['an empty sub', ''],
    ['a numeric sub', 583231],
    ['no sub', undefined],
  ])('throws invalid_identity for %s as sub', async (_label, sub) => {
    await expect(
      mintApiAssertion({ sub: sub as string, login: 'octocat' }, SECRET, { now: NOW }),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'invalid_identity' });
  });

  it('accepts a 20-digit sub', async () => {
    const sub = '9'.repeat(20);
    const { payload } = await verify(await mintApiAssertion({ sub, login: 'octocat' }, SECRET, { now: NOW }));

    expect(payload.sub).toBe(sub);
  });

  it.each<[string, unknown]>([
    ['an empty login', ''],
    ['a leading hyphen', '-octocat'],
    ['40 characters', 'a'.repeat(40)],
    ['an underscore', 'octo_cat'],
    ['a space', 'octo cat'],
    ['no login', undefined],
  ])('throws invalid_identity for a login with %s', async (_label, login) => {
    await expect(
      mintApiAssertion({ sub: '583231', login: login as string }, SECRET, { now: NOW }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
  });

  it('throws a RangeError for an invalid clock', async () => {
    await expect(mintApiAssertion(IDENTITY, SECRET, { now: 1.5 })).rejects.toThrow(RangeError);
  });
});
