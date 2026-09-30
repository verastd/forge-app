/**
 * /apps: the Apps lobby (PRD v0.2). SiteChrome (../../components/SiteChrome.tsx)
 * treats this route, and only this route exactly, as "lobby" chrome: the
 * site nav, no footer, and a full-bleed page, which the 3D lobby fills
 * under the nav (../../components/lobby/Lobby.tsx).
 *
 * The heading and the directory are rendered here, on the server, so the
 * page reads and works the same with no WebGL, no JavaScript, or the lobby
 * switched off: one link per lit app, and a count of the empty slots
 * waiting for proposals. In the 3D view they float over the cave.
 */

import { APPS, WALL } from '@forge/lobby';
import Link from 'next/link';

import { Lobby } from '../../components/lobby/Lobby';
import styles from './apps.module.css';

export default function AppsPage() {
  const lit = APPS.filter((app) => app.lit);
  const empty = WALL.columns * WALL.rows - lit.length;

  return (
    <main className={styles.lobby}>
      <Lobby
        heading={
          <div className={styles.heading}>
            <h1 className="page-title">Apps</h1>
            <p className="lede">Everything the community has built, on one wall.</p>
          </div>
        }
        directory={
          <nav aria-label="Apps" className={styles.directory}>
            <ul className={styles.apps}>
              {lit.map((app) => (
                <li key={app.slug}>
                  <Link href={app.route} className={styles.app} data-slug={app.slug}>
                    {`${app.title}: ${app.description}`}
                  </Link>
                </li>
              ))}
            </ul>
            <p className={styles.empty}>{`${empty} empty slots are waiting for the next proposal.`}</p>
          </nav>
        }
      />
    </main>
  );
}
