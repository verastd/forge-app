/**
 * SidebarNav (handoff layout/SidebarNav.jsx, CM-02, adapted BranchedMenu
 * SEL-11). Controlled: activeHref, openGroups + onToggleGroup. Items are links
 * with aria-current="page". Badges: lock (tier text), new, live, count.
 * Favorites group first with a star toggle. Collapsed bodies are inert.
 *
 * Adaptations: `renderLink` lets a host render items with its router link
 * (default <a>); locked items always render a plain <a href="#pricing"> so the
 * Hint's aria-describedby and focus handlers reach the element. Group and item
 * icons are optional. Group body ids are per instance (useId), so the inline
 * sidebar and the drawer copy never share ids. The favorite toggle is a
 * sibling of the link, not nested inside it (no interactive content in <a>).
 */
import { useId } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { Badge } from '../core/Badge';
import type { BadgeTone } from '../core/Badge';
import { Hint } from '../core/Hint';
import { Icon } from '../core/Icon';
import type { IconName } from '../core/Icon';

export interface NavItem {
  label: string;
  href: string;
  icon?: IconName;
  locked?: boolean;
  lockedTier?: string;
  isNew?: boolean;
  live?: boolean;
  count?: number;
}

export interface NavGroup {
  id: string;
  label: string;
  icon?: IconName;
  items: NavItem[];
}

export interface NavLinkRenderProps {
  href: string;
  className?: string;
  style: CSSProperties;
  'aria-current'?: 'page';
  children: ReactNode;
}

export interface SidebarNavProps {
  groups: NavGroup[];
  activeHref?: string;
  openGroups?: string[];
  onToggleGroup?: (id: string) => void;
  favorites?: NavItem[];
  onToggleFavorite?: (item: NavItem) => void;
  width?: number | string;
  /** Render an item link with the host's router link. Defaults to <a>. */
  renderLink?: (props: NavLinkRenderProps) => ReactNode;
  style?: CSSProperties;
}

const TIER_TONES: ReadonlyArray<BadgeTone> = ['free', 'basic', 'premium'];

function lockTone(tier: string | undefined): BadgeTone {
  const t = tier?.toLowerCase();
  return TIER_TONES.find((x) => x === t) ?? 'lock';
}

function defaultLink({ children, ...props }: NavLinkRenderProps): ReactElement {
  return <a {...props}>{children}</a>;
}

export function SidebarNav({
  groups = [],
  activeHref,
  openGroups = [],
  onToggleGroup,
  favorites = [],
  onToggleFavorite,
  width = 'var(--sidebar-width)',
  renderLink = defaultLink,
  style,
}: SidebarNavProps) {
  const uid = useId();
  const shared = { activeHref, onToggle: onToggleGroup, favorites, onToggleFavorite, renderLink, uid };
  return (
    <nav aria-label="Main" style={{ width, flex: 'none', display: 'grid', alignContent: 'start', gap: 2, padding: '8px', overflowY: 'auto', background: 'var(--surface-card)', borderRight: '1px solid var(--border-subtle)', font: 'var(--type-body-sm)', color: 'var(--text-primary)', boxSizing: 'border-box', ...style }}>
      {favorites.length > 0 && <Group id="fav" label="Favorites" icon="star" open={openGroups.includes('fav')} items={favorites} {...shared} />}
      {groups.map((g) => (
        <Group key={g.id} id={g.id} label={g.label} icon={g.icon} items={g.items} open={openGroups.includes(g.id)} {...shared} />
      ))}
    </nav>
  );
}

interface GroupProps {
  id: string;
  label: string;
  icon?: IconName;
  items?: NavItem[];
  open: boolean;
  onToggle?: (id: string) => void;
  activeHref?: string;
  favorites: NavItem[];
  onToggleFavorite?: (item: NavItem) => void;
  renderLink: (props: NavLinkRenderProps) => ReactNode;
  uid: string;
}

function Group({ id, label, icon, items = [], open, onToggle, activeHref, favorites, onToggleFavorite, renderLink, uid }: GroupProps) {
  const bodyId = `${uid}nav-${id}`;
  const hasActive = items.some((i) => i.href === activeHref);
  return (
    <div>
      <button
        type="button"
        className="em-nav__group"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle?.(id)}
        style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32, padding: '0 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer', boxSizing: 'border-box', color: hasActive && !open ? 'var(--accent-strong)' : 'var(--text-secondary)', font: 'var(--type-label)' }}
      >
        {icon && <Icon name={icon} size={15} />}
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <Icon name="chevron-down" size={13} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-fast)', opacity: 0.7 }} />
      </button>
      <ul id={bodyId} inert={!open} style={{ listStyle: 'none', margin: 0, padding: 0, display: open ? 'grid' : 'none', gap: 1, position: 'relative', paddingLeft: 14 }}>
        <li aria-hidden="true" role="presentation" style={{ position: 'absolute', left: 15, top: 4, bottom: 4, width: 1, background: 'var(--border-subtle)' }} />
        {items.map((it) => {
          const active = it.href === activeHref;
          const fav = favorites.some((f) => f.href === it.href);
          const linkProps: NavLinkRenderProps = {
            href: it.locked ? '#pricing' : it.href,
            className: 'em-nav__link',
            'aria-current': active ? 'page' : undefined,
            style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: `4px ${onToggleFavorite ? 28 : 8}px 4px 14px`, borderRadius: 'var(--radius-md)', textDecoration: 'none', color: active ? 'var(--text-primary)' : it.locked ? 'var(--text-muted)' : 'var(--text-secondary)', background: active ? 'var(--accent-soft)' : 'transparent', fontWeight: active ? 600 : 400, position: 'relative', boxSizing: 'border-box' },
            children: (
              <>
                {active && <span aria-hidden="true" style={{ position: 'absolute', left: 1, top: 6, bottom: 6, width: 2, borderRadius: 1, background: 'var(--accent)' }} />}
                {it.icon && <Icon name={it.icon} size={14} />}
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{it.label}</span>
                {it.locked && (
                  <Badge tone={lockTone(it.lockedTier)} size="xs" icon="lock">
                    {it.lockedTier || 'Locked'}
                  </Badge>
                )}
                {it.isNew && (
                  <Badge tone="new" size="xs">
                    New
                  </Badge>
                )}
                {it.live && (
                  <Badge tone="live" size="xs" dot>
                    Live
                  </Badge>
                )}
                {it.count !== undefined && it.count > 0 && (
                  <span className="em-num" style={{ font: 'var(--type-caption)', color: 'var(--text-muted)' }}>
                    {it.count}
                  </span>
                )}
              </>
            ),
          };
          return (
            <li key={it.href} className={onToggleFavorite ? 'em-nav__item--fav' : undefined} style={{ position: 'relative' }}>
              {it.locked ? (
                <Hint content={`Requires ${it.lockedTier || 'a paid plan'}. Click to see plans.`} side="right">
                  {defaultLink(linkProps)}
                </Hint>
              ) : (
                renderLink(linkProps)
              )}
              {onToggleFavorite && (
                <button
                  type="button"
                  className="em-nav__fav"
                  aria-label={fav ? `Remove ${it.label} from favorites` : `Add ${it.label} to favorites`}
                  aria-pressed={fav}
                  onClick={() => onToggleFavorite(it)}
                  style={{ all: 'unset', position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', color: fav ? 'var(--accent)' : 'var(--border-strong)', opacity: fav ? 1 : 0.6 }}
                >
                  <Icon name="star" size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
