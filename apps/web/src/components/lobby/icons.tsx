/**
 * The HUD's glyphs: 24-unit line icons drawn in `currentColor`, so a button's
 * colour is the icon's, plus the busy spinner every action shows while it
 * works. All decorative: the button around each one carries the words.
 */

import styles from './Lobby.module.css';

export function MicIcon({ off }: { off: boolean }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <rect className={styles.micBody} x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function HeadphonesIcon({ off }: { off: boolean }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13" width="4" height="7" rx="1.5" />
      <rect x="17" y="13" width="4" height="7" rx="1.5" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function PeopleIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-5-5.9" />
    </svg>
  );
}

/** Something is under way. Still (a broken ring) with reduced motion, where the words beside it say so. */
export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}
