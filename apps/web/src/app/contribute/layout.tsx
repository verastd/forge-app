'use client';

/**
 * The Bridge's front door: the kill switch, then the label.
 *
 * `contribute_bridge` is advertised as the switch that takes the Bridge off the
 * air, so it has to actually do it — every screen under /contribute hangs off
 * this gate. Flags fail closed, which means a flag service we cannot reach
 * reads the same as a switch somebody threw on purpose; that is the correct
 * live behaviour and is not masked here. The demo app forces the Bridge open
 * instead, since demonstrating it with nothing behind it is the entire job.
 */

import Link from 'next/link';
import { useFlags } from '@forge/flags/react';
import type { ReactNode } from 'react';

import { DemoBanner } from '../../components/DemoBanner';
import { demoFlagFallback } from '../../lib/flags';
import { isDemoMode } from '../../lib/mode';

export default function ContributeLayout({ children }: { children: ReactNode }) {
  const demo = isDemoMode();
  const { flags, loading } = useFlags(demoFlagFallback());
  const open = demo || flags.contribute_bridge;

  if (loading && !demo) {
    return (
      <main className="page">
        <div className="card stack" aria-busy="true">
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Opening the Bridge…
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
        <h1 className="page-title">Contributing is closed just now</h1>
        <div className="card stack" role="alert">
          <p className="muted">
            Nobody can pick up a task at the moment. Anything you have already sent in is safe and
            keeps going on its own.
          </p>
          <p className="faint">Please look in again a bit later.</p>
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
      <DemoBanner />
      {children}
    </>
  );
}
