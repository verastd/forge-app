/**
 * /signin: what signing in means, then the one way in this server offers.
 * Every availability state renders something honest. There is never a button
 * that leads nowhere: with sign-in switched off there is no button at all.
 */
import { safeNext } from '@forge/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getPublicSession, signInAvailability } from '../../lib/session';
import styles from './signin.module.css';

export const metadata: Metadata = {
  title: 'Sign in — FORGE',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One entry per `error` value the auth routes send back here. */
const ERRORS: Readonly<Record<string, string>> = {
  unavailable: 'Sign-in isn’t available on this server right now.',
  expired: 'That sign-in took too long or started in another browser. Please try again.',
  state: 'We couldn’t match that sign-in to this browser, so we stopped it. Please try again.',
  denied: 'You didn’t approve the sign-in on GitHub, so nothing was shared.',
  github: 'GitHub didn’t finish the sign-in. Please try again in a moment.',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNext(first(params.next));
  if ((await getPublicSession()) !== null) redirect(next);

  const availability = await signInAvailability();
  const error = first(params.error);
  const message = error !== undefined && Object.hasOwn(ERRORS, error) ? ERRORS[error] : undefined;
  const githubHref = `/auth/signin?${new URLSearchParams({ next }).toString()}`;

  return (
    <main className="page">
      <div className={styles.panel}>
        <div>
          <h1 className="page-title">Sign in to FORGE</h1>
          <p className="lede">
            {availability === 'demo'
              ? 'This is the practice app, so there is a practice account instead of GitHub.'
              : 'FORGE uses your GitHub account to know who you are. That is all it uses it for.'}
          </p>
        </div>

        {message !== undefined ? (
          <p className={styles.error} role="alert">
            {message}
          </p>
        ) : null}

        {availability === 'demo' ? (
          <div className="card stack">
            <ul className={styles.points}>
              <li>
                The practice account isn’t linked to any GitHub account, so FORGE learns nothing
                about you from it.
              </li>
              <li>You stay signed in on this browser for up to 7 days, or until you sign out.</li>
            </ul>
            <form method="post" action="/auth/demo">
              <input type="hidden" name="next" value={next} />
              <button type="submit" className="btn btn-primary btn-lg">
                Continue with the practice account
              </button>
            </form>
          </div>
        ) : (
          <div className="card stack">
            <h2 className="section-title">What signing in does</h2>
            <ul className={styles.points}>
              <li>FORGE sees your GitHub username, display name and profile picture.</li>
              <li>It gets no access to your repositories or your code.</li>
              <li>No GitHub token is kept: FORGE reads your profile once and lets the token go.</li>
              <li>You stay signed in on this browser for up to 7 days, or until you sign out.</li>
            </ul>
            {availability === 'github' ? (
              <p>
                {/* A plain link, not next/link: a prefetch must never start a sign-in. */}
                <a className="btn btn-primary btn-lg" href={githubHref}>
                  Continue with GitHub
                </a>
              </p>
            ) : (
              <p className="muted">
                Sign-in isn’t switched on yet. Everything that doesn’t need an account still works.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
