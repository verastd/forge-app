'use client';

/**
 * What a 401 from the ledger shows: never data, never a demo (brief).
 * Depends on who is looking (host adapter):
 * - signed out: "Sign in" (the host middleware usually redirects first);
 * - the practice account: no button — signing in again can't change the
 *   answer and would only loop back here;
 * - a real member the ledger refused (session just expired, or the gateway
 *   disagreed): "Try again" and "Sign in again".
 */
import Link from 'next/link';
import { AsyncButton, Button, Card } from '@forge/ui';

import { SIGN_IN_HREF, useViewer } from '../_lib/forge-adapter';

const WHAT = 'The Upland Ledger is for signed-in members. It shows Upland’s public chain and market data, the same for everyone.';

export function SignInPrompt({ onRetry }: { onRetry?: () => Promise<unknown> }) {
  const viewer = useViewer();
  const title =
    viewer === 'member' ? 'The ledger didn’t accept your sign-in' : 'Sign in with GitHub to open the Upland Ledger';
  return (
    <div role="alert">
      <Card style={{ justifyItems: 'center', textAlign: 'center', padding: '32px 16px', gap: 10 }}>
        <h2 style={{ margin: 0, font: 'var(--type-title)', color: 'var(--text-primary)' }}>{title}</h2>
        {viewer === 'member' ? (
          <>
            <p style={{ margin: 0, font: 'var(--type-body)', color: 'var(--text-secondary)' }}>
              Your session may have just expired. Try again, or sign in again if it keeps happening.
            </p>
            <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {onRetry && <AsyncButton label="Try again" pendingLabel="Trying…" onAction={onRetry} />}
              <Button as={Link} href={SIGN_IN_HREF} icon="log-in">
                Sign in again
              </Button>
            </span>
          </>
        ) : (
          <>
            <p style={{ margin: 0, font: 'var(--type-body)', color: 'var(--text-secondary)' }}>{WHAT}</p>
            {viewer === 'signed-out' ? (
              <Button as={Link} href={SIGN_IN_HREF} variant="primary" icon="log-in">
                Sign in
              </Button>
            ) : (
              <p style={{ margin: 0, font: 'var(--type-body-sm)', color: 'var(--text-muted)' }}>
                The practice account can’t open it, because it isn’t tied to a real GitHub account.
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
