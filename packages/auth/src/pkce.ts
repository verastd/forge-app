/**
 * PKCE (RFC 7636) for the GitHub App's web flow. The verifier stays in the
 * sealed transaction cookie and only its S256 challenge goes to GitHub, so an
 * intercepted authorization code is useless without that cookie.
 */
import { base64url } from 'jose';

import { randomToken } from './random.js';

/** RFC 7636 §4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const encoder = new TextEncoder();

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * The S256 challenge for `verifier`: BASE64URL(SHA-256(ASCII(verifier))),
 * unpadded (RFC 7636 §4.2).
 *
 * @throws RangeError if `verifier` is not a valid RFC 7636 verifier.
 */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    throw new RangeError('pkceChallenge: a verifier is 43 to 128 characters of [A-Za-z0-9._~-] (RFC 7636 §4.1)');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64url.encode(new Uint8Array(digest));
}

/**
 * A fresh verifier and its S256 challenge. The verifier is 32 CSPRNG bytes as
 * base64url, which is exactly 43 characters, the RFC 7636 minimum.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}
