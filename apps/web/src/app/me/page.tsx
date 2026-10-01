/**
 * Your account: who FORGE thinks you are, the agent keys FORGE keeps for you
 * and the agents you connected to it, then the contribution record.
 * Server-rendered so the identity comes straight from the session cookie —
 * nothing here is fetched twice or flashes in after paint. The two agent
 * sections load through the BFF; the practice account has neither.
 */

import { redirect } from 'next/navigation';

import { ContributionRecord } from '../../components/ContributionRecord';
import { getSession } from '../../lib/session';
import { AgentKeys } from './AgentKeys';
import { ConnectedAgents } from './ConnectedAgents';
import styles from './me.module.css';

export default async function MePage() {
  const session = await getSession();
  if (session === null) {
    // The middleware already keeps signed-out visitors off /me/*; this is
    // belt-and-braces in case the page is ever reached another way.
    redirect('/signin?next=%2Fme');
  }

  const displayName = session.name ?? session.login;

  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Your account</h1>
        <p className="lede">
          The GitHub identity FORGE uses for you, the agents you trust it with, and your contribution
          record.
        </p>
      </div>

      <section className="card">
        <div className={styles.identity}>
          {session.avatarUrl ? (
            <img
              src={session.avatarUrl}
              alt=""
              width={56}
              height={56}
              referrerPolicy="no-referrer"
              className={styles.avatar}
            />
          ) : (
            <span className={styles.avatarFallback} aria-hidden="true">
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
          <div>
            <p className="card-title">{displayName}</p>
            <p className="faint">@{session.login}</p>
            <p className="muted" style={{ marginTop: 6 }}>
              {session.demo ? (
                'Practice account (demo)'
              ) : (
                <>
                  Signed in with GitHub ·{' '}
                  <a href={`https://github.com/${session.login}`} className="faint" target="_blank" rel="noreferrer">
                    github.com/{session.login}
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      </section>

      <AgentKeys practice={session.demo} />
      <ConnectedAgents practice={session.demo} />

      <h2 className="section-title">Your contributions</h2>
      <ContributionRecord />
    </main>
  );
}
