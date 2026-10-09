import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable, Pager } from './DataTable';
import type { Column } from './DataTable';
import { Dialog } from './Dialog';
import { EventTimeline } from './EventTimeline';
import { FillGauge } from './FillGauge';
import { FilterBar, FilterField } from './FilterBar';
import { GlowCard } from './GlowCard';
import { JobPhaseList } from './JobPhaseList';
import { LiveTicker } from './LiveTicker';
import { ProgressRing } from './ProgressRing';
import { RecommendedBeam } from './RecommendedBeam';
import { Receipt, StepFlow } from './StepFlow';
import { WaitIndicator } from './WaitIndicator';

/** Installs a controllable window.matchMedia; returns a setter that fires `change`. */
function mockMatchMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return state[query] ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return (query: string, value: boolean) => {
    state[query] = value;
    act(() => listeners.forEach((l) => l()));
  };
}

const REDUCE = '(prefers-reduced-motion: reduce)';
const HOVER = '(hover: hover)';
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

interface Sale {
  id: string;
  addr: string;
  price: number;
  up2: number;
  tags?: string[];
  flag?: boolean;
  __new?: boolean;
}
const rows: Sale[] = [
  { id: '1', addr: '1204 Quailwood Dr', price: 4200, up2: 1830, tags: ['a', 'b'], __new: true },
  { id: '2', addr: '88 Tyner St', price: 9800, up2: 3110, flag: true },
];
const cols: Column<Sale>[] = [
  { key: 'addr', label: 'Address', sortable: true },
  { key: 'price', label: 'Price', num: true, sortable: true, hint: 'Ask in UPX', render: (r) => `${r.price.toLocaleString()} UPX` },
  { key: 'up2', label: 'UP2', num: true, hint: 'Square footage', width: 80 },
  { key: 'tags', label: 'Tags', mono: true, muted: true, align: 'center' },
  { key: 'flag', label: 'Flag' },
];

describe('DataTable', () => {
  it('renders cells with data-label for the card layout and the arrival highlight', () => {
    const { container } = render(<DataTable columns={cols} rows={rows} density="standard" />);
    const table = screen.getByRole('table');
    expect(table.className).toBe('em-datatable');
    const cell = screen.getByText('4,200 UPX');
    expect(cell.getAttribute('data-label')).toBe('Price');
    expect(cell.className).toBe('em-num');
    expect(cell.style.textAlign).toBe('right');
    expect(cell.style.height).toBe('var(--row-standard)');
    expect(screen.getByText('a,b').style.font).toBe('var(--type-code)');
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows[0]?.className).toBe('em-motion');
    expect((bodyRows[1] as HTMLElement).style.animation).toBe('none');
    // booleans render nothing, like React would
    expect(within(bodyRows[1] as HTMLElement).getAllByRole('cell')[4]?.textContent).toBe('');
  });

  it('sorts from a keyboard-operable header button and reflects aria-sort', () => {
    const onSort = vi.fn();
    const { rerender } = render(<DataTable columns={cols} rows={rows} onSort={onSort} />);
    const addr = screen.getByRole('button', { name: 'Address' });
    expect(addr.tagName).toBe('BUTTON');
    fireEvent.click(addr);
    expect(onSort).toHaveBeenLastCalledWith({ key: 'addr', dir: 'asc' });
    rerender(<DataTable columns={cols} rows={rows} onSort={onSort} sort={{ key: 'addr', dir: 'asc' }} />);
    expect(screen.getByRole('columnheader', { name: /Address/ }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    expect(onSort).toHaveBeenLastCalledWith({ key: 'addr', dir: 'desc' });
    rerender(<DataTable columns={cols} rows={rows} onSort={onSort} sort={{ key: 'price', dir: 'desc' }} />);
    expect(screen.getByRole('columnheader', { name: /Price/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: 'Price' }));
    expect(onSort).toHaveBeenLastCalledWith({ key: 'price', dir: 'asc' });
    // non-sortable hinted header is focusable; plain ones are not
    expect(screen.getByText('UP2').getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('Flag').getAttribute('tabindex')).toBeNull();
    // sortable headers without onSort do not throw
    rerender(<DataTable columns={cols} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
  });

  it('selects rows, with a mixed select-all that ignores keys from other pages', () => {
    const onSelect = vi.fn();
    const onRowClick = vi.fn();
    const { rerender } = render(<DataTable columns={cols} rows={rows} selectable selected={[]} onSelect={onSelect} onRowClick={onRowClick} />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(all);
    expect(onSelect).toHaveBeenLastCalledWith(['1', '2']);
    const rowBoxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(rowBoxes[0] as HTMLElement);
    expect(onSelect).toHaveBeenLastCalledWith(['1']);
    expect(onRowClick).not.toHaveBeenCalled();

    rerender(<DataTable columns={cols} rows={rows} selectable selected={['x', '2']} onSelect={onSelect} onRowClick={onRowClick} />);
    expect(screen.getByRole('checkbox', { name: 'Select all rows' }).getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelect).toHaveBeenLastCalledWith(['x', '2', '1']);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[1] as HTMLElement);
    expect(onSelect).toHaveBeenLastCalledWith(['x']);
    expect((screen.getByText('88 Tyner St').closest('tr') as HTMLElement).style.background).toBe('var(--accent-soft)');

    // keys from another page alone do not read as "all selected"
    rerender(<DataTable columns={cols} rows={rows} selectable selected={['x', 'y']} onSelect={onSelect} />);
    expect(screen.getByRole('checkbox', { name: 'Select all rows' }).getAttribute('aria-checked')).toBe('false');

    rerender(<DataTable columns={cols} rows={rows} selectable selected={['1', '2', 'x']} onSelect={onSelect} onRowClick={onRowClick} />);
    expect(screen.getByRole('checkbox', { name: 'Select all rows' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelect).toHaveBeenLastCalledWith(['x']);
    fireEvent.click(screen.getByText('88 Tyner St'));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });

  it('shows skeleton rows while loading, a footer, and survives missing callbacks', () => {
    const { container, rerender } = render(<DataTable columns={cols} rows={[]} loading skeletonRows={2} selectable footer={<Pager page={2} pages={3} />} maxHeight={200} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelectorAll('tbody td[data-label="Address"]')).toHaveLength(2);
    expect(screen.getByText(/Page 2 of 3/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select all rows' }).getAttribute('aria-checked')).toBe('false');
    rerender(<DataTable columns={cols} rows={rows} selectable />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0] as HTMLElement);
    render(<DataTable<{ name: string }> columns={[{ key: 'name', label: 'Name' }]} rows={[{ name: 'no id' }]} rowKey={(r) => r.name} />);
    expect(screen.getByText('no id')).toBeTruthy();
    render(<DataTable<{ v: unknown; id?: number }> columns={[{ key: 'v', label: 'V' }]} rows={[{ v: { toString: () => 'obj' } }]} />);
    expect(screen.getByText('obj')).toBeTruthy();
  });

  it('defaults to empty columns and rows', () => {
    // @ts-expect-error -- columns/rows are required by type; the .jsx defaults guard plain JS callers
    render(<DataTable />);
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

describe('Pager', () => {
  it('pages with a known total and guards the ends with a reason', () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager page={1} pages={3} total={4820} onPage={onPage} />);
    expect(screen.getByText('Page 1 of 3 · 4,820 rows')).toBeTruthy();
    const prev = screen.getByRole('button', { name: 'Previous page' });
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Already on the first page')).toBeTruthy();
    fireEvent.click(prev);
    expect(onPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenLastCalledWith(2);
    rerender(<Pager page={3} pages={3} onPage={onPage} />);
    expect(screen.getByText('No more pages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPage).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it('handles an unknown total with hasMore, and shows a spinner in the busy button', () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager page={4} hasMore onPage={onPage} />);
    expect(screen.getByText('Page 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenLastCalledWith(5);
    rerender(<Pager page={4} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('aria-disabled')).toBe('true');
    rerender(<Pager page={4} hasMore busy="next" onPage={onPage} />);
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next.getAttribute('aria-busy')).toBe('true');
    expect(next.querySelector('.em-motion')).toBeTruthy();
    expect(screen.getAllByText('Loading page…')).toHaveLength(2);
    fireEvent.click(next);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPage).toHaveBeenCalledTimes(1);
    rerender(<Pager page={4} hasMore busy="previous" onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('aria-busy')).toBeNull();
  });

  it('renders load-more mode, with and without a total, and a busy state', () => {
    const onLoadMore = vi.fn();
    const { container, rerender } = render(<Pager loadMore total={1200} onLoadMore={onLoadMore} />);
    expect(screen.getByText('1,200 rows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<Pager loadMore onLoadMore={onLoadMore} busy="next" />);
    expect(container.querySelector('span')?.textContent).toBe('');
    const btn = screen.getByRole('button', { name: /Load more/ });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<Pager />);
    expect(screen.getByText('Page 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  });
});

describe('FilterBar', () => {
  it('is a search form; dirty shows the unsaved dot and Enter applies', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onReset = vi.fn();
    render(
      <FilterBar state="dirty" onApply={onApply} onReset={onReset} appliedCount={2} extra={<span>Saved</span>}>
        <FilterField label="City">
          <input />
        </FilterField>
        <input type="checkbox" aria-label="Hide reserved" />
      </FilterBar>,
    );
    const form = screen.getByRole('search');
    expect(form.tagName).toBe('FORM');
    expect(form.style.border).toContain('var(--accent)');
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeTruthy();
    expect(screen.queryByText(/applied/)).toBeNull();
    const field = screen.getByLabelText('City');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'a' });
      fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Hide reserved' }), { key: 'Enter' });
    });
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(onApply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('submits through Apply, ignores composing or handled Enter, and blocks when clean', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <FilterBar state="dirty" onApply={onApply}>
        <input aria-label="Min" />
      </FilterBar>,
    );
    await act(async () => {
      fireEvent.submit(screen.getByRole('search'));
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    const field = screen.getByLabelText('Min');
    field.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      fireEvent.keyDown(screen.getByRole('search'), { key: 'Enter' });
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    rerender(
      <FilterBar state="clean" onApply={onApply} appliedCount={1}>
        <input aria-label="Min" />
      </FilterBar>,
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Min'), { key: 'Enter' });
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No changes to apply')).toBeTruthy();
    rerender(
      <FilterBar state="applied" appliedCount={3}>
        <span />
      </FilterBar>,
    );
    expect(screen.getByText('3 filters applied')).toBeTruthy();
    rerender(
      <FilterBar state="applied" appliedCount={1}>
        <span />
      </FilterBar>,
    );
    expect(screen.getByText('1 filter applied')).toBeTruthy();
  });

  it('applying: Apply is pending and Reset is blocked with a reason', () => {
    const onReset = vi.fn();
    render(
      <FilterBar state="applying" onReset={onReset} style={{ position: 'static' }}>
        <span />
      </FilterBar>,
    );
    expect(screen.getByRole('button', { name: /Applying/ }).getAttribute('aria-busy')).toBe('true');
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Filters are being applied')).toBeTruthy();
    fireEvent.click(reset);
    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByRole('search').style.position).toBe('static');
  });

  it('ignores Enter while composing', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <FilterBar state="dirty" onApply={onApply}>
        <input aria-label="Q" />
      </FilterBar>,
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Q'), { key: 'Enter', isComposing: true });
    });
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  it('focuses inside, traps Tab, closes on Escape and backdrop, and returns focus', () => {
    const onClose = vi.fn();
    const Harness = ({ open }: { open: boolean }) => (
      <>
        <button type="button">Opener</button>
        <Dialog open={open} title="Delete watchlist?" description="This cannot be undone." onClose={onClose} footer={<button type="button">Delete</button>}>
          <input aria-label="Name" />
        </Dialog>
      </>
    );
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    rerender(<Harness open />);
    const dialog = screen.getByRole('dialog', { name: 'Delete watchlist?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close' });
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(del, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'a' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(3);
    rerender(<Harness open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('blocking ignores Escape and backdrop and hides Close; an empty panel holds focus', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Processing" blocking onClose={onClose} width={360} style={{ padding: 0 }}>
        <p>Wait</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog);
  });

  it('closes without onClose and keeps focus already inside', () => {
    const { rerender } = render(
      <Dialog title="Info">
        <input aria-label="Field" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Field'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    rerender(<Dialog title="Info" open={false} />);
  });
});

describe('EventTimeline', () => {
  const entries = [
    { id: '1', date: '2026-09-25', dateLabel: 'Sep 25 14:02', title: 'Construction started', status: 'done' as const, content: 'By @tdlabs' },
    { id: '2', date: '2026-09-28', title: 'Awaiting completion' },
  ];

  it('compact: an ordered list of <time dateTime> entries with load more', () => {
    const onLoadMore = vi.fn();
    const { container } = render(<EventTimeline entries={entries} heading="History" hasMore onLoadMore={onLoadMore} />);
    expect(screen.getByRole('region', { name: 'History' })).toBeTruthy();
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(Array.from(list.children).every((c) => c.tagName === 'LI')).toBe(true);
    const times = container.querySelectorAll('time');
    expect(times[0]?.getAttribute('dateTime')).toBe('2026-09-25');
    expect(times[0]?.textContent).toBe('Sep 25 14:02');
    expect(times[1]?.textContent).toBe('2026-09-28');
    expect(screen.getByText('By @tdlabs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('comfortable: changelog layout, no load more without hasMore', () => {
    render(<EventTimeline entries={entries} density="comfortable" heading="Changelog" />);
    expect(screen.getByRole('heading', { name: 'Changelog' }).style.font).toBe('var(--type-h2)');
    expect(screen.getByText('By @tdlabs').tagName).toBe('DIV');
    expect(screen.queryByRole('button')).toBeNull();
    // @ts-expect-error -- entries is required by type; the .jsx default guards plain JS callers
    render(<EventTimeline />);
  });
});

describe('ProgressRing', () => {
  it('shows a percent, clamps, and holds 99 until value === max', () => {
    const { rerender } = render(<ProgressRing value={995} max={1000} label="Job" caption="Running" />);
    const bar = screen.getByRole('progressbar', { name: 'Job' });
    expect(bar.getAttribute('aria-valuetext')).toBe('99%');
    expect(screen.getByText('Running')).toBeTruthy();
    rerender(<ProgressRing value={1200} max={1000} label="Job" />);
    expect(bar.getAttribute('aria-valuenow')).toBe('1000');
    expect(bar.getAttribute('aria-valuetext')).toBe('100%');
    rerender(<ProgressRing value={-5} label="Job" />);
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    rerender(<ProgressRing value={12} max={30} valueText="12 of 30" label="Job" />);
    expect(bar.getAttribute('aria-valuetext')).toBe('12 of 30');
    expect(screen.getByText('12 of 30')).toBeTruthy();
  });

  it('covers empty, indeterminate, success and error', () => {
    const { container, rerender } = render(<ProgressRing max={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuetext')).toBe('No data');
    expect(bar.getAttribute('aria-valuemax')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    rerender(<ProgressRing status="indeterminate" />);
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('em-motion');
    expect(screen.getByText('…')).toBeTruthy();
    rerender(<ProgressRing status="success" value={100} />);
    expect(container.querySelector('[data-icon="check"]')).toBeTruthy();
    rerender(<ProgressRing status="error" size={72} />);
    expect(container.querySelector('[data-icon="x"]')).toBeTruthy();
  });
});

describe('FillGauge', () => {
  it('is a meter with value text and an over-limit state', () => {
    const { rerender } = render(<FillGauge current={3200} max={5000} unit="SPH" label="Contract fill" />);
    const meter = screen.getByRole('meter', { name: 'Contract fill' });
    expect(meter.getAttribute('aria-valuetext')).toBe('3,200 of 5,000 SPH');
    expect(screen.getByText('64%').style.color).toBe('var(--on-accent)');
    rerender(<FillGauge current={5400} max={5000} label="Contract fill" />);
    expect(meter.getAttribute('aria-valuetext')).toBe('5,400 of 5,000 (over limit)');
    expect(meter.getAttribute('aria-valuenow')).toBe('5000');
    rerender(<FillGauge current={-10} max={0} label="Contract fill" />);
    expect(screen.getByText('0%').style.color).toBe('var(--text-primary)');
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    rerender(<FillGauge current={-10} max={100} label="Contract fill" />);
    expect(screen.getByText('0%')).toBeTruthy();
  });
});

describe('WaitIndicator', () => {
  it('working: lattice, elapsed m:ss, and slow / timeout / custom notices', () => {
    const { container, rerender } = render(<WaitIndicator label="Awaiting acceptance in Upland" elapsed={142} notice="slow" grid={4} />);
    expect(container.querySelectorAll('.em-motion')).toHaveLength(16);
    expect(screen.getByText('2:22')).toBeTruthy();
    expect(screen.getByText('Still working, Upland is slow')).toBeTruthy();
    rerender(<WaitIndicator notice="timeout" />);
    expect(screen.getByText('Timed out after 10 min. Retry or cancel.').style.color).toBe('var(--state-error)');
    expect(screen.getByText('Working')).toBeTruthy();
    rerender(<WaitIndicator notice="Queued behind 3 jobs" elapsed={5} />);
    expect(screen.getByText('Queued behind 3 jobs')).toBeTruthy();
    expect(screen.getByText('0:05')).toBeTruthy();
  });

  it('done and error stop the lattice and hide elapsed', () => {
    const { container, rerender } = render(<WaitIndicator status="done" doneLabel="Accepted" elapsed={9} />);
    expect(screen.getByText('Accepted')).toBeTruthy();
    expect(screen.queryByText('0:09')).toBeNull();
    expect((container.querySelector('.em-motion') as HTMLElement).style.animation).toBe('none');
    rerender(<WaitIndicator status="error" />);
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(container.querySelector('[data-icon="circle-alert"]')).toBeTruthy();
  });
});

describe('JobPhaseList', () => {
  it('announces the active step, marks aria-current, and offers Cancel', () => {
    const onCancel = vi.fn();
    render(
      <JobPhaseList
        slow
        onCancel={onCancel}
        steps={[
          { id: 'a', label: 'Fetch owned properties', status: 'done', detail: '1,204 properties' },
          { id: 'b', label: 'Resolve collections', status: 'skipped' },
          { id: 'c', label: 'Price sparklet stakes', status: 'active' },
          { id: 'd', label: 'Compute net worth', status: 'pending' },
        ]}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Step 3 of 4: Price sparklet stakes');
    expect(screen.getByText('Price sparklet stakes').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('· skipped')).toBeTruthy();
    expect(screen.getByText('Still working, Upland is slow')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('error rows offer Retry (no Cancel); all done reads Complete; otherwise empty', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <JobPhaseList
        onRetry={onRetry}
        onCancel={() => undefined}
        steps={[
          { id: 'a', label: 'Fetch', status: 'done' },
          { id: 'b', label: 'Price', status: 'error', detail: 'Upland returned 502' },
        ]}
      />,
    );
    expect(screen.getByText('Upland returned 502').style.color).toBe('var(--state-error)');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('b');
    rerender(<JobPhaseList steps={[{ id: 'a', label: 'Fetch', status: 'done' }]} />);
    expect(screen.getByRole('status').textContent).toBe('Complete');
    rerender(<JobPhaseList steps={[{ id: 'a', label: 'Fetch', status: 'pending' }]} />);
    expect(screen.getByRole('status').textContent).toBe('');
    // @ts-expect-error -- steps is required by type; the .jsx default guards plain JS callers
    rerender(<JobPhaseList />);
  });
});

describe('StepFlow and Receipt', () => {
  it('marks the current step and closes', () => {
    const onClose = vi.fn();
    render(
      <StepFlow
        title="Withdraw UPX"
        onClose={onClose}
        steps={[
          { id: '1', label: 'Amount', status: 'complete' },
          { id: '2', label: 'Confirm', status: 'failed' },
          { id: '3', label: 'Receipt', status: 'pending' },
        ]}
      >
        <p>Body</p>
      </StepFlow>,
    );
    expect(screen.getByRole('dialog', { name: 'Withdraw UPX' })).toBeTruthy();
    expect(screen.getByText('Confirm').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('Confirm').style.color).toBe('var(--text-primary)');
    expect(screen.getByText('Body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a failed step in error color when it is not current', () => {
    render(
      <StepFlow
        title="Stake"
        steps={[
          { id: '1', label: 'Amount', status: 'awaiting' },
          { id: '2', label: 'Late', status: 'failed' },
        ]}
      />,
    );
    expect(screen.getByText('Late').style.color).toBe('var(--state-error)');
    expect(screen.queryByRole('button')).toBeNull();
    // @ts-expect-error -- steps is required by type; the .jsx default guards plain JS callers
    render(<StepFlow title="Empty" />);
  });

  it('Receipt is a <dl> with tx link and copy', () => {
    const onCopy = vi.fn();
    const { container, rerender } = render(
      <Receipt
        timestamp="2026-09-28 14:02:11 UTC"
        txId="a91f…3c2e"
        txHref="https://example.test/tx"
        onCopy={onCopy}
        rows={[
          { label: 'Requested', value: '4,500 UPX' },
          { label: 'Hash', value: '0xabc', mono: true },
          { label: 'Net to Upland', value: '4,050 UPX', strong: true },
        ]}
      />,
    );
    expect(container.querySelector('dl')).toBeTruthy();
    expect(screen.getByText('Net to Upland').style.fontWeight).toBe('600');
    expect(screen.getByText('0xabc').style.font).toBe('var(--type-code)');
    expect(screen.getByRole('link', { name: /View tx/ }).getAttribute('href')).toBe('https://example.test/tx');
    expect(screen.getByText('a91f…3c2e')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy receipt' }));
    expect(onCopy).toHaveBeenCalledOnce();
    // @ts-expect-error -- rows is required by type; the .jsx default guards plain JS callers
    rerender(<Receipt />);
    expect(container.querySelector('time')).toBeNull();
  });
});

describe('GlowCard', () => {
  it('tracks the pointer when hover is available and motion allowed', () => {
    mockMatchMedia({ [HOVER]: true });
    const onPointerMove = vi.fn();
    const onPointerLeave = vi.fn();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(
      <GlowCard as="a" href="/treasure/1" glow="var(--rarity-rare)" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onFocus={onFocus} onBlur={onBlur}>
        Chest · Rio
      </GlowCard>,
    );
    const card = screen.getByRole('link', { name: 'Chest · Rio' });
    expect(card.getAttribute('href')).toBe('/treasure/1');
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const glow = card.firstElementChild as HTMLElement;
    fireEvent.pointerMove(card, { clientX: 50, clientY: 50 });
    expect(glow.style.getPropertyValue('--go')).toBe('1');
    expect(onPointerMove).toHaveBeenCalledOnce();
    fireEvent.pointerLeave(card);
    expect(glow.style.getPropertyValue('--go')).toBe('0');
    fireEvent.focus(card);
    expect(glow.style.getPropertyValue('--go')).toBe('0.7');
    expect(glow.style.getPropertyValue('--gy')).toBe('30%');
    fireEvent.blur(card);
    expect(onPointerLeave).toHaveBeenCalledOnce();
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it('is off under reduced motion (live) but still forwards handlers; no href unless an <a>', () => {
    const set = mockMatchMedia({ [HOVER]: true, [REDUCE]: true });
    const onPointerMove = vi.fn();
    const { container } = render(
      <GlowCard as="article" href="/ignored" onPointerMove={onPointerMove} padding={8}>
        Body
      </GlowCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.tagName).toBe('ARTICLE');
    expect(card.getAttribute('href')).toBeNull();
    const glow = card.firstElementChild as HTMLElement;
    fireEvent.pointerMove(card, { clientX: 5, clientY: 5 });
    expect(glow.style.getPropertyValue('--go')).toBe('');
    expect(onPointerMove).toHaveBeenCalledOnce();
    set(REDUCE, false);
    card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(card, { clientX: 5, clientY: 5 });
    expect(glow.style.getPropertyValue('--go')).toBe('1');
  });

  it('renders where matchMedia does not exist, as a div by default', () => {
    // @ts-expect-error -- simulate an environment without matchMedia
    delete window.matchMedia;
    const { container } = render(<GlowCard>Plain</GlowCard>);
    const card = container.firstElementChild as HTMLElement;
    expect(card.tagName).toBe('DIV');
    fireEvent.pointerMove(card);
    fireEvent.pointerLeave(card);
    fireEvent.focus(card);
    fireEvent.blur(card);
  });
});

describe('LiveTicker', () => {
  const items = ['Sold · 4,200 UPX', 'Mint · 1,830 UP2'];

  it('animates a real copy plus an inert, hidden duplicate; pauses on toggle, hover and focus', () => {
    mockMatchMedia({});
    const { container } = render(<LiveTicker items={items} moreHref="/properties/live" />);
    expect(screen.getByRole('region', { name: 'Live activity' })).toBeTruthy();
    const track = container.querySelector('.em-motion') as HTMLElement;
    expect(track.style.animation).toContain('em-marquee 10s linear infinite');
    const copies = track.children;
    expect(copies).toHaveLength(2);
    expect(copies[1]?.getAttribute('aria-hidden')).toBe('true');
    expect(copies[1]?.hasAttribute('inert')).toBe(true);
    expect(copies[0]?.hasAttribute('aria-hidden')).toBe(false);
    expect(screen.getByRole('link', { name: /Full feed/ }).getAttribute('href')).toBe('/properties/live');

    const toggle = screen.getByRole('button', { name: 'Pause ticker' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Play ticker' }).getAttribute('aria-pressed')).toBe('true');
    expect(track.style.animation).toContain('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Play ticker' }));
    expect(track.style.animation).toContain('running');

    const region = screen.getByRole('region');
    fireEvent.pointerEnter(region);
    expect(track.style.animation).toContain('paused');
    fireEvent.pointerLeave(region);
    expect(track.style.animation).toContain('running');

    const link = screen.getByRole('link');
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    expect(track.style.animation).toContain('paused');
    fireEvent.blur(btn, { relatedTarget: link });
    expect(track.style.animation).toContain('paused');
    fireEvent.blur(link, { relatedTarget: document.body });
    expect(track.style.animation).toContain('running');
    fireEvent.focus(btn);
    fireEvent.blur(btn);
    expect(track.style.animation).toContain('running');
  });

  it('is a static scrollable row under reduced motion, and supports controlled pause with renderItem', () => {
    const set = mockMatchMedia({ [REDUCE]: true });
    const onTogglePause = vi.fn();
    const sales = [
      { id: 1, text: 'One' },
      { id: 2, text: 'Two' },
    ];
    const { container } = render(<LiveTicker items={sales} renderItem={(s) => <b>{s.text}</b>} paused onTogglePause={onTogglePause} speed={10} label="Sales" />);
    const track = container.querySelector('.em-motion') as HTMLElement;
    expect(track.style.animation).toBe('none');
    expect(track.children).toHaveLength(1);
    expect((track.parentElement as HTMLElement).style.overflow).toBe('auto');
    expect(screen.getByText('One').tagName).toBe('B');
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play ticker' }));
    expect(onTogglePause).toHaveBeenCalledWith(false);
    set(REDUCE, false);
    expect(track.style.animation).toContain('em-marquee 20s');
  });

  it('renders where matchMedia does not exist', () => {
    // @ts-expect-error -- simulate an environment without matchMedia
    delete window.matchMedia;
    // @ts-expect-error -- items is required by type; the .jsx default guards plain JS callers
    const { container } = render(<LiveTicker />);
    expect((container.querySelector('.em-motion') as HTMLElement).style.animation).toContain('em-marquee 10s');
  });
});

describe('RecommendedBeam', () => {
  it('travels when motion is allowed and is a static border under reduced motion', () => {
    const set = mockMatchMedia({});
    const { container } = render(<RecommendedBeam duration={4} />);
    const beam = container.querySelector('.em-motion') as HTMLElement;
    expect(beam.style.animation).toBe('em-beam 4s linear infinite');
    expect((container.firstElementChild as HTMLElement).getAttribute('aria-hidden')).toBe('true');
    set(REDUCE, true);
    expect(container.querySelector('.em-motion')).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.border).toBe('1.5px solid var(--tier-premium)');
  });

  it('renders where matchMedia does not exist', () => {
    // @ts-expect-error -- simulate an environment without matchMedia
    delete window.matchMedia;
    const { container } = render(<RecommendedBeam colorFrom="red" borderWidth={2} />);
    expect(container.querySelector('.em-motion')).toBeTruthy();
  });
});

describe('fake timers sanity for FilterBar apply cycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Apply runs the AsyncButton machine to success', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <FilterBar state="dirty" onApply={onApply}>
        <span />
      </FilterBar>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(screen.getByRole('button', { name: /Done/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });
});

describe('EventTimeline load-more feedback', () => {
  it('spins while loading older entries and offers Retry after a failure', async () => {
    const { EventTimeline } = await import('./EventTimeline');
    const onLoadMore = vi.fn();
    const entries = [{ id: '1', date: '2026-10-09T00:12:28Z', title: 'Sale' }];
    const { rerender } = render(<EventTimeline entries={entries} hasMore loadingMore onLoadMore={onLoadMore} />);
    const busy = screen.getByRole('button', { name: /Loading older/ });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onLoadMore).not.toHaveBeenCalled();
    rerender(<EventTimeline entries={entries} hasMore loadMoreError="The ledger is unreachable (502)." onLoadMore={onLoadMore} />);
    expect(screen.getByRole('alert').textContent).toContain('502');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});
