/**
 * TopBar (handoff layout/TopBar.jsx, CM-03). Search combobox (3-char min,
 * states: idle | too short | loading | results | empty | error, recent history
 * when the query is empty), UTC + Los Angeles clocks (Intl, no digit
 * animation), theme Segment (light | dark | system), notification bell with
 * dropdown, account chip. Search and notification state is controlled by the
 * caller.
 *
 * Adaptations for a host app: `brand` replaces the "Embers" wordmark link,
 * `leading` renders before it (e.g. a back link), `trailing` replaces the
 * bell + account chip. Rows with `href` render as real <a href> links.
 *
 * Bugs fixed from the .jsx: Retry was a dead button (now `onSearchRetry`); the
 * clocks never ticked unless the caller re-rendered (now a 1 s interval,
 * cleared on unmount, when `now` is not controlled); the blur timer was never
 * cleared; the combobox had no keyboard path to its options (now Arrow/Enter/
 * Escape with aria-activedescendant) and Tab to Retry closed the popover
 * before focus arrived; the "/" hint did nothing (now focuses search); the
 * icon-only theme radios had no accessible names.
 */
import { useEffect, useId, useRef, useState } from "react";

import "./TopBar.css";
import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from "react";

import { Badge } from "../core/Badge";
import type { BadgeTone } from "../core/Badge";
import { Button } from "../core/Button";
import { Icon } from "../core/Icon";
import type { IconName } from "../core/Icon";
import { Spinner } from "../core/Spinner";
import { Segment } from "../controls/Segment";
import type { SegmentOption } from "../controls/Segment";

export type TopBarSearchStatus =
  | "idle"
  | "loading"
  | "results"
  | "empty"
  | "error";
export type TopBarTheme = "light" | "dark" | "system";

export interface TopBarSearchRow {
  label: string;
  kind?: string;
  icon?: IconName;
  /** When set the row renders as a real link. onPick still fires on click. */
  href?: string;
}

export interface TopBarNotification {
  id: string | number;
  title: string;
  detail?: string;
  when: string;
  unread?: boolean;
  icon?: IconName;
  __new?: boolean;
}

export interface TopBarUser {
  name: string;
  tier: string;
}

export interface TopBarProps {
  query?: string;
  onQueryChange?: (q: string) => void;
  searchStatus?: TopBarSearchStatus;
  results?: TopBarSearchRow[];
  recent?: TopBarSearchRow[];
  onPick?: (row: TopBarSearchRow) => void;
  onSearchRetry?: () => void;
  theme?: TopBarTheme;
  onTheme?: (t: TopBarTheme) => void;
  unread?: number;
  notifications?: TopBarNotification[];
  notifOpen?: boolean;
  onNotifToggle?: () => void;
  onMarkAllRead?: () => void;
  user?: TopBarUser | null;
  onMenu?: () => void;
  /** Fixed clock time (ms). When omitted the clocks tick once per second. */
  now?: number;
  /** Replaces the "Embers" wordmark link. */
  brand?: ReactNode;
  /** Rendered before the brand, e.g. a back link. */
  leading?: ReactNode;
  /** Rendered instead of the notifications bell and account chip. */
  trailing?: ReactNode;
  style?: CSSProperties;
}

const MIN_QUERY = 3;

const THEME_OPTIONS: ReadonlyArray<SegmentOption<TopBarTheme>> = [
  { value: "light", label: "", icon: "sun", ariaLabel: "Light" },
  { value: "dark", label: "", icon: "moon", ariaLabel: "Dark" },
  { value: "system", label: "", icon: "monitor", ariaLabel: "System" },
];

const TIER_TONES: ReadonlyArray<BadgeTone> = ["free", "basic", "premium"];

function tierTone(tier: string | undefined): BadgeTone {
  const t = tier?.toLowerCase();
  return TIER_TONES.find((x) => x === t) ?? "neutral";
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

export function TopBar({
  query = "",
  onQueryChange,
  searchStatus = "idle",
  results = [],
  recent = [],
  onPick,
  onSearchRetry,
  theme = "system",
  onTheme,
  unread = 0,
  notifications = [],
  notifOpen,
  onNotifToggle,
  onMarkAllRead,
  user,
  onMenu,
  now,
  brand,
  leading,
  trailing,
  style,
}: TopBarProps) {
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(-1);
  const [tick, setTick] = useState(() => Date.now());
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}listbox`;
  const optId = (i: number): string => `${id}opt-${i}`;

  useEffect(() => {
    if (now !== undefined) return undefined;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (
        e.key !== "/" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        isEditable(e.target)
      )
        return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const time = now ?? tick;
  const fmt = (tz: string): string =>
    new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(time);
  const open = focus && (query.length > 0 || recent.length > 0);
  const short = query.length > 0 && query.length < MIN_QUERY;
  const pickable: TopBarSearchRow[] =
    query.length === 0
      ? recent
      : !short && searchStatus !== "loading" && searchStatus !== "error"
        ? results
        : [];
  const cur = open && active < pickable.length ? active : -1;

  const onSearchFocus = (): void => {
    clearTimeout(blurTimer.current);
    setFocus(true);
  };
  const onSearchBlur = (e: FocusEvent<HTMLDivElement>): void => {
    // Focus moving inside the combobox (e.g. Tab to Retry) keeps it open.
    if (
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    )
      return;
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setFocus(false), 120);
  };
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      setFocus(false);
      setActive(-1);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setFocus(true);
      const n = pickable.length;
      if (n === 0) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setActive(cur < 0 ? (dir === 1 ? 0 : n - 1) : (cur + dir + n) % n);
      return;
    }
    if (e.key === "Enter" && cur >= 0) {
      e.preventDefault();
      // A real click: links navigate, and onPick fires either way.
      document.getElementById(optId(cur))?.click();
    }
  };

  const showAccount = trailing === undefined;

  return (
    <header
      className="em-topbar"
      style={{
        height: "var(--topbar-height)",
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px 0 8px",
        background: "var(--surface-card)",
        borderBottom: "1px solid var(--border-subtle)",
        color: "var(--text-primary)",
        position: "relative",
        zIndex: "var(--z-sticky)" as unknown as number,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {onMenu && (
        <Button
          variant="ghost"
          size="dense"
          icon="menu"
          aria-label="Open navigation"
          onClick={onMenu}
        />
      )}
      {leading}
      <span className="em-topbar__brand" style={{ display: "contents" }}>
        {brand ?? (
          <a
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              textDecoration: "none",
              color: "var(--text-primary)",
              font: "var(--type-title)",
              marginRight: 8,
            }}
          >
            Embers
          </a>
        )}
      </span>
      <div
        style={{ position: "relative", flex: 1, minWidth: 0, maxWidth: 420 }}
        onFocus={onSearchFocus}
        onBlur={onSearchBlur}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 32,
            padding: "0 10px",
            borderRadius: "var(--radius-md)",
            border: `1px solid ${focus ? "var(--border-focus)" : "var(--border-subtle)"}`,
            background: "var(--surface-sunken)",
          }}
        >
          <Icon
            name="search"
            size={14}
            style={{ color: "var(--text-muted)" }}
          />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={cur >= 0 ? optId(cur) : undefined}
            aria-label="Search properties, users, collections"
            placeholder="Search properties, users, collections…"
            value={query}
            onChange={(e) => {
              setActive(-1);
              setFocus(true);
              onQueryChange?.(e.target.value);
            }}
            onKeyDown={onInputKey}
            style={{
              all: "unset",
              flex: 1,
              font: "var(--type-body-sm)",
              color: "var(--text-primary)",
              minWidth: 0,
            }}
          />
          {searchStatus === "loading" ? (
            <Spinner size={12} label="" />
          ) : (
            <kbd
              className="em-topbar__kbd"
              style={{
                font: "var(--type-code)",
                fontSize: 10,
                color: "var(--text-muted)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 3,
                padding: "0 4px",
              }}
            >
              /
            </kbd>
          )}
        </div>
        {open && (
          <div
            role="listbox"
            id={listId}
            aria-label="Search suggestions"
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              background: "var(--surface-popover)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--elevation-2)",
              padding: 4,
              display: "grid",
              gap: 1,
              zIndex: "var(--z-popover)" as unknown as number,
            }}
          >
            {short ? (
              <Row muted>
                Type {MIN_QUERY - query.length} more character
                {MIN_QUERY - query.length === 1 ? "" : "s"}
              </Row>
            ) : query.length === 0 ? (
              <>
                <Row muted small>
                  Recent
                </Row>
                {recent.map((r, i) => (
                  <Row
                    key={`${r.label}-${i}`}
                    id={optId(i)}
                    selected={i === cur}
                    href={r.href}
                    onClick={() => onPick?.(r)}
                    icon="history"
                  >
                    {r.label}
                  </Row>
                ))}
              </>
            ) : searchStatus === "loading" ? (
              <Row muted>
                <Spinner size={12} label="" /> Searching…
              </Row>
            ) : searchStatus === "error" ? (
              <Row>
                <span style={{ color: "var(--state-error)" }}>
                  Search failed
                </span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSearchRetry}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    color: "var(--text-link)",
                    textDecoration: "underline",
                    marginLeft: 8,
                  }}
                >
                  Retry
                </button>
              </Row>
            ) : results.length === 0 ? (
              <Row muted>No results for “{query}”</Row>
            ) : (
              results.map((r, i) => (
                <Row
                  key={`${r.label}-${i}`}
                  id={optId(i)}
                  selected={i === cur}
                  href={r.href}
                  onClick={() => onPick?.(r)}
                  icon={r.icon}
                  meta={r.kind}
                >
                  {r.label}
                </Row>
              ))
            )}
          </div>
        )}
      </div>
      <span style={{ flex: 1 }} />
      <span
        className="em-num em-topbar__clocks"
        style={{
          display: "inline-flex",
          gap: 12,
          font: "var(--type-caption)",
          color: "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>
          <span
            suppressHydrationWarning
            style={{ color: "var(--text-primary)", fontWeight: 500 }}
          >
            {fmt("UTC")}
          </span>{" "}
          UTC
        </span>
        <span>
          <span
            suppressHydrationWarning
            style={{ color: "var(--text-primary)", fontWeight: 500 }}
          >
            {fmt("America/Los_Angeles")}
          </span>{" "}
          LA
        </span>
      </span>
      <Segment
        size="dense"
        label="Theme"
        value={theme}
        onChange={onTheme}
        options={THEME_OPTIONS}
      />
      {showAccount ? (
        <>
          <span
            style={{ position: "relative" }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && notifOpen) onNotifToggle?.();
            }}
          >
            <Button
              variant="ghost"
              size="dense"
              icon="bell"
              aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
              aria-expanded={notifOpen}
              onClick={onNotifToggle}
            />
            {unread > 0 && (
              <span
                aria-hidden="true"
                className="em-num"
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  minWidth: 14,
                  height: 14,
                  padding: "0 3px",
                  borderRadius: 7,
                  background: "var(--state-error)",
                  color: "var(--on-danger)",
                  font: "var(--type-eyebrow)",
                  fontSize: 9,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
            {notifOpen && (
              <div
                role="dialog"
                aria-label="Notifications"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  width: 340,
                  background: "var(--surface-popover)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--elevation-3)",
                  zIndex: "var(--z-popover)" as unknown as number,
                  display: "grid",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span style={{ font: "var(--type-label)" }}>
                    Notifications
                  </span>
                  <Button variant="link" size="dense" onClick={onMarkAllRead}>
                    Mark all read
                  </Button>
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 4,
                    maxHeight: 360,
                    overflowY: "auto",
                    display: "grid",
                    gap: 1,
                  }}
                >
                  {notifications.length === 0 && (
                    <li
                      style={{
                        padding: 16,
                        textAlign: "center",
                        font: "var(--type-body-sm)",
                        color: "var(--text-muted)",
                      }}
                    >
                      You’re all caught up.
                    </li>
                  )}
                  {notifications.map((n) => (
                    <li
                      key={n.id}
                      className={n.__new ? "em-motion" : undefined}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto",
                        gap: 10,
                        padding: "8px 8px",
                        borderRadius: "var(--radius-sm)",
                        background: n.unread
                          ? "var(--accent-soft)"
                          : "transparent",
                        animation: n.__new
                          ? "em-toast-in var(--dur-slow) var(--ease-out)"
                          : "none",
                      }}
                    >
                      <Icon
                        name={n.icon ?? "bell"}
                        size={14}
                        style={{ color: "var(--accent-strong)", marginTop: 2 }}
                      />
                      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                        <span
                          style={{
                            font: "var(--type-body-sm)",
                            color: "var(--text-primary)",
                          }}
                        >
                          {n.title}
                        </span>
                        {n.detail && (
                          <span
                            style={{
                              font: "var(--type-caption)",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {n.detail}
                          </span>
                        )}
                      </span>
                      <time
                        className="em-num"
                        style={{
                          font: "var(--type-caption)",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {n.when}
                      </time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </span>
          {user ? (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <Badge tone={tierTone(user.tier)}>{user.tier}</Badge>
              <span
                title={user.name}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "var(--accent-soft)",
                  color: "var(--accent-strong)",
                  display: "grid",
                  placeItems: "center",
                  font: "var(--type-label)",
                  fontSize: 12,
                }}
              >
                {user.name[0]}
              </span>
            </span>
          ) : (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <Button variant="ghost" size="dense" as="a" href="/auth/login">
                Log in
              </Button>
              <Button variant="primary" size="dense" as="a" href="/auth/signup">
                Create free account
              </Button>
            </span>
          )}
        </>
      ) : (
        trailing
      )}
    </header>
  );
}

interface RowProps {
  children: ReactNode;
  muted?: boolean;
  small?: boolean;
  icon?: IconName;
  meta?: string;
  onClick?: () => void;
  href?: string;
  id?: string;
  selected?: boolean;
}

function Row({
  children,
  muted,
  small,
  icon,
  meta,
  onClick,
  href,
  id,
  selected,
}: RowProps) {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: small ? "6px 8px 2px" : "0 8px",
    height: small ? "auto" : 32,
    borderRadius: 4,
    font: small ? "var(--type-eyebrow)" : "var(--type-body-sm)",
    textTransform: small ? "uppercase" : "none",
    letterSpacing: small ? "var(--tracking-wide)" : 0,
    color: muted ? "var(--text-muted)" : "var(--text-primary)",
    cursor: onClick ? "pointer" : "default",
    background: selected ? "var(--surface-hover)" : undefined,
    textDecoration: "none",
  };
  const body = (
    <>
      {icon && (
        <Icon name={icon} size={13} style={{ color: "var(--text-muted)" }} />
      )}
      <span style={{ flex: 1 }}>{children}</span>
      {meta && (
        <span
          style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}
        >
          {meta}
        </span>
      )}
    </>
  );
  if (!onClick) {
    return (
      <div role="presentation" style={rowStyle}>
        {body}
      </div>
    );
  }
  if (href) {
    return (
      <a
        role="option"
        id={id}
        aria-selected={!!selected}
        href={href}
        tabIndex={-1}
        onClick={onClick}
        style={rowStyle}
      >
        {body}
      </a>
    );
  }
  return (
    <div
      role="option"
      id={id}
      aria-selected={!!selected}
      onClick={onClick}
      style={rowStyle}
    >
      {body}
    </div>
  );
}
