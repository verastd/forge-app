import { describe, expect, it } from 'vitest';

import * as pkg from './index.js';

describe('package entry point', () => {
  it('exports the client, errors, schemas and param enums', () => {
    expect(typeof pkg.createLedgerClient).toBe('function');
    expect(typeof pkg.paginate).toBe('function');
    expect(typeof pkg.paginateOffset).toBe('function');
    expect(typeof pkg.buildQuery).toBe('function');
    expect(new pkg.LedgerError(400, 'validation_error', 'x', 'ledger', '/a')).toBeInstanceOf(Error);
    expect(pkg.isLedgerError(new Error('x'))).toBe(false);
    expect(typeof pkg.PropertyDetailSchema.parse).toBe('function');
  });

  it('mirrors the ledger enums', () => {
    expect(pkg.QUERY_SOURCES).toHaveLength(12);
    expect(pkg.RATE_METHODS).toContain('weighted_comps');
    expect(pkg.PROPERTY_SORTS[0]).toBe('mint_price_upx');
    expect(pkg.ACCOUNT_SORTS[0]).toBe('events');
    expect(pkg.SIGNAL_TYPES).toContain('regime_shift');
    expect(pkg.ACCOUNT_ROLES).toEqual(['actor', 'receiver', 'notified']);
  });

  it('ANTELOPE_ACCOUNT matches the ledger account validator', () => {
    for (const ok of ['a', 'smfvx4j4dqsb', 'eosio.token', 'abcdefghijkl', 'abcdefghijkla', 'abcdefghijkl5', '............']) {
      expect(pkg.isAntelopeAccount(ok), ok).toBe(true);
    }
    for (const bad of ['', 'ABC', 'abc6', 'abcdefghijklm', 'abcdefghijklz', 'abcdefghijkl12', 'a-b', 'eosio token']) {
      expect(pkg.isAntelopeAccount(bad), bad).toBe(false);
    }
  });
});
