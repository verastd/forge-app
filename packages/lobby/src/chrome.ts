/**
 * Picks the page shell from the URL (Phase 2 addendum's cross-unit
 * contract). Moved here from apps/web/src/components/SiteChrome.tsx with
 * the same behaviour, so the lobby and the site chrome agree on what counts
 * as the lobby:
 *
 * - "site" — the normal site nav plus footer. Everything not under /apps.
 * - "lobby" — /apps exactly. The same site nav, but no footer, so the 3D
 *   lobby owns the rest of the viewport.
 * - "app" — any /apps/<slug> route. No site nav, no footer: the app renders
 *   its own AppBar instead, so there is never more than one top bar on
 *   screen.
 */

export type ChromeMode = 'site' | 'lobby' | 'app';

export function chromeModeFor(pathname: string): ChromeMode {
  // usePathname() carries no query or hash, but a caller passing a full href
  // (`/apps?from=data`) must get the same answer. split() always returns a
  // first element; `?? ''` is only for the type checker.
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  if (path === '/apps' || path === '/apps/') {
    return 'lobby';
  }
  if (path.startsWith('/apps/')) {
    return 'app';
  }
  return 'site';
}
