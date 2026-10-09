'use client';

/**
 * The Upland Ledger UI's front door: the `upland_ledger` flag, then the
 * Embers shell every screen under /apps/ledger hangs off. Flags fail closed,
 * so an unreachable flag service reads exactly like the switch being off.
 *
 * Self-contained on purpose (it may move to its own repo): pages import only
 * `@forge/upland-ledger`, React/Next and files in this tree; the host's
 * session, flags and chrome come through `_lib/forge-adapter.tsx`.
 */

import type { ReactNode } from 'react';

import { LedgerFrame, LedgerShell } from './_components/Shell';
import { ButtonLink, Skeleton, Spinner } from './_components/primitives';
import { LOBBY_HREF, useLedgerFlag } from './_lib/forge-adapter';
import './_components/embers.css';

/** Work Sans (UI) and Geist Mono (numbers, ids). A plain stylesheet link, so `next build` never needs the network; system faces otherwise. */
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap';

export default function LedgerLayout({ children }: { children: ReactNode }) {
  const flag = useLedgerFlag();

  let body: ReactNode;
  if (flag.loading) {
    body = (
      <LedgerFrame>
        <div className="em-card" aria-busy="true" style={{ display: 'grid', gap: 10 }}>
          <p className="em-row" role="status">
            <Spinner size={16} label="" /> Opening the Upland Ledger…
          </p>
          <Skeleton width="45%" />
          <Skeleton width="70%" />
        </div>
      </LedgerFrame>
    );
  } else if (!flag.enabled) {
    body = (
      <LedgerFrame>
        <h1 className="em-h1">Upland Ledger</h1>
        <div className="em-card" role="alert" style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
          <p>The Upland Ledger is in private beta and isn’t switched on for you yet.</p>
          <ButtonLink href={LOBBY_HREF} icon="arrow-left">
            Back to the lobby
          </ButtonLink>
        </div>
      </LedgerFrame>
    );
  } else {
    body = <LedgerShell>{children}</LedgerShell>;
  }

  return (
    <>
      <link rel="stylesheet" href={FONTS_HREF} precedence="default" />
      {body}
    </>
  );
}
