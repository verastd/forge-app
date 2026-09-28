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
  transpilePackages: ['@forge/shared', '@forge/flags', '@forge/auth'],

  // Baseline response headers on every route: no framing (clickjacking on the
  // sign-in and account pages), no MIME sniffing, and no full URLs (the OAuth
  // callback's ?code=&state=) leaked to other origins in Referer.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
