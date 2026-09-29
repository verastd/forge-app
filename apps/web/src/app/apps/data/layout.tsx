'use client';

/**
 * The Data app's front door: the `upland_data` kill switch, then the AppBar
 * and sub-nav every screen under /apps/data hangs off. Flags fail closed, so
 * a flag service we cannot reach reads exactly like a switch somebody threw
 * on purpose, same shape as the Bridge's (`../../contribute/layout.tsx`). The
 * demo app forces it open instead.
 *
 * The AppBar renders unconditionally (loading, closed, or open): it's the
 * only way back to the lobby once SiteChrome has stopped rendering the site
 * nav for anything under /apps/<slug> (Phase 2 addendum).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFlags } from '@forge/flags/react';
import type { ReactNode } from 'react';

import { AppBar } from '../../../components/AppBar';
import { chipClass } from '../../../components/Chip';
import { demoFlagFallback } from '../../../lib/flags';
import { isDemoMode } from '../../../lib/mode';

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/apps/data', label: 'Overview' },
  { href: '/apps/data/actions', label: 'Actions' },
  { href: '/apps/data/sales', label: 'Sales' },
];

export default function DataLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const demo = isDemoMode();
  const { flags, loading } = useFlags(demoFlagFallback());
  const open = demo || flags.upland_data;

  let body: ReactNode;

  if (loading && !demo) {
    body = (
      <main className="page">
        <div className="card stack" aria-busy="true">
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Opening the ledger…
          </p>
          <div className="skeleton" style={{ width: '45%' }} />
          <div className="skeleton" style={{ width: '70%' }} />
        </div>
      </main>
    );
  } else if (!open) {
    body = (
      <main className="page stack">
        <h1 className="page-title">Data — Private Beta</h1>
        <div className="card stack" role="alert">
          <p className="muted">Data is in private beta and is not enabled for you yet.</p>
        </div>
        <p>
          <Link href="/apps" className="btn">
            Back to the lobby
          </Link>
        </p>
      </main>
    );
  } else {
    body = (
      <>
        <nav className="subnav-bar" aria-label="Data sections">
          <div className="subnav">
            {TABS.map((tab) => {
              const current = pathname === tab.href;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={chipClass('neutral', 'chip-button subnav-link')}
                  aria-current={current ? 'page' : undefined}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </nav>
        {children}
      </>
    );
  }

  return (
    <>
      <AppBar title="Data" slug="data" />
      {body}
    </>
  );
}
