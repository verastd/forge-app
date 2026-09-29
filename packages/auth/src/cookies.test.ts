import { describe, expect, it } from 'vitest';

import { COOKIE, cookieOptions, SESSION_TTL_SECONDS, TRANSACTION_TTL_SECONDS } from './index.js';

describe('lifetimes', () => {
  it('are 7 days for a session and 10 minutes for a sign-in attempt', () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(TRANSACTION_TTL_SECONDS).toBe(10 * 60);
  });
});

describe('COOKIE', () => {
  it('prefixes the session cookie with __Host- in production only', () => {
    expect(COOKIE.session(true)).toBe('__Host-forge_session');
    expect(COOKIE.session(false)).toBe('forge_session');
  });

  it('prefixes the transaction cookie with __Host- in production only', () => {
    expect(COOKIE.transaction(true)).toBe('__Host-forge_oauth');
    expect(COOKIE.transaction(false)).toBe('forge_oauth');
  });
});

describe('cookieOptions', () => {
  it.each([true, false])('scopes the session cookie to the whole site for 7 days (prod: %s)', (prod) => {
    expect(cookieOptions('session', prod)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: prod,
      maxAge: 604_800,
    });
  });

  it.each([true, false])('scopes the transaction cookie to the whole site for 10 minutes (prod: %s)', (prod) => {
    expect(cookieOptions('transaction', prod)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: prod,
      maxAge: 600,
    });
  });

  it.each(['session', 'transaction'] as const)('meets the __Host- rules in production: Secure, Path=/, no Domain (%s)', (kind) => {
    const options = cookieOptions(kind, true);

    expect(COOKIE[kind](true).startsWith('__Host-')).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.path).toBe('/');
    expect(options).not.toHaveProperty('domain');
  });

  it('keeps each cookie as long as the token inside it', () => {
    expect(cookieOptions('session', true).maxAge).toBe(SESSION_TTL_SECONDS);
    expect(cookieOptions('transaction', true).maxAge).toBe(TRANSACTION_TTL_SECONDS);
  });

  it('returns a fresh object each call, so a caller can override it', () => {
    const cleared = { ...cookieOptions('session', true), maxAge: 0 };
    const mutated = cookieOptions('transaction', true);
    mutated.maxAge = 0;

    expect(cleared.maxAge).toBe(0);
    expect(cookieOptions('session', true).maxAge).toBe(SESSION_TTL_SECONDS);
    expect(cookieOptions('transaction', true).maxAge).toBe(TRANSACTION_TTL_SECONDS);
  });
});
