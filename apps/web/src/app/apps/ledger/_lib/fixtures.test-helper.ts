/**
 * Test-only: the real ledger responses captured in `@forge/upland-ledger`'s
 * `examples/` (2026-10-09), parsed with the package's own schemas so a
 * fixture can never drift from the contract the UI is typed against.
 * Located through the package itself, so this works wherever the package
 * is installed (this repo or a future standalone one).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const EXAMPLES = path.join(path.dirname(require.resolve('@forge/upland-ledger')), '..', 'examples');

export function example(name: string): unknown {
  return JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8')) as unknown;
}

export function fixture<T>(name: string, schema: { parse: (value: unknown) => T }): T {
  return schema.parse(example(name));
}
