import { describe, expect, it } from 'vitest';

import {
  acceptSession,
  DEV_SESSION_SECRET,
  resolveSessionKeys,
  sealSession,
  SESSION_TTL_SECONDS,
  sessionAllowed,
} from './index.js';
import type { SessionInput, SessionKeys } from './index.js';

const NOW = 1_800_000_000;
const SECRET = 'current-session-secret-0123456789abcdef';
const PREVIOUS = 'previous-session-secret-0123456789abcdef';

const USER: SessionInput = { sub: '583231', login: 'octocat', name: null, avatarUrl: null, demo: false };
const PRACTICE: SessionInput = { sub: 'demo', login: 'you', name: 'Practice account', avatarUrl: null, demo: true };

const PRACTICE_KEYS: SessionKeys = { seal: DEV_SESSION_SECRET, open: [DEV_SESSION_SECRET], practiceOnly: true };
const REAL_KEYS: SessionKeys = { seal: SECRET, open: [SECRET], practiceOnly: false };

describe('DEV_SESSION_SECRET', () => {
  it('is long enough to seal with, and says what it is', () => {
    expect(DEV_SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(DEV_SESSION_SECRET).toMatch(/^dev-only-insecure-/);
  });
});

describe('resolveSessionKeys', () => {
  it.each([undefined, ''])('falls back to the public dev secret when unset (%j), under next dev only', (secret) => {
    expect(resolveSessionKeys({ secret, previous: undefined, development: true })).toEqual(PRACTICE_KEYS);
    expect(resolveSessionKeys({ secret, previous: undefined, development: false })).toBe('unset');
  });

  it('ignores a leftover previous secret when the current one is unset', () => {
    expect(resolveSessionKeys({ secret: undefined, previous: PREVIOUS, development: true })).toEqual(PRACTICE_KEYS);
    expect(resolveSessionKeys({ secret: undefined, previous: PREVIOUS, development: false })).toBe('unset');
  });

  it.each([' ', 'short', 'x'.repeat(31)])('has no keys for a set but short secret (%j), even under next dev', (secret) => {
    expect(resolveSessionKeys({ secret, previous: PREVIOUS, development: true })).toBe('too_short');
    expect(resolveSessionKeys({ secret, previous: PREVIOUS, development: false })).toBe('too_short');
  });

  it.each([true, false])('seals and opens with a usable secret (development: %s)', (development) => {
    expect(resolveSessionKeys({ secret: SECRET, previous: undefined, development })).toEqual(REAL_KEYS);
  });

  it('accepts a secret of exactly 32 characters', () => {
    const secret = 's'.repeat(32);

    expect(resolveSessionKeys({ secret, previous: undefined, development: false })).toEqual({
      seal: secret,
      open: [secret],
      practiceOnly: false,
    });
  });

  it('opens with the previous secret too while rotating, sealing with the current one', () => {
    expect(resolveSessionKeys({ secret: SECRET, previous: PREVIOUS, development: false })).toEqual({
      seal: SECRET,
      open: [SECRET, PREVIOUS],
      practiceOnly: false,
    });
  });

  it.each([undefined, '', 'x'.repeat(31)])('skips a missing or short previous secret (%j)', (previous) => {
    expect(resolveSessionKeys({ secret: SECRET, previous, development: false })).toEqual(REAL_KEYS);
  });

  it('never opens real sessions with the public dev secret as the previous one', () => {
    expect(resolveSessionKeys({ secret: SECRET, previous: DEV_SESSION_SECRET, development: true })).toEqual(REAL_KEYS);
  });

  it.each([true, false])('treats the dev secret set on purpose as practice-only keys (development: %s)', (development) => {
    expect(resolveSessionKeys({ secret: DEV_SESSION_SECRET, previous: PREVIOUS, development })).toEqual(PRACTICE_KEYS);
  });
});

describe('sessionAllowed', () => {
  it.each<[string, boolean, SessionKeys, boolean, boolean]>([
    ['a real session, real keys, live build', false, REAL_KEYS, false, true],
    ['a real session, real keys, demo build', false, REAL_KEYS, true, true],
    ['a real session, practice-only keys, live build', false, PRACTICE_KEYS, false, false],
    ['a real session, practice-only keys, demo build', false, PRACTICE_KEYS, true, false],
    ['a practice session, real keys, live build', true, REAL_KEYS, false, false],
    ['a practice session, real keys, demo build', true, REAL_KEYS, true, true],
    ['a practice session, practice-only keys, live build', true, PRACTICE_KEYS, false, false],
    ['a practice session, practice-only keys, demo build', true, PRACTICE_KEYS, true, true],
  ])('%s: %s', (_label, demo, keys, demoBuild, allowed) => {
    expect(sessionAllowed({ demo }, keys, { demoBuild })).toBe(allowed);
  });
});

describe('acceptSession', () => {
  const seal = (claims: SessionInput, secret: string): Promise<string> => sealSession(claims, secret, { now: NOW });

  it.each([true, false])('accepts a real session under real keys (demo build: %s)', async (demoBuild) => {
    const token = await seal(USER, SECRET);

    await expect(acceptSession(token, REAL_KEYS, { demoBuild, now: NOW })).resolves.toMatchObject(USER);
  });

  it('refuses a real identity sealed under the public dev secret, whoever it claims to be', async () => {
    const forged = await seal(USER, DEV_SESSION_SECRET);

    for (const demoBuild of [true, false]) {
      await expect(acceptSession(forged, PRACTICE_KEYS, { demoBuild, now: NOW })).resolves.toBeNull();
      await expect(acceptSession(forged, REAL_KEYS, { demoBuild, now: NOW })).resolves.toBeNull();
    }
  });

  it('accepts the practice account under the dev secret in a demo build only', async () => {
    const token = await seal(PRACTICE, DEV_SESSION_SECRET);

    await expect(acceptSession(token, PRACTICE_KEYS, { demoBuild: true, now: NOW })).resolves.toMatchObject(PRACTICE);
    await expect(acceptSession(token, PRACTICE_KEYS, { demoBuild: false, now: NOW })).resolves.toBeNull();
  });

  it('refuses a practice session in a live build, even under real keys', async () => {
    const token = await seal(PRACTICE, SECRET);

    await expect(acceptSession(token, REAL_KEYS, { demoBuild: true, now: NOW })).resolves.toMatchObject(PRACTICE);
    await expect(acceptSession(token, REAL_KEYS, { demoBuild: false, now: NOW })).resolves.toBeNull();
  });

  it('opens with every key it is given, in order', async () => {
    const token = await seal(USER, PREVIOUS);
    const rotating: SessionKeys = { seal: SECRET, open: [SECRET, PREVIOUS], practiceOnly: false };

    await expect(acceptSession(token, rotating, { demoBuild: false, now: NOW })).resolves.toMatchObject(USER);
    await expect(acceptSession(token, REAL_KEYS, { demoBuild: false, now: NOW })).resolves.toBeNull();
  });

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['garbage', 'not-a-token'],
  ])('is null for %s', async (_label, token) => {
    await expect(acceptSession(token, REAL_KEYS, { demoBuild: true, now: NOW })).resolves.toBeNull();
  });

  it('honours the clock it is given', async () => {
    const token = await seal(USER, SECRET);

    await expect(
      acceptSession(token, REAL_KEYS, { demoBuild: false, now: NOW + SESSION_TTL_SECONDS }),
    ).resolves.toBeNull();
  });
});
