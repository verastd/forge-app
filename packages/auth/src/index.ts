/**
 * @forge/auth — Sign in with GitHub for FORGE.
 *
 * Edge-safe by construction: Next's middleware imports this package, so every
 * module is built on Web APIs (Web Crypto, TextEncoder, fetch) and jose, never
 * on a Node built-in. `eslint.config.mjs` enforces that; the Node-based test
 * run cannot.
 */
export { randomToken } from './random.js';
