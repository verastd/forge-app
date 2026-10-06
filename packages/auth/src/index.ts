/**
 * @forge/auth — Sign in with GitHub for FORGE.
 *
 * Edge-safe by construction: Next's middleware imports this package, so every
 * module is built on Web APIs (Web Crypto, TextEncoder, fetch) and jose, never
 * on a Node built-in. `eslint.config.mjs` enforces that; the Node-based test
 * run cannot.
 */
export { mintApiAssertion } from './assertion.js';
export type { ApiIdentity, AssertionOptions } from './assertion.js';
export { constantTimeEqual } from './compare.js';
export { COOKIE, cookieOptions, SESSION_TTL_SECONDS, TRANSACTION_TTL_SECONDS } from './cookies.js';
export type { CookieKind, CookieOptions } from './cookies.js';
export { AuthError } from './errors.js';
export {
  authorizeUrl,
  exchangeCode,
  fetchGitHubUser,
  PUBLIC_REPO_SCOPE,
  publicRepoAuthorizeUrl,
  revokeGitHubToken,
} from './github.js';
export type { AuthorizeUrlParams, ExchangeCodeParams, FetchLike, GitHubUser, RevokeTokenParams } from './github.js';
export { acceptSession, DEV_SESSION_SECRET, resolveSessionKeys, sessionAllowed } from './keys.js';
export type { AcceptOptions, NoSessionKeys, SessionKeyEnv, SessionKeys } from './keys.js';
export { createPkcePair, pkceChallenge } from './pkce.js';
export type { PkcePair } from './pkce.js';
export { randomToken } from './random.js';
export { safeNext } from './redirect.js';
export { MIN_SECRET_LENGTH, openSession, sealSession } from './session.js';
export type { SessionClaims, SessionInput, TimeOptions } from './session.js';
export { isRepoAction, openTransaction, REPO_ACTIONS, sealTransaction } from './transaction.js';
export type {
  AgentAttempt,
  RepoAction,
  RepoAttempt,
  SignInAttempt,
  TransactionClaims,
  TransactionInput,
} from './transaction.js';
