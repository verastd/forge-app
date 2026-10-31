import { describe, expect, it } from 'vitest';

import {
  AuthError,
  exchangeGoogleCode,
  fetchGoogleUser,
  googleAuthorizeUrl,
  googleHandle,
  isGitHubSession,
  isGoogleLogin,
  isGoogleSub,
  memberId,
  mintApiAssertion,
  openSession,
  openTransaction,
  sealSession,
  sealTransaction,
} from './index.js';
import type { FetchLike } from './index.js';

const NOW = 1_800_000_000;
const SECRET = 'current-session-secret-0123456789abcdef';
const STATE = 'Xq3vG0b1k9Zr8dT2yWc4nHs6uJm5pLf7aEo-_iRkQzA';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const EXCHANGE = {
  clientId: '123-forge.apps.googleusercontent.com',
  clientSecret: 'google-secret-must-never-leak-0001',
  code: 'google-code-must-never-leak-0002',
  redirectUri: 'https://forge.example/auth/google/callback',
  codeVerifier: VERIFIER,
};
const TOKEN = 'google-access-token-must-never-leak-0003';
const JANE = {
  sub: '109876543210987654321',
  name: 'Jane Doe',
  email: 'jane.doe@gmail.com',
  email_verified: true,
  picture: 'https://lh3.googleusercontent.com/a/jane',
};
const MEMBER = { sub: 'google:109876543210987654321', login: 'g.jane-doe', name: 'Jane Doe', avatarUrl: null, demo: false };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected a rejection');
}

describe('googleAuthorizeUrl', () => {
  it('asks Google for the code flow, openid email profile only, with PKCE and the account chooser', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: EXCHANGE.clientId, redirectUri: EXCHANGE.redirectUri, state: STATE, codeChallenge: CHALLENGE }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: EXCHANGE.clientId,
      redirect_uri: EXCHANGE.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  });
});

describe('exchangeGoogleCode', () => {
  it('posts the code, verifier and client secret as a form, and returns the access token', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ access_token: TOKEN, token_type: 'Bearer', id_token: 'x' }));
    await expect(exchangeGoogleCode({ ...EXCHANGE, fetchImpl })).resolves.toEqual({ accessToken: TOKEN });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      client_id: EXCHANGE.clientId,
      client_secret: EXCHANGE.clientSecret,
      code: EXCHANGE.code,
      redirect_uri: EXCHANGE.redirectUri,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
    });
  });

  it.each([
    ['a refusal', () => json({ error: 'invalid_grant' }, 400)],
    ['no token', () => json({ token_type: 'Bearer' })],
    ['an empty token', () => json({ access_token: '' })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['a network error', () => Promise.reject(new TypeError('offline'))],
  ])('is exchange_failed on %s, and leaks nothing', async (_, respond) => {
    const { fetchImpl } = fakeFetch(respond);
    const error = await failure(exchangeGoogleCode({ ...EXCHANGE, fetchImpl }));
    expect(error.code).toBe('exchange_failed');
    for (const secret of [EXCHANGE.clientSecret, EXCHANGE.code, VERIFIER]) expect(JSON.stringify(error) + error.message).not.toContain(secret);
  });
});

describe('fetchGoogleUser', () => {
  it('reads the member from userinfo: a google: sub, a g. handle, their name and picture', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(JANE));
    await expect(fetchGoogleUser(TOKEN, fetchImpl)).resolves.toEqual({
      sub: 'google:109876543210987654321',
      login: 'g.jane-doe-vtuhvpo1',
      name: 'Jane Doe',
      avatarUrl: 'https://lh3.googleusercontent.com/a/jane',
    });
    expect(calls[0]!.url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('drops a name or picture it can’t use, and never makes a handle from the email', async () => {
    const { fetchImpl } = fakeFetch(() => json({ sub: '42', name: '  ', email: 'x.y@example.com', picture: 'http://insecure/p' }));
    await expect(fetchGoogleUser(TOKEN, fetchImpl)).resolves.toEqual({ sub: 'google:42', login: 'g.member-00000016', name: null, avatarUrl: null });
  });

  it('refuses an unverified email, a missing or odd sub, and a failed call', async () => {
    expect((await failure(fetchGoogleUser(TOKEN, fakeFetch(() => json({ ...JANE, email_verified: false })).fetchImpl))).code).toBe('google_email_unverified');
    for (const body of [{ ...JANE, sub: undefined }, { ...JANE, sub: 'abc' }, { ...JANE, sub: 42 }]) {
      expect((await failure(fetchGoogleUser(TOKEN, fakeFetch(() => json(body)).fetchImpl))).code).toBe('google_user_failed');
    }
    expect((await failure(fetchGoogleUser(TOKEN, fakeFetch(() => json({}, 401)).fetchImpl))).code).toBe('google_user_failed');
    expect((await failure(fetchGoogleUser('', fakeFetch(() => json(JANE)).fetchImpl))).code).toBe('google_user_failed');
  });
});

describe('googleHandle', () => {
  it('is g., a lower-case slug no GitHub login could be, and a tail that is theirs alone', () => {
    expect(googleHandle('José María O’Neil', '1')).toBe('g.jose-maria-o-neil-00000001');
    expect(googleHandle('Sam_Smith', '42')).toBe('g.sam-smith-00000016');
    expect(googleHandle('李雷', '1')).toBe('g.member-00000001');
    expect(googleHandle(null, '1')).toBe('g.member-00000001');
    // Two of the same name, or two with none, are never one handle.
    expect(googleHandle('Jane Doe', '109876543210987654321')).not.toBe(googleHandle('Jane Doe', '109876543210987654322'));
    expect(googleHandle(null, '7')).not.toBe(googleHandle(null, '8'));
    const long = googleHandle('a'.repeat(30) + ' ' + 'b'.repeat(30), '109876543210987654321');
    expect(long.length).toBeLessThanOrEqual(39);
    expect(isGoogleLogin(long)).toBe(true);
    expect(long.endsWith('-')).toBe(false);
  });

  it('keeps the shapes apart: a google sub or handle is never a GitHub id or login', () => {
    expect(isGoogleSub('google:1')).toBe(true);
    expect(isGoogleSub('1')).toBe(false);
    expect(isGoogleLogin('g.jane')).toBe(true);
    expect(isGoogleLogin('jane')).toBe(false);
    expect(isGoogleLogin('g.Jane')).toBe(false);
  });
});

describe('a Google member’s session', () => {
  it('seals and opens, keyed go:<id>, and is no GitHub session', async () => {
    const token = await sealSession(MEMBER, SECRET, { now: NOW });
    const session = await openSession(token, [SECRET], { now: NOW });
    expect(session).toMatchObject(MEMBER);
    expect(memberId(session!)).toBe('go:109876543210987654321');
    expect(isGitHubSession(session!)).toBe(false);
  });

  it('never mixes a google sub with a GitHub login, or the other way round, or a practice flag', async () => {
    for (const claims of [
      { ...MEMBER, login: 'janedoe' },
      { ...MEMBER, sub: '583231' },
      { ...MEMBER, demo: true },
    ]) {
      await expect(sealSession(claims, SECRET, { now: NOW })).rejects.toThrow(AuthError);
    }
  });

  it('keys a GitHub member gh:<id> and the practice account nothing', () => {
    expect(memberId({ sub: '583231', demo: false })).toBe('gh:583231');
    expect(isGitHubSession({ sub: '583231', demo: false })).toBe(true);
    expect(memberId({ sub: 'demo', demo: true })).toBeNull();
    expect(isGitHubSession({ sub: 'demo', demo: true })).toBe(false);
    expect(memberId({ sub: 'nobody', demo: false })).toBeNull();
  });

  it('mints an API assertion, as a GitHub member does', async () => {
    const jwt = await mintApiAssertion(MEMBER, SECRET, { now: NOW });
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: MEMBER.sub, login: MEMBER.login });
    await expect(mintApiAssertion({ sub: MEMBER.sub, login: 'janedoe' }, SECRET, { now: NOW })).rejects.toThrow(AuthError);
  });
});

describe('a Google sign-in attempt', () => {
  it('round-trips as its own kind, and nothing else can ride on it', async () => {
    const tx = { state: STATE, verifier: VERIFIER, next: '/apps', purpose: 'google' as const };
    const token = await sealTransaction(tx, SECRET, { now: NOW });
    await expect(openTransaction(token, [SECRET], { now: NOW })).resolves.toMatchObject(tx);
    await expect(sealTransaction({ ...tx, taskId: 1 } as never, SECRET, { now: NOW })).rejects.toThrow(AuthError);
  });
});
