// Coverage config for Gauntlet G2.2 only — plain `vitest run` ignores it.
// tools/forge/coverage-gate.sh reads <pkg>/coverage/coverage-final.json, so
// the `json` reporter and this reportsDirectory are a contract, not a
// preference. `all: true` is load-bearing: a new source file with no test at
// all must show up as uncovered rather than be absent from the report.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["json", "text"],
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**"],
      reportsDirectory: "coverage",
      // The lobby's geometry, registry and CSP helpers are what the scene, the
      // shell and next.config.mjs all trust: a floor here, on top of the
      // changed-line gate, so coverage can't erode one small PR at a time.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
