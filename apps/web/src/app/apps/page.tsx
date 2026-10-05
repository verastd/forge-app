/**
 * /apps: the Apps lobby (PRD v0.2). SiteChrome (../../components/SiteChrome.tsx)
 * treats this route, and only this route exactly, as "lobby" chrome: the
 * site nav, no footer, and a full-bleed page, which the 3D lobby fills
 * under the nav (../../components/lobby/Lobby.tsx).
 *
 * The heading and the directory are rendered here, on the server, so the
 * page reads and works the same with no WebGL, no JavaScript, or the lobby
 * switched off: one tile per lit app (its slot, its poster, what it is),
 * and a card counting the empty slots, which leads to the Propose floor.
 * That is the whole page without the 3D wall: no cave and no voice. While the 3D wall is the page they are out of
 * sight (Lobby.tsx): still the page's h1 and its list for screen readers,
 * and the list shows while a keyboard user is in it.
 *
 * Signed in only: the middleware sends a signed-out visitor to /signin.
 */

import { APPS, WALL, slotIndex } from '@forge/lobby';
import type { AppEntry } from '@forge/lobby';
import type { CSSProperties } from 'react';
import Link from 'next/link';

import { Lobby } from '../../components/lobby/Lobby';
import styles from './apps.module.css';

/** The tile's picture: the app's poster or image; nothing for generated media, which shows the tile's grid. */
function posterOf(app: AppEntry): CSSProperties | undefined {
  const src = app.media.kind === 'video' ? app.media.poster : app.media.kind === 'image' ? app.media.src : null;
  // Registry paths are validated to plain URL characters (packages/lobby), so they are safe in url().
  return src === null ? undefined : { backgroundImage: `url("${src}")`, backgroundSize: 'cover' };
}

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
            <ul className={styles.tiles}>
              {lit.map((app) => (
                <li key={app.slug}>
                  <Link
                    href={app.route}
                    className={styles.app}
                    data-slug={app.slug}
                    aria-label={`${app.title}: ${app.description}`}
                  >
                    <span className={styles.slot}>{`Slot ${slotIndex(app.slot)} · Live`}</span>
                    <span className={styles.poster} style={posterOf(app)} aria-hidden="true" />
                    <span className={styles.title}>{app.title}</span>
                    <span className={styles.description}>{app.description}</span>
                    <span className={styles.go} aria-hidden="true">
                      Open →
                    </span>
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/propose" className={styles.propose}>
                  <span className={styles.slot}>{`${empty.toLocaleString('en-US')} empty slots`}</span>
                  <span className={styles.title}>Propose the next app</span>
                  <span className={styles.description}>
                    A proposal the floor passes becomes a task; the task that ships lights a slot.
                  </span>
                  <span className={styles.go}>Go to the Propose floor →</span>
                </Link>
              </li>
            </ul>
          </nav>
        }
      />
    </main>
  );
}
