import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { FeatureGrid } from './FeatureGrid';
import { SidebarNav } from './SidebarNav';
import type { NavGroup, NavLinkRenderProps } from './SidebarNav';
import { TopBar } from './TopBar';
import type { TopBarSearchRow } from './TopBar';

type MQListener = () => void;
function stubMatchMedia(matches: (q: string) => boolean) {
  const listeners: MQListener[] = [];
  const mq = (q: string) => ({
    get matches() {
      return matches(q);
    },
    media: q,
    addEventListener: (_: string, l: MQListener) => listeners.push(l),
    removeEventListener: (_: string, l: MQListener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(mq) });
  return listeners;
}
function unstubMatchMedia() {
  Reflect.deleteProperty(window, 'matchMedia');
}

describe('AppShell', () => {
  it('renders the em-root grid with slots, footer, routing bar and main ref', () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(
      <AppShell className="host" topBar={<header>top</header>} sidebar={<nav aria-label="Main">side</nav>} banner={<div>banner</div>} routing mainRef={ref} style={{ height: 500 }}>
        <p>content</p>
      </AppShell>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('em-root em-shell host');
    expect(root.style.height).toBe('500px');
    expect(ref.current?.tagName).toBe('MAIN');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.getByText('banner')).toBeTruthy();
    expect(screen.getByRole('contentinfo').textContent).toMatch(/not affiliated with Upland/);
    expect(container.querySelector('.em-motion')).toBeTruthy();
    const body = container.querySelector('.em-shell__body') as HTMLElement;
    expect(body.style.gridTemplateColumns).toBe('auto minmax(0, 1fr)');
    expect(container.querySelector('.em-shell__sidebar')?.textContent).toBe('side');
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('collapses to one column without a sidebar and accepts a custom footer', () => {
    const { container } = render(<AppShell footer="Custom footer">x</AppShell>);
    expect((container.firstElementChild as HTMLElement).className).toBe('em-root em-shell');
    expect((container.querySelector('.em-shell__body') as HTMLElement).style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(container.querySelector('.em-shell__sidebar')).toBeNull();
    expect(container.querySelector('.em-motion')).toBeNull();
    expect(screen.getByText('Custom footer')).toBeTruthy();
  });

  describe('drawer', () => {
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    afterEach(() => {
      delete proto.showModal;
      delete proto.close;
      unstubMatchMedia();
    });

    it('drives a native modal dialog and reports Escape, backdrop and close clicks', () => {
      const showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      });
      const close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      });
      proto.showModal = showModal;
      proto.close = close;
      const onClose = vi.fn();
      const { container, rerender } = render(
        <AppShell drawer={<span>drawer nav</span>} drawerOpen={false} onDrawerClose={onClose} drawerTitle="FORGE">
          x
        </AppShell>,
      );
      const dialog = container.querySelector('dialog') as HTMLDialogElement;
      expect(dialog.className).toBe('em-shell__drawer');
      expect(dialog.open).toBe(false);
      expect(showModal).not.toHaveBeenCalled();

      rerender(
        <AppShell drawer={<span>drawer nav</span>} drawerOpen onDrawerClose={onClose} drawerTitle="FORGE">
          x
        </AppShell>,
      );
      expect(showModal).toHaveBeenCalledOnce();
      expect(dialog.open).toBe(true);
      expect(within(dialog).getByText('FORGE')).toBeTruthy();
      expect(within(dialog).getByText('drawer nav')).toBeTruthy();

      const cancel = new Event('cancel', { cancelable: true });
      fireEvent(dialog, cancel);
      expect(cancel.defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);

      fireEvent.click(dialog);
      expect(onClose).toHaveBeenCalledTimes(2);
      fireEvent.click(within(dialog).getByText('drawer nav'));
      expect(onClose).toHaveBeenCalledTimes(2);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close navigation' }));
      expect(onClose).toHaveBeenCalledTimes(3);

      rerender(
        <AppShell drawer={<span>drawer nav</span>} drawerOpen={false} onDrawerClose={onClose}>
          x
        </AppShell>,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(dialog.open).toBe(false);
      // The programmatic close event does not echo back to the host.
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('falls back to the open attribute where showModal is missing (jsdom)', () => {
      const { container, rerender } = render(<AppShell drawer={<span>nav</span>} drawerOpen />);
      const dialog = container.querySelector('dialog') as HTMLDialogElement;
      expect(dialog.hasAttribute('open')).toBe(true);
      rerender(<AppShell drawer={<span>nav</span>} drawerOpen={false} />);
      expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('asks the host to close when the viewport grows to desktop width', () => {
      let desktop = false;
      const listeners = stubMatchMedia(() => desktop);
      const onClose = vi.fn();
      const { rerender, unmount } = render(
        <AppShell drawer={<span>nav</span>} drawerOpen onDrawerClose={onClose}>
          x
        </AppShell>,
      );
      expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
      listeners.forEach((l) => l());
      expect(onClose).not.toHaveBeenCalled();
      desktop = true;
      listeners.forEach((l) => l());
      expect(onClose).toHaveBeenCalledOnce();
      rerender(
        <AppShell drawer={<span>nav</span>} drawerOpen={false} onDrawerClose={onClose}>
          x
        </AppShell>,
      );
      listeners.forEach((l) => l());
      expect(onClose).toHaveBeenCalledOnce();
      unmount();
      expect(listeners).toHaveLength(0);
    });
  });
});

describe('TopBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const results: TopBarSearchRow[] = [
    { label: '1204 Quailwood Dr, Bakersfield', kind: 'Property', icon: 'building-2' },
    { label: 'Quailwood', kind: 'Neighborhood', icon: 'map', href: '#hood' },
    { label: 'quailwoodqueen', kind: 'User', icon: 'user' },
  ];
  const input = () => screen.getByRole('combobox', { name: 'Search properties, users, collections' });

  it('ticks the UTC and Los Angeles clocks every second and clears the interval on unmount', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { container, unmount } = render(<TopBar />);
    expect(container.textContent).toContain('12:00 UTC');
    expect(container.textContent).toContain('04:00 LA');
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.textContent).toContain('12:01 UTC');
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('shows a fixed time when `now` is controlled', () => {
    const { container } = render(<TopBar now={Date.UTC(2026, 6, 1, 8, 5)} />);
    expect(container.textContent).toContain('08:05 UTC');
    expect(container.textContent).toContain('01:05 LA');
    act(() => vi.advanceTimersByTime(120_000));
    expect(container.textContent).toContain('08:05 UTC');
  });

  it('stays closed when idle with no history, and lists recent history on focus', () => {
    const { rerender } = render(<TopBar />);
    fireEvent.focus(input());
    expect(input().getAttribute('aria-expanded')).toBe('false');
    const onPick = vi.fn();
    const recent: TopBarSearchRow[] = [{ label: '410 Mission St' }, { label: 'tdlabs', href: '#u/tdlabs' }];
    rerender(<TopBar recent={recent} onPick={onPick} />);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox');
    expect(input().getAttribute('aria-controls')).toBe(list.id);
    expect(within(list).getByText('Recent')).toBeTruthy();
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]?.tagName).toBe('DIV');
    expect(options[1]?.tagName).toBe('A');
    expect(options[1]?.getAttribute('href')).toBe('#u/tdlabs');
    fireEvent.click(options[0] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(recent[0]);
  });

  it('asks for more characters below the 3-char minimum', () => {
    const onQueryChange = vi.fn();
    const { rerender } = render(<TopBar query="s" onQueryChange={onQueryChange} />);
    fireEvent.focus(input());
    expect(screen.getByRole('listbox').textContent).toBe('Type 2 more characters');
    rerender(<TopBar query="sf" onQueryChange={onQueryChange} />);
    expect(screen.getByRole('listbox').textContent).toBe('Type 1 more character');
    fireEvent.change(input(), { target: { value: 'sfo' } });
    expect(onQueryChange).toHaveBeenCalledWith('sfo');
  });

  it('shows loading, empty and error states; Retry calls onSearchRetry', () => {
    const onSearchRetry = vi.fn();
    const { rerender, container } = render(<TopBar query="quailwood" searchStatus="loading" />);
    fireEvent.focus(input());
    expect(screen.getByRole('listbox').textContent).toContain('Searching…');
    expect(container.querySelector('kbd')).toBeNull();
    rerender(<TopBar query="quailwood" searchStatus="results" />);
    expect(screen.getByRole('listbox').textContent).toBe('No results for “quailwood”');
    rerender(<TopBar query="quailwood" searchStatus="empty" />);
    expect(screen.getByRole('listbox').textContent).toBe('No results for “quailwood”');
    rerender(<TopBar query="quailwood" searchStatus="error" onSearchRetry={onSearchRetry} />);
    expect(screen.getByText('Search failed')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(fireEvent.mouseDown(retry)).toBe(false);
    fireEvent.click(retry);
    expect(onSearchRetry).toHaveBeenCalledOnce();
    // Tabbing from the input to Retry keeps the popover open.
    fireEvent.blur(input(), { relatedTarget: retry });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders results with kind meta and link rows, and picks on click', () => {
    const onPick = vi.fn();
    render(<TopBar query="quailwood" searchStatus="results" results={results} onPick={onPick} />);
    fireEvent.focus(input());
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toBe('1204 Quailwood Dr, BakersfieldProperty');
    expect(options[1]?.getAttribute('href')).toBe('#hood');
    fireEvent.click(options[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(results[1]);
  });

  it('walks options with the arrow keys, picks with Enter and closes with Escape', () => {
    const onPick = vi.fn();
    render(<TopBar query="quailwood" searchStatus="results" results={results} onPick={onPick} />);
    const box = input();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2]?.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id);
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(results[1]);
    fireEvent.keyDown(box, { key: 'Tab' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('ignores arrows when nothing is pickable and closes 120 ms after blur', () => {
    render(<TopBar query="qu" />);
    const box = input();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.blur(box);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.focus(box);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.blur(box);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('focuses search on "/" unless typing or using a modifier', () => {
    render(
      <>
        <TopBar />
        <textarea aria-label="notes" />
      </>,
    );
    fireEvent.keyDown(window, { key: 'x' });
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(screen.getByLabelText('notes'), { key: '/' });
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: '/' })).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('changes theme through the labeled segment', () => {
    const onTheme = vi.fn();
    render(<TopBar theme="light" onTheme={onTheme} />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(onTheme).toHaveBeenCalledWith('dark');
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    expect(onTheme).toHaveBeenCalledWith('system');
  });

  it('shows the bell count, the notifications dropdown and Mark all read', () => {
    const onNotifToggle = vi.fn();
    const onMarkAllRead = vi.fn();
    const { rerender, container } = render(<TopBar unread={3} onNotifToggle={onNotifToggle} />);
    const bell = screen.getByRole('button', { name: 'Notifications, 3 unread' });
    fireEvent.click(bell);
    expect(onNotifToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<TopBar unread={12} notifOpen onNotifToggle={onNotifToggle} onMarkAllRead={onMarkAllRead} />);
    expect(container.textContent).toContain('9+');
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog.textContent).toContain('You’re all caught up.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark all read' }));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Mark all read' }), { key: 'Escape' });
    expect(onNotifToggle).toHaveBeenCalledTimes(2);
    rerender(
      <TopBar
        notifOpen
        onNotifToggle={onNotifToggle}
        notifications={[
          { id: 1, title: 'Rare chest found in Rio de Janeiro', detail: 'Ready in 1:35', when: '2m', unread: true, icon: 'gem', __new: true },
          { id: 'b', title: 'Withdraw confirmed', when: '3h' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items[0]?.className).toBe('em-motion');
    expect(items[0]?.style.background).toBe('var(--accent-soft)');
    expect(items[0]?.textContent).toContain('Ready in 1:35');
    expect(items[1]?.className).toBe('');
    expect(items[1]?.querySelector('[data-icon="bell"]')).toBeTruthy();
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Enter' });
    expect(onNotifToggle).toHaveBeenCalledTimes(2);
  });

  it('shows the user chip with a tier badge, or log-in links when signed out', () => {
    const { rerender } = render(<TopBar user={{ name: 'TD', tier: 'Premium' }} />);
    expect(screen.getByText('Premium').style.color).toBe('var(--tier-premium)');
    expect(screen.getByTitle('TD').textContent).toBe('T');
    rerender(<TopBar user={{ name: 'Ann', tier: 'Staff' }} />);
    expect(screen.getByText('Staff').style.color).toBe('var(--text-secondary)');
    rerender(<TopBar user={null} />);
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/auth/login');
    expect(screen.getByRole('link', { name: 'Create free account' }).getAttribute('href')).toBe('/auth/signup');
  });

  it('composes into a host: menu, leading, brand and trailing slots', () => {
    const onMenu = vi.fn();
    const { rerender } = render(<TopBar onMenu={onMenu} />);
    expect(screen.getByRole('link', { name: 'Embers' }).getAttribute('href')).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(onMenu).toHaveBeenCalledOnce();
    rerender(<TopBar leading={<a href="/back">Back</a>} brand={<strong>FORGE</strong>} trailing={<span>host actions</span>} user={{ name: 'TD', tier: 'Free' }} />);
    expect(screen.queryByRole('link', { name: 'Embers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
    const header = screen.getByRole('banner');
    expect(header.textContent?.indexOf('Back')).toBeLessThan(header.textContent?.indexOf('FORGE') ?? -1);
    expect(screen.getByText('host actions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Notifications/ })).toBeNull();
    expect(screen.queryByText('Free')).toBeNull();
  });
});

const NAV: NavGroup[] = [
  { id: 'props', label: 'Properties', icon: 'building-2', items: [{ label: 'Search', href: '/properties/search' }, { label: 'Live listings', href: '/properties/live', live: true }, { label: 'City release', href: '/properties/city-release', isNew: true }] },
  { id: 'ssh', label: 'Staking Hub', items: [{ label: 'Active contracts', href: '/ssh', icon: 'layers' }, { label: 'My contributions', href: '/ssh/mine', count: 4 }, { label: 'Empty count', href: '/ssh/zero', count: 0 }] },
  { id: 'tools', label: 'Tools', icon: 'wrench', items: [{ label: 'Appraiser', href: '/tools/appraiser', locked: true, lockedTier: 'Basic' }, { label: 'Optimizer', href: '/me/optimizer', locked: true }] },
];

describe('SidebarNav', () => {
  it('renders groups as disclosure buttons with inert collapsed bodies', () => {
    const onToggleGroup = vi.fn();
    render(<SidebarNav groups={NAV} openGroups={['props']} activeHref="/ssh" onToggleGroup={onToggleGroup} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.style.width).toBe('var(--sidebar-width)');
    const props = screen.getByRole('button', { name: 'Properties' });
    const ssh = screen.getByRole('button', { name: 'Staking Hub' });
    expect(props.getAttribute('aria-expanded')).toBe('true');
    expect(ssh.getAttribute('aria-expanded')).toBe('false');
    const sshBody = document.getElementById(ssh.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(sshBody.hasAttribute('inert')).toBe(true);
    expect(sshBody.style.display).toBe('none');
    // Collapsed group that holds the active page is highlighted.
    expect(ssh.style.color).toBe('var(--accent-strong)');
    expect(props.style.color).toBe('var(--text-secondary)');
    expect(ssh.querySelectorAll('svg')).toHaveLength(1);
    fireEvent.click(ssh);
    expect(onToggleGroup).toHaveBeenCalledWith('ssh');
  });

  it('marks the active link, shows badges and counts, and locks with tier text', () => {
    vi.useFakeTimers();
    render(<SidebarNav groups={NAV} openGroups={['props', 'ssh', 'tools']} activeHref="/ssh" width={300} style={{ borderRight: 0 }} />);
    const nav = screen.getByRole('navigation');
    expect(nav.style.width).toBe('300px');
    const active = screen.getByRole('link', { name: 'Active contracts' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.className).toBe('em-nav__link');
    expect(active.querySelector('[data-icon="layers"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: /Live listings/ }).textContent).toContain('Live');
    expect(screen.getByRole('link', { name: /City release/ }).textContent).toContain('New');
    expect(screen.getByRole('link', { name: /My contributions/ }).textContent).toBe('My contributions4');
    expect(screen.getByRole('link', { name: 'Empty count' }).textContent).toBe('Empty count');
    const appraiser = screen.getByRole('link', { name: /Appraiser/ });
    expect(appraiser.getAttribute('href')).toBe('#pricing');
    expect(within(appraiser).getByText('Basic').style.color).toBe('var(--tier-basic)');
    const optimizer = screen.getByRole('link', { name: /Optimizer/ });
    expect(within(optimizer).getByText('Locked').style.color).toBe('var(--text-muted)');
    fireEvent.focus(appraiser);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip').textContent).toBe('Requires Basic. Click to see plans.');
    fireEvent.blur(appraiser);
    fireEvent.focus(optimizer);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('tooltip').textContent).toBe('Requires a paid plan. Click to see plans.');
    vi.useRealTimers();
  });

  it('lists favorites first with a star toggle outside the link', () => {
    const onToggleFavorite = vi.fn();
    const favorites = [{ label: 'Live listings', href: '/properties/live', live: true }];
    render(<SidebarNav groups={NAV} favorites={favorites} openGroups={['fav', 'props']} onToggleFavorite={onToggleFavorite} />);
    const groups = screen.getAllByRole('button', { expanded: true });
    expect(groups[0]?.textContent).toBe('Favorites');
    const remove = screen.getAllByRole('button', { name: 'Remove Live listings from favorites' });
    expect(remove).toHaveLength(2);
    expect(remove[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(remove[0]?.closest('a')).toBeNull();
    expect(remove[0]?.closest('li')?.className).toBe('em-nav__item--fav');
    const add = screen.getByRole('button', { name: 'Add Search to favorites' });
    expect(add.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(add);
    expect(onToggleFavorite).toHaveBeenCalledWith(NAV[0]?.items[0]);
    expect(screen.getByRole('link', { name: 'Search' }).style.padding).toBe('4px 28px 4px 14px');
  });

  it('renders items through renderLink and gives each instance unique ids', () => {
    const renderLink = vi.fn(({ children, href, ...rest }: NavLinkRenderProps): ReactNode => (
      <a data-router="yes" href={`/app${href}`} {...rest}>
        {children}
      </a>
    ));
    render(
      <>
        <SidebarNav groups={NAV} openGroups={['props', 'tools']} activeHref="/properties/search" renderLink={renderLink} />
        <SidebarNav groups={NAV} openGroups={['props']} />
      </>,
    );
    const link = screen.getAllByRole('link', { name: 'Search' })[0] as HTMLElement;
    expect(link.getAttribute('data-router')).toBe('yes');
    expect(link.getAttribute('href')).toBe('/app/properties/search');
    expect(renderLink).toHaveBeenCalledWith(expect.objectContaining({ href: '/properties/search', 'aria-current': 'page', className: 'em-nav__link' }));
    // Locked items keep a plain hash link so the Hint wiring reaches them.
    expect(renderLink).not.toHaveBeenCalledWith(expect.objectContaining({ href: '#pricing' }));
    const [a, b] = screen.getAllByRole('button', { name: 'Properties' });
    expect(a?.getAttribute('aria-controls')).not.toBe(b?.getAttribute('aria-controls'));
  });

  it('renders an empty nav by default', () => {
    render(<SidebarNav groups={undefined as unknown as NavGroup[]} />);
    expect(screen.getByRole('navigation').childElementCount).toBe(0);
  });
});

describe('FeatureGrid', () => {
  const groups = [
    {
      tier: 'free' as const,
      title: 'Free for everyone',
      tiles: [
        { title: 'Property search', description: 'Every listing, every city.', icon: 'search' as const, href: '/properties/search', colSpan: 2 },
        { title: 'Treasure board', description: 'Timers and rarity.', icon: 'gem' as const, locked: false },
      ],
    },
    { tier: 'premium' as const, title: 'Premium', tiles: [{ title: 'Collection optimizer', description: 'Cheapest completion path.', icon: 'sparkles' as const, locked: true }] },
  ];
  afterEach(() => unstubMatchMedia());

  it('groups tiles by tier with links, and routes locked tiles to plans', () => {
    const { container } = render(<FeatureGrid groups={groups} columns={2} style={{ gap: 10 }} />);
    expect((container.firstElementChild as HTMLElement).style.gap).toBe('10px');
    const free = screen.getByRole('region', { name: 'Free for everyone' });
    expect(within(free).getByRole('heading', { level: 3 }).textContent).toBe('Free for everyone');
    const search = within(free).getByRole('link', { name: /Property search/ });
    expect(search.getAttribute('href')).toBe('/properties/search');
    expect(search.style.gridColumn).toBe('span 2');
    expect(search.textContent).toContain('Open');
    expect(within(free).getByRole('link', { name: /Treasure board/ }).getAttribute('href')).toBe('#');
    const premium = screen.getByRole('region', { name: 'Premium' });
    const locked = within(premium).getByRole('link', { name: /Collection optimizer/ });
    expect(locked.getAttribute('href')).toBe('#pricing');
    expect(locked.textContent).toContain('See plans');
    expect(locked.style.opacity).toBe('0.85');
    expect(within(locked).getByText('premium')).toBeTruthy();
  });

  it('lifts on hover unless reduced motion is preferred (and survives a missing matchMedia)', () => {
    const { unmount } = render(<FeatureGrid groups={groups} />);
    const tile = screen.getByRole('link', { name: /Property search/ });
    fireEvent.pointerEnter(tile);
    expect(tile.style.transform).toBe('translateY(-2px)');
    expect(tile.style.boxShadow).toBe('var(--elevation-2)');
    fireEvent.pointerLeave(tile);
    expect(tile.style.transform).toBe('none');
    unmount();
    stubMatchMedia(() => true);
    render(<FeatureGrid groups={groups} />);
    const t2 = screen.getByRole('link', { name: /Property search/ });
    fireEvent.pointerEnter(t2);
    expect(t2.style.transform).toBe('none');
    expect(t2.style.border).toBe('1px solid var(--border-strong)');
  });

  it('renders nothing without groups', () => {
    const { container } = render(<FeatureGrid groups={undefined as unknown as []} />);
    expect(container.firstElementChild?.childElementCount).toBe(0);
  });
});
