import { describe, expect, it } from 'vitest';

import { createPkcePair, pkceChallenge } from './index.js';

/** 32 bytes as unpadded base64url: the verifier, and a SHA-256 challenge, are both this. */
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe('pkceChallenge', () => {
  it('matches the RFC 7636 Appendix B example', async () => {
    await expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('accepts the whole RFC 7636 length range and alphabet', async () => {
    await expect(pkceChallenge('a'.repeat(43))).resolves.toMatch(BASE64URL_43);
    await expect(pkceChallenge('Az09-._~'.repeat(16))).resolves.toMatch(BASE64URL_43);
  });

  it.each([
    ['is empty', ''],
    ['is 42 characters', 'a'.repeat(42)],
    ['is 129 characters', 'a'.repeat(129)],
    ['has a +', `${'a'.repeat(42)}+`],
    ['has a /', `${'a'.repeat(42)}/`],
    ['has padding', `${'a'.repeat(42)}=`],
    ['has a space', `${'a'.repeat(21)} ${'a'.repeat(21)}`],
    ['has a non-ASCII character', `${'a'.repeat(42)}é`],
  ])('rejects a verifier that %s', async (_label, verifier) => {
    await expect(pkceChallenge(verifier)).rejects.toThrow(RangeError);
  });

  it('rejects a non-string verifier', async () => {
    await expect(pkceChallenge(undefined as unknown as string)).rejects.toThrow(RangeError);
  });
});

describe('createPkcePair', () => {
  it('makes a 43-character base64url verifier and its S256 challenge', async () => {
    const { verifier, challenge } = await createPkcePair();

    expect(verifier).toMatch(BASE64URL_43);
    expect(challenge).toMatch(BASE64URL_43);
    expect(challenge).not.toBe(verifier);
    await expect(pkceChallenge(verifier)).resolves.toBe(challenge);
  });

  it('never makes the same pair twice', async () => {
    const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);

    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
