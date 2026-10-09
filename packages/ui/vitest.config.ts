// Coverage config for Gauntlet G2.2 only — plain `vitest run` ignores it.
// tools/forge/coverage-gate.sh reads <pkg>/coverage/coverage-final.json, so
// the `json` reporter and this reportsDirectory are a contract. `all: true`
// keeps an untested component visible as uncovered rather than absent.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test-setup.ts', 'dist/**'],
      reportsDirectory: 'coverage',
    },
  },
});
