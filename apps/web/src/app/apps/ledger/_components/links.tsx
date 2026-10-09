'use client';

/**
 * Entity links. Every account name anywhere in the UI goes through
 * `AccountLink`, every property through `PropertyLink`, so they all lead to
 * the same pages. Names the ledger can't look up (not a chain account) are
 * shown as plain text rather than a link that would 400.
 */

import Link from 'next/link';
import { isAntelopeAccount } from '@forge/upland-ledger';

import { LEDGER_BASE } from '../_lib/forge-adapter';
import { NONE, shortHash } from '../_lib/format';

export const routes = {
  overview: LEDGER_BASE,
  properties: `${LEDGER_BASE}/properties`,
  property: (id: string) => `${LEDGER_BASE}/properties/${encodeURIComponent(id)}`,
  market: `${LEDGER_BASE}/market`,
  opportunities: `${LEDGER_BASE}/opportunities`,
  account: (account: string) => `${LEDGER_BASE}/accounts/${encodeURIComponent(account)}`,
};

export function AccountLink({ account, username }: { account: string | null | undefined; username?: string | null }) {
  if (!account) return <span className="em-muted">{NONE}</span>;
  const name = username && username !== account ? username : null;
  const text = (
    <>
      <span className="em-mono">{account}</span>
      {name && <span className="em-muted"> · {name}</span>}
    </>
  );
  if (!isAntelopeAccount(account)) return <span>{text}</span>;
  return (
    <Link href={routes.account(account)} title={`Open account ${account}`}>
      {text}
    </Link>
  );
}

export function PropertyLink({ id, label }: { id: string; label?: string }) {
  const text = label && label.trim() !== '' ? label : `#${id}`;
  return (
    <Link href={routes.property(id)} title={`Open property ${id}`}>
      {text}
    </Link>
  );
}

/** A transaction id, shortened, with the full id on hover and for screen readers. */
export function TrxId({ id }: { id: string }) {
  if (!id) return <span className="em-muted">{NONE}</span>;
  return (
    <span className="em-mono" title={id}>
      <span aria-hidden="true">{shortHash(id)}</span>
      <span className="em-sr">{id}</span>
    </span>
  );
}
