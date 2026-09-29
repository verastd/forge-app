'use client';

/**
 * The chrome for a standalone app living under /apps/<slug> (SiteChrome's
 * "app" mode, see SiteChrome.tsx): a way back to the lobby, the app's own
 * name, and the same account menu the site nav carries. Cross-unit contract
 * (Phase 2 addendum) — the app's own layout renders this and owns its own
 * <h1>; `title` here is a label, not a heading.
 */

import Link from 'next/link';

import { AccountMenu } from './AccountMenu';
import styles from './AppBar.module.css';

export function AppBar({ title, slug }: { title: string; slug: string }) {
  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link
          href={`/apps?from=${encodeURIComponent(slug)}`}
          className={styles.back}
          aria-label="Back to the lobby"
        >
          ← Lobby
        </Link>
        <span className={styles.title}>{title}</span>
        <span className={styles.spacer} />
        <AccountMenu />
      </div>
    </header>
  );
}
