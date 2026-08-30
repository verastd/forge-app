import { describe, expect, it } from 'vitest';

import { createContractsClient, MockContractsClient } from './index.js';

describe('MockContractsClient.getTokenBalance', () => {
  it('is deterministic: the same address twice yields the same balance', async () => {
    const client = new MockContractsClient();
    const first = await client.getTokenBalance('0xAbC1230000000000000000000000000000dEaD');
    const second = await client.getTokenBalance('0xAbC1230000000000000000000000000000dEaD');
    expect(second.raw).toBe(first.raw);
    expect(second.formatted).toBe(first.formatted);
  });

  it('is deterministic across separate client instances', async () => {
    const a = await new MockContractsClient().getTokenBalance('0x1111111111111111111111111111111111111');
    const b = await new MockContractsClient().getTokenBalance('0x1111111111111111111111111111111111111');
    expect(a).toEqual(b);
  });

  it('is case-insensitive on the address', async () => {
    const client = new MockContractsClient();
    const lower = await client.getTokenBalance('0xabc');
    const upper = await client.getTokenBalance('0xABC');
    expect(upper.raw).toBe(lower.raw);
  });

  it('produces (almost certainly) different balances for different addresses', async () => {
    const client = new MockContractsClient();
    const a = await client.getTokenBalance('address-one');
    const b = await client.getTokenBalance('address-two');
    expect(a.raw).not.toBe(b.raw);
  });

  it('returns a formatted string consistent with the raw bigint', async () => {
    const client = new MockContractsClient();
    const { raw, formatted } = await client.getTokenBalance('0xdeadbeef');
    expect(typeof raw).toBe('bigint');
    expect(formatted).toMatch(/^\d+(\.\d+)?$/);
  });
});

describe('MockContractsClient.getTokenSupply', () => {
  it('returns a fixed value on every call', async () => {
    const client = new MockContractsClient();
    const first = await client.getTokenSupply();
    const second = await client.getTokenSupply();
    expect(second.raw).toBe(first.raw);
    expect(second.formatted).toBe(first.formatted);
  });

  it('is fixed across separate client instances too', async () => {
    const a = await new MockContractsClient().getTokenSupply();
    const b = await new MockContractsClient().getTokenSupply();
    expect(a).toEqual(b);
  });
});

describe('MockContractsClient.getRecentTransfers', () => {
  it('defaults to 10 transfers', async () => {
    const client = new MockContractsClient();
    const transfers = await client.getRecentTransfers();
    expect(transfers).toHaveLength(10);
  });

  it('respects an explicit limit', async () => {
    const client = new MockContractsClient();
    const transfers = await client.getRecentTransfers(3);
    expect(transfers).toHaveLength(3);
  });

  it('returns the same seeded transfers across separate client instances', async () => {
    const a = await new MockContractsClient().getRecentTransfers(5);
    const b = await new MockContractsClient().getRecentTransfers(5);
    expect(a).toEqual(b);
  });

  it('returns well-shaped transfer records', async () => {
    const client = new MockContractsClient();
    const [transfer] = await client.getRecentTransfers(1);
    expect(transfer).toBeDefined();
    expect(typeof transfer?.from).toBe('string');
    expect(typeof transfer?.to).toBe('string');
    expect(typeof transfer?.amount).toBe('string');
    expect(() => new Date(transfer?.ts ?? '')).not.toThrow();
    expect(Number.isNaN(new Date(transfer?.ts ?? '').getTime())).toBe(false);
  });
});

describe('createContractsClient', () => {
  it('returns a working MockContractsClient in mock mode', async () => {
    const client = createContractsClient({ mode: 'mock' });
    expect(client).toBeInstanceOf(MockContractsClient);
    const supply = await client.getTokenSupply();
    expect(typeof supply.raw).toBe('bigint');
  });

  it('throws the exact cold-account review message in live mode', () => {
    expect(() => createContractsClient({ mode: 'live', rpcUrl: 'https://rpc.example.com' })).toThrow(
      'live mode requires cold-account review — see CODEOWNERS /packages/contracts-client and PRD §H.1; no chain SDK is wired in Phase 0',
    );
  });
});
