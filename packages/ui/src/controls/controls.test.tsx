import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlertToggle } from './AlertToggle';
import { Chips } from './Chips';
import { CodeInput } from './CodeInput';
import { HoldToConfirm } from './HoldToConfirm';
import { NumberField } from './NumberField';
import { SearchableSelect } from './SearchableSelect';
import type { SSOption } from './SearchableSelect';
import { Select } from './Select';
import { SlideToConfirm } from './SlideToConfirm';
import { SpeedSlider } from './SpeedSlider';
import { Toggle } from './Toggle';

/** jsdom has no PointerEvent; React reads clientX off a MouseEvent just fine. */
const pointer = (el: Element, type: string, clientX = 0): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
  });
};

/** A promise whose settle functions the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Toggle', () => {
  it('flips on click and reports error / pending', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle checked={false} onChange={onChange} label="Hide reserved" />);
    const sw = screen.getByRole('switch', { name: 'Hide reserved' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Toggle checked onChange={onChange} label="Hide reserved" error="Reverted" />);
    expect(screen.getByRole('alert').textContent).toBe('Reverted');
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<Toggle checked pending onChange={onChange} label="Saving" />);
    const busy = screen.getByRole('switch');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('stays focusable with a reason when disabled or locked', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle onChange={onChange} label="Alerts" disabledReason="Sign in first" />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Sign in first')).toBeTruthy();
    fireEvent.click(sw);
    rerender(<Toggle onChange={onChange} label="Alerts" locked />);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByText('Requires a paid plan')).toBeTruthy();
    rerender(<Toggle onChange={onChange} label="Alerts" locked lockedTier="Premium" />);
    expect(screen.getByText('Requires Premium')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Chips', () => {
  const options = [
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '90d', label: '90d', locked: true, lockedTier: 'Basic' },
    { value: 'all', label: 'All', disabledReason: 'Too much data' },
  ] as const;

  it('selects by click and arrows, skipping inert chips and moving focus', () => {
    function Harness() {
      const [v, setV] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
      return <Chips label="Range" options={options} value={v} onChange={setV} size="dense" />;
    }
    render(<Harness />);
    const [d7, d30] = screen.getAllByRole('radio');
    expect(d30?.getAttribute('aria-checked')).toBe('true');
    expect(d30?.tabIndex).toBe(0);
    d30?.focus();
    // From 30d, right skips 90d (locked) and All (disabled) and wraps to 7d.
    fireEvent.keyDown(d30!, { key: 'ArrowRight' });
    expect(d7?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(d7);
    // Focus followed, so a second press walks on from 7d.
    fireEvent.keyDown(d7!, { key: 'ArrowRight' });
    expect(d30?.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(d30!, { key: 'ArrowLeft' });
    expect(d7?.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(d7!, { key: 'x' });
    fireEvent.click(screen.getByRole('radio', { name: /90d/ }));
    fireEvent.click(screen.getByRole('radio', { name: /All/ }));
    expect(d7?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(d30!);
    expect(d30?.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Requires Basic')).toBeTruthy();
    expect(screen.getByText('Too much data')).toBeTruthy();
  });

  it('never selects an inert chip from the keyboard, and keeps a tab stop', () => {
    const onChange = vi.fn();
    render(
      <Chips
        options={[
          { value: 'a', label: 'A', locked: true },
          { value: 'b', label: 'B', disabledReason: 'No' },
        ]}
        onChange={onChange}
      />,
    );
    const [a] = screen.getAllByRole('radio');
    expect(a?.tabIndex).toBe(0);
    fireEvent.keyDown(a!, { key: 'ArrowRight' });
    fireEvent.keyDown(a!, { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Requires a paid plan')).toBeTruthy();
  });

  it('selects nothing for an unknown value; the first enabled chip is the tab stop', () => {
    render(<Chips options={[{ value: 'x', label: 'X', locked: true }, { value: 'y', label: 'Y' }]} value="zzz" />);
    const radios = screen.getAllByRole('radio');
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(radios[1]?.tabIndex).toBe(0);
    render(<Chips options={[]} />);
  });
});

describe('Select', () => {
  const options = [
    { value: 'price', label: 'Price' },
    { value: 'up2', label: 'UP2' },
    { value: 'markup', label: 'Markup %' },
    { value: 'mint', label: 'Mint date' },
    { value: 'fsa', label: 'FSA only', locked: true, lockedTier: 'Basic' },
  ];

  function Harness({ initial = 'price', onChange }: { initial?: string; onChange?: (v: string) => void }) {
    const [v, setV] = useState(initial);
    return (
      <div>
        <span data-testid="outside">outside</span>
        <Select
          label="Sort by"
          options={options}
          value={v}
          onChange={(x) => {
            setV(x);
            onChange?.(x);
          }}
          size="dense"
        />
      </div>
    );
  }

  it('opens on click, picks an option on click, closes on outside pointerdown', () => {
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Sort by' });
    expect(box.textContent).toContain('Price');
    fireEvent.click(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const opt = screen.getByRole('option', { name: 'UP2' });
    pointer(opt, 'pointerover');
    expect(box.getAttribute('aria-activedescendant')).toBe(opt.id);
    fireEvent.click(opt);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.textContent).toContain('UP2');
    expect(document.activeElement).toBe(box);
    // Locked options stay in the list but cannot be picked.
    fireEvent.click(box);
    const locked = screen.getByRole('option', { name: /FSA only/ });
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(locked.textContent).toContain('Basic');
    fireEvent.click(locked);
    expect(screen.getByRole('listbox')).toBeTruthy();
    // Pointerdown inside keeps it open; outside closes it.
    pointer(locked, 'pointerdown');
    expect(screen.getByRole('listbox')).toBeTruthy();
    pointer(screen.getByTestId('outside'), 'pointerdown');
    expect(screen.queryByRole('listbox')).toBeNull();
    // Click toggles closed too.
    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keyboard: arrows, Home/End skip locked options, Enter/Space select, Escape closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('combobox');
    const activeLabel = (): string | null | undefined => {
      const id = box.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id)?.textContent : null;
    };
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(activeLabel()).toContain('Price');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(activeLabel()).toBe('UP2');
    // End lands on the last ENABLED option, not the locked one at the end.
    fireEvent.keyDown(box, { key: 'End' });
    expect(activeLabel()).toBe('Mint date');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(activeLabel()).toBe('Mint date');
    fireEvent.keyDown(box, { key: 'Home' });
    expect(activeLabel()).toContain('Price');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(activeLabel()).toContain('Price');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('markup');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(box, { key: ' ' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('up2');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(box, { key: 'Shift' });
  });

  it('typeahead selects when closed, moves the active option when open, never onto locked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'm' });
    expect(onChange).toHaveBeenLastCalledWith('markup');
    fireEvent.keyDown(box, { key: 'Enter' });
    // Open: "m" cycles to the next match after the active one.
    fireEvent.keyDown(box, { key: 'm' });
    expect(document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent).toBe('Mint date');
    fireEvent.keyDown(box, { key: 'f' });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'z' });
  });

  it('shows the placeholder for an unknown value and ignores input when disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Select options={options} value="nope" onChange={onChange} placeholder="Pick one" size="comfortable" />);
    const box = screen.getByRole('combobox');
    expect(box.textContent).toContain('Pick one');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent).toBe('Price');
    rerender(<Select options={[]} />);
    expect(screen.getByRole('combobox').textContent).toContain('Select…');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'a' });
    rerender(<Select options={options} value="price" onChange={onChange} disabledReason="Load results first" />);
    const off = screen.getByRole('combobox');
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Load results first')).toBeTruthy();
    fireEvent.click(off);
    fireEvent.keyDown(off, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('NumberField', () => {
  it('commits on blur and Enter only when changed, once', () => {
    const onCommit = vi.fn();
    function Harness() {
      const [v, setV] = useState<number | null>(null);
      return (
        <NumberField
          label="Min mint"
          prefix="UPX"
          suffix="max"
          value={v}
          onCommit={(x) => {
            setV(x);
            onCommit(x);
          }}
          size="dense"
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    expect(input.placeholder).toBe('Any');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1,200' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(1200);
    input.focus();
    fireEvent.change(input, { target: { value: '1500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(1500);
    expect(document.activeElement).not.toBe(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(null);
  });

  it('rejects garbage and out-of-range text with an error, Escape reverts', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberField label="Markup" value={50} min={0} max={100} onCommit={onCommit} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    expect(input.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.change(input, { target: { value: '12abc' } });
    expect(screen.getByRole('alert').textContent).toBe('Enter a number');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '140' } });
    expect(screen.getByRole('alert').textContent).toBe('Must be ≥ 0 and ≤ 100');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('50');
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<NumberField value={5} min={10} />);
    expect(screen.getByRole('alert').textContent).toBe('Must be ≥ 10');
    rerender(<NumberField value={140} max={100} />);
    expect(screen.getByRole('alert').textContent).toBe('Must be ≤ 100');
    rerender(<NumberField value={1} error="Server says no" pending />);
    expect(screen.getByRole('alert').textContent).toBe('Server says no');
    // A new value from the parent replaces the text.
    rerender(<NumberField value={7} />);
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('7');
  });

  it('nudges with arrows (Shift ×10), clamped, committing only changes', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberField value={null} min={0} max={25} step={2} onCommit={onCommit} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(2);
    expect(input.value).toBe('2');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(22);
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(25);
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onCommit).toHaveBeenLastCalledWith(3);
    rerender(<NumberField value={25} max={25} onCommit={onCommit} />);
    const calls = onCommit.mock.calls.length;
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenCalledTimes(calls);
    rerender(<NumberField value={null} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowDown' });
    expect(onCommit).toHaveBeenLastCalledWith(-1);
  });

  it('scrubs by dragging the label and commits on release', () => {
    const onCommit = vi.fn();
    render(<NumberField label="Min mint" value={10} min={0} onCommit={onCommit} />);
    const label = screen.getByText('Min mint');
    const capture = vi.fn();
    Object.defineProperty(label, 'setPointerCapture', { value: capture });
    pointer(label, 'pointermove', 50);
    pointer(label, 'pointerup', 50);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(label, 'pointerdown', 100);
    expect(capture).toHaveBeenCalled();
    pointer(label, 'pointermove', 140);
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('20');
    pointer(label, 'pointermove', 0);
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('0');
    pointer(label, 'pointerup', 0);
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('scrub starts from min when empty, clamps to max, works without pointer capture', () => {
    const onCommit = vi.fn();
    render(<NumberField label="Level" value={null} min={1} max={5} onCommit={onCommit} />);
    const label = screen.getByText('Level');
    pointer(label, 'pointerdown', 0);
    pointer(label, 'pointermove', 400);
    pointer(label, 'pointercancel', 400);
    expect(onCommit).toHaveBeenLastCalledWith(5);
  });

  it('is read-only with a reason when disabled; no scrub when scrub=false', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberField label="Min" value={3} onCommit={onCommit} disabledReason="Pick a city" />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.title).toBe('Pick a city');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    pointer(screen.getByText('Min'), 'pointerdown', 0);
    pointer(screen.getByText('Min'), 'pointermove', 100);
    expect(onCommit).not.toHaveBeenCalled();
    rerender(<NumberField label="Min" value={3} onCommit={onCommit} scrub={false} />);
    pointer(screen.getByText('Min'), 'pointerdown', 0);
    pointer(screen.getByText('Min'), 'pointermove', 100);
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('3');
  });
});

describe('SearchableSelect', () => {
  const sf: SSOption = { value: 'sf', label: 'San Francisco', flag: '🇺🇸', meta: '12,402' };
  const bk: SSOption = { value: 'bk', label: 'Bakersfield', flag: '🇺🇸', meta: '3,120' };
  const rio: SSOption = { value: 'rio', label: 'Rio de Janeiro', flag: '🇧🇷' };
  const groups = [
    { label: 'United States', options: [sf, bk] },
    { label: 'Brazil', options: [rio] },
  ];

  it('walks the status states: min-chars hint, loading, error + retry, empty, results', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<SearchableSelect label="City" query="sa" status="idle" options={[sf]} />);
    const input = screen.getByRole('combobox', { name: 'City' });
    fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox').textContent).toBe('Type 1 more character');
    // Hidden options can't be picked with Enter.
    fireEvent.keyDown(input, { key: 'Enter' });
    rerender(<SearchableSelect label="City" query="" status="idle" />);
    expect(screen.getByRole('listbox').textContent).toBe('Type 3 more characters');
    rerender(<SearchableSelect label="City" query="san" status="loading" options={[sf]} />);
    expect(screen.getByRole('listbox').textContent).toContain('Searching…');
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    rerender(<SearchableSelect label="City" query="san" status="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toBe('Search failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<SearchableSelect label="City" query="san" status="error" error="Upland is down" />);
    expect(screen.getByRole('alert').textContent).toBe('Upland is down');
    rerender(<SearchableSelect label="City" query="zzz" status="empty" />);
    expect(screen.getByRole('listbox').textContent).toBe('No results for “zzz”');
    rerender(<SearchableSelect label="City" query="zzz" status="results" options={[]} />);
    expect(screen.getByRole('listbox').textContent).toBe('No results for “zzz”');
    rerender(<SearchableSelect label="City" query="san" status="results" options={[sf]} size="dense" />);
    expect(screen.getByRole('option', { name: /San Francisco/ })).toBeTruthy();
  });

  it('single: grouped options, full keyboard, pick clears the query and closes', () => {
    const onChange = vi.fn();
    const onQueryChange = vi.fn();
    function Harness() {
      const [q, setQ] = useState('');
      const [v, setV] = useState<SSOption | null>(null);
      return (
        <div>
          <span data-testid="outside">outside</span>
          <SearchableSelect
            label="City"
            placeholder="City"
            query={q}
            onQueryChange={(x) => {
              setQ(x);
              onQueryChange(x);
            }}
            status={q.length >= 3 ? 'results' : 'idle'}
            groups={groups}
            value={v}
            onChange={(x) => {
              setV(x);
              onChange(x);
            }}
            size="comfortable"
          />
        </div>
      );
    }
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(input, { target: { value: 'ban' } });
    expect(screen.getByText('United States')).toBeTruthy();
    expect(screen.getByText('Brazil')).toBeTruthy();
    const active = (): string | null | undefined => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.textContent;
    expect(active()).toContain('San Francisco');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()).toContain('Rio de Janeiro');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(active()).toContain('Bakersfield');
    pointer(screen.getByRole('option', { name: /San Francisco/ }), 'pointerover');
    expect(active()).toContain('San Francisco');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(sf);
    expect(onQueryChange).toHaveBeenLastCalledWith('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.placeholder).toBe('San Francisco');
    fireEvent.keyDown(input, { key: 'Enter' });
    // Clear resets query and selection.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(input.placeholder).toBe('City');
    // Escape / Tab / outside pointerdown close.
    fireEvent.change(input, { target: { value: 'bak' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    pointer(screen.getByRole('listbox'), 'pointerdown');
    fireEvent.mouseDown(screen.getByRole('listbox'));
    expect(input.getAttribute('aria-expanded')).toBe('true');
    pointer(screen.getByTestId('outside'), 'pointerdown');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('option', { name: /Bakersfield/ }));
    expect(onChange).toHaveBeenLastCalledWith(bk);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('multi: toggles picks, stays open, shows two tokens + overflow, removes by button and Backspace', () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState<SSOption[]>([sf]);
      return (
        <SearchableSelect
          multi
          label="Cities"
          query="abc"
          status="results"
          options={[sf, bk, rio, { value: 'ny', label: 'New York' }]}
          value={v}
          onChange={(x) => {
            setV(x);
            onChange(x);
          }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByRole('option', { name: /San Francisco/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: /Bakersfield/ }));
    expect(onChange).toHaveBeenLastCalledWith([sf, bk]);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([sf, bk, rio]);
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /San Francisco/ }));
    expect(onChange).toHaveBeenLastCalledWith([bk, rio]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bakersfield' }));
    expect(onChange).toHaveBeenLastCalledWith([rio]);
    // Query is non-empty: Backspace edits text, doesn't remove a pick.
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(4);
    // Clear in multi only clears the query.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('multi: Backspace on an empty query removes the last pick; handles a null value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchableSelect multi query="" value={[sf, bk]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith([sf]);
    rerender(<SearchableSelect multi query="" value={null} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<SearchableSelect />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
  });
});

describe('CodeInput', () => {
  it('keeps digits only, completes at full length, pastes from slot 0', () => {
    const onChange = vi.fn();
    const onComplete = vi.fn();
    const { rerender, container } = render(<CodeInput value="48" onChange={onChange} onComplete={onComplete} />);
    const input = screen.getByLabelText('Verification code');
    expect(container.querySelectorAll('[data-slot]')).toHaveLength(6);
    fireEvent.change(input, { target: { value: '48a1' } });
    expect(onChange).toHaveBeenLastCalledWith('481');
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.paste(input, { clipboardData: { getData: () => '12-34-56-78' } });
    expect(onChange).toHaveBeenLastCalledWith('123456');
    expect(onComplete).toHaveBeenCalledWith('123456');
    // Focus shows a caret in the next empty slot; clicking the slots focuses the input.
    fireEvent.click(container.querySelector('[data-slot="0"]')!);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-slot="2"] [data-caret]')).toBeTruthy();
    rerender(<CodeInput value="123456" onChange={onChange} length={6} />);
    expect(container.querySelector('[data-caret]')).toBeNull();
    fireEvent.blur(input);
    rerender(<CodeInput value="" length={4} />);
    expect(container.querySelectorAll('[data-slot]')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '1' } });
  });

  it('verifying and success lock the input (paste too); error shows text and links it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeInput value="123456" status="verifying" onChange={onChange} label="Code" />);
    const input = screen.getByLabelText<HTMLInputElement>('Code');
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Verifying')).toBeTruthy();
    fireEvent.paste(input, { clipboardData: { getData: () => '999999' } });
    expect(onChange).not.toHaveBeenCalled();
    rerender(<CodeInput value="123456" status="success" onChange={onChange} label="Code" />);
    expect(screen.getByRole('status').textContent).toBe('Verified');
    rerender(<CodeInput value="481920" status="error" onChange={onChange} label="Code" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('That code didn’t match. Check the email and try again.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    rerender(<CodeInput value="481920" status="error" error="Code expired" label="Code" />);
    expect(screen.getByRole('alert').textContent).toBe('Code expired');
    rerender(<CodeInput value="" error="stale" label="Code" />);
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('resend respects the cooldown', () => {
    const onResend = vi.fn();
    const { rerender } = render(<CodeInput value="" onResend={onResend} resendIn={28} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('Resend code in 28s');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn);
    expect(onResend).not.toHaveBeenCalled();
    rerender(<CodeInput value="" onResend={onResend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(onResend).toHaveBeenCalledTimes(1);
  });
});

describe('AlertToggle', () => {
  it('controlled: pressed state, constant name, count badge', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AlertToggle label="Rare treasure" onChange={onChange} />);
    const btn = screen.getByRole('button', { name: 'Rare treasure' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.textContent).toContain('Notify me');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<AlertToggle label="Rare treasure" on count={2} onChange={onChange} size="dense" />);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toContain('Notifying');
    expect(screen.getByLabelText('2 alerts').textContent).toBe('2');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<AlertToggle label="Rare treasure" on count={0} />);
    expect(screen.queryByLabelText('0 alerts')).toBeNull();
  });

  it('controlled statuses: pending, error + retry, denied, locked', () => {
    const onChange = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(<AlertToggle label="Rare" status="pending" onChange={onChange} />);
    const btn = screen.getByRole('button', { name: 'Rare' });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent).toContain('Saving');
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
    rerender(<AlertToggle label="Rare" status="error" onRetry={onRetry} onChange={onChange} />);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t save');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
    // A click in error re-sends the reverted value's opposite.
    rerender(<AlertToggle label="Rare" status="error" on error="Rule limit reached" onChange={onChange} />);
    expect(screen.getByRole('alert').textContent).toContain('Rule limit reached');
    fireEvent.click(screen.getByRole('button', { name: 'Rare' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<AlertToggle label="Rare" status="denied" deniedHelpHref="/help/notifications" onChange={onChange} />);
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Notifications are blocked in your browser settings.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How to allow notifications' }).getAttribute('href')).toBe('/help/notifications');
    fireEvent.click(screen.getByRole('button', { name: 'Rare' }));
    rerender(<AlertToggle label="Rare" status="locked" lockedTier="Basic" onChange={onChange} />);
    expect(screen.getByText('Requires Basic')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rare' }));
    rerender(<AlertToggle label="Rare" status="locked" />);
    expect(screen.getByText('Requires a paid plan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rare' }).textContent).toContain('Locked');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('promise lifecycle: pending until resolved; rejection persists with Retry', async () => {
    const calls: Array<ReturnType<typeof deferred>> = [];
    const onChange = vi.fn(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });
    const { unmount } = render(<AlertToggle label="Rare" onChange={onChange} />);
    const btn = screen.getByRole('button', { name: 'Rare' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledTimes(1);
    calls[0]?.reject(new Error('Network down'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Network down');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('alert')).toBeNull();
    calls[1]?.reject('nope');
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t save');
    fireEvent.click(btn);
    calls[2]?.resolve();
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(btn.getAttribute('aria-busy')).toBeNull();
    // Settling after unmount is ignored.
    fireEvent.click(btn);
    unmount();
    calls[3]?.resolve();
    await flush();
  });

  it('ignores a rejection that lands after unmount', async () => {
    const d = deferred();
    const { unmount } = render(<AlertToggle label="Rare" onChange={() => d.promise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rare' }));
    unmount();
    d.reject(new Error('late'));
    await flush();
  });
});

describe('HoldToConfirm', () => {
  const fake = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
  };

  it('holding fills, then success only after the promise resolves, then idle', async () => {
    fake();
    const d = deferred();
    const onHold = vi.fn(() => d.promise);
    const { container } = render(<HoldToConfirm label="Delist" pendingLabel="Delisting…" successLabel="Delisted" onHold={onHold} />);
    const btn = screen.getByRole('button', { name: /Delist/ });
    expect(btn.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(btn.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Press and hold');
    const capture = vi.fn();
    Object.defineProperty(btn, 'setPointerCapture', { value: capture });
    pointer(btn, 'pointerdown');
    expect(capture).toHaveBeenCalled();
    expect(btn.textContent).toContain('Keep holding…');
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(Number(container.querySelector('[data-progress]')?.getAttribute('data-progress'))).toBeGreaterThan(0.3);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toContain('Delisting…');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    // Pointer input during pending is ignored.
    pointer(btn, 'pointerdown');
    expect(btn.textContent).toContain('Delisting…');
    d.resolve();
    await flush();
    expect(btn.textContent).toContain('Delisted');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(btn.textContent).toContain('Delist');
    expect(btn.textContent).not.toContain('Delisted');
  });

  it('a short press calls the click fallback; a long release before holdMs cancels quietly', () => {
    fake();
    const onClickFallback = vi.fn();
    const onHold = vi.fn(() => Promise.resolve());
    render(<HoldToConfirm onHold={onHold} onClickFallback={onClickFallback} size="standard" />);
    const btn = screen.getByRole('button', { name: /Delete/ });
    pointer(btn, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    pointer(btn, 'pointerup');
    expect(onClickFallback).toHaveBeenCalledTimes(1);
    pointer(btn, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    pointer(btn, 'pointercancel');
    pointer(btn, 'pointerup');
    expect(onClickFallback).toHaveBeenCalledTimes(1);
    expect(onHold).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Delete');
    // Enter opens the fallback directly; Escape cancels nothing in progress.
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onClickFallback).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(btn, { key: 'Enter', repeat: true });
    fireEvent.keyDown(btn, { key: 'Escape' });
    fireEvent.keyUp(btn, { key: 'Enter' });
    fireEvent.keyUp(btn, { key: 'a' });
    expect(onClickFallback).toHaveBeenCalledTimes(2);
  });

  it('without a fallback, holding Space holds (no pointer capture); Escape cancels', async () => {
    fake();
    const onHold = vi.fn(() => Promise.resolve());
    render(<HoldToConfirm onHold={onHold} />);
    const btn = screen.getByRole('button', { name: /Delete/ });
    fireEvent.keyDown(btn, { key: ' ' });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(btn.textContent).toContain('Delete');
    fireEvent.keyDown(btn, { key: 'Enter' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onHold).toHaveBeenCalledTimes(1);
    await flush();
    expect(btn.textContent).toContain('Deleted');
  });

  it('rejection persists with Retry; Retry re-runs onHold or calls onRetry', async () => {
    fake();
    const onHold = vi.fn().mockRejectedValueOnce(new Error('Contract has active stakes')).mockRejectedValueOnce('x').mockResolvedValueOnce(undefined);
    const { rerender } = render(<HoldToConfirm label="Delist" onHold={onHold} />);
    const btn = screen.getByRole('button', { name: /Delist/ });
    pointer(btn, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Contract has active stakes');
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    // From error a new hold is allowed too.
    pointer(btn, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(btn.textContent).toContain('Deleted');
    const onRetry = vi.fn();
    rerender(<HoldToConfirm phase="error" error="Nope" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('controlled phases render; disabled ignores pointer and keys', () => {
    const onClickFallback = vi.fn();
    const { rerender } = render(<HoldToConfirm phase="holding" label="Delist" />);
    expect(screen.getByRole('button').textContent).toContain('Keep holding…');
    rerender(<HoldToConfirm phase="pending" pendingLabel="Delisting…" />);
    expect(screen.getByRole('button').getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    rerender(<HoldToConfirm phase="success" successLabel="Delisted" />);
    expect(screen.getByRole('button').textContent).toContain('Delisted');
    rerender(<HoldToConfirm disabledReason="Listing is locked" onClickFallback={onClickFallback} />);
    const btn = screen.getAllByRole('button')[0]!;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Listing is locked')).toBeTruthy();
    pointer(btn, 'pointerdown');
    pointer(btn, 'pointerup');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onClickFallback).not.toHaveBeenCalled();
  });

  it('cleans up timers when unmounted mid-flight', async () => {
    fake();
    const d = deferred();
    const { unmount } = render(<HoldToConfirm onHold={() => d.promise} />);
    const btn = screen.getByRole('button', { name: /Delete/ });
    pointer(btn, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    unmount();
    d.resolve();
    await flush();
    const d2 = deferred();
    const r2 = render(<HoldToConfirm onHold={() => d2.promise} />);
    pointer(screen.getByRole('button', { name: /Delete/ }), 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    r2.unmount();
    d2.reject(new Error('late'));
    await flush();
  });
});

describe('SlideToConfirm', () => {
  it('keyboard commit: pending, success only after resolve, never twice', async () => {
    const d = deferred();
    const onConfirm = vi.fn(() => d.promise);
    render(<SlideToConfirm label="Slide to withdraw 4,500 UPX" successLabel="Withdrawn" onConfirm={onConfirm} width={260} />);
    const slider = screen.getByRole('slider', { name: 'Slide to withdraw 4,500 UPX' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'Enter' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(slider.getAttribute('aria-busy')).toBe('true');
    expect(slider.textContent).toContain('Sending…');
    expect(slider.getAttribute('aria-valuenow')).toBe('100');
    d.resolve();
    await flush();
    expect(slider.textContent).toContain('Withdrawn');
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    expect(slider.tabIndex).toBe(0);
    fireEvent.keyDown(slider, { key: ' ' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('drag past 92% commits; short drags snap back', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const { container } = render(<SlideToConfirm onConfirm={onConfirm} />);
    const knob = container.querySelector('[data-knob]')!;
    const capture = vi.fn();
    Object.defineProperty(knob, 'setPointerCapture', { value: capture });
    const slider = screen.getByRole('slider');
    pointer(knob, 'pointermove', 50);
    pointer(knob, 'pointerup', 50);
    pointer(knob, 'pointerdown', 0);
    expect(capture).toHaveBeenCalled();
    pointer(knob, 'pointermove', 100);
    expect(slider.getAttribute('aria-valuenow')).toBe(String(Math.round((100 / 236) * 100)));
    pointer(knob, 'pointerup', 100);
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(onConfirm).not.toHaveBeenCalled();
    pointer(knob, 'pointerdown', 0);
    pointer(knob, 'pointermove', 500);
    expect(slider.getAttribute('aria-valuenow')).toBe('100');
    pointer(knob, 'pointercancel', 500);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flush();
    expect(slider.textContent).toContain('Sent');
  });

  it('error persists until Retry, which resets to idle', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Not enough balance')).mockRejectedValueOnce('boom');
    const onRetry = vi.fn();
    render(<SlideToConfirm onConfirm={onConfirm} onRetry={onRetry} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'Enter' });
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Not enough balance');
    expect(slider.textContent).toContain('Failed, try again');
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    // Sliding again from error is a retry as well.
    fireEvent.keyDown(slider, { key: 'Enter' });
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(slider.textContent).toContain('Slide to confirm');
  });

  it('controlled phases and disabled with a linked reason', () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const { rerender, container } = render(<SlideToConfirm phase="pending" />);
    expect(screen.getByRole('slider').textContent).toContain('Sending…');
    expect(container.querySelector('[data-knob]')).toBeNull();
    rerender(<SlideToConfirm phase="error" error="Not enough balance" />);
    expect(screen.getByRole('alert').textContent).toContain('Not enough balance');
    rerender(<SlideToConfirm disabledReason="Verify your email first" onConfirm={onConfirm} />);
    const slider = screen.getByRole('slider');
    expect(slider.tabIndex).toBe(0);
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(slider.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Verify your email first');
    fireEvent.keyDown(slider, { key: 'Enter' });
    const knob = container.querySelector('[data-knob]')!;
    pointer(knob, 'pointerdown', 0);
    pointer(knob, 'pointermove', 500);
    pointer(knob, 'pointerup', 500);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores a settle that lands after unmount', async () => {
    const d1 = deferred();
    const r1 = render(<SlideToConfirm onConfirm={() => d1.promise} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'Enter' });
    r1.unmount();
    d1.resolve();
    await flush();
    const d2 = deferred();
    const r2 = render(<SlideToConfirm onConfirm={() => d2.promise} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'Enter' });
    r2.unmount();
    d2.reject(new Error('late'));
    await flush();
  });
});

describe('SpeedSlider', () => {
  const rect = (el: Element): void => {
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 0, width: 200, top: 0, height: 28, right: 200, bottom: 28, x: 0, y: 0 }) });
  };

  it('renders value text and lit bars; keyboard changes and commits on key-up only', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { container, rerender } = render(<SpeedSlider value={12} onChange={onChange} onCommit={onCommit} width={200} />);
    const slider = screen.getByRole('slider', { name: 'Playback speed' });
    expect(slider.getAttribute('aria-valuetext')).toBe('12×');
    expect(screen.getByText('12×')).toBeTruthy();
    expect(container.querySelectorAll('[data-lit]')).toHaveLength(Math.round((11 / 99) * 32));
    // A stray key-up (e.g. Tab landing here) commits nothing.
    fireEvent.keyUp(slider, { key: 'Tab' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(13);
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(12);
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(11);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(onChange).toHaveBeenLastCalledWith(22);
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    fireEvent.keyDown(slider, { key: 'x' });
    expect(onChange).toHaveBeenCalledTimes(8);
    rerender(<SpeedSlider value={100} onChange={onChange} formatValue={(v) => `${v}x speed`} label="Speed" bars={10} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Speed' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(100);
    expect(screen.getByText('100x speed')).toBeTruthy();
  });

  it('drags: onChange while moving, onCommit on release', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<SpeedSlider value={1} min={0} max={100} step={5} onChange={onChange} onCommit={onCommit} />);
    const slider = screen.getByRole('slider');
    rect(slider);
    const capture = vi.fn();
    Object.defineProperty(slider, 'setPointerCapture', { value: capture });
    pointer(slider, 'pointermove', 100);
    pointer(slider, 'pointerup', 100);
    expect(onChange).not.toHaveBeenCalled();
    pointer(slider, 'pointerdown', 100);
    expect(capture).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(50);
    pointer(slider, 'pointermove', 300);
    expect(onChange).toHaveBeenLastCalledWith(100);
    pointer(slider, 'pointerup', -20);
    expect(onCommit).toHaveBeenLastCalledWith(0);
    pointer(slider, 'pointerdown', 20);
    pointer(slider, 'pointercancel', 20);
    pointer(slider, 'pointermove', 60);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('falls back to min when it has no width', () => {
    const onChange = vi.fn();
    render(<SpeedSlider value={5} onChange={onChange} />);
    pointer(screen.getByRole('slider'), 'pointerdown', 120);
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('stays focusable with a reason when disabled and ignores input', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<SpeedSlider value={5} onChange={onChange} onCommit={onCommit} disabledReason="Pick a release first" />);
    const slider = screen.getByRole('slider');
    expect(slider.tabIndex).toBe(0);
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    expect(slider.title).toBe('Pick a release first');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    pointer(slider, 'pointerdown', 10);
    pointer(slider, 'pointerup', 10);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
