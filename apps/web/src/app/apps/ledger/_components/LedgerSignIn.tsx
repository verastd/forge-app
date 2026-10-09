'use client';

/**
 * What a 401 from the ledger shows: never data, never a demo. The prompt
 * depends on who is looking (from the host adapter):
 * - signed out: a "Sign in" button (the host's middleware usually sends
 *   signed-out visitors to sign-in first; this is the fail-safe);
 * - the practice account: no button, because signing in again can't change
 *   the answer and would only loop back here;
 * - a real member the ledger still refused: the session may have just
 *   expired or the gateway disagreed, so offer "Try again" and "Sign in
 *   again".
 */

import { SIGN_IN_HREF, useViewer } from '../_lib/forge-adapter';
import { AsyncButton, ButtonLink } from './primitives';

const WHAT = 'The Upland Ledger is for signed-in members. It shows Upland’s public chain and market data, the same for everyone.';

export function LedgerSignIn({ onRetry }: { onRetry?: () => Promise<unknown> }) {
  const viewer = useViewer();

  if (viewer === 'member') {
    return (
      <div role="alert" className="em-card em-state em-state--error">
        <h2 className="em-state-title">The ledger didn’t accept your sign-in</h2>
        <p>Your session may have just expired. Try again, or sign in again if it keeps happening.</p>
        <div className="em-row" style={{ justifyContent: 'center' }}>
          {onRetry && <AsyncButton label="Try again" pendingLabel="Trying…" onAction={onRetry} />}
          <ButtonLink href={SIGN_IN_HREF} variant="secondary" icon="log-in">
            Sign in again
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="em-card em-state em-state--error">
      <h2 className="em-state-title">Sign in with GitHub to open the Upland Ledger</h2>
      <p>{WHAT}</p>
      {viewer === 'signed-out' ? (
        <ButtonLink href={SIGN_IN_HREF} variant="primary" icon="log-in">
          Sign in
        </ButtonLink>
      ) : (
        <p>The practice account can’t open it, because it isn’t tied to a real GitHub account.</p>
      )}
    </div>
  );
}
