import { base64url, decodeProtectedHeader, EncryptJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  createPkcePair,
  openSession,
  openTransaction,
  randomToken,
  safeNext,
  sealSession,
  sealTransaction,
  TRANSACTION_TTL_SECONDS,
} from './index.js';
import type { TransactionInput } from './index.js';
import { deriveKey } from './session.js';

const NOW = 1_800_000_000;
const SECRET = 'current-session-secret-0123456789abcdef';
const PREVIOUS = 'previous-session-secret-0123456789abcdef';
const UNRELATED = 'unrelated-session-secret-0123456789abcdef';

const TX: TransactionInput = {
  state: 'Xq3vG0b1k9Zr8dT2yWc4nHs6uJm5pLf7aEo-_iRkQzA',
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  next: '/apps/data?x=1#y',
};

/** A valid transaction payload with `overrides` applied (`undefined` drops a claim). */
const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...TX,
  iat: NOW,
  exp: NOW + TRANSACTION_TTL_SECONDS,
  ...overrides,
});

/** Seals `claims` the way the package does, under the key for `info`, without its checks. */
async function forge(
  claims: Record<string, unknown>,
  { secret = SECRET, info = 'forge-oauth-tx-v1' } = {},
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

describe('sealTransaction and openTransaction', () => {
  it('open what they seal, adding iat and a 10-minute exp', async () => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toEqual({
      ...TX,
      iat: NOW,
      exp: NOW + 600,
    });
  });

  it('carry a real sign-in attempt', async () => {
    const { verifier } = await createPkcePair();
    const attempt = { state: randomToken(), verifier, next: safeNext('/me/settings') };
    const token = await sealTransaction(attempt, SECRET, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toMatchObject(attempt);
  });

  it('carry the longest next safeNext accepts, sealed short enough for a browser to keep the cookie', async () => {
    // 2048 characters, the cap (a connector consent URL is about 600). With
    // the cookie's name and attributes, a browser keeps at most about 4 KB.
    const next = `/${'a'.repeat(2047)}`;
    expect(safeNext(next)).toBe(next);
    const largest: TransactionInput[] = [
      { ...TX, next },
      { ...TX, next, purpose: 'agent', taskId: Number.MAX_SAFE_INTEGER, rail: `c${'a'.repeat(31)}` },
    ];

    for (const attempt of largest) {
      const token = await sealTransaction(attempt, SECRET, { now: NOW });

      expect(token.length).toBeLessThan(3800);
      await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toMatchObject(attempt);
    }
  });

  it('seal only the attempt fields, dropping any other key', async () => {
    const token = await sealTransaction({ ...TX, extra: 1 } as TransactionInput, SECRET, { now: NOW });
    const claims = await openTransaction(token, [SECRET], { now: NOW });

    expect(Object.keys(claims ?? {}).sort()).toEqual(['exp', 'iat', 'next', 'state', 'verifier']);
  });

  it('write a dir + A256GCM compact JWE', async () => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });

    expect(token.split('.')).toHaveLength(5);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'dir', enc: 'A256GCM' });
    expect(token).not.toContain(TX.verifier);
  });

  it('open until the last second before exp, and not at exp', async () => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });
    const exp = NOW + TRANSACTION_TTL_SECONDS;

    await expect(openTransaction(token, [SECRET], { now: exp - 1 })).resolves.toMatchObject({ exp });
    await expect(openTransaction(token, [SECRET], { now: exp })).resolves.toBeNull();
  });

  it('tolerate an iat up to 60 seconds ahead, and no further', async () => {
    const skewed = await sealTransaction(TX, SECRET, { now: NOW + 60 });
    const ahead = await sealTransaction(TX, SECRET, { now: NOW + 61 });

    await expect(openTransaction(skewed, [SECRET], { now: NOW })).resolves.toMatchObject(TX);
    await expect(openTransaction(ahead, [SECRET], { now: NOW })).resolves.toBeNull();
  });
});

describe('openTransaction secrets and rotation', () => {
  it('refuses a token sealed with another secret', async () => {
    const token = await sealTransaction(TX, UNRELATED, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('opens a previous-secret token with [current, previous], and not with [current]', async () => {
    const token = await sealTransaction(TX, PREVIOUS, { now: NOW });

    await expect(openTransaction(token, [SECRET, PREVIOUS], { now: NOW })).resolves.toMatchObject(TX);
    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('skips missing and short secrets', async () => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });
    const underShort = await forge(payload(), { secret: 'x'.repeat(31) });

    await expect(openTransaction(token, [undefined, 'x'.repeat(31), SECRET], { now: NOW })).resolves.toMatchObject(TX);
    await expect(openTransaction(underShort, ['x'.repeat(31)], { now: NOW })).resolves.toBeNull();
    await expect(openTransaction(token, [], { now: NOW })).resolves.toBeNull();
  });
});

describe('openTransaction on tampered and malformed tokens', () => {
  it.each([0, 1, 2, 3, 4])('refuses a token with a byte changed in JWE segment %i', async (index) => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });

    await expect(openTransaction(tamper(token, index), [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['garbage', 'not-a-token'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('is null for %s', async (_label, token) => {
    await expect(openTransaction(token as string, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it.each([Number.NaN, 0.5, -1])('is null, not an exception, for an invalid clock (%s)', async (now) => {
    const token = await sealTransaction(TX, SECRET, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now })).resolves.toBeNull();
  });

  it('opens the untouched forged payload, so each refusal below is its own claim', async () => {
    await expect(openTransaction(await forge(payload()), [SECRET], { now: NOW })).resolves.toEqual(payload());
  });

  it.each<[string, Record<string, unknown>]>([
    ['state missing', { state: undefined }],
    ['state 42 characters', { state: 'a'.repeat(42) }],
    ['state 44 characters', { state: 'a'.repeat(44) }],
    ['state in standard base64', { state: `${'a'.repeat(42)}+` }],
    ['state a number', { state: 42 }],
    ['verifier missing', { verifier: undefined }],
    ['verifier 42 characters', { verifier: 'a'.repeat(42) }],
    ['verifier with padding', { verifier: `${'a'.repeat(42)}=` }],
    ['next missing', { next: undefined }],
    ['next empty', { next: '' }],
    ['next protocol-relative', { next: '//evil.com' }],
    ['next absolute', { next: 'https://evil.com' }],
    ['next with a backslash', { next: '/\\evil.com' }],
    ['next with a space', { next: '/a b' }],
    ['next a number', { next: 1 }],
    ['iat missing', { iat: undefined }],
    ['exp missing', { exp: undefined }],
    ['iat fractional', { iat: NOW + 0.5 }],
    ['exp equal to iat', { iat: NOW + 30, exp: NOW + 30 }],
    ['a lifetime over 10 minutes', { exp: NOW + TRANSACTION_TTL_SECONDS + 1 }],
    ['iat beyond the clock skew', { iat: NOW + 61, exp: NOW + 400 }],
    ['an unknown claim', { v: 1 }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(openTransaction(await forge(payload(overrides)), [SECRET], { now: NOW })).resolves.toBeNull();
  });
});

describe('sealTransaction refusals', () => {
  it.each<[string, unknown]>([
    ['a short state', { ...TX, state: 'short' }],
    ['a state with a +', { ...TX, state: `${'a'.repeat(42)}+` }],
    ['a short verifier', { ...TX, verifier: 'a'.repeat(42) }],
    ['a next that is not a path', { ...TX, next: 'https://evil.com' }],
    ['a next that safeNext would change', { ...TX, next: '/a b' }],
    ['a protocol-relative next', { ...TX, next: '//evil.com' }],
    ['a missing next', { state: TX.state, verifier: TX.verifier }],
    ['null', null],
  ])('throws invalid_claims for %s', async (_label, tx) => {
    await expect(sealTransaction(tx as TransactionInput, SECRET, { now: NOW })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'invalid_claims',
    });
  });

  it('throws weak_secret for a secret under 32 characters', async () => {
    await expect(sealTransaction(TX, 'x'.repeat(31), { now: NOW })).rejects.toMatchObject({ code: 'weak_secret' });
  });

  it('throws a RangeError for an invalid clock', async () => {
    await expect(sealTransaction(TX, SECRET, { now: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe('transaction and session tokens', () => {
  it('a session token never opens as a transaction', async () => {
    const session = await sealSession(
      { sub: '583231', login: 'octocat', name: null, avatarUrl: null, demo: false },
      SECRET,
      { now: NOW },
    );

    await expect(openTransaction(session, [SECRET], { now: NOW })).resolves.toBeNull();
  });

  it('a transaction-shaped payload under the session key does not open either: the keys differ', async () => {
    const token = await forge(payload(), { info: 'forge-session-v1' });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toBeNull();
    await expect(openSession(await sealTransaction(TX, SECRET, { now: NOW }), [SECRET], { now: NOW })).resolves.toBeNull();
  });
});

describe('agent attempts (the one-time authorization that starts an agent)', () => {
  const AGENT: TransactionInput = {
    ...TX,
    next: '/contribute/task/7',
    purpose: 'agent',
    taskId: 7,
    rail: 'copilot',
  };
  const AGENT_FIELDS = { purpose: 'agent', taskId: 7, rail: 'copilot' };

  it('open with their purpose, task and rail', async () => {
    const token = await sealTransaction(AGENT, SECRET, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toEqual({
      ...AGENT,
      iat: NOW,
      exp: NOW + TRANSACTION_TTL_SECONDS,
    });
  });

  it('a sign-in attempt still opens with no purpose, task or rail', async () => {
    const claims = await openTransaction(await sealTransaction(TX, SECRET, { now: NOW }), [SECRET], { now: NOW });

    expect(claims).not.toBeNull();
    expect(claims?.purpose).toBeUndefined();
    expect(Object.keys(claims ?? {})).not.toContain('taskId');
    expect(Object.keys(claims ?? {})).not.toContain('rail');
  });

  it('seal only the attempt fields, dropping any other key', async () => {
    const token = await sealTransaction({ ...AGENT, extra: 1 } as TransactionInput, SECRET, { now: NOW });
    const claims = await openTransaction(token, [SECRET], { now: NOW });

    expect(Object.keys(claims ?? {}).sort()).toEqual([
      'exp',
      'iat',
      'next',
      'purpose',
      'rail',
      'state',
      'taskId',
      'verifier',
    ]);
  });

  it('accept a rail id of up to 32 characters', async () => {
    const longest = { ...AGENT, rail: `c${'a'.repeat(31)}` };
    const token = await sealTransaction(longest, SECRET, { now: NOW });

    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toMatchObject({ rail: longest.rail });
  });

  it.each<[string, unknown]>([
    ['a purpose with no task', { ...TX, purpose: 'agent', rail: 'copilot' }],
    ['a purpose with no rail', { ...TX, purpose: 'agent', taskId: 7 }],
    ['a task with no purpose', { ...TX, taskId: 7 }],
    ['a rail with no purpose', { ...TX, rail: 'copilot' }],
    ['a task and rail with no purpose', { ...TX, taskId: 7, rail: 'copilot' }],
    ['an unknown purpose', { ...AGENT, purpose: 'signin' }],
    ['task 0', { ...AGENT, taskId: 0 }],
    ['a negative task', { ...AGENT, taskId: -1 }],
    ['a fractional task', { ...AGENT, taskId: 1.5 }],
    ['a task past the safe integers', { ...AGENT, taskId: 2 ** 53 }],
    ['a task as a string', { ...AGENT, taskId: '7' }],
    ['an uppercase rail', { ...AGENT, rail: 'Copilot' }],
    ['a rail with a slash', { ...AGENT, rail: 'copilot/../x' }],
    ['a rail starting with a digit', { ...AGENT, rail: '1copilot' }],
    ['a rail of 33 characters', { ...AGENT, rail: `c${'a'.repeat(32)}` }],
    ['an empty rail', { ...AGENT, rail: '' }],
    ['an agent attempt with an unsafe next', { ...AGENT, next: '//evil.com' }],
  ])('sealTransaction throws invalid_claims for %s', async (_label, tx) => {
    await expect(sealTransaction(tx as TransactionInput, SECRET, { now: NOW })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'invalid_claims',
    });
  });

  it('opens the untouched forged agent payload, so each refusal below is its own claim', async () => {
    await expect(openTransaction(await forge(payload(AGENT_FIELDS)), [SECRET], { now: NOW })).resolves.toEqual(
      payload(AGENT_FIELDS),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['a purpose with no task or rail', { purpose: 'agent' }],
    ['a task and rail with no purpose', { taskId: 7, rail: 'copilot' }],
    ['an unknown purpose', { ...AGENT_FIELDS, purpose: 'admin' }],
    ['a null purpose', { ...AGENT_FIELDS, purpose: null }],
    ['a task as a string', { ...AGENT_FIELDS, taskId: '7' }],
    ['task 0', { ...AGENT_FIELDS, taskId: 0 }],
    ['a rail with a dot', { ...AGENT_FIELDS, rail: 'co.pilot' }],
    ['a rail as a number', { ...AGENT_FIELDS, rail: 1 }],
  ])('openTransaction refuses a forged payload with %s', async (_label, overrides) => {
    await expect(openTransaction(await forge(payload(overrides)), [SECRET], { now: NOW })).resolves.toBeNull();
  });
});
