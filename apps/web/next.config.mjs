/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // NEXT_PUBLIC_* is inlined at compile time, so two dev servers with
  // different env must never share a build dir — compiled chunks carry the
  // OTHER server's app. Playwright gives each e2e server its own dir via
  // FORGE_DIST_DIR (see playwright.config.ts); unset means the normal
  // `.next`, so `next build` and plain `pnpm dev` are unaffected.
  distDir: process.env.FORGE_DIST_DIR ?? '.next',

  // Workspace packages ship pre-built ESM to dist/, but transpiling them here
  // keeps pnpm's symlinked node_modules layout working the same in dev, in
  // `next build`, and under Playwright.
  //
  // No webpack aliasing is needed for `@forge/flags`: its browser-reachable
  // modules (`./core`, `./react`) import no node built-ins, and `loadFlags`
  // pulls `node:fs/promises`/`node:path` in dynamically from server code only.
  transpilePackages: ['@forge/shared', '@forge/flags'],
};

export default nextConfig;
