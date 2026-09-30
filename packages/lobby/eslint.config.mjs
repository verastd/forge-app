// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @forge/lobby is the Apps lobby's pure logic. The three.js scene, the React
// shell and next.config.mjs's headers() all import it, and vitest runs it in
// Node, so it has to stay plain TypeScript that runs anywhere: no DOM, no
// three.js or React, no Node built-ins, and no runtime dependencies at all.
// tsconfig.json drops the DOM lib and ambient @types, so the type checker
// catches most slips. These rules catch the rest: a bare import, a global
// reached some other way, and a clock or an unseeded random number, either of
// which would make the layout, the camera or the presence maths non-deterministic.
const PURE =
  '@forge/lobby is pure logic: import only its own modules (relative paths), with no three.js, React, DOM, Node built-ins or runtime dependencies.';
const DETERMINISTIC =
  '@forge/lobby must be deterministic: no clocks and no unseeded randomness (callers pass the time and any seed in).';

// Globals that exist in a browser or in Node but not in plain ECMAScript.
const HOST_GLOBALS = [
  // DOM and browser
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'self',
  'HTMLElement',
  'Element',
  'Image',
  'OffscreenCanvas',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'getComputedStyle',
  'devicePixelRatio',
  'innerWidth',
  'innerHeight',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  // timers and I/O
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'performance',
  'console',
  // Node
  'process',
  'Buffer',
  'global',
  'require',
  'module',
  '__dirname',
  '__filename',
];

const restrictGlobals = (names) => ['error', ...names.map((name) => ({ name, message: PURE }))];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: DETERMINISTIC },
        { object: 'Date', property: 'now', message: DETERMINISTIC },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: DETERMINISTIC },
        { selector: 'ImportExpression', message: PURE },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\.\\.?/)', message: PURE }] }],
      // `URL` too: registry.ts parses framed routes itself, strictly, rather
      // than inherit the WHATWG parser's forgiveness (stripped tabs and
      // newlines, backslashes read as slashes, default ports dropped).
      'no-restricted-globals': restrictGlobals([...HOST_GLOBALS, 'globalThis', 'URL', 'URLSearchParams']),
    },
  },
  {
    // Tests may reach the WHATWG URL parser through globalThis, to check the
    // registry's own parsing against it, and nothing else from the host.
    files: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(?!\\.\\.?/|vitest$)', message: `${PURE} Tests may also import vitest.` }] },
      ],
      'no-restricted-globals': restrictGlobals(HOST_GLOBALS),
    },
  },
);
