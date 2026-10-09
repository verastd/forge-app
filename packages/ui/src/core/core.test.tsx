import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Countdown } from './Countdown';
import { DataState } from './DataState';
import { LiveIndicator } from './LiveIndicator';
import { LockedFeature } from './LockedFeature';
import { StatTile } from './StatTile';
import { Toast, ToastStack } from './Toast';

describe('DataState', () => {
  it('renders the default skeleton rows, or a custom skeleton, while loading', () => {
    const { container, rerender } = render(<DataState state="loading">content</DataState>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelectorAll('[aria-hidden="true"]')).toHaveLength(10);
    expect(screen.queryByText('content')).toBeNull();
    rerender(<DataState state="loading" skeleton={<p>table skeleton</p>} />);
    expect(screen.getByText('table skeleton')).toBeTruthy();
  });

  it('renders empty and empty-initial with an optional action', () => {
    const onEmptyAction = vi.fn();
    const { rerender } = render(<DataState state="empty" emptyMessage="No listings." emptyAction="Clear filters" onEmptyAction={onEmptyAction} />);
    expect(screen.getByText('No listings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onEmptyAction).toHaveBeenCalledOnce();
    rerender(<DataState state="empty-initial" />);
    expect(screen.getByText('Set filters and press Search')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<DataState state="empty" />);
    expect(screen.getByText('Nothing to show.')).toBeTruthy();
  });

  it('renders the error state with code, request id, async Retry and Report', async () => {
    const onReport = vi.fn();
    let resolve!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<DataState state="error" error={{ message: 'Upland timed out', code: 'E_UPSTREAM' }} requestId="req_42" onRetry={onRetry} onReport={onReport} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Upland timed out');
    expect(screen.getByText('E_UPSTREAM')).toBeTruthy();
    expect(screen.getByText('request req_42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Retrying/ }).getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    expect(onReport).toHaveBeenCalledOnce();
  });

  it('draws no Report button without a handler', () => {
    render(<DataState state="error" error={{ message: 'Upland timed out' }} onRetry={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });


  it('falls back to a generic error message without handlers', () => {
    render(<DataState state="error" />);
    expect(screen.getByText('Request failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows the partial, stale and capped banners above the children', async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const refresh = vi.fn();
    const upgrade = vi.fn();
    const { rerender } = render(
      <DataState state="partial" partialMessage="2 of 5 cities failed" onRetryPartial={retry}>
        rows
      </DataState>,
    );
    expect(screen.getByRole('status').textContent).toContain('2 of 5 cities failed');
    expect(screen.getByText('rows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(1500));
    rerender(
      <DataState state="stale" staleMinutes={12} onRefresh={refresh}>
        rows
      </DataState>,
    );
    expect(screen.getByText('Data is 12 min old')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(1500));
    rerender(
      <DataState state="capped" cappedCount={10000} onUpgrade={upgrade}>
        rows
      </DataState>,
    );
    expect(screen.getByRole('status').textContent).toContain(`Showing first ${(10000).toLocaleString()}.`);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(upgrade).toHaveBeenCalledOnce();
    vi.useRealTimers();
    rerender(<DataState state="capped">rows</DataState>);
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  it('dims children while refreshing and appends rows while loading more', () => {
    const { container, rerender } = render(<DataState state="refreshing">rows</DataState>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(/Updating/)).toBeTruthy();
    expect(screen.getByText('rows').style.opacity).toBe('0.6');
    rerender(<DataState state="loading-more">rows</DataState>);
    expect(root.getAttribute('aria-busy')).toBeNull();
    expect(root.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    rerender(<DataState>rows</DataState>);
    expect(screen.getByText('rows').style.opacity).toBe('1');
  });
});

describe('LiveIndicator', () => {
  it('shows live details and the new-items pill', () => {
    const onJumpToNew = vi.fn();
    render(<LiveIndicator status="live" updatedAt="14:02:11" nextPollIn={30} newCount={3} onJumpToNew={onJumpToNew} />);
    expect(screen.getByRole('status').textContent).toContain('LIVE');
    expect(screen.getByText('Updated 14:02:11 UTC')).toBeTruthy();
    expect(screen.getByText('next in 30s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '↑ 3 new' }));
    expect(onJumpToNew).toHaveBeenCalledOnce();
  });

  it('covers connecting, reconnecting, paused, offline and error', () => {
    const onResume = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(<LiveIndicator newCount={0} />);
    expect(screen.getByText('Connecting')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<LiveIndicator status="reconnecting" attempt={2} />);
    expect(screen.getByText('Reconnecting (attempt 2)')).toBeTruthy();
    rerender(<LiveIndicator status="reconnecting" />);
    expect(screen.getByText('Reconnecting')).toBeTruthy();
    rerender(<LiveIndicator status="paused" onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledOnce();
    rerender(<LiveIndicator status="offline" onRetry={onRetry} />);
    expect(screen.getByText('Offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    rerender(<LiveIndicator status="error" reason="Feed closed" onRetry={onRetry} />);
    expect(screen.getByText('Feed closed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(2);
    rerender(<LiveIndicator status="error" />);
    expect(screen.getByText('Error')).toBeTruthy();
  });
});

describe('StatTile', () => {
  let rafCallbacks: Array<FrameRequestCallback> = [];
  let now = 0;
  const flushFrame = (t: number): void => {
    now = t;
    const cbs = rafCallbacks;
    rafCallbacks = [];
    act(() => cbs.forEach((cb) => cb(t)));
  };
  beforeEach(() => {
    rafCallbacks = [];
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('formats the value with unit, hint, live status and deltas', () => {
    const { rerender } = render(<StatTile label="Listings" value={12840} delta={3.2} deltaLabel="24h" unit="props" hint="All cities" live="live" />);
    expect(screen.getByText((12840).toLocaleString())).toBeTruthy();
    expect(screen.getByText('props')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(document.querySelector('[data-icon="info"]')).toBeTruthy();
    expect(document.querySelector('[data-icon="trending-up"]')).toBeTruthy();
    expect(screen.getByText(/\+3\.2%/)).toBeTruthy();
    rerender(<StatTile label="Listings" value={5} delta={-1.5} />);
    expect(document.querySelector('[data-icon="trending-down"]')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    rerender(<StatTile label="Listings" value="n/a" delta={0} format={{ style: 'percent' }} />);
    expect(document.querySelector('[data-icon="minus"]')).toBeTruthy();
    expect(screen.getByText('n/a')).toBeTruthy();
  });

  it('renders loading skeletons and an error with a working Retry', () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(<StatTile label="Volume" state="loading" />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    rerender(<StatTile label="Volume" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('Failed to load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<StatTile label="Volume" state="error" />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('ticks an animated value over 600 ms and keeps the real value for screen readers', () => {
    const { container, rerender } = render(<StatTile label="Listings" value={100} animate />);
    const visible = (): string => (container.querySelector('.em-num[aria-hidden="true"]') as HTMLElement).textContent ?? '';
    expect(visible()).toBe('100');
    rerender(<StatTile label="Listings" value={200} animate />);
    expect(container.querySelector('.em-sr')?.textContent).toBe('200');
    flushFrame(300);
    const mid = parseFloat(visible().replace(/[^\d.]/g, ''));
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(200);
    flushFrame(600);
    expect(visible()).toBe('200');
    expect(rafCallbacks).toHaveLength(0);
    rerender(<StatTile label="Listings" value="—" animate />);
    expect(container.querySelector('.em-sr')?.textContent).toBe('—');
  });

  it('starts from 0 after a non-numeric value and cancels on unmount', () => {
    const { container, rerender, unmount } = render(<StatTile label="Listings" value="—" animate />);
    rerender(<StatTile label="Listings" value={50} animate />);
    flushFrame(0);
    expect((container.querySelector('.em-num[aria-hidden="true"]') as HTMLElement).textContent).toBe('0');
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('jumps straight to the value under reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }));
    const { container, rerender } = render(<StatTile label="Listings" value={1} animate />);
    rerender(<StatTile label="Listings" value={9} animate />);
    expect(rafCallbacks).toHaveLength(0);
    expect((container.querySelector('.em-num[aria-hidden="true"]') as HTMLElement).textContent).toBe('9');
  });
});

describe('Countdown', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('ticks each second, turns expiring-soon, then expires and stops', () => {
    const { unmount } = render(<Countdown expiresAt={T0 + 62000} prefix="Ready in" />);
    const timer = screen.getByRole('timer');
    expect(timer.tagName).toBe('TIME');
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(timer.getAttribute('dateTime')).toBe(new Date(T0 + 62000).toISOString());
    expect(timer.textContent).toBe('Ready in 01:02');
    expect(timer.dataset.state).toBe('ticking');
    act(() => vi.advanceTimersByTime(3000));
    expect(timer.textContent).toBe('Ready in 00:59');
    expect(timer.dataset.state).toBe('expiring-soon');
    expect(timer.style.color).toBe('var(--state-warning)');
    act(() => vi.advanceTimersByTime(59000));
    expect(timer.textContent).toBe('Expired');
    expect(timer.dataset.state).toBe('expired');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('formats hours, honours clock offset and a custom expired label', () => {
    const { rerender } = render(<Countdown expiresAt={T0 + 2 * 3600000 + 5 * 60000} />);
    expect(screen.getByRole('timer').textContent).toBe('2h 05m');
    rerender(<Countdown expiresAt={T0 + 90000} format="hhmmss" />);
    expect(screen.getByRole('timer').textContent).toBe('0h 01m');
    rerender(<Countdown expiresAt={T0 + 5000} clockOffset={10000} expiredLabel="Gone" />);
    expect(screen.getByRole('timer').textContent).toBe('Gone');
  });

  it('renders the unknown dash without a timer and clears its timer on unmount', () => {
    const { container, rerender, unmount } = render(<Countdown expiresAt={null} />);
    expect(container.textContent).toBe('—');
    expect((container.firstElementChild as HTMLElement).dataset.state).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
    rerender(<Countdown expiresAt={T0 + 120000} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LockedFeature', () => {
  it('offers Upgrade / Compare plans to signed-in users', () => {
    const onUpgrade = vi.fn();
    const onCompare = vi.fn();
    render(<LockedFeature feature="Collection optimizer" value="Find the cheapest completion path." onUpgrade={onUpgrade} onCompare={onCompare} />);
    expect(screen.getByText('Collection optimizer')).toBeTruthy();
    expect(screen.getByText('Premium')).toBeTruthy();
    expect(screen.getByText('Find the cheapest completion path.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(onCompare).toHaveBeenCalledOnce();
  });

  it('swaps CTAs for anonymous visitors and supports compact', () => {
    const onLogin = vi.fn();
    const onSignup = vi.fn();
    const { container } = render(<LockedFeature feature="Alerts" tier="Basic" anonymous compact onLogin={onLogin} onSignup={onSignup} />);
    expect((container.firstElementChild as HTMLElement).style.padding).toBe('16px');
    expect(screen.getByText('Basic')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create free account' }));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onSignup).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });
});

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders title, description, action and close', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(<Toast variant="error" title="Withdraw failed" description="Upland rejected it" actionLabel="Retry" onAction={onAction} onClose={onClose} />);
    expect(document.querySelector('[data-icon="circle-alert"]')).toBeTruthy();
    expect(screen.getByText('Upland rejected it')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(10000));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('auto-dismisses info after 4 s, pausing on hover and focus', () => {
    const onClose = vi.fn();
    const { container } = render(<Toast title="Saved" onClose={onClose} />);
    const card = container.firstElementChild as HTMLElement;
    expect(document.querySelector('[data-icon="info"]')).toBeTruthy();
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.pointerEnter(card);
    act(() => vi.advanceTimersByTime(10000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerLeave(card);
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.focus(close);
    act(() => vi.advanceTimersByTime(10000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(close, { relatedTarget: card });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(close, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('persists with duration 0 and without onClose', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast variant="success" title="Done" duration={0} onClose={onClose} />);
    expect(document.querySelector('[data-icon="circle-check"]')).toBeTruthy();
    act(() => vi.advanceTimersByTime(10000));
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Toast variant="success" title="Done" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ToastStack', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('routes errors to the assertive region and others to the polite one', () => {
    const onClose = vi.fn();
    const onAction = vi.fn();
    render(
      <ToastStack
        position="top-right"
        onClose={onClose}
        onAction={onAction}
        toasts={[
          { id: 'a', variant: 'success', title: 'Saved' },
          { id: 'b', variant: 'error', title: 'Withdraw failed', actionLabel: 'Retry' },
        ]}
      />,
    );
    const polite = screen.getByRole('status');
    const assertive = screen.getByRole('alert');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(assertive.getAttribute('aria-live')).toBe('assertive');
    expect(polite.textContent).toContain('Saved');
    expect(assertive.textContent).toContain('Withdraw failed');
    expect((polite.parentElement as HTMLElement).style.top).toBe('16px');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledWith('b');
    act(() => vi.advanceTimersByTime(4000));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('pre-mounts empty regions and tolerates missing handlers', () => {
    const { rerender } = render(<ToastStack />);
    expect(screen.getByRole('status').childElementCount).toBe(0);
    expect(screen.getByRole('alert').childElementCount).toBe(0);
    expect((screen.getByRole('status').parentElement as HTMLElement).style.bottom).toBe('16px');
    rerender(<ToastStack toasts={[{ id: 'x', title: 'Note', actionLabel: 'Undo' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => vi.advanceTimersByTime(4000));
  });
});

describe('DataState loading', () => {
  it('announces loading to assistive tech behind the skeleton', () => {
    render(<DataState state="loading" />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });
});
