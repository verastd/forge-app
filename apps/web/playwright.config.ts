import { defineConfig, devices } from '@playwright/test';

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
 *   every spec but the live one, and asserts the fixture fallback end to end.
 * - chromium-live (:3101) — what production ships, API deliberately down. Runs
 *   `live-mode.spec.ts`, which asserts that nothing is ever substituted.
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
      testIgnore: /live-mode\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEMO_URL },
    },
    {
      name: 'chromium-live',
      testMatch: /live-mode\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: LIVE_URL },
    },
  ],
  // No `reuseExistingServer`: the env is what makes each of these servers the
  // app it is, and an already-running one on the port could be either.
  webServer: [
    {
      command: `pnpm dev --port ${DEMO_PORT}`,
      env: { NEXT_PUBLIC_FORGE_DEMO: '1', FORGE_DIST_DIR: '.next-e2e-demo' },
      port: DEMO_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm dev --port ${LIVE_PORT}`,
      env: { FORGE_DIST_DIR: '.next-e2e-live' },
      port: LIVE_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
