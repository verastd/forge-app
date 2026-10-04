import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { connectSources, contentSecurityPolicy } from '../../apps/web/next.config.mjs';
import { startWithToken } from '../../apps/web/src/app/auth/callback/agent-start';
import type { TokenSteps } from '../../apps/web/src/app/auth/callback/agent-start';
import { usableApiBase } from '../../apps/web/src/lib/auth/api-url';

/**
 * What the Phase 4 review asked to be locked down, outside any one screen
 * (unit F3c). Project `chromium-demo`; all but the CSP check run without a
 * browser.
 *
 * - The protected paths (review-creds CR-1, review-web M3, review-mcp L8):
 *   every file that holds a pasted or saved agent key or the Copilot token on
 *   its way through, checks the links shown back, or is the text every agent
 *   is given, is a protected path for Foreman (`.github/forge-protocol.json`)
 *   and needs the cold account in CODEOWNERS.
 * - The CSP's `connect-src` (CR-1): a page may connect only where it already
 *   needs to.
 * - FORGE_API_URL must be https (CR-13).
 * - The Copilot token is revoked once it has been used (CR-9).
 */

const ROOT = join(__dirname, '..', '..');

/** Foreman's own rule (forge repo, apps/foreman/src/protocol.ts `protectedPaths`): a prefix ending in `/`, else the exact path. */
function guardedBy(file: string, guarded: readonly string[]): boolean {
  return guarded.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));
}

/** The owners CODEOWNERS gives `file`: its last matching line wins, as on GitHub. */
function codeOwners(file: string): string[] {
  let owners: string[] = [];
  for (const line of readFileSync(join(ROOT, 'CODEOWNERS'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [pattern = '', ...who] = trimmed.split(/\s+/);
    const path = pattern.replace(/^\//, '');
    const matches =
      pattern === '*' ||
      (path.endsWith('/') && file.startsWith(path)) ||
      (path.endsWith('*') && file.startsWith(path.slice(0, -1))) ||
      file === path;
    if (matches) owners = who;
  }
  return owners;
}

/** Every file under `dir` (repo-relative), or `dir` itself when it is a file. */
function filesUnder(dir: string): string[] {
  const full = join(ROOT, dir);
  if (!statSync(full).isDirectory()) return [dir];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(`${dir.replace(/\/$/, '')}/${entry.name}`),
  );
}

test.describe('protected paths', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.github/forge-protocol.json'), 'utf8')) as {
    protectedPaths: string[];
  };

  test('the code that carries agent keys and the Copilot token, and every agent’s text, needs the cold account', () => {
    const sensitive = [
      // The browser side: the form, the request, the BFF, the links it shows back.
      'apps/web/src/lib/bff-forward.ts',
      'apps/web/src/lib/handoff.ts',
      'apps/web/src/lib/api.ts',
      'apps/web/src/components/contribute/',
      // The API side: the dispatch and relay paths, the body models, the middleware.
      'apps/api/src/forge_api/services/bridge.py',
      'apps/api/src/forge_api/routers/bridge.py',
      'apps/api/src/forge_api/models.py',
      'apps/api/src/forge_api/main.py',
      // What every contributor's agent is told about each task.
      'apps/api/src/forge_api/fixtures/',
      // The ones that were already covered stay covered.
      'apps/web/src/app/bff/bridge/[...path]/route.ts',
      'apps/web/src/app/auth/callback/route.ts',
      'apps/web/src/lib/launch.ts',
      'apps/api/src/forge_api/services/vault.py',
    ];
    const files = sensitive.flatMap(filesUnder);
    expect(files).toContain('apps/web/src/components/contribute/StartRails.tsx');
    expect(files).toContain('apps/api/src/forge_api/fixtures/tasks.json');
    for (const file of files) {
      expect(guardedBy(file, manifest.protectedPaths), `${file} in protectedPaths`).toBe(true);
      expect(codeOwners(file), `${file} in CODEOWNERS`).toEqual(['@verastd', '@forge-cold']);
    }
  });

  test('CODEOWNERS and protectedPaths name the same new paths', () => {
    for (const path of [
      'apps/web/src/lib/bff-forward.ts',
      'apps/web/src/lib/handoff.ts',
      'apps/web/src/lib/api.ts',
      'apps/web/src/components/contribute/',
      'apps/api/src/forge_api/services/bridge.py',
      'apps/api/src/forge_api/routers/bridge.py',
      'apps/api/src/forge_api/models.py',
      'apps/api/src/forge_api/main.py',
      'apps/api/src/forge_api/fixtures/',
    ]) {
      expect(manifest.protectedPaths, path).toContain(path);
      expect(readFileSync(join(ROOT, 'CODEOWNERS'), 'utf8'), path).toMatch(
        new RegExp(`^/${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+@verastd @forge-cold$`, 'm'),
      );
    }
  });
});

test.describe('the content security policy', () => {
  test('connect-src: this origin, the API the browser reads, and the lobby’s LiveKit host only', () => {
    expect(connectSources({})).toEqual(["'self'", 'http://localhost:8000']);
    expect(connectSources({ NEXT_PUBLIC_API_URL: 'https://api.forge.example/base/' })).toEqual([
      "'self'",
      'https://api.forge.example',
    ]);
    // LiveKit: the signal socket and the https checks livekit-client makes on the same host.
    expect(
      connectSources({ NEXT_PUBLIC_API_URL: 'https://api.forge.example', LIVEKIT_URL: 'wss://forge-x1.livekit.cloud' }),
    ).toEqual(["'self'", 'https://api.forge.example', 'wss://forge-x1.livekit.cloud', 'https://forge-x1.livekit.cloud']);
    expect(connectSources({ LIVEKIT_URL: 'https://lk.forge.example:7443' })).toEqual([
      "'self'",
      'http://localhost:8000',
      'wss://lk.forge.example:7443',
      'https://lk.forge.example:7443',
    ]);
    expect(connectSources({ LIVEKIT_URL: 'ws://localhost:7880' })).toEqual([
      "'self'",
      'http://localhost:8000',
      'ws://localhost:7880',
      'http://localhost:7880',
    ]);
    // Anything that isn't a usable URL adds nothing.
    for (const bad of ['', 'not a url', 'ftp://lk.example', 'javascript:alert(1)', 'wss://user:pass@lk.example']) {
      expect(connectSources({ LIVEKIT_URL: bad }), bad).toEqual(["'self'", 'http://localhost:8000']);
    }
    expect(connectSources({ NEXT_PUBLIC_API_URL: 'nonsense' })).toEqual(["'self'"]);
    expect(contentSecurityPolicy({ LIVEKIT_URL: 'wss://example.invalid' })).toBe(
      "frame-ancestors 'none'; connect-src 'self' http://localhost:8000 wss://example.invalid https://example.invalid",
    );
  });

  test('every page carries it', async ({ request, baseURL }) => {
    test.skip(baseURL === undefined, 'needs the demo server');
    for (const path of ['/', '/contribute', '/contribute/task/1', '/connect', '/signin']) {
      const response = await request.get(path, { maxRedirects: 0 });
      // The demo server has no NEXT_PUBLIC_API_URL and no LiveKit (playwright.config.ts).
      expect(response.headers()['content-security-policy'], path).toBe(
        "frame-ancestors 'none'; connect-src 'self' http://localhost:8000",
      );
    }
  });
});

test.describe('FORGE_API_URL', () => {
  test('is https, or plain http only to this computer (CR-13)', () => {
    expect(usableApiBase('https://api.forge.example')).toBe('https://api.forge.example');
    expect(usableApiBase('https://api.forge.example/forge//')).toBe('https://api.forge.example/forge');
    expect(usableApiBase('http://localhost:8000')).toBe('http://localhost:8000');
    expect(usableApiBase('http://127.0.0.1:9/')).toBe('http://127.0.0.1:9');
    expect(usableApiBase('http://[::1]:8000')).toBe('http://[::1]:8000');
    for (const bad of [
      'http://api.forge.example',
      'http://10.0.0.5:8000',
      'http://localhost.evil.example',
      'http://127.0.0.1.nip.io',
      'https://user:pass@api.forge.example',
      'https://api.forge.example/?q=1',
      'https://api.forge.example/#x',
      'ftp://api.forge.example',
      'api.forge.example',
      '',
    ]) {
      expect(usableApiBase(bad), bad).toBeNull();
    }
  });
});

test.describe('the Copilot start’s one-time token', () => {
  /** The steps, recording the order they ran in; nothing reaches GitHub or the API. */
  function steps(userId: string | Error, dispatched: Awaited<ReturnType<TokenSteps['dispatch']>> = { ok: true }) {
    const ran: string[] = [];
    const given: TokenSteps = {
      userIdOf: async (token) => {
        ran.push(`user ${token}`);
        if (userId instanceof Error) throw userId;
        return userId;
      },
      dispatch: async (token) => {
        ran.push(`dispatch ${token}`);
        return dispatched;
      },
      revoke: (token) => {
        ran.push(`revoke ${token}`);
      },
    };
    return { ran, given };
  }

  test('is revoked once the start went through (CR-9)', async () => {
    const { ran, given } = steps('5104001');
    await expect(startWithToken('test-only-token', '5104001', given)).resolves.toEqual({ ok: true });
    expect(ran).toEqual(['user test-only-token', 'dispatch test-only-token', 'revoke test-only-token']);
  });

  test('is revoked when the start failed, and the failure comes back (CR-9)', async () => {
    const { ran, given } = steps('5104001', { ok: false, code: 'rail_failed', status: 502 });
    await expect(startWithToken('test-only-token', '5104001', given)).resolves.toEqual({
      ok: false,
      code: 'rail_failed',
      status: 502,
    });
    expect(ran.at(-1)).toBe('revoke test-only-token');
  });

  test('is revoked, and starts nothing, when it is someone else’s (CR-9)', async () => {
    const { ran, given } = steps('999');
    await expect(startWithToken('test-only-token', '5104001', given)).resolves.toEqual({
      ok: false,
      code: 'wrong_account',
    });
    expect(ran).toEqual(['user test-only-token', 'revoke test-only-token']);
  });

  test('is revoked when GitHub won’t say whose it is, and the error still surfaces (CR-9)', async () => {
    const { ran, given } = steps(new Error('github_user_failed'));
    await expect(startWithToken('test-only-token', '5104001', given)).rejects.toThrow('github_user_failed');
    expect(ran).toEqual(['user test-only-token', 'revoke test-only-token']);
  });
});
