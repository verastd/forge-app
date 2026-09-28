import { defineConfig, devices } from '@playwright/test';

import { ASSERTION_SECRET, DEMO_API_PORT, SESSION_SECRET } from '../../tests/e2e/helpers/env';

const DEMO_PORT = 3100;
const LIVE_PORT = 3101;
const DEMO_URL = `http://localhost:${DEMO_PORT}`;
const LIVE_URL = `http://localhost:${LIVE_PORT}`;

/**
 * Two apps, because demo mode is a property of the build, not of the request:
 * `NEXT_PUBLIC_FORGE_DEMO` is inlined into the bundle, so the practice app and
 * the app we deploy are different artefacts and each needs its own server.
 *
 * - chromium-demo (:3100) — the practice build, API deliberately down. Runs
 *   every `*.spec.ts` except `live-*.spec.ts`, and asserts the fixture
 *   fallback end to end, plus sign-in with the practice account.
 * - chromium-live (:3101) — what production ships, API deliberately down.
 *   Runs `live-*.spec.ts`: `live-mode.spec.ts` (nothing is ever substituted)
 *   and `live-auth.spec.ts` (real-shaped GitHub sign-in, sealed directly —
 *   this project alone gets a fake GitHub App config, so the OAuth start and
 *   callback error paths are testable without GitHub).
 *
 * Specs live at the repo root (`tests/e2e`) per PRD Appendix A.1.
 *
 * Isolation constraint, learned the hard way: NEXT_PUBLIC_* is inlined at
 * compile time, and Playwright starts BOTH servers up front — with a shared
 * `.next` the live server intermittently serves demo-compiled chunks (project
 * sequencing cannot fix that; the servers coexist for the whole run). Each
 * server therefore gets its own build dir via FORGE_DIST_DIR
 * (next.config.mjs), which is what makes the two projects safe to run and
 * lets them run without artificial sequencing. `port` rather than `url` for
 * the readiness probe: cheaper, and no route compile just to answer a probe.
 *
 * Test secrets (`FORGE_SESSION_SECRET`, `FORGE_API_ASSERTION_SECRET`) come
 * from `helpers/env.ts`, the one place both this config and
 * `helpers/session.ts` read them from, so a sealed cookie can never drift
 * out of sync with the value the server it's sent to was started with.
 * `FORGE_API_URL` points at a closed local port so the BFF's upstream call
 * fails fast and deterministically (a 502) rather than hanging or reaching
 * a real service. The demo server's port is only closed between tests: the
 * BFF header test in `auth.spec.ts` briefly serves a hostile stand-in API
 * on it (no other demo test ever forwards upstream).
 */
export default defineConfig({
  testDir: '../../tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-demo',
      testIgnore: /live-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEMO_URL },
    },
    {
      name: 'chromium-live',
      testMatch: /live-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: LIVE_URL },
    },
  ],
  // No `reuseExistingServer`: the env is what makes each of these servers the
  // app it is, and an already-running one on the port could be either.
  webServer: [
    {
      command: `pnpm dev --port ${DEMO_PORT}`,
      env: {
        NEXT_PUBLIC_FORGE_DEMO: '1',
        FORGE_DIST_DIR: '.next-e2e-demo',
        FORGE_SESSION_SECRET: SESSION_SECRET,
        FORGE_API_ASSERTION_SECRET: ASSERTION_SECRET,
        FORGE_PUBLIC_ORIGIN: DEMO_URL,
        FORGE_API_URL: `http://127.0.0.1:${DEMO_API_PORT}`,
      },
      port: DEMO_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm dev --port ${LIVE_PORT}`,
      env: {
        FORGE_DIST_DIR: '.next-e2e-live',
        FORGE_SESSION_SECRET: SESSION_SECRET,
        FORGE_API_ASSERTION_SECRET: ASSERTION_SECRET,
        FORGE_PUBLIC_ORIGIN: LIVE_URL,
        FORGE_API_URL: 'http://127.0.0.1:9',
        // Live-only: makes `signInAvailability()` resolve to 'github', so
        // /auth/signin and /auth/callback's error paths are testable without
        // ever reaching github.com.
        GITHUB_APP_CLIENT_ID: 'Iv1.e2e0000000000000',
        GITHUB_APP_CLIENT_SECRET: 'e2e-fake-client-secret',
      },
      port: LIVE_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
