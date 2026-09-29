/**
 * /apps: the minimal placeholder for the lobby (PRD v0.2). SiteChrome (see
 * ../../components/SiteChrome.tsx) treats this route, and only this route
 * exactly, as "lobby" chrome — site nav, no footer, full-bleed main —
 * because Phase 3 replaces this list with the real 3D lobby in the same
 * slot. Until then it just lists what is actually live.
 */

import Link from 'next/link';

import styles from './apps.module.css';

export default function AppsPage() {
  return (
    <main className={styles.lobby}>
      <div>
        <h1 className="page-title">Apps</h1>
        <p className="lede">Everything the community has built, on one wall.</p>
      </div>

      <div className={styles.cards}>
        <Link href="/apps/data" className="card card-link">
          <h2 className="card-title">Data: Upland blockchain data</h2>
          <span className="card-go" aria-hidden="true">
            Open →
          </span>
        </Link>
      </div>

      <p className="muted">The 3D lobby is coming.</p>
    </main>
  );
}
