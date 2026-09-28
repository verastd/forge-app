import { describe, expect, it } from 'vitest';

import { AuthError } from './index.js';

describe('AuthError', () => {
  it('is an Error with a machine-readable code', () => {
    const error = new AuthError('exchange_failed');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.name).toBe('AuthError');
    expect(error.code).toBe('exchange_failed');
    // With no message given, the code is the message.
    expect(error.message).toBe('exchange_failed');
  });

  it('takes a separate human-readable message', () => {
    const error = new AuthError('weak_secret', 'secrets must be at least 32 characters');

    expect(error.code).toBe('weak_secret');
    expect(error.message).toBe('secrets must be at least 32 characters');
  });

  it('is what callers branch on once caught', async () => {
    await expect(Promise.reject(new AuthError('bad_verification_code'))).rejects.toMatchObject({
      name: 'AuthError',
      code: 'bad_verification_code',
    });
  });
});
