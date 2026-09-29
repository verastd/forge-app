/**
 * The one error type for expected sign-in failures: GitHub refusing a code, an
 * unreadable `/user` response, a secret too short to trust. Callers branch on
 * `code`, a stable snake_case string. `message` is for logs and never carries
 * a client secret, an authorization code or a token.
 */
export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string = code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
