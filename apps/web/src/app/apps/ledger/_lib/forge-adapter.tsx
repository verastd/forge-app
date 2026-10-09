'use client';

/**
 * The ONLY file in the ledger UI that imports FORGE itself. Everything else
 * in apps/ledger imports from `@forge/upland-ledger`, React/Next and files in
 * this tree. To move the UI to its own repo, rewrite this file against that
 * repo's session, flags and chrome; nothing else needs to change.
 *
 * It provides:
 * - `useLedgerFlag()`: the `upland_ledger` feature flag, failing closed;
 * - `useViewer()`: who is looking (signed out, the practice account, or a
 *   real member), which decides what the sign-in prompt can offer;
 * - `SIGN_IN_HREF` and `LOBBY_HREF`;
 * - `HostAccountControls`: the host app's notification bell and account menu.
 */

import { useFlags } from '@forge/flags/react';

import { AccountMenu } from '../../../../components/AccountMenu';
import { NotificationBell } from '../../../../components/NotificationBell';
import { useSession } from '../../../../components/SessionProvider';
import { demoFlagFallback } from '../../../../lib/flags';

export const LEDGER_BASE = '/apps/ledger';
export const SIGN_IN_HREF = `/signin?next=${encodeURIComponent(LEDGER_BASE)}`;
export const LOBBY_HREF = '/apps?from=ledger';
export const PRODUCT_NAME = 'Upland Ledger';

export interface LedgerFlag {
  loading: boolean;
  enabled: boolean;
}

/**
 * Flags fail closed: an unreachable flag service reads exactly like the
 * switch being off. The practice build's all-on fallback applies here as it
 * does for every app; the practice account still gets a 401 from the BFF,
 * so it sees the sign-in prompt, never data.
 */
export function useLedgerFlag(): LedgerFlag {
  const { flags, loading } = useFlags(demoFlagFallback());
  return { loading, enabled: flags.upland_ledger };
}

export type Viewer = 'signed-out' | 'practice' | 'member';

export function useViewer(): Viewer {
  const { session } = useSession();
  if (session === null) return 'signed-out';
  return session.demo ? 'practice' : 'member';
}

export function HostAccountControls() {
  return (
    <>
      <NotificationBell />
      <AccountMenu />
    </>
  );
}
