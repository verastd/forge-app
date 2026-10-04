'use client';

/**
 * The bell (Phase 5 contract §4): what happened on the Propose floor that a
 * member should hear about — a new proposal, a second, a vote opening, an
 * outcome — next to the account slot in the site nav and an app's bar.
 *
 * Signed-in GitHub members only: nothing for signed-out visitors, the
 * practice account or the practice app, and nothing at all while the
 * `proposals` flag is off. The unread count is read on mount and every 60
 * seconds while the tab is visible (backing off when it fails), and again
 * when the list is opened. Each item links to its `href`, but only when that
 * is a path on this site (`sitePath`); opening one marks it read, and "Mark
 * all read" does the rest.
 *
 * A disclosure like the account menu, not an ARIA `menu`: its items are
 * ordinary links in normal tab order, and Escape closes it.
 *
 * An item of a kind this build doesn't know yet (the API grew one) shows as
 * the plain message it is, so a new kind never empties the bell.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFlags } from '@forge/flags/react';

import { useSession } from './SessionProvider';
import { demoFlagFallback } from '../lib/flags';
import { formatTimestamp } from '../lib/format';
import { isDemoMode } from '../lib/mode';
import { loadNotifications, markNotificationsRead } from '../lib/proposals';
// Explicit names, so neither is ever the DOM's global `Notification`.
import type { DisplayNotification, DisplayNotificationList } from '../lib/proposals';
import { sitePath } from '../lib/proposals-format';
import styles from './NotificationBell.module.css';

/** How often the count is read while the tab is visible. */
const POLL_MS = 60_000;
/** Failures back off, doubling, up to this. */
const MAX_BACKOFF_MS = 10 * 60_000;

export function NotificationBell() {
  const { session } = useSession();
  if (session === null || session.demo || isDemoMode()) {
    return null;
  }
  return <Bell />;
}

function allRead(list: DisplayNotificationList): DisplayNotificationList {
  return { notifications: list.notifications.map((item) => ({ ...item, read: true })), unread: 0 };
}

function oneRead(list: DisplayNotificationList, id: number): DisplayNotificationList {
  const wasUnread = list.notifications.some((item) => item.id === id && !item.read);
  return {
    notifications: list.notifications.map((item) => (item.id === id ? { ...item, read: true } : item)),
    unread: wasUnread ? Math.max(0, list.unread - 1) : list.unread,
  };
}

function Bell() {
  const { flags } = useFlags(demoFlagFallback());
  const on = flags.proposals;
  const pathname = usePathname();
  const [list, setList] = useState<DisplayNotificationList | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lastUnread = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // The list: now, every 60 s while visible, and when the tab comes back.
  useEffect(() => {
    if (!on) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = (): void => {
      timer = undefined;
      if (cancelled || inFlight || document.visibilityState !== 'visible') {
        return;
      }
      inFlight = true;
      void loadNotifications()
        .then((result) => {
          if (cancelled) return;
          setList(result);
          setFailed(false);
          delay = POLL_MS;
        })
        .catch(() => {
          // The last count stays; nothing here pretends to know more.
          if (cancelled) return;
          setFailed(true);
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) timer = setTimeout(tick, delay);
        });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && !inFlight) {
        if (timer !== undefined) clearTimeout(timer);
        tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [on, refresh]);

  // New ones are said out loud, once, without moving focus.
  const unread = list?.unread ?? 0;
  useEffect(() => {
    if (list === null) return;
    if (lastUnread.current !== null && unread > lastUnread.current) {
      const fresh = unread - lastUnread.current;
      setAnnouncement(`${fresh} new ${fresh === 1 ? 'notification' : 'notifications'}.`);
    }
    lastUnread.current = unread;
  }, [list, unread]);

  // Any navigation closes it, a link inside included.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent): void => {
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

  const toggle = useCallback(() => {
    if (!open) {
      // Opening reads the list again, so it is current.
      setProblem(null);
      setRefresh((value) => value + 1);
    }
    setOpen(!open);
  }, [open]);

  const markAll = useCallback(() => {
    setMarking(true);
    setProblem(null);
    void markNotificationsRead()
      .then((next) => {
        setList((current) => next ?? (current === null ? current : allRead(current)));
      })
      .catch(() => {
        setProblem("FORGE couldn't mark them read just now. Try again in a minute.");
      })
      .finally(() => {
        setMarking(false);
      });
  }, []);

  const opened = useCallback((item: DisplayNotification) => {
    if (item.read) return;
    setList((current) => (current === null ? current : oneRead(current, item.id)));
    // Fire and forget: the link is what matters, and the next read corrects the count.
    void markNotificationsRead([item.id]).catch(() => undefined);
  }, []);

  if (!on) {
    return null;
  }

  const label = unread === 0 ? 'Notifications' : `Notifications: ${unread} unread`;

  return (
    <div className={styles.wrap}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={toggle}
      >
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.6l-1.7 3A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.4l-1.7-3V9a6 6 0 0 0-6-6Zm-2.4 15.5a2.5 2.5 0 0 0 4.8 0Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>

      <div id={panelId} ref={panelRef} className={styles.panel} hidden={!open}>
        <div className={styles.panelHead}>
          <h2 className={styles.title}>Notifications</h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={markAll}
            disabled={unread === 0 || marking}
            aria-busy={marking || undefined}
          >
            Mark all read
          </button>
        </div>
        {list === null ? (
          <p className={styles.note}>
            {failed ? "FORGE couldn't load your notifications just now." : 'Loading your notifications…'}
          </p>
        ) : list.notifications.length === 0 ? (
          <p className={styles.note}>Nothing yet. New proposals, seconds, votes and outcomes show up here.</p>
        ) : (
          <ul className={styles.list}>
            {list.notifications.map((item) => {
              const href = sitePath(item.href);
              const body = (
                <>
                  <span className={styles.message}>
                    {!item.read && <span className="visually-hidden">Unread: </span>}
                    {item.message}
                  </span>
                  <time className={styles.time} dateTime={item.at}>
                    {formatTimestamp(item.at)}
                  </time>
                </>
              );
              return (
                <li key={item.id} className={item.read ? styles.read : styles.unread}>
                  {href === null ? (
                    <div className={styles.item}>{body}</div>
                  ) : (
                    <Link
                      href={href}
                      className={styles.item}
                      onClick={() => {
                        opened(item);
                      }}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {list !== null && failed && <p className={styles.note}>This list may be out of date: the last update failed.</p>}
        {problem !== null && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
