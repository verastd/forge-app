import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { CONNECTOR_PATHS, connectorRewrites } from '../../apps/web/next.config.mjs';
import {
  antigravityEntry,
  connectorUrl,
  cursorInstallLink,
  IN_REPO_CONFIG,
  vscodeInstallLink,
} from '../../apps/web/src/app/connect/connector';
import { errorPageHtml, escapeHtml } from '../../apps/web/src/app/oauth/authorize/decision/error-page';
import {
  authorizeParamsFrom,
  clientRedirect,
  consentPath,
  displayText,
  fromRecord,
  isLoopbackHost,
  isSameOriginPost,
  MAX_VALUE_LENGTH,
  oauthFields,
  returnTarget,
  scopesDescribed,
} from '../../apps/web/src/app/oauth/authorize/oauth-request';
import { DEMO_API_PORT } from './helpers/env';
import { demoSignIn, plantPracticeSession, signInAs } from './helpers/session';
import { assertionClaims, json, withStandIn } from './helpers/standin';
import type { Answer, Seen } from './helpers/standin';

/**
 * The FORGE connector's web side (unit W2): the /connect page, the consent
 * page at /oauth/authorize with its Allow/Cancel handler, and the rewrites
 * that hand the connector's OAuth and MCP paths to the API. Project
 * `chromium-demo`; signed-in GitHub-shaped sessions are sealed directly
 * with `signInAs`, as auth.spec.ts does.
 *
 * Three parts:
 * - the pure helpers, run directly (apps/web has no unit-test runner);
 * - pages and redirects that never reach the API;
 * - a serial block with a stand-in API on the demo server's API port
 *   (DEMO_API_PORT, where this server's FORGE_API_URL and rewrites point).
 *
 * The port is shared with the other specs' stand-ins, so the stand-in comes
 * from `helpers/standin.ts`: it waits for the port to be free, holds it only
 * for the length of one test, and answers only the paths its test names.
 */

// --------------------------------------------------------------------------
// The pure helpers
// --------------------------------------------------------------------------

test.describe('helpers', () => {
  test('connectorRewrites proxies exactly the connector paths, and only to an http(s) FORGE_API_URL', () => {
    expect(CONNECTOR_PATHS).toEqual([
      '/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/token',
      '/oauth/revoke',
      // MCP 2025-03-26's fallback paths, which the API answers too.
      '/register',
      '/token',
    ]);
    // Never the consent page or its handler: those are the web's own, and
    // the fallback `/authorize` is a redirect to the consent page.
    expect(CONNECTOR_PATHS).not.toContain('/oauth/authorize');
    expect(CONNECTOR_PATHS).not.toContain('/oauth/authorize/decision');
    expect(CONNECTOR_PATHS).not.toContain('/authorize');

    expect(connectorRewrites('http://127.0.0.1:3190')).toEqual(
      CONNECTOR_PATHS.map((path) => ({ source: path, destination: `http://127.0.0.1:3190${path}` })),
    );
    expect(connectorRewrites('https://api.example.com/').map((rule) => rule.destination)[0]).toBe(
      'https://api.example.com/mcp',
    );
    expect(connectorRewrites('https://api.example.com/forge//')[3]?.destination).toBe(
      'https://api.example.com/forge/.well-known/oauth-authorization-server',
    );

    for (const bad of [
      undefined,
      '',
      'api.example.com',
      '/relative',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'https://user:pass@api.example.com',
      'https://api.example.com/?q=1',
      'https://api.example.com/#frag',
      'https://api.example.com/:param',
      'http://[::1]:8000',
      // Plain http only to this computer: tokens and codes cross these paths (review-creds CR-13).
      'http://api.example.com',
      'http://10.0.0.5:8000',
      'http://localhost.example.com',
    ]) {
      expect(connectorRewrites(bad), String(bad)).toEqual([]);
    }
    expect(connectorRewrites('http://localhost:8000')[0]?.destination).toBe('http://localhost:8000/mcp');
  });

  test('returnTarget names where a refused request would go back to: a host, or the app, never the address', () => {
    expect(returnTarget('https://claude.ai/api/mcp/auth_callback?error=invalid_scope&state=s')).toBe('claude.ai');
    expect(returnTarget('https://app.example.com:8443/cb?error=x')).toBe('app.example.com:8443');
    expect(returnTarget('https://app.example.com:443/cb?error=x')).toBe('app.example.com');
    expect(returnTarget('http://127.0.0.1:33418/?error=x')).toBe('127.0.0.1:33418');
    expect(returnTarget('cursor://anysphere.cursor-retrieval/oauth/callback?error=x')).toBe('anysphere.cursor-retrieval');
    // `scheme:/path` names no host: the app, by its scheme (as the API's redirectHost says it).
    expect(returnTarget('com.example.app:/oauth2redirect?error=x&state=s')).toBe('the app com.example.app');
    expect(returnTarget('https://xn--bcher-kva.example/cb')).toBe('xn--bcher-kva.example');
  });

  test('authorizeParamsFrom maps the OAuth query onto AuthorizeParams', () => {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      code_challenge: 'test-only-challenge',
      code_challenge_method: 'S256',
      state: 'test-only-state',
      scope: 'forge.tasks',
      resource: 'https://forge.example/mcp',
      prompt: 'consent',
    });
    const result = authorizeParamsFrom((name) => query.getAll(name));
    expect(result).toEqual({
      ok: true,
      params: {
        responseType: 'code',
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:5555/callback',
        codeChallenge: 'test-only-challenge',
        codeChallengeMethod: 'S256',
        state: 'test-only-state',
        scope: 'forge.tasks',
        resource: 'https://forge.example/mcp',
      },
    });

    // Back again, minus what OAuth says to ignore (`prompt`), in a fixed order.
    if (!result.ok) throw new Error('unreachable');
    expect(oauthFields(result.params).map(([field]) => field)).toEqual([
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'state',
      'scope',
      'resource',
    ]);
    const path = consentPath(result.params);
    expect(path.startsWith('/oauth/authorize?response_type=code&client_id=client-1&')).toBe(true);
    const again = new URL(path, 'https://forge.invalid').searchParams;
    expect(authorizeParamsFrom((name) => again.getAll(name))).toEqual(result);
  });

  test('authorizeParamsFrom leaves validation to the API but refuses what has no single value', () => {
    // Missing required parameters go to the API as '' (only it knows whether
    // the client may be told); absent optional ones are left out.
    expect(authorizeParamsFrom(fromRecord({ client_id: 'only-this' }))).toEqual({
      ok: true,
      params: { responseType: '', clientId: 'only-this', redirectUri: '', codeChallenge: '', codeChallengeMethod: '' },
    });
    expect(authorizeParamsFrom(fromRecord({}))).toEqual({ ok: false, reason: 'empty' });
    expect(authorizeParamsFrom(fromRecord({ unrelated: 'x' }))).toEqual({ ok: false, reason: 'empty' });
    expect(authorizeParamsFrom(fromRecord({ client_id: ['a', 'b'] }))).toEqual({ ok: false, reason: 'repeated' });
    expect(authorizeParamsFrom(fromRecord({ client_id: 'a', state: ['x', 'y'] }))).toEqual({
      ok: false,
      reason: 'repeated',
    });
    expect(authorizeParamsFrom(fromRecord({ client_id: 'c'.repeat(MAX_VALUE_LENGTH) })).ok).toBe(true);
    expect(authorizeParamsFrom(fromRecord({ client_id: 'c'.repeat(MAX_VALUE_LENGTH + 1) }))).toEqual({
      ok: false,
      reason: 'too_long',
    });
    // An inherited name is not a parameter.
    expect(authorizeParamsFrom(fromRecord(Object.create({ client_id: 'inherited' }) as Record<string, string>))).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  test('isSameOriginPost: the public origin, or the browser saying same-origin', () => {
    const origin = 'https://forge.example';
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(isSameOriginPost(headers({ origin }), origin)).toBe(true);
    expect(isSameOriginPost(headers({ 'sec-fetch-site': 'same-origin' }), origin)).toBe(true);
    expect(isSameOriginPost(headers({ 'sec-fetch-site': 'same-origin' }), null)).toBe(true);
    expect(isSameOriginPost(headers({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), origin)).toBe(
      false,
    );
    expect(isSameOriginPost(headers({ origin: 'https://evil.example' }), origin)).toBe(false);
    expect(isSameOriginPost(headers({ 'sec-fetch-site': 'same-site' }), origin)).toBe(false);
    expect(isSameOriginPost(headers({ 'sec-fetch-site': 'none' }), origin)).toBe(false);
    expect(isSameOriginPost(headers({ origin: 'null' }), origin)).toBe(false);
    expect(isSameOriginPost(headers({ origin }), null)).toBe(false);
    expect(isSameOriginPost(headers({}), origin)).toBe(false);
    // Origin comparison is exact: no prefix, case or trailing-slash games.
    expect(isSameOriginPost(headers({ origin: 'https://forge.example.evil.example' }), origin)).toBe(false);
    expect(isSameOriginPost(headers({ origin: 'https://forge.example/' }), origin)).toBe(false);
  });

  test('clientRedirect lets through only addresses a browser may be sent to', () => {
    expect(clientRedirect('https://claude.ai/api/mcp/auth_callback?code=c&state=s')).toBe(
      'https://claude.ai/api/mcp/auth_callback?code=c&state=s',
    );
    expect(clientRedirect('http://127.0.0.1:33418/?code=c')).toBe('http://127.0.0.1:33418/?code=c');
    expect(clientRedirect('http://localhost:8787/callback?code=c')).toBe('http://localhost:8787/callback?code=c');
    expect(clientRedirect('http://[::1]:9000/cb?code=c')).toBe('http://[::1]:9000/cb?code=c');
    expect(clientRedirect('cursor://anysphere.cursor-retrieval/oauth/callback?code=c')).toBe(
      'cursor://anysphere.cursor-retrieval/oauth/callback?code=c',
    );
    // Serialized for a Location header: non-ASCII is percent-encoded.
    expect(clientRedirect('https://example.com/caf\u00e9?code=c')).toBe('https://example.com/caf%C3%A9?code=c');

    for (const bad of [
      undefined,
      null,
      42,
      '',
      '/relative/path',
      '//evil.example/cb',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
      'blob:https://forge.example/uuid',
      'http://evil.example/cb?code=c',
      'https://example.com/cb#fragment',
      'https://example.com/cb#',
      'https://example.com/cb\r\nSet-Cookie: x=1',
      'https://example.com/c b',
      `https://example.com/${'x'.repeat(8200)}`,
    ]) {
      expect(clientRedirect(bad), String(bad).slice(0, 60)).toBeNull();
    }
  });

  test('displayText strips what can hide or reorder a name, and caps it', () => {
    expect(displayText('Claude', 60, 'fallback')).toBe('Claude');
    expect(displayText('Safe\u202eegasseM', 60, 'fallback')).toBe('SafeegasseM');
    expect(displayText('Zero\u200bWidth\u2066Isolate\u2069', 60, 'fallback')).toBe('ZeroWidthIsolate');
    expect(displayText('  lots \n of\t  space  ', 60, 'fallback')).toBe('lots of space');
    expect(displayText('\u0000\u200b\u202e', 60, 'An unnamed app')).toBe('An unnamed app');
    expect(displayText('abcdefghij', 5, 'fallback')).toBe('abcd…');
    // Counted in characters, so an emoji is never cut in half.
    expect(displayText('\u{1F600}'.repeat(5), 3, 'fallback')).toBe('\u{1F600}\u{1F600}…');
  });

  test('isLoopbackHost recognises this computer, port or not', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:8080', 'localhost', 'LOCALHOST:3000', '[::1]', '[::1]:9000', '::1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['claude.ai', 'localhost.evil.example', '127.0.0.2', 'vscode.dev']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  test('scopesDescribed holds only for scopes the consent screen puts into words', () => {
    expect(scopesDescribed(['forge.tasks'])).toBe(true);
    expect(scopesDescribed([])).toBe(true);
    expect(scopesDescribed(['forge.tasks', 'forge.admin'])).toBe(false);
    expect(scopesDescribed(['FORGE.TASKS'])).toBe(false);
  });

  test('the decision error page escapes everything it shows', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    const html = errorPageHtml(
      { title: 'Title <script>', message: 'Message & "quotes"' },
      { href: '/signin?next=%2Foauth%2Fauthorize%3Fa%3D1%26b%3D2', label: 'Sign <in>' },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h1>Title &lt;script&gt;</h1>');
    expect(html).toContain('Message &amp; &quot;quotes&quot;');
    expect(html).toContain('href="/signin?next=%2Foauth%2Fauthorize%3Fa%3D1%26b%3D2">Sign &lt;in&gt;</a>');
    expect(html).toContain('href="/connect"');
  });

  test('connectorUrl uses FORGE_PUBLIC_ORIGIN, and the request only under next dev', () => {
    const base = { publicOrigin: null, development: false, host: 'evil.example', forwardedProto: null };
    expect(connectorUrl({ ...base, publicOrigin: 'https://forge.example' })).toBe('https://forge.example/mcp');
    expect(connectorUrl({ ...base, publicOrigin: 'https://forge.example', development: true })).toBe(
      'https://forge.example/mcp',
    );
    expect(connectorUrl(base)).toBeNull();
    expect(connectorUrl({ ...base, development: true, host: 'localhost:3000' })).toBe('http://localhost:3000/mcp');
    expect(connectorUrl({ ...base, development: true, host: 'dev.example', forwardedProto: 'https' })).toBe(
      'https://dev.example/mcp',
    );
    expect(connectorUrl({ ...base, development: true, host: '[::1]:3000' })).toBe('http://[::1]:3000/mcp');
    for (const host of [null, '', 'evil.example/path', 'a b', 'host:port', 'evil.example\r\nx: y']) {
      expect(connectorUrl({ ...base, development: true, host }), String(host)).toBeNull();
    }
  });

  test('the install links carry exactly the connector, in each client’s format', () => {
    const url = 'https://forge-app-eta-mocha.vercel.app/mcp';
    expect(decodeVsCodeLink(vscodeInstallLink(url))).toEqual({ name: 'forge', type: 'http', url });
    expect(decodeCursorLink(cursorInstallLink(url))).toEqual({ name: 'forge', config: { url } });
    expect(antigravityEntry(url)).toBe(`"forge": { "serverUrl": "${url}" }`);
    // A URL whose base64 has '+' and '/' in it still survives the query.
    const awkward = 'https://forge.example/mcp?>>>???';
    expect(decodeCursorLink(cursorInstallLink(awkward)).config).toEqual({ url: awkward });
  });

  test('the in-repo config list matches the files actually in the repo', () => {
    const root = join(__dirname, '..', '..');
    for (const [client, file] of Object.entries(IN_REPO_CONFIG)) {
      if (file !== null) expect(existsSync(join(root, file)), `${client}: ${file}`).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// Decoding the install links the way each client does
// --------------------------------------------------------------------------

/** VS Code: `JSON.parse(decodeURIComponent(query))` (parseMcpInstallUriPayload). */
function decodeVsCodeLink(href: string): unknown {
  const prefix = 'vscode:mcp/install?';
  expect(href.startsWith(prefix)).toBe(true);
  return JSON.parse(decodeURIComponent(href.slice(prefix.length)));
}

/** Cursor: `name` and base64 JSON `config` query parameters. */
function decodeCursorLink(href: string): { name: string | null; config: unknown } {
  const url = new URL(href);
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('cursor://anysphere.cursor-deeplink/mcp/install');
  const config = url.searchParams.get('config') ?? '';
  return { name: url.searchParams.get('name'), config: JSON.parse(Buffer.from(config, 'base64').toString('utf8')) };
}

// --------------------------------------------------------------------------
// /connect
// --------------------------------------------------------------------------

/** Answers the browser's flag fetch, so the page never depends on what happens to run on :8000. */
async function serveFlags(page: Page, mcpConnector: boolean, githubSignin = true): Promise<void> {
  const body = JSON.stringify({ mcp_connector: mcpConnector, github_signin: githubSignin });
  await page.route('**/api/flags', (route) => route.fulfill({ status: 200, contentType: 'application/json', body }));
}

async function expectNoSideScroll(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test.describe('/connect', () => {
  test('shows this server’s connector URL, and Copy copies it', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await serveFlags(page, true);
    await page.goto('/connect');

    await expect(page.getByRole('heading', { name: 'Connect your agent to FORGE', level: 1 })).toBeVisible();
    const url = `${baseURL}/mcp`;
    await expect(page.getByTestId('connector-url')).toHaveText(url);

    await page.getByRole('button', { name: 'Copy the connector URL' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connector URL copied.' })).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    // The one copy on the page: everything else is typed or clicked.
    await expect(page.getByRole('button', { name: /copy/i })).toHaveCount(1);
  });

  test('gives each client its exact action, with this server’s URL in it', async ({ page, baseURL }) => {
    await serveFlags(page, true);
    await page.goto('/connect');
    const url = `${baseURL}/mcp`;

    for (const name of [
      'Claude',
      'Claude Code on your computer',
      'Codex',
      'VS Code',
      'Cursor',
      'Google Antigravity',
      'ChatGPT',
    ]) {
      await expect(page.getByRole('heading', { name, exact: true, level: 3 })).toBeVisible();
    }
    const claude = page.getByRole('article', { name: 'Claude', exact: true });
    await expect(claude.getByRole('link', { name: 'Customize → Connectors' })).toHaveAttribute(
      'href',
      'https://claude.ai/customize/connectors',
    );
    await expect(page.getByText(`claude mcp add --transport http forge ${url}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`codex mcp add forge --url ${url}`, { exact: true })).toBeVisible();
    await expect(page.getByText('codex mcp login forge', { exact: true })).toBeVisible();
    await expect(page.getByText(`"forge": { "serverUrl": "${url}" }`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'chatgpt.com/plugins' })).toHaveAttribute(
      'href',
      'https://chatgpt.com/plugins',
    );
    await expect(page.getByText(/Jules, GitHub Copilot and the other agents FORGE starts for you/)).toBeVisible();

    // The repo's .mcp.json isn't committed yet, so nothing may claim it is.
    await expect(page.getByText('.mcp.json')).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Codex' }).getByText('.codex/config.toml')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Cursor' }).getByText('.cursor/mcp.json')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Google Antigravity' }).getByText('.agents/mcp_config.json')).toBeVisible();
  });

  test('the VS Code and Cursor install links decode to this server’s connector', async ({ page, baseURL }) => {
    await serveFlags(page, true);
    await page.goto('/connect');
    const url = `${baseURL}/mcp`;

    const vscode = await page.getByRole('link', { name: 'Add FORGE to VS Code' }).getAttribute('href');
    expect(decodeVsCodeLink(vscode ?? '')).toEqual({ name: 'forge', type: 'http', url });

    const cursor = await page.getByRole('link', { name: 'Add FORGE to Cursor' }).getAttribute('href');
    expect(decodeCursorLink(cursor ?? '')).toEqual({ name: 'forge', config: { url } });
  });

  test('says the connector is off, and shows no URL, when the flag is off', async ({ page }) => {
    await serveFlags(page, false);
    await page.goto('/connect');

    await expect(page.getByText('The FORGE connector is switched off right now.')).toBeVisible();
    await expect(page.getByTestId('connector-url')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add FORGE to VS Code' })).toHaveCount(0);
  });

  test('says the connector is off while GitHub sign-in is switched off, as the API does', async ({ page }) => {
    await serveFlags(page, true, false);
    await page.goto('/connect');

    await expect(page.getByText('The FORGE connector is switched off right now.')).toBeVisible();
    await expect(page.getByTestId('connector-url')).toHaveCount(0);
  });

  test('fits a 390 px screen', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveFlags(page, true);
    await page.goto('/connect');

    await expect(page.getByTestId('connector-url')).toHaveText(`${baseURL}/mcp`);
    await expect(page.getByRole('button', { name: 'Copy the connector URL' })).toBeInViewport();
    await expectNoSideScroll(page, 390);
  });

  test('the account menu links to it', async ({ page }) => {
    await page.goto('/signin');
    await demoSignIn(page);
    const trigger = page.getByRole('button', { name: 'Account: you' });
    // Retried as auth.spec.ts does: a click can land before the menu has hydrated.
    await expect(async () => {
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await page.getByRole('link', { name: 'Connect an agent' }).click();
    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole('heading', { name: 'Connect your agent to FORGE', level: 1 })).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// The consent page and the decision handler, without the API
// --------------------------------------------------------------------------

/** Where the stand-in API sends the browser back to: the "agent". */
const CALLBACK = `http://127.0.0.1:${DEMO_API_PORT}/callback`;
const STATE = 'test-only-state';

/** A consent URL (path and query) for `clientId`, as an agent's OAuth client would build it. */
function consentUrl(baseURL: string | undefined, clientId: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: 'test-only-code-challenge-0123456789abcdefghijk',
    code_challenge_method: 'S256',
    state: STATE,
    scope: 'forge.tasks',
    resource: `${baseURL ?? ''}/mcp`,
  });
  return `/oauth/authorize?${query.toString()}`;
}

/** The consent form's fields for `clientId`, as the page would post them. */
function consentForm(baseURL: string | undefined, clientId: string, decision: 'allow' | 'deny'): Record<string, string> {
  const query = new URL(consentUrl(baseURL, clientId), 'https://forge.invalid').searchParams;
  return { ...Object.fromEntries(query), decision };
}

const REAL = { sub: '4002001', login: 'consent-check' } as const;

test.describe('/oauth/authorize, before the API', () => {
  test('signed out, it goes to /signin and comes back with the whole query', async ({ page, baseURL }) => {
    const consent = consentUrl(baseURL, 'round-trip-client');
    expect(consent.length).toBeLessThanOrEqual(512);

    await page.goto(consent);
    await expect(page).toHaveURL(/\/signin\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(consent);

    // The practice account is this build's sign-in, and it is refused here,
    // but only after landing back on exactly the URL the agent opened.
    await demoSignIn(page);
    await expect(page).toHaveURL(`${baseURL}${consent}`);
    await expect(page.getByRole('heading', { name: 'Practice accounts can’t connect agents.' })).toBeVisible();
    await expect(page.getByText('Sign in with GitHub.')).toBeVisible();
  });

  test('a real client’s ~600-character consent URL survives practice sign-in, query and all', async ({
    page,
    baseURL,
  }) => {
    // Real clients' signed client_ids make consent URLs of 490 to 570
    // characters; this one is 600, past sign-in's old 512-character cap.
    const prefix = 'test-only-long-client-';
    const consent = consentUrl(baseURL, `${prefix}${'x'.repeat(600 - consentUrl(baseURL, prefix).length)}`);
    expect(consent).toHaveLength(600);

    await page.goto(consent);
    await expect(page).toHaveURL(/\/signin\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(consent);
    // The page hands it to the practice button's form as it is.
    await expect(page.locator('form[action="/auth/demo"] input[name="next"]')).toHaveValue(consent);

    await demoSignIn(page);
    await expect(page).toHaveURL(`${baseURL}${consent}`);
    await expect(page.getByRole('heading', { name: 'Practice accounts can’t connect agents.' })).toBeVisible();
  });

  test('a query too long for sign-in’s next comes back bare, and says to start again', async ({ page, context, baseURL }) => {
    // Past sign-in's 2048-character cap on `next`.
    const long = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'c'.repeat(2100) }).toString()}`;
    await page.goto(long);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/oauth/authorize');

    await signInAs(context, baseURL ?? '', REAL);
    await page.goto('/oauth/authorize');
    await expect(page.getByRole('heading', { name: 'Nothing to approve here' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'How to connect an agent' })).toHaveAttribute(
      'href',
      '/connect',
    );
  });

  test('a repeated parameter is refused here, without asking the API', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await page.goto(`${consentUrl(baseURL, 'one')}&client_id=two`);
    await expect(page.getByRole('heading', { name: 'This connection request isn’t valid' })).toBeVisible();
  });

  test('the decision handler takes POST only', async ({ request }) => {
    const response = await request.get('/oauth/authorize/decision', { maxRedirects: 0 });
    expect(response.status()).toBe(405);
  });

  test('a cross-origin POST to the decision handler is 403, even with a session', async ({ context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    const response = await context.request.post('/oauth/authorize/decision', {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      form: consentForm(baseURL, 'any-client', 'allow'),
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    expect(response.headers()['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers()['location']).toBeUndefined();
    expect(await response.text()).toContain('<h1>FORGE didn’t accept that</h1>');
  });

  test('signed out, the decision handler offers sign-in back to the same consent screen', async ({ request, baseURL }) => {
    const response = await request.post('/oauth/authorize/decision', {
      headers: { origin: baseURL ?? '' },
      form: consentForm(baseURL, 'any-client', 'allow'),
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    const html = await response.text();
    expect(html).toContain('<h1>You’re signed out</h1>');
    const href = /href="(\/signin\?next=[^"]+)"/.exec(html)?.[1] ?? '';
    const next = new URL(href.replaceAll('&amp;', '&'), 'https://forge.invalid').searchParams.get('next');
    expect(next).toBe(consentUrl(baseURL, 'any-client'));
  });

  test('a practice session is refused by the decision handler too', async ({ context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    const response = await context.request.post('/oauth/authorize/decision', {
      headers: { origin: baseURL ?? '' },
      form: consentForm(baseURL, 'any-client', 'allow'),
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    expect(await response.text()).toContain('<h1>Practice accounts can’t connect agents.</h1>');
  });
});

// --------------------------------------------------------------------------
// With a stand-in API
// --------------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
  'access-control-expose-headers': 'WWW-Authenticate',
};

/**
 * The API, as far as these tests need it, plus the agent's callback page and,
 * when given, another site's page (`crossSitePage`). `undefined` for anything
 * else, which `withStandIn` cuts off like a closed port.
 */
function standInApi(request: Seen, crossSitePage?: string): Answer | undefined {
  const path = request.path.split('?')[0];
  switch (`${request.method} ${path}`) {
    case 'POST /api/oauth/authorize/check': {
      const { clientId } = JSON.parse(request.body) as { clientId?: string };
      if (clientId === 'unknown-app') {
        return json(400, { error: 'invalid_client', errorDescription: 'FORGE doesn’t know this app.' });
      }
      if (clientId === 'bad-scope-app') {
        return json(400, {
          error: 'invalid_scope',
          errorDescription: 'FORGE has no scope called forge.admin.',
          redirectTo: `${CALLBACK}?error=invalid_scope&state=${STATE}`,
        });
      }
      if (clientId === 'bad-scope-app-quiet') {
        return json(400, { error: 'invalid_scope', redirectTo: `${CALLBACK}?error=invalid_scope&state=${STATE}` });
      }
      if (clientId === 'switched-off') return json(404, { error: 'connector-disabled' });
      if (clientId === 'greedy-app') {
        return json(200, { clientName: 'Greedy', redirectHost: '127.0.0.1', scopes: ['forge.tasks', 'forge.admin'] });
      }
      // A bidi override in the self-declared name, which the page must not let reorder it.
      return json(200, { clientName: 'Stand-in \u202eAgent', redirectHost: '127.0.0.1', scopes: ['forge.tasks'] });
    }
    case 'POST /api/oauth/authorize/approve':
      return json(200, { redirectTo: `${CALLBACK}?code=test-only-code&state=${STATE}` });
    case 'POST /api/oauth/authorize/deny':
      return json(200, { redirectTo: `${CALLBACK}?error=access_denied&state=${STATE}` });
    case 'GET /callback':
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><title>Stand-in agent</title><h1>Back at the agent</h1>',
      };
    case 'GET /cross-site':
      return crossSitePage === undefined
        ? undefined
        : { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: crossSitePage };
    case 'GET /.well-known/oauth-authorization-server':
      return json(200, { issuer: 'stand-in', authorization_endpoint: 'stand-in/oauth/authorize' }, CORS);
    case 'OPTIONS /mcp':
      return { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'POST' } };
    case 'POST /mcp':
      return json(
        401,
        { error: 'invalid_token' },
        { ...CORS, 'www-authenticate': 'Bearer resource_metadata="stand-in", scope="forge.tasks"' },
      );
    // The fallback paths, answered as the API answers `/oauth/register` and `/oauth/token`.
    case 'POST /register':
      return json(201, { client_id: 'test-only-registered-client' }, CORS);
    case 'POST /token':
      return json(400, { error: 'invalid_grant' }, { ...CORS, 'cache-control': 'no-store' });
    default:
      return undefined;
  }
}

const calls = (seen: Seen[], path: string): Seen[] => seen.filter((entry) => entry.path.split('?')[0] === path);

test.describe('with a stand-in API on the demo server’s API port', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test('the consent screen names the app and where it sends you back, and Allow lands there', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async (seen) => {
        const consent = consentUrl(baseURL, 'good-app');
        const response = await page.goto(consent);

        // Never cached, never framed.
        const headers = response?.headers() ?? {};
        expect(headers['cache-control']).toContain('no-store');
        expect(headers['x-frame-options']).toBe('DENY');
        expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");

        await expect(page.getByRole('heading', { name: 'Connect Stand-in Agent to FORGE?', level: 1 })).toBeVisible();
        await expect(page.getByText('It will send you back to 127.0.0.1.')).toBeVisible();
        await expect(page.getByText('That address is this computer, so the app is one running here.')).toBeVisible();
        await expect(page.getByText('“Stand-in Agent” is the name the app gave itself.', { exact: false })).toBeVisible();
        await expect(page.getByText('Claim and release tasks in your name')).toBeVisible();
        await expect(page.getByText('Push code for you')).toBeVisible();
        await expect(page.getByText('Signed in as @consent-check.')).toBeVisible();

        // The API was asked server-side, with the query as AuthorizeParams and no identity.
        const [check] = calls(seen, '/api/oauth/authorize/check');
        expect(check?.authorization).toBeNull();
        expect(JSON.parse(check?.body ?? '{}')).toEqual({
          responseType: 'code',
          clientId: 'good-app',
          redirectUri: CALLBACK,
          codeChallenge: 'test-only-code-challenge-0123456789abcdefghijk',
          codeChallengeMethod: 'S256',
          state: STATE,
          scope: 'forge.tasks',
          resource: `${baseURL}/mcp`,
        });

        await page.getByRole('button', { name: 'Allow' }).click();
        await expect(page).toHaveURL(`${CALLBACK}?code=test-only-code&state=${STATE}`);
        await expect(page.getByRole('heading', { name: 'Back at the agent' })).toBeVisible();

        // Approved as the signed-in visitor, with the same parameters.
        const [approve] = calls(seen, '/api/oauth/authorize/approve');
        expect(assertionClaims(approve?.authorization ?? null)).toMatchObject({
          sub: REAL.sub,
          login: REAL.login,
          iss: 'forge-web',
          aud: 'forge-api',
        });
        expect(JSON.parse(approve?.body ?? '{}')).toEqual(JSON.parse(check?.body ?? '{}'));
        expect(calls(seen, '/api/oauth/authorize/deny')).toHaveLength(0);
      },
    );
  });

  test('Cancel tells the API and lands on its access_denied address', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async (seen) => {
        await page.goto(consentUrl(baseURL, 'good-app'));
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(page).toHaveURL(`${CALLBACK}?error=access_denied&state=${STATE}`);
        expect(calls(seen, '/api/oauth/authorize/deny')).toHaveLength(1);
        expect(calls(seen, '/api/oauth/authorize/approve')).toHaveLength(0);
      },
    );
  });

  test('another site’s form pressing Allow is refused with 403', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    // Another site's page, holding a copy of the consent form with Allow pressed.
    const target = `${baseURL}/oauth/authorize/decision`;
    const fields = Object.entries(consentForm(baseURL, 'good-app', 'allow'))
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('');
    const crossSitePage = `<!doctype html><title>Not FORGE</title><form method="post" action="${target}">${fields}</form>`;
    await withStandIn(
      (request) => standInApi(request, crossSitePage),
      async (seen) => {
        await page.goto(`http://127.0.0.1:${DEMO_API_PORT}/cross-site`);
        const [response] = await Promise.all([
          page.waitForResponse((candidate) => candidate.url() === target),
          page.locator('form').evaluate((form: HTMLFormElement) => form.submit()),
        ]);
        expect(response.status()).toBe(403);
        await expect(page.getByRole('heading', { name: 'FORGE didn’t accept that' })).toBeVisible();
        expect(calls(seen, '/api/oauth/authorize/approve')).toHaveLength(0);
      },
    );
  });

  test('a refusal with no safe address shows an error page and goes nowhere', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async () => {
        const consent = consentUrl(baseURL, 'unknown-app');
        await page.goto(consent);
        await expect(page.getByRole('heading', { name: 'This connection request isn’t valid' })).toBeVisible();
        await expect(page.getByText('What FORGE said: FORGE doesn’t know this app.')).toBeVisible();
        await expect(page).toHaveURL(`${baseURL}${consent}`);
        await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
      },
    );
  });

  test('a refusal the client may hear about is said here, and goes back only when asked to', async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async (seen) => {
        const consent = consentUrl(baseURL, 'bad-scope-app');
        const response = await page.goto(consent);
        // No bounce: the page itself answers, and the browser stays on FORGE (review-oauth M1).
        expect(response?.status()).toBe(200);
        await expect(page).toHaveURL(`${baseURL}${consent}`);
        await expect(
          page.getByRole('heading', { name: 'This connection request can’t go ahead: FORGE has no scope called forge.admin.' }),
        ).toBeVisible();
        const back = page.getByRole('link', { name: `Return to 127.0.0.1:${DEMO_API_PORT}` });
        await expect(back).toHaveAttribute('href', `${CALLBACK}?error=invalid_scope&state=${STATE}`);
        await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);

        await back.click();
        await expect(page).toHaveURL(`${CALLBACK}?error=invalid_scope&state=${STATE}`);
        await expect(page.getByRole('heading', { name: 'Back at the agent' })).toBeVisible();
        expect(calls(seen, '/api/oauth/authorize/approve')).toHaveLength(0);
      },
    );
  });

  test('a refusal with no description still says it can’t go ahead, and waits', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async () => {
        const consent = consentUrl(baseURL, 'bad-scope-app-quiet');
        await page.goto(consent);
        await expect(page.getByRole('heading', { name: 'This connection request can’t go ahead.' })).toBeVisible();
        await expect(page.getByRole('link', { name: `Return to 127.0.0.1:${DEMO_API_PORT}` })).toBeVisible();
        await expect(page).toHaveURL(`${baseURL}${consent}`);
      },
    );
  });

  test('the connector switched off in the API shows the off message', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async () => {
        await page.goto(consentUrl(baseURL, 'switched-off'));
        await expect(page.getByRole('heading', { name: 'The FORGE connector is switched off right now.' })).toBeVisible();
      },
    );
  });

  test('a scope the consent screen can’t describe gets no consent screen', async ({ page, context, baseURL }) => {
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async () => {
        await page.goto(consentUrl(baseURL, 'greedy-app'));
        await expect(page.getByRole('heading', { name: 'FORGE can’t connect agents right now' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
      },
    );
  });

  test('a practice session never reaches the API', async ({ page, context, baseURL }) => {
    await plantPracticeSession(context, baseURL ?? '');
    await withStandIn(
      (request) => standInApi(request),
      async (seen) => {
        await page.goto(consentUrl(baseURL, 'good-app'));
        await expect(page.getByRole('heading', { name: 'Practice accounts can’t connect agents.' })).toBeVisible();
        expect(seen).toHaveLength(0);
      },
    );
  });

  test('the consent screen fits a 390 px screen', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAs(context, baseURL ?? '', REAL);
    await withStandIn(
      (request) => standInApi(request),
      async () => {
        await page.goto(consentUrl(baseURL, 'good-app'));
        await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
        await expectNoSideScroll(page, 390);
      },
    );
  });

  test('the rewrites hand the connector paths to the API, headers and all', async ({ request }) => {
    await withStandIn(
      (entry) => standInApi(entry),
      async (seen) => {
        const metadata = await request.get('/.well-known/oauth-authorization-server');
        expect(metadata.status()).toBe(200);
        expect(metadata.headers()['content-type']).toBe('application/json');
        expect(metadata.headers()['access-control-allow-origin']).toBe('*');
        expect(await metadata.json()).toEqual({ issuer: 'stand-in', authorization_endpoint: 'stand-in/oauth/authorize' });

        const preflight = await request.fetch('/mcp', {
          method: 'OPTIONS',
          headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
        });
        expect(preflight.status()).toBe(204);
        expect(preflight.headers()['access-control-allow-origin']).toBe('*');

        const mcp = await request.post('/mcp', {
          headers: { authorization: 'Bearer test-only-access-token' },
          data: { jsonrpc: '2.0', id: 1, method: 'ping' },
        });
        expect(mcp.status()).toBe(401);
        expect(mcp.headers()['www-authenticate']).toBe('Bearer resource_metadata="stand-in", scope="forge.tasks"');
        expect(await mcp.json()).toEqual({ error: 'invalid_token' });

        const [post] = calls(seen, '/mcp').filter((entry) => entry.method === 'POST');
        expect(post?.authorization).toBe('Bearer test-only-access-token');
        expect(JSON.parse(post?.body ?? '{}')).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
      },
    );
  });

  test('the fallback /register and /token reach the API too', async ({ request }) => {
    await withStandIn(
      (entry) => standInApi(entry),
      async (seen) => {
        const registration = { client_name: 'Fallback client', redirect_uris: ['http://127.0.0.1:5555/callback'] };
        const register = await request.post('/register', { data: registration });
        expect(register.status()).toBe(201);
        expect(register.headers()['access-control-allow-origin']).toBe('*');
        expect(await register.json()).toEqual({ client_id: 'test-only-registered-client' });

        const form = { grant_type: 'refresh_token', refresh_token: 'test-only-refresh-token' };
        const token = await request.post('/token', { form });
        expect(token.status()).toBe(400);
        expect(token.headers()['cache-control']).toBe('no-store');
        expect(await token.json()).toEqual({ error: 'invalid_grant' });

        const [upRegister] = calls(seen, '/register');
        expect(upRegister?.method).toBe('POST');
        expect(upRegister?.headers['content-type']).toContain('application/json');
        expect(JSON.parse(upRegister?.body ?? '{}')).toEqual(registration);
        const [upToken] = calls(seen, '/token');
        expect(upToken?.method).toBe('POST');
        expect(upToken?.headers['content-type']).toContain('application/x-www-form-urlencoded');
        expect(Object.fromEntries(new URLSearchParams(upToken?.body ?? ''))).toEqual(form);
        // The /oauth/ paths were not what got called.
        expect(calls(seen, '/oauth/register')).toHaveLength(0);
        expect(calls(seen, '/oauth/token')).toHaveLength(0);
      },
    );
  });
});

test.describe('the fallback /authorize', () => {
  test('redirects, for now, to the consent page with the same query', async ({ request, baseURL }) => {
    const response = await request.get('/authorize?x=1', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const location = new URL(response.headers()['location'] ?? '', baseURL);
    expect(`${location.origin}${location.pathname}${location.search}`).toBe(`${baseURL}/oauth/authorize?x=1`);
  });

  test('lands on the consent page, behind the same sign-in gate', async ({ page, context, baseURL }) => {
    await page.goto('/authorize?x=1');
    await expect(page).toHaveURL(/\/signin\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/oauth/authorize?x=1');

    await signInAs(context, baseURL ?? '', REAL);
    await page.goto('/authorize?x=1');
    await expect(page).toHaveURL(`${baseURL}/oauth/authorize?x=1`);
    await expect(page.getByRole('heading', { name: 'Nothing to approve here' })).toBeVisible();
  });
});
