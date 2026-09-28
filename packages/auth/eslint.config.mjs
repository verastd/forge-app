// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @forge/auth is imported by Next's Edge middleware, where Node built-ins do
// not exist. vitest runs on Node, where they do, so the test suite alone would
// never notice one slipping in: this guard is the only thing that does. Web
// APIs (crypto.subtle, crypto.getRandomValues, TextEncoder, fetch, URL) and
// jose only. No `/` in the pattern: it doubles as an esquery regex below.
const NODE_BUILTIN =
  '^(?:node:|(?:assert|async_hooks|buffer|child_process|crypto|dns|events|fs|http|https|net|os|path|perf_hooks|querystring|stream|string_decoder|timers|tls|url|util|vm|worker_threads|zlib)(?:$|[^\\w.-]))';
const EDGE_ONLY =
  '@forge/auth runs in Edge middleware: use Web APIs (crypto.subtle, TextEncoder, fetch) or jose, never Node built-ins.';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { patterns: [{ regex: NODE_BUILTIN, message: EDGE_ONLY }] }],
      'no-restricted-syntax': [
        'error',
        { selector: `ImportExpression[source.value=/${NODE_BUILTIN}/]`, message: EDGE_ONLY },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'global', 'require', '__dirname', '__filename'].map((name) => ({
          name,
          message: EDGE_ONLY,
        })),
      ],
    },
  },
);
