/**
 * Whether the settings for FORGE's OAuth App ("your copy" and "Send for
 * review", Phase 7) are usable: one pure function of the environment, read by
 * `./config`'s `githubRepoConfig()`. Dependency-free like `./api-url`, so the
 * e2e suite tests the rules on their own (tests/e2e/repo-flow.spec.ts).
 */

/** An OAuth App's client id as GitHub issues them: letters, digits, `.`, `_` and `-`. */
const OAUTH_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A client secret: printable ASCII with no spaces, so Basic auth can always carry it. */
const OAUTH_CLIENT_SECRET = /^[\x21-\x7E]{1,200}$/;

/** The raw settings {@link repoAppSettings} reads. */
export interface RepoAppEnv {
  /** GITHUB_REPO_CLIENT_ID. */
  clientId: string | undefined;
  /** GITHUB_REPO_CLIENT_SECRET. */
  clientSecret: string | undefined;
  /** GITHUB_APP_CLIENT_ID: the sign-in App, which can't stand in for the OAuth App. */
  signInClientId: string | undefined;
  /** `publicOrigin()`. */
  origin: string | null;
}

/** The OAuth App, as the routes use it. */
export interface RepoAppSettings {
  clientId: string;
  clientSecret: string;
  origin: string;
}

/**
 * The OAuth App settings in `env`, or null unless they are usable: a client
 * id and secret of the shapes GitHub issues (the secret as printable ASCII,
 * so it fits Basic auth when the token is revoked), a client id that isn't
 * the sign-in App's own, and a public origin for the callback.
 */
export function repoAppSettings({ clientId, clientSecret, signInClientId, origin }: RepoAppEnv): RepoAppSettings | null {
  if (clientId === undefined || !OAUTH_CLIENT_ID.test(clientId)) return null;
  if (clientSecret === undefined || !OAUTH_CLIENT_SECRET.test(clientSecret)) return null;
  if (clientId === signInClientId || origin === null) return null;
  return { clientId, clientSecret, origin };
}
