/**
 * The one ledger client the UI uses. It talks only to the same-origin BFF
 * (`/bff/ledger/*`, the package default); nothing in this tree builds an
 * upstream URL of its own.
 */
import { createLedgerClient } from '@forge/upland-ledger';
import type { LedgerClient } from '@forge/upland-ledger';

let client: LedgerClient | null = null;

export function ledgerClient(): LedgerClient {
  client ??= createLedgerClient();
  return client;
}
