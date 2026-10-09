// Unit tests for the Upland Ledger UI's data layer (hooks' core, formatters,
// transforms). Node environment: everything under test is plain TS, and the
// captured ledger responses in @forge/upland-ledger/examples are the fixtures.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/app/apps/ledger/**/*.test.ts'],
  },
});
