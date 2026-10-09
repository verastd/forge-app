import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncButton } from './AsyncButton';
import { Badge } from './Badge';
import { Button } from './Button';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
import { StatusBanner } from './StatusBanner';

describe('Icon', () => {
  it('is decorative by default and announced with a label', () => {
    const { container, rerender } = render(<Icon name="search" />);
    expect(container.querySelector('[data-icon="search"]')).toHaveProperty('ariaHidden', 'true');
    rerender(<Icon name="search" label="Search" />);
    expect(screen.getByRole('img', { name: 'Search' })).toBeTruthy();
  });
});

describe('Spinner and Skeleton', () => {
  it('render the status spinner and a hidden skeleton', () => {
    render(<Spinner label="Loading sales" />);
    expect(screen.getByRole('status', { name: 'Loading sales' })).toBeTruthy();
    const { container } = render(<Skeleton shape="circle" width={20} height={20} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.borderRadius).toBe('50%');
    render(<Skeleton shape="text" />);
  });
});

describe('Button', () => {
  it('fires onClick, shows press feedback and hover colors', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" icon="check" iconRight="chevron-right" onClick={onClick}>
        Apply
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Apply' });
    fireEvent.pointerEnter(btn);
    expect(btn.style.background).toBe('var(--accent-hover)');
    fireEvent.pointerDown(btn);
    expect(btn.style.transform).toBe('scale(0.985)');
    fireEvent.pointerUp(btn);
    fireEvent.pointerLeave(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(['secondary', 'ghost', 'danger', 'link'] as const)('renders the %s variant', (variant) => {
    render(
      <Button variant={variant} size="dense">
        {variant}
      </Button>,
    );
    expect(screen.getByRole('button', { name: variant })).toBeTruthy();
  });

  it('renders icon-only square buttons and other elements via `as`', () => {
    render(<Button icon="x" aria-label="Close" size="comfortable" />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.style.width).toBe('var(--control-comfortable)');
    render(
      <Button as="a" href="/x" full aria-disabled>
        Link
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Link' });
    expect(link.getAttribute('href')).toBe('/x');
    expect(link.style.cursor).toBe('not-allowed');
  });
});

describe('Badge', () => {
  it('always carries text, with a dot or icon', () => {
    render(
      <Badge tone="live" dot>
        Live
      </Badge>,
    );
    render(
      <Badge tone="lock" icon="lock" size="xs">
        Locked
      </Badge>,
    );
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Locked').style.fontSize).toBe('10px');
  });
});

describe('Hint', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens on hover after the delay, instantly on focus, and closes on Escape', () => {
    render(
      <Hint content="Requires an account">
        <button type="button" aria-describedby="other">
          Withdraw
        </button>
      </Hint>,
    );
    const btn = screen.getByRole('button', { name: 'Withdraw' });
    fireEvent.pointerEnter(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('tooltip').textContent).toBe('Requires an account');
    expect(btn.getAttribute('aria-describedby')).toContain('other');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(btn);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.pointerEnter(screen.getByRole('tooltip'));
    fireEvent.pointerLeave(screen.getByRole('tooltip'));
    fireEvent.blur(btn);
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerLeave(btn);
  });

  it('keeps a persistent reason readable without opening', () => {
    render(
      <Hint content="Link an Upland account first" persistent side="right">
        <button type="button">Withdraw</button>
      </Hint>,
    );
    const btn = screen.getByRole('button');
    const id = btn.getAttribute('aria-describedby');
    expect(id && document.getElementById(id)?.textContent).toBe('Link an Upland account first');
  });
});

describe('AsyncButton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes idle → pending → slow → success → idle', async () => {
    let resolve!: () => void;
    render(<AsyncButton label="Save" pendingLabel="Saving…" onAction={() => new Promise<void>((r) => (resolve = r))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const pending = screen.getByRole('button', { name: /Saving/ });
    expect(pending.getAttribute('aria-busy')).toBe('true');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByText('Still working, Upland is slow')).toBeTruthy();
    fireEvent.click(pending);
    await act(async () => {
      resolve();
    });
    expect(screen.getByRole('button', { name: /Done/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('shows the error in words with Retry, and times out', async () => {
    const onAction = vi.fn().mockRejectedValueOnce(new Error('Upland returned 502')).mockImplementation(() => new Promise(() => undefined));
    render(<AsyncButton label="Save" onAction={onAction} timeoutMs={1000} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Upland returned 502');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Timed out');
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic message for non-Error rejections', async () => {
    render(<AsyncButton label="Save" onAction={() => Promise.reject('nope')} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
  });

  it('renders controlled, disabled-with-reason and locked states', () => {
    const onUpgrade = vi.fn();
    const { rerender } = render(<AsyncButton label="Run" state="pending" />);
    expect(screen.getByRole('button', { name: /Run/ }).getAttribute('aria-disabled')).toBe('true');
    rerender(<AsyncButton label="Run" disabledReason="Pick a city first" icon="zap" />);
    const disabled = screen.getByRole('button', { name: /Run/ });
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabled);
    rerender(<AsyncButton label="Run" locked lockedTier="Basic" onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    rerender(<AsyncButton label="Run" state="error" errorMessage="Failed" icon="zap" full />);
    expect(screen.getByRole('alert').textContent).toBe('Failed');
    rerender(<AsyncButton label="Run" state="success" />);
    rerender(<AsyncButton label="Run" state="idle" icon="zap" />);
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
  });
});

describe('StatusBanner', () => {
  it.each(['partial', 'stale', 'capped', 'info'] as const)('%s is a status region', (kind) => {
    render(<StatusBanner kind={kind}>Note</StatusBanner>);
    expect(screen.getByRole('status').textContent).toContain('Note');
  });

  it('maintenance is an alert; actions and dismiss work', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn();
    render(
      <StatusBanner kind="maintenance" actionLabel="Retry" onAction={onAction} onDismiss={onDismiss}>
        Down
      </StatusBanner>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(onAction).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    render(<StatusBanner actionLabel="Refresh">Old</StatusBanner>);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});

describe('StatusGlyph', () => {
  it.each(['pending', 'running', 'done', 'failed', 'cancelled', 'awaiting'] as const)('%s pairs a shape with its word', async (status) => {
    const { StatusGlyph } = await import('./StatusGlyph');
    render(<StatusGlyph status={status} label={`State ${status}`} />);
    expect(screen.getByText(`State ${status}`)).toBeTruthy();
  });

  it('draws a measured ring when progress is given', async () => {
    const { StatusGlyph } = await import('./StatusGlyph');
    const { container } = render(<StatusGlyph status="running" progress={0.5} size={20} />);
    expect(container.querySelector('svg')?.getAttribute('class')).toBeNull();
    render(<StatusGlyph />);
  });
});
