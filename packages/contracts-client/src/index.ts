/**
 * @forge/contracts-client — typed chain-interaction layer for FORGE.
 *
 * PRD Appendix H.1 isolation rule: this is the ONLY module in the
 * monorepo allowed to import a chain SDK. See README.md for the cold-account
 * path and tier-floor T2 that gate changes here (CODEOWNERS
 * /packages/contracts-client).
 *
 * Zero runtime dependencies: Node built-ins only.
 */
import { createHash } from 'node:crypto';

export interface TokenAmount {
  raw: bigint;
  formatted: string;
}

export interface TransferRecord {
  from: string;
  to: string;
  amount: string;
  ts: string;
}

export interface ContractsClient {
  getTokenBalance(address: string): Promise<TokenAmount>;
  getTokenSupply(): Promise<TokenAmount>;
  getRecentTransfers(limit?: number): Promise<TransferRecord[]>;
}

const DECIMALS = 18;
const UNIT = 10n ** BigInt(DECIMALS);

/** Deterministic 64-bit-ish bigint derived from a seed string (sha256-based, no randomness). */
function seededBigInt(seed: string): bigint {
  const digest = createHash('sha256').update(seed).digest('hex');
  return BigInt(`0x${digest.slice(0, 16)}`);
}

/** Deterministic 20-byte hex "address" derived from a seed string. */
function seededAddress(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  return `0x${digest.slice(0, 40)}`;
}

/** Render a raw base-unit bigint as a decimal string with `decimals` places. */
function formatUnits(raw: bigint, decimals: number = DECIMALS): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

const MOCK_TOTAL_SUPPLY = 1_000_000_000n * UNIT;
const MOCK_BALANCE_CAP = 1_000_000n * UNIT;
const MOCK_TRANSFER_CAP = 1_000n * UNIT;
const MOCK_TRANSFER_COUNT = 25;
const MOCK_TRANSFER_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

function buildSeededTransfers(): TransferRecord[] {
  const transfers: TransferRecord[] = [];
  for (let i = 0; i < MOCK_TRANSFER_COUNT; i += 1) {
    const raw = seededBigInt(`forge-mock-amount-${i}`) % MOCK_TRANSFER_CAP;
    transfers.push({
      from: seededAddress(`forge-mock-from-${i}`),
      to: seededAddress(`forge-mock-to-${i}`),
      amount: formatUnits(raw),
      ts: new Date(MOCK_TRANSFER_EPOCH_MS + i * 3_600_000).toISOString(),
    });
  }
  return transfers;
}

/**
 * Deterministic, synthetic {@link ContractsClient}: same input always
 * produces the same output, with no network access. Safe for local dev,
 * tests, and the Phase 0 beta/testnet app.
 */
export class MockContractsClient implements ContractsClient {
  private readonly transfers: TransferRecord[] = buildSeededTransfers();

  async getTokenBalance(address: string): Promise<TokenAmount> {
    const raw = seededBigInt(address.toLowerCase()) % MOCK_BALANCE_CAP;
    return { raw, formatted: formatUnits(raw) };
  }

  async getTokenSupply(): Promise<TokenAmount> {
    return { raw: MOCK_TOTAL_SUPPLY, formatted: formatUnits(MOCK_TOTAL_SUPPLY) };
  }

  async getRecentTransfers(limit = 10): Promise<TransferRecord[]> {
    return this.transfers.slice(0, limit);
  }
}

export type ContractsClientOptions = { mode: 'mock' } | { mode: 'live'; rpcUrl: string };

/**
 * Factory for the app's {@link ContractsClient}. `mode: 'live'` always
 * throws in Phase 0 — see README.md for why, and what has to happen
 * (cold-account CODEOWNERS review) before it can be wired up.
 */
export function createContractsClient(opts: ContractsClientOptions): ContractsClient {
  if (opts.mode === 'live') {
    throw new Error(
      'live mode requires cold-account review — see CODEOWNERS /packages/contracts-client and PRD §H.1; no chain SDK is wired in Phase 0',
    );
  }
  return new MockContractsClient();
}
