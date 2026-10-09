import { URL } from 'node:url';

/**
 * The FORGE connector's public paths (contract §1). They live on this origin,
 * so the URL people give their agent survives an API move, but the API
 * answers them: a `beforeFiles` rewrite proxies each one (method, headers and
 * body) to the same path on FORGE_API_URL. Exact paths, no patterns, so
 * nothing else is ever proxied. `/oauth/authorize` and
 * `/oauth/authorize/decision` are not here: they are this app's own consent
 * page and its form handler (src/app/oauth/authorize).
 *
 * `/register` and `/token` are MCP 2025-03-26's fallback paths, for a client
 * that has lost the metadata (the MCP Python SDK refreshes at `/token` after a
 * restart). The API answers them with the `/oauth/` handlers, and the
 * metadata never names them. Their `/authorize` is a redirect (below).
 */
export const CONNECTOR_PATHS = Object.freeze([
  '/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
  '/register',
  '/token',
]);

/**
 * The hosts plain `http:` may reach: this computer. Anywhere else, what goes
 * to the API (pasted agent keys, the Copilot token, assertions) needs https.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `raw` as a proxy base (origin plus any base path, no trailing slash), or
 * null unless it is an absolute https URL (plain http only to localhost or
 * 127.0.0.1) with no credentials, query or fragment. Next compiles a
 * destination's host and path as patterns (`:name`, `(`, `*`), so only plain
 * host and path characters get through; that also leaves out IPv6 literals.
 *
 * @param {string | undefined} raw
 * @returns {string | null}
 */
function connectorApiBase(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._~/-]*$/.test(path)) return null;
  return `${url.origin}${path}`;
}

/**
 * The connector rewrites for FORGE_API_URL `raw`, or none when it is unset or
 * not a usable http(s) URL. Next reads rewrites once, when `next dev` starts
 * or `next build` runs, so FORGE_API_URL must be set at build time.
 *
 * @param {string | undefined} raw
 * @returns {{ source: string, destination: string }[]}
 */
export function connectorRewrites(raw) {
  const base = connectorApiBase(raw);
  if (base === null) return [];
  return CONNECTOR_PATHS.map((path) => ({ source: path, destination: `${base}${path}` }));
}

/**
 * `raw`'s origin when it parses as one of `schemes`, else null.
 *
 * @param {string | undefined} raw
 * @param {readonly string[]} schemes
 * @returns {URL | null}
 */
function parsedOrigin(raw, schemes) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return schemes.includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * Everywhere a page on this site may open a connection to (CSP
 * `connect-src`), so script that got in can't send a pasted key anywhere
 * else:
 * - this origin: the BFF, the lobby's token route, Next's own requests (and,
 *   under `next dev`, its hot-reload socket);
 * - the API the browser reads from while signed out, and the flags:
 *   NEXT_PUBLIC_API_URL, or the `http://localhost:8000` that lib/api.ts and
 *   @forge/flags fall back to;
 * - the lobby's LiveKit server (LIVEKIT_URL): its signal socket and the https
 *   endpoints livekit-client checks on the same host (region settings, the
 *   connection check). Only that host: LiveKit Cloud's other regions are left
 *   out, so a failed join stays failed rather than trying another region.
 *
 * Both values are read when `next dev` starts or `next build` runs, like the
 * rest of this file's headers, so set them at build time.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function connectSources(env) {
  const sources = ["'self'"];
  const api = parsedOrigin(env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000', ['https:', 'http:']);
  if (api !== null) sources.push(api.origin);
  const livekit = parsedOrigin(env.LIVEKIT_URL, ['wss:', 'ws:', 'https:', 'http:']);
  if (livekit !== null) {
    const secure = livekit.protocol === 'wss:' || livekit.protocol === 'https:';
    sources.push(`${secure ? 'wss' : 'ws'}://${livekit.host}`, `${secure ? 'https' : 'http'}://${livekit.host}`);
  }
  return [...new Set(sources)];
}

/**
 * The site-wide Content-Security-Policy: never framed (clickjacking on the
 * sign-in, account and consent pages), and connections only to
 * {@link connectSources}.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function contentSecurityPolicy(env) {
  return `frame-ancestors 'none'; connect-src ${connectSources(env).join(' ')}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // NEXT_PUBLIC_* is inlined at compile time, so two dev servers with
  // different env must never share a build dir — compiled chunks carry the
  // OTHER server's app. Playwright gives each e2e server its own dir via
  // FORGE_DIST_DIR (see playwright.config.ts); unset means the normal
  // `.next`, so `next build` and plain `pnpm dev` are unaffected.
  distDir: process.env.FORGE_DIST_DIR ?? '.next',

  // Practice sign-in is decided at build time. Next inlines a NEXT_PUBLIC_*
  // variable only if it is set when compiling; unset, server code (the
  // middleware included) would read it at runtime, and setting it on a live
  // deployment would switch practice sign-in on. Listing it here inlines
  // it always, as '' when unset, so a live build can never become a demo one.
  env: { NEXT_PUBLIC_FORGE_DEMO: process.env.NEXT_PUBLIC_FORGE_DEMO ?? '' },

  // Workspace packages ship pre-built ESM to dist/, but transpiling them here
  // keeps pnpm's symlinked node_modules layout working the same in dev, in
  // `next build`, and under Playwright.
  //
  // No webpack aliasing is needed for `@forge/flags`: its browser-reachable
  // modules (`./core`, `./react`) import no node built-ins, and `loadFlags`
  // pulls `node:fs/promises`/`node:path` in dynamically from server code only.
  // `@forge/auth` imports none at all (its eslint config enforces it), because
  // Edge middleware imports it.
  transpilePackages: ['@forge/shared', '@forge/flags', '@forge/auth', '@forge/lobby', '@forge/upland-ledger', 'three'],

  // Baseline response headers on every route: no framing (clickjacking on the
  // sign-in and account pages) and connections only where the site needs them
  // (contentSecurityPolicy), no MIME sniffing, and no full URLs (the OAuth
  // callback's ?code=&state=) leaked to other origins in Referer.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy(process.env) },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The connector's consent page and its Allow/Cancel handler (contract
        // §9): never stored by a browser or proxy, and never framed, for the
        // browsers that predate CSP's frame-ancestors too. `:path*` matches
        // /oauth/authorize itself as well. Proxied connector paths are not
        // touched here: the rule above is harmless to their JSON, and the API
        // sets their caching itself.
        source: '/oauth/authorize/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },

  // The FORGE connector (see CONNECTOR_PATHS). `beforeFiles`, so the
  // proxy wins over any page or file at the same path.
  async rewrites() {
    const raw = process.env.FORGE_API_URL;
    const beforeFiles = connectorRewrites(raw);
    if (raw && beforeFiles.length === 0) {
      // Never the value itself: it is configuration, and may carry more than a host.
      console.error(
        'FORGE_API_URL is not an https URL (plain http only to localhost or 127.0.0.1) without credentials, query or fragment, so the FORGE connector paths (/mcp, /oauth/token, ...) are not proxied',
      );
    }
    return { beforeFiles, afterFiles: [], fallback: [] };
  },

  // Phase 2 restructure: History is gone and Upland moved under /apps/data,
  // so old links (bookmarks, issues, external references) get a permanent
  // redirect instead of a 404.
  //
  // `/authorize` is the third MCP 2025-03-26 fallback path (see
  // CONNECTOR_PATHS): the consent page, with the query passed through
  // unchanged. Redirects run before the middleware, so its sign-in gate
  // applies at /oauth/authorize as usual. Not permanent: browsers cache 308s.
  async redirects() {
    return [
      { source: '/history', destination: '/apps/data', permanent: true },
      { source: '/upland', destination: '/apps/data', permanent: true },
      { source: '/upland/:path*', destination: '/apps/data/:path*', permanent: true },
      { source: '/contribute/profile', destination: '/me', permanent: true },
      { source: '/authorize', destination: '/oauth/authorize', permanent: false },
    ];
  },
};

export default nextConfig;
