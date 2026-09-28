/**
 * Unguessable tokens for the sign-in flow (OAuth `state`, the PKCE verifier).
 * Web Crypto only, so it runs unchanged in Next's Edge middleware.
 */
import { base64url } from 'jose';

/** Web Crypto's per-call quota: `getRandomValues` refuses anything larger. */
const MAX_BYTES = 65_536;

/**
 * `bytes` of CSPRNG output as unpadded base64url (RFC 4648 §5), safe as-is in
 * a URL, a header or a cookie. The default 32 bytes (256 bits) encodes to 43
 * characters.
 *
 * @throws RangeError unless `bytes` is an integer from 1 to 65,536. Zero is
 *   refused on purpose: an empty token would compare equal to an empty one.
 */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) {
    throw new RangeError(`randomToken: bytes must be an integer from 1 to ${MAX_BYTES}, got ${bytes}`);
  }
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}
