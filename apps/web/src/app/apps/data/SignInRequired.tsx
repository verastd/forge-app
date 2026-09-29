'use client';

/**
 * The Data app's sign-in gate: shown wherever a read through the BFF comes
 * back 401. The Data app is a shared explorer of Upland's public blockchain
 * data, open to signed-in FORGE members; nothing in it is personal. What
 * helps after a 401 depends on who is asking, so this shows one of three:
 *
 * - Signed out: a "Sign in" link. The middleware sends signed-out visitors
 *   to /signin before this page renders, so this is the fail-safe.
 * - The practice account: no button. It isn't anybody on GitHub, so no
 *   sign-in changes the answer, and /signin sends anyone already signed in
 *   straight back here: a "Sign in" link was a loop.
 * - A real GitHub session: the data service refused a sign-in the BFF
 *   vouched for (the two disagreeing on config, say). Signing in again would
 *   loop the same way, so "Try again" re-runs the page's own fetch.
 */

import Link from 'next/link';

import { useSession } from '../../../components/SessionProvider';
import { RequestError } from '../../../lib/api';

/** Where "Sign in" sends you, and where sign-in sends you back once it's done. */
const SIGNIN_HREF = '/signin?next=%2Fapps%2Fdata';

const FOR_MEMBERS =
  "The Data app is for signed-in FORGE members. It shows Upland's public blockchain data, the same for everyone.";

/** True for exactly the failure this gate exists for: a 401 from the BFF. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof RequestError && error.status === 401;
}

export function SignInRequired({ onRetry }: { onRetry: () => void }) {
  const { session } = useSession();

  if (session !== null && !session.demo) {
    return (
      <div className="card stack" role="alert">
        <h2 className="section-title">FORGE couldn&apos;t confirm your sign-in</h2>
        <p className="muted">
          You&apos;re signed in with GitHub, but FORGE couldn&apos;t confirm the sign-in with the
          data service, so the Data app can&apos;t open just now.
        </p>
        <div className="row">
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card stack" role="alert">
      <h2 className="section-title">Sign in with GitHub to open the Data app</h2>
      {session === null ? (
        <>
          <p className="muted">{FOR_MEMBERS}</p>
          <div className="row">
            <Link href={SIGNIN_HREF} className="btn btn-primary">
              Sign in
            </Link>
          </div>
        </>
      ) : (
        <p className="muted">
          {FOR_MEMBERS} The practice account can&apos;t open it, because it isn&apos;t tied to a
          real GitHub account.
        </p>
      )}
    </div>
  );
}
