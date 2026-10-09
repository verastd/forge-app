'use client';

/**
 * Entity links. Every account name in the UI goes through AccountLink and
 * every property through PropertyLink, so they lead to the same pages.
 * Accounts, ids and transaction hashes are set in Geist Mono
 * (DESIGN_SYSTEM.md). Transaction ids carry an icon-only copy button with a
 * Hint and a toast outcome.
 */
import Link from 'next/link';
import { Button, Hint } from '@forge/ui';
import { isAntelopeAccount } from '@forge/upland-ledger';

import { LEDGER_BASE } from '../_lib/forge-adapter';
import { NONE, shortHash } from '../_lib/format';
import { useToast } from './toasts';

export const routes = {
  overview: LEDGER_BASE,
  properties: `${LEDGER_BASE}/properties`,
  property: (id: string) => `${LEDGER_BASE}/properties/${encodeURIComponent(id)}`,
  market: `${LEDGER_BASE}/market`,
  opportunities: `${LEDGER_BASE}/opportunities`,
  account: (account: string) => `${LEDGER_BASE}/accounts/${encodeURIComponent(account)}`,
};

export function AccountLink({ account, username }: { account: string | null | undefined; username?: string | null }) {
  if (!account) return <span style={{ color: 'var(--text-muted)' }}>{NONE}</span>;
  const name = username && username !== account ? username : null;
  const text = (
    <>
      <span className="em-mono">{account}</span>
      {name && <span style={{ color: 'var(--text-secondary)' }}> · {name}</span>}
    </>
  );
  return isAntelopeAccount(account) ? <Link href={routes.account(account)}>{text}</Link> : <span>{text}</span>;
}

export function PropertyLink({ id, label }: { id: string; label?: string }) {
  return <Link href={routes.property(id)}>{label && label.trim() !== '' ? label : `#${id}`}</Link>;
}

export function TrxId({ id }: { id: string }) {
  const toast = useToast();
  if (!id) return <span style={{ color: 'var(--text-muted)' }}>{NONE}</span>;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      toast({ variant: 'success', title: 'Transaction id copied', dedupeKey: 'copied' });
    } catch {
      toast({ variant: 'error', title: 'Couldn’t copy the transaction id', description: 'Your browser blocked the clipboard. Select the id and copy it instead.' });
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <span className="em-mono" title={id}>
        <span aria-hidden="true">{shortHash(id)}</span>
        <span className="em-sr">{id}</span>
      </span>
      <Hint content="Copy transaction id">
        <Button variant="ghost" size="dense" icon="copy" aria-label="Copy transaction id" onClick={() => void copy()} style={{ height: 24, width: 24 }} />
      </Hint>
    </span>
  );
}
