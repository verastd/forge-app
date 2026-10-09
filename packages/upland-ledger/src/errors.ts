/**
 * The one error type the client throws.
 *
 * `source` says who produced it:
 * - `ledger`  — the ledger answered `{"error": {"code", "message"}}` (passed through the gateway unchanged).
 * - `gateway` — the BFF / forge-api gateway answered `{"error": "<code>"}`:
 *               401 signed out, 404 route not allowed or flag off,
 *               502/504 ledger down / timed out, 503 not configured.
 * - `client`  — nothing usable came back: network failure, timeout, abort,
 *               a non-JSON body, or a 2xx body that failed schema validation.
 *
 * The client never substitutes data: on any of these it throws.
 */
export type LedgerErrorSource = 'ledger' | 'gateway' | 'client';

/** Codes the client itself assigns (`source: 'client'`). */
export type ClientErrorCode = 'network_error' | 'timeout' | 'aborted' | 'invalid_response' | 'schema_mismatch';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';

  constructor(
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    /** `validation_error`, `not_found`, a gateway code, or a {@link ClientErrorCode}. */
    readonly code: string,
    message: string,
    readonly source: LedgerErrorSource,
    /** Request path relative to the base URL, e.g. `/properties/123`. */
    readonly path: string,
    /** The parsed body or zod issues, for debugging. Never render it raw. */
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** 401 from the gateway: the session is gone; send the user to sign in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** 404 for a real entity (ledger `not_found`), as opposed to a route the gateway hides. */
  get isNotFound(): boolean {
    return this.status === 404 && this.source === 'ledger';
  }

  /** Worth a retry later: ledger down/timeout, rate limit, network trouble (not 503 not-configured). */
  get isRetryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 504 ||
      this.status === 408 ||
      this.code === 'network_error' ||
      this.code === 'timeout'
    );
  }
}

export function isLedgerError(err: unknown): err is LedgerError {
  return err instanceof LedgerError;
}
