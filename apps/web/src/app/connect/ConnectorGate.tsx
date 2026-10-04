'use client';

/**
 * /connect's kill switch: the `mcp_connector` flag, read client-side like the
 * Bridge's and the Data app's. The API also closes the connector while
 * `github_signin` is off (nobody could sign in to approve an agent), so the
 * page reads that flag the same way. Flags fail closed, so a flag service nobody can
 * reach reads exactly like the switch thrown on purpose. The practice build
 * starts from its all-on fallback (`demoFlagFallback`), but an actual answer
 * from the service still wins there: unlike the Bridge, the connector is not
 * something to demonstrate with nothing behind it.
 */

import { useFlags } from '@forge/flags/react';
import type { ReactNode } from 'react';

import { demoFlagFallback } from '../../lib/flags';
import { isDemoMode } from '../../lib/mode';

const CONNECTOR_OFF = 'The FORGE connector is switched off right now.';

export function ConnectorGate({ available, children }: { available: boolean; children: ReactNode }) {
  const demo = isDemoMode();
  const { flags, loading } = useFlags(demoFlagFallback());

  if (loading && !demo) {
    return (
      <div className="card stack" aria-busy="true">
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Checking the connector…
        </p>
        <div className="skeleton" style={{ width: '55%' }} />
        <div className="skeleton" style={{ width: '80%' }} />
      </div>
    );
  }

  // `available` is false when this server has no public origin to give out.
  if (!available || !flags.mcp_connector || !flags.github_signin) {
    return (
      <div className="card stack" role="status">
        <p>{CONNECTOR_OFF}</p>
        <p className="faint">
          Agents you have already connected can’t reach FORGE until it’s back. Everything else in
          FORGE works as usual.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
