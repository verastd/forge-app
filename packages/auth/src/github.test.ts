import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError, authorizeUrl, exchangeCode, fetchGitHubUser, revokeGitHubToken } from './index.js';
import type { FetchLike } from './index.js';

const STATE = 'Xq3vG0b1k9Zr8dT2yWc4nHs6uJm5pLf7aEo-_iRkQzA';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const EXCHANGE = {
  clientId: 'Iv23liForgeClientId',
  clientSecret: 'client-secret-must-never-leak-0001',
  code: 'authorization-code-must-never-leak-0002',
  redirectUri: 'https://forge.example/auth/callback',
  codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
};

const TOKEN = 'ghu_access-token-must-never-leak-0003';

const OCTOCAT = {
  login: 'octocat',
  id: 583231,
  node_id: 'MDQ6VXNlcjU4MzIzMQ==',
  avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
  type: 'User',
  site_admin: false,
  name: 'The Octocat',
  company: '@github',
  email: null,
};

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake `fetch` that records each call and answers with `respond()`. */
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

/** Everything an error could show a log: message, stack, cause and own properties. */
function exposed(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [e.message, e.stack, String(e.cause), JSON.stringify(e)].join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authorizeUrl', () => {
  it('points at GitHub’s authorize endpoint with exactly the PKCE parameters and no scope', () => {
    const url = new URL(
      authorizeUrl({
        clientId: EXCHANGE.clientId,
        redirectUri: EXCHANGE.redirectUri,
        state: STATE,
        codeChallenge: CHALLENGE,
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: EXCHANGE.clientId,
      redirect_uri: EXCHANGE.redirectUri,
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.hash).toBe('');
  });

  it('encodes every value, so none can smuggle in a parameter', () => {
    const href = authorizeUrl({
      clientId: 'id&scope=repo',
      redirectUri: 'https://forge.example/auth/callback?a=1&b=2',
      state: 's#t',
      codeChallenge: 'c c',
    });
    const params = new URL(href).searchParams;

    expect(params.get('client_id')).toBe('id&scope=repo');
    expect(params.get('redirect_uri')).toBe('https://forge.example/auth/callback?a=1&b=2');
    expect(params.get('state')).toBe('s#t');
    expect(params.get('code_challenge')).toBe('c c');
    expect(params.has('scope')).toBe(false);
    expect([...params.keys()]).toHaveLength(5);
  });
});

describe('exchangeCode', () => {
  it('POSTs the code and PKCE verifier as JSON and returns the access token', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ access_token: TOKEN, expires_in: 28_800, refresh_token: 'ghr_x', token_type: 'bearer', scope: '' }),
    );

    await expect(exchangeCode({ ...EXCHANGE, fetchImpl })).resolves.toEqual({ accessToken: TOKEN });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const headers = new Headers(init.headers);
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('forge-web');
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: EXCHANGE.clientId,
      client_secret: EXCHANGE.clientSecret,
      code: EXCHANGE.code,
      redirect_uri: EXCHANGE.redirectUri,
      code_verifier: EXCHANGE.codeVerifier,
    });
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([
    'bad_verification_code',
    'redirect_uri_mismatch',
    'incorrect_client_credentials',
    'unverified_user_email',
    'a'.repeat(64),
  ])('throws GitHub’s own code, %s, from an HTTP 200 error body', async (code) => {
    const { fetchImpl } = fakeFetch(() =>
      json({ error: code, error_description: 'The code passed is incorrect or expired.' }),
    );

    await expect(exchangeCode({ ...EXCHANGE, fetchImpl })).rejects.toMatchObject({ name: 'AuthError', code });
  });

  it('trusts an error over a token when GitHub sends both', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'bad_verification_code', access_token: TOKEN }));

    await expect(exchangeCode({ ...EXCHANGE, fetchImpl })).rejects.toMatchObject({ code: 'bad_verification_code' });
  });

  it('reads error: null as no error', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: null, access_token: TOKEN }));

    await expect(exchangeCode({ ...EXCHANGE, fetchImpl })).resolves.toEqual({ accessToken: TOKEN });
  });

  const failures: [string, () => Response | Promise<Response>][] = [
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['the timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['HTTP 500, even with an error code in the body', () => json({ error: 'server_error' }, 500)],
    ['HTTP 404', () => new Response('Not Found', { status: 404 })],
    ['HTTP 302', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })],
    ['a body that is not JSON', () => new Response('<html>unavailable</html>', { status: 200 })],
    ['a JSON array', () => json([TOKEN])],
    ['JSON null', () => json(null)],
    ['a JSON string', () => json(TOKEN)],
    ['no access_token', () => json({ token_type: 'bearer' })],
    ['an empty access_token', () => json({ access_token: '' })],
    ['a non-string access_token', () => json({ access_token: 42 })],
    ['an error that is not a plain code', () => json({ error: 'Bad Code!' })],
    ['an error code over 64 characters', () => json({ error: 'a'.repeat(65) })],
    ['an empty error', () => json({ error: '' })],
    ['an error that is not a string', () => json({ error: { code: 'bad_verification_code' } })],
    ['a non-string error beside a token', () => json({ error: 7, access_token: TOKEN })],
  ];

  it.each(failures)('throws exchange_failed on %s', async (_label, respond) => {
    const { fetchImpl } = fakeFetch(respond);

    await expect(exchangeCode({ ...EXCHANGE, fetchImpl })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'exchange_failed',
    });
  });

  it('never lets the client secret, the code, the verifier or the token into an error', async () => {
    const leaky = (): Response => json({ error: `bad ${EXCHANGE.code} ${EXCHANGE.clientSecret} ${TOKEN}` });
    const cases = [...failures.map(([, respond]) => respond), leaky];

    for (const respond of cases) {
      const { fetchImpl } = fakeFetch(respond);
      const error = await exchangeCode({ ...EXCHANGE, fetchImpl }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthError);
      const text = exposed(error);
      for (const secret of [EXCHANGE.clientSecret, EXCHANGE.code, EXCHANGE.codeVerifier, TOKEN]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('uses globalThis.fetch by default', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ access_token: TOKEN }));
    vi.stubGlobal('fetch', fetchImpl);

    await expect(exchangeCode(EXCHANGE)).resolves.toEqual({ accessToken: TOKEN });
    expect(calls).toHaveLength(1);
  });
});

describe('fetchGitHubUser', () => {
  it('GETs /user with the token and the pinned API version, and maps the profile', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl, calls } = fakeFetch(() => json(OCTOCAT));

    await expect(fetchGitHubUser(TOKEN, fetchImpl)).resolves.toEqual({
      id: 583231,
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const headers = new Headers(init.headers);
    expect(url).toBe('https://api.github.com/user');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('forge-web');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no name or avatar', { name: null, avatar_url: null }],
    ['a 256-character name', { name: 'n'.repeat(256) }],
    ['the largest safe id', { id: Number.MAX_SAFE_INTEGER }],
    ['a 39-character login', { login: 'a'.repeat(39) }],
  ])('accepts a user with %s', async (_label, overrides) => {
    const { fetchImpl } = fakeFetch(() => json({ ...OCTOCAT, ...overrides }));
    const user = await fetchGitHubUser(TOKEN, fetchImpl);

    expect(user).toEqual({
      id: overrides.id ?? OCTOCAT.id,
      login: overrides.login ?? OCTOCAT.login,
      name: 'name' in overrides ? overrides.name : OCTOCAT.name,
      avatarUrl: 'avatar_url' in overrides ? overrides.avatar_url : OCTOCAT.avatar_url,
    });
  });

  const invalidUsers: [string, Record<string, unknown>][] = [
    ['no id', { id: undefined }],
    ['id 0', { id: 0 }],
    ['a negative id', { id: -1 }],
    ['a fractional id', { id: 1.5 }],
    ['an id as a string', { id: '583231' }],
    ['an id past the safe range', { id: 2 ** 53 }],
    ['a null id', { id: null }],
    ['no login', { login: undefined }],
    ['a login with a leading hyphen', { login: '-octocat' }],
    ['a 40-character login', { login: 'a'.repeat(40) }],
    ['a login with an underscore', { login: 'octo_cat' }],
    ['a non-string login', { login: 7 }],
    ['no name at all', { name: undefined }],
    ['a non-string name', { name: 42 }],
    ['a name over 256 characters', { name: 'n'.repeat(257) }],
    ['no avatar_url at all', { avatar_url: undefined }],
    ['an http avatar', { avatar_url: 'http://avatars.githubusercontent.com/u/583231' }],
    ['an avatar that is not a URL', { avatar_url: 'avatar.png' }],
    ['an avatar URL over 2048 characters', { avatar_url: `https://a.example/${'x'.repeat(2049 - 18)}` }],
    ['a non-string avatar', { avatar_url: 1 }],
  ];

  it.each(invalidUsers)('throws github_user_failed for a user with %s', async (_label, overrides) => {
    const { fetchImpl } = fakeFetch(() => json({ ...OCTOCAT, ...overrides }));

    await expect(fetchGitHubUser(TOKEN, fetchImpl)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'github_user_failed',
    });
  });

  const transportFailures: [string, () => Response | Promise<Response>][] = [
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['the timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['HTTP 401', () => json({ message: 'Bad credentials' }, 401)],
    ['HTTP 403', () => json({ message: 'rate limited' }, 403)],
    ['HTTP 500', () => json(OCTOCAT, 500)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a JSON array', () => json([OCTOCAT])],
    ['JSON null', () => json(null)],
  ];

  it.each(transportFailures)('throws github_user_failed on %s', async (_label, respond) => {
    const { fetchImpl } = fakeFetch(respond);

    await expect(fetchGitHubUser(TOKEN, fetchImpl)).rejects.toMatchObject({ code: 'github_user_failed' });
  });

  it.each([
    ['an empty token', ''],
    ['no token', undefined],
  ])('refuses %s without calling GitHub', async (_label, token) => {
    const { fetchImpl, calls } = fakeFetch(() => json(OCTOCAT));

    await expect(fetchGitHubUser(token as string, fetchImpl)).rejects.toMatchObject({ code: 'github_user_failed' });
    expect(calls).toHaveLength(0);
  });

  it('never lets the token into an error', async () => {
    const cases = [
      ...transportFailures.map(([, respond]) => respond),
      ...invalidUsers.map(([, overrides]) => () => json({ ...OCTOCAT, ...overrides })),
      () => json({ ...OCTOCAT, login: TOKEN }),
    ];

    for (const respond of cases) {
      const { fetchImpl } = fakeFetch(respond);
      const error = await fetchGitHubUser(TOKEN, fetchImpl).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthError);
      expect(exposed(error)).not.toContain(TOKEN);
    }
  });

  it('uses globalThis.fetch by default', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(OCTOCAT));
    vi.stubGlobal('fetch', fetchImpl);

    await expect(fetchGitHubUser(TOKEN)).resolves.toMatchObject({ login: 'octocat' });
    expect(calls).toHaveLength(1);
  });
});

describe('revokeGitHubToken', () => {
  const REVOKE = { clientId: EXCHANGE.clientId, clientSecret: EXCHANGE.clientSecret, accessToken: TOKEN };
  const noContent = (): Response => new Response(null, { status: 204 });

  it("DELETEs the app's token with Basic client credentials and the token in the body", async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl, calls } = fakeFetch(noContent);

    await expect(revokeGitHubToken({ ...REVOKE, fetchImpl })).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const headers = new Headers(init.headers);
    expect(url).toBe(`https://api.github.com/applications/${EXCHANGE.clientId}/token`);
    expect(init.method).toBe('DELETE');
    expect(headers.get('authorization')).toBe(`Basic ${btoa(`${EXCHANGE.clientId}:${EXCHANGE.clientSecret}`)}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('user-agent')).toBe('forge-web');
    expect(JSON.parse(String(init.body))).toEqual({ access_token: TOKEN });
    // The token rides in the body, never in the URL.
    expect(url).not.toContain(TOKEN);
    expect(init.redirect).toBe('error');
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it('puts the client id into the path as one segment', async () => {
    const { fetchImpl, calls } = fakeFetch(noContent);
    await revokeGitHubToken({ ...REVOKE, clientId: 'a/b?c', fetchImpl });
    expect(calls[0]?.url).toBe('https://api.github.com/applications/a%2Fb%3Fc/token');
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['the timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['HTTP 404 (already gone)', () => json({ message: 'Not Found' }, 404)],
    ['HTTP 422', () => json({ message: 'Validation Failed' }, 422)],
    ['HTTP 200 instead of 204', () => json({})],
  ])('is false, and never throws, on %s', async (_label, respond) => {
    const { fetchImpl } = fakeFetch(respond);
    await expect(revokeGitHubToken({ ...REVOKE, fetchImpl })).resolves.toBe(false);
  });

  it.each([
    ['no client id', { clientId: '' }],
    ['no client secret', { clientSecret: '' }],
    ['no token', { accessToken: '' }],
  ])('does not call GitHub with %s', async (_label, overrides) => {
    const { fetchImpl, calls } = fakeFetch(noContent);
    await expect(revokeGitHubToken({ ...REVOKE, ...overrides, fetchImpl })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is false for a secret Basic auth cannot carry, without calling GitHub', async () => {
    const { fetchImpl, calls } = fakeFetch(noContent);
    await expect(revokeGitHubToken({ ...REVOKE, clientSecret: 'not latin-1: \u{1F511}', fetchImpl })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uses globalThis.fetch by default', async () => {
    const { fetchImpl, calls } = fakeFetch(noContent);
    vi.stubGlobal('fetch', fetchImpl);

    await expect(revokeGitHubToken(REVOKE)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });
});
