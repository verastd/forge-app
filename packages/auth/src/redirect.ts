/**
 * Where to land after sign-in. `next` arrives in a query string, so it is
 * attacker-controlled: an open redirect here would turn FORGE's own GitHub
 * sign-in into a phishing link. Only same-origin absolute paths get through.
 */
const MAX_LENGTH = 512;

/** A placeholder origin that can never be a real host (RFC 2606 `.invalid`). */
const BASE = 'https://forge.invalid';

/**
 * Printable ASCII (`\x21`-`\x7E`) is all a path may hold, which leaves out:
 * - whitespace and control characters, which the URL parser strips
 *   (`/<TAB>/host` becomes `//host`);
 * - everything non-ASCII: callers put the result straight into a Location
 *   header, where Node throws on it (a 500). Real paths arrive
 *   percent-encoded, so nothing legitimate is lost.
 *
 * The backslash (`\x5C`) is cut out of the range too: browsers read it as
 * `/`, so `/\host` becomes `//host`.
 */
const SAFE_CHARS = /^[\x21-\x5B\x5D-\x7E]*$/;

function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return false;
  // Exactly one leading slash: `//host` is a protocol-relative URL.
  if (value[0] !== '/' || value[1] === '/' || !SAFE_CHARS.test(value)) return false;
  try {
    const url = new URL(value, BASE);
    // The origin check is the final guard. The pathname check catches
    // `/..//host`, which stays same-origin as written but normalizes to
    // `//host`, protocol-relative again once anything re-serializes the path.
    return url.origin === BASE && !url.pathname.startsWith('//');
  } catch {
    return false;
  }
}

/**
 * `input` if it is a same-origin absolute path (at most 512 characters of
 * printable ASCII, starting with exactly one `/`, with no backslash), else
 * `fallback`. The fallback goes through the same rules, and `/` replaces it
 * if it fails them. The value comes back exactly as given, so
 * `safeNext(x) === x` holds for every accepted `x`.
 */
export function safeNext(input: string | null | undefined, fallback = '/'): string {
  if (isSafePath(input)) return input;
  return isSafePath(fallback) ? fallback : '/';
}
