/**
 * Account settings: what FORGE keeps about you, how to revoke it on GitHub's
 * side, and the same sign-out as the account menu.
 */

import { redirect } from 'next/navigation';

import { getSession } from '../../../lib/session';
import styles from '../me.module.css';

export default async function MeSettingsPage() {
  const session = await getSession();
  if (session === null) {
    // Belt-and-braces, same as /me: the middleware already gates /me/*.
    redirect('/signin?next=%2Fme%2Fsettings');
  }

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="lede">Your account details, and what FORGE keeps about you.</p>
      </div>

      <section className="card stack">
        <h2 className="section-title">Account</h2>
        <dl className={styles.details}>
          <div>
            <dt>GitHub login</dt>
            <dd>@{session.login}</dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd>{session.name ?? '—'}</dd>
          </div>
          <div>
            <dt>Signed in with</dt>
            <dd>{session.demo ? 'Practice account (demo)' : 'GitHub'}</dd>
          </div>
        </dl>
      </section>

      <section className="card stack">
        <h2 className="section-title">Privacy</h2>
        <p className="muted">
          FORGE stores only your GitHub id, login, name and avatar, sealed in an encrypted cookie
          for 7 days, plus what you choose to give it on your profile: agent keys you ask it to
          remember (kept encrypted) and the agents you connect. It keeps no GitHub token: when you
          start GitHub Copilot from a task, GitHub&apos;s one-time approval is used once and dropped.
        </p>
        {!session.demo && (
          <p>
            <a href="https://github.com/settings/apps/authorizations" className="btn btn-ghost btn-sm">
              Review or revoke FORGE&apos;s access on GitHub
            </a>
          </p>
        )}
      </section>

      <section className="card stack">
        <h2 className="section-title">Sign out</h2>
        <p className="muted">Ends this session on this device.</p>
        <form method="post" action="/auth/signout">
          <button type="submit" className="btn">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
