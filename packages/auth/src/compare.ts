/**
 * Equality for secrets, such as the OAuth `state` GitHub echoes back against
 * the one sealed in the transaction cookie. Its running time does not depend
 * on where two same-length values differ, so it leaks nothing about how close
 * a guess was.
 */
const encoder = new TextEncoder();

/**
 * Lone surrogates: TextEncoder turns every one into U+FFFD, so two different
 * ill-formed strings would encode to the same bytes.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Whether `a` and `b` are the same string, compared as UTF-8 bytes through an
 * XOR accumulator with no early exit on content. A length mismatch returns at
 * once, because lengths are not secret (`state` is always 43 characters).
 * Ill-formed strings (lone surrogates) and non-strings never compare equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (LONE_SURROGATE.test(a) || LONE_SURROGATE.test(b)) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    // Both indexes are in range: the lengths are equal.
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}
