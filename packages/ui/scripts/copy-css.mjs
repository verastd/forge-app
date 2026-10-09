// tsc does not copy stylesheets; components import their sibling .css
// (DataTable's card layout below 640px, AppShell's drawer breakpoint), so
// mirror every src/**/*.css into dist/ after the TypeScript build.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.css') ? [full] : [];
  });

for (const file of walk(path.join(root, 'src'))) {
  const target = path.join(root, 'dist', path.relative(path.join(root, 'src'), file));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
}
