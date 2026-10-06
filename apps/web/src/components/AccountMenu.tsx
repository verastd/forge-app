'use client';

/**
 * The account slot at the far right of the nav.
 *
 * Signed out, a plain "Sign in" link — shown only once sign-in is actually
 * offered, never a button that would just 404. Signed in, a disclosure
 * button with the avatar, opening a small panel: Profile, Settings, Connect
 * an agent (the FORGE connector's one-time setup, /connect), Sign out. An
 * admin also gets an Admin group with Robot avatars (the avatar editor,
 * /me/avatars), once the API has said so (`fetchAvatarAccess`). While that is
 * being asked the group shows a spinner; if it can't be asked, it says so and
 * offers Retry. Only a definite "not an admin" leaves it out.
 * Deliberately not an ARIA `menu` — its items are ordinary links and a
 * form button, reachable in normal tab order, same as any other disclosure
 * on the site (see Modal for the pattern this borrows Escape-to-close from).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useFlags } from '@forge/flags/react';

import { describeAvatarsError, fetchAvatarAccess } from '../lib/avatars';
import { demoFlagFallback } from '../lib/flags';
import { Chip } from './Chip';
import { useSession } from './SessionProvider';
import styles from './AccountMenu.module.css';

/** The Admin group's state: left out, asking, the link, or couldn't ask (with why). */
type AvatarAccess = { state: 'none' } | { state: 'checking' } | { state: 'admin' } | { state: 'error'; message: string };

export function AccountMenu() {
  const { session, availability } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { flags, loading: flagsLoading } = useFlags(demoFlagFallback());
  const [avatarAccess, setAvatarAccess] = useState<AvatarAccess>({ state: 'none' });
  const [accessAttempt, setAccessAttempt] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Any navigation — including one started by a link inside the panel —
  // closes it. Nothing in here needs to survive a route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Admins get the avatar editor in the menu. Asked once per signed-in
  // GitHub member while robot avatars are on; the practice account is nobody
  // to the API, so it isn't asked.
  const avatarsOn = !flagsLoading && flags.lobby_avatars;
  const askAs = session !== null && !session.demo ? session.login : null;
  useEffect(() => {
    if (!avatarsOn || askAs === null) {
      setAvatarAccess({ state: 'none' });
      return undefined;
    }
    setAvatarAccess({ state: 'checking' });
    let live = true;
    fetchAvatarAccess().then(
      (canEdit) => {
        if (live) setAvatarAccess({ state: canEdit ? 'admin' : 'none' });
      },
      (error: unknown) => {
        if (live) setAvatarAccess({ state: 'error', message: describeAvatarsError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [avatarsOn, askAs, accessAttempt]);

  const retryAvatarAccess = useCallback(() => {
    setAccessAttempt((attempt) => attempt + 1);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  if (session === null) {
    // No working sign-in method: render nothing rather than a button that
    // can only ever fail.
    if (availability === 'unavailable') {
      return null;
    }
    return (
      <Link href={`/signin?next=${encodeURIComponent(pathname)}`} className="btn btn-ghost btn-sm">
        Sign in
      </Link>
    );
  }

  const initial = session.login.charAt(0).toUpperCase();

  return (
    <div className={styles.wrap}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${session.login}`}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {session.avatarUrl ? (
          <img
            src={session.avatarUrl}
            alt=""
            width={28}
            height={28}
            referrerPolicy="no-referrer"
            className={styles.avatar}
          />
        ) : (
          <span className={styles.avatarFallback} aria-hidden="true">
            {initial}
          </span>
        )}
      </button>

      {/* Always in the DOM (hidden, not unmounted) so `aria-controls` above
          always names a real element, and so it never fights the button's
          own click for focus when it opens. */}
      <div id={panelId} ref={panelRef} className={styles.panel} hidden={!open}>
        <div className={styles.panelHead}>
          <p className={styles.name}>{session.name ?? session.login}</p>
          <p className={styles.login}>@{session.login}</p>
          {session.demo && (
            <Chip tone="warn" className={styles.demoChip}>
              Practice account
            </Chip>
          )}
        </div>
        <ul className={styles.list}>
          <li>
            <Link href="/me" className={styles.item} onClick={close}>
              Profile
            </Link>
          </li>
          <li>
            <Link href="/me/settings" className={styles.item} onClick={close}>
              Settings
            </Link>
          </li>
          <li>
            <Link href="/connect" className={styles.item} onClick={close}>
              Connect an agent
            </Link>
          </li>
          {avatarAccess.state !== 'none' && (
            <li className={styles.group}>
              <span className={styles.groupLabel}>Admin</span>
              {avatarAccess.state === 'checking' && (
                <span className={styles.status} role="status">
                  <span className="spinner" aria-hidden="true" />
                  Checking admin access…
                </span>
              )}
              {avatarAccess.state === 'admin' && (
                <Link href="/me/avatars" className={styles.item} onClick={close}>
                  Robot avatars
                </Link>
              )}
              {avatarAccess.state === 'error' && (
                <div className={styles.status} role="alert">
                  <span>Couldn’t check admin access. {avatarAccess.message}</span>
                  <button type="button" className={styles.retry} onClick={retryAvatarAccess}>
                    Retry
                  </button>
                </div>
              )}
            </li>
          )}
          <li className={avatarAccess.state !== 'none' ? styles.group : undefined}>
            <form method="post" action="/auth/signout" className={styles.signOutForm}>
              <button type="submit" className={styles.item}>
                Sign out
              </button>
            </form>
          </li>
        </ul>
      </div>
    </div>
  );
}
