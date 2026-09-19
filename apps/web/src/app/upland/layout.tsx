'use client';

/**
 * The Upland data app's front door: the `upland_data` kill switch, then the
 * sub-nav. Every screen under /upland hangs off this gate, same shape as the
 * Bridge's (`../contribute/layout.tsx`): flags fail closed, so a flag service
 * we cannot reach reads exactly like a switch somebody threw on purpose. The
 * demo app forces it open instead.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useFlags } from '@forge/flags/react';
import type { ReactNode } from 'react';

import { chipClass } from '../../components/Chip';
import { demoFlagFallback } from '../../lib/flags';
import { isDemoMode } from '../../lib/mode';

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/upland', label: 'Overview' },
  { href: '/upland/actions', label: 'Actions' },
  { href: '/upland/sales', label: 'Sales' },
];

export default function UplandLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const demo = isDemoMode();
  const { flags, loading } = useFlags(demoFlagFallback());
  const open = demo || flags.upland_data;

  if (loading && !demo) {
    return (
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
  }

  if (!open) {
    return (
      <main className="page stack">
        <h1 className="page-title">Upland Data — Private Beta</h1>
        <div className="card stack" role="alert">
          <p className="muted">Upland Data is in private beta and is not enabled for you yet.</p>
        </div>
        <p>
          <Link href="/" className="btn">
            Back to the app
          </Link>
        </p>
      </main>
    );
  }

  return (
    <>
      <nav className="subnav-bar" aria-label="Upland sections">
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
