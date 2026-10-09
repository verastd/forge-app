import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Check } from './Check';
import { Segment } from './Segment';

describe('Check', () => {
  it('toggles, and a mixed box selects everything', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Check checked={false} onChange={onChange} label="Rome" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rome' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Check checked onChange={onChange} label="Rome" size="touch" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<Check checked="indeterminate" onChange={onChange} label="Select all" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('stays focusable with a reason when disabled or locked, and ignores clicks', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Check onChange={onChange} label="FSA" disabledReason="Pick a city first" />);
    const box = screen.getByRole('checkbox');
    expect(box.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(box);
    rerender(<Check onChange={onChange} label="FSA" locked lockedTier="Basic" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Requires Basic')).toBeTruthy();
  });
});

describe('Segment', () => {
  const options = [
    { value: 'asc', label: '↑', ariaLabel: 'Ascending' },
    { value: 'desc', label: '↓', ariaLabel: 'Descending', icon: 'arrow-down' as const },
    { value: 'x', label: 'Locked', locked: true, lockedTier: 'Basic' },
  ];

  it('selects by click and by arrow keys, skipping inert options', () => {
    const onChange = vi.fn();
    render(<Segment label="Sort direction" options={options} value="asc" onChange={onChange} size="dense" fullWidth />);
    fireEvent.click(screen.getByRole('radio', { name: 'Descending' }));
    expect(onChange).toHaveBeenLastCalledWith('desc');
    const group = screen.getByRole('radiogroup', { name: 'Sort direction' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('desc');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('asc');
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('desc');
    fireEvent.keyDown(group, { key: 'a' });
    fireEvent.click(screen.getByRole('radio', { name: /Locked/ }));
    expect(onChange).not.toHaveBeenCalledWith('x');
  });

  it('selects nothing for an unknown value', () => {
    render(<Segment options={options} value={'nope' as string} size="comfortable" />);
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowUp' });
  });

  it('does nothing when every option is inert', () => {
    const onChange = vi.fn();
    render(<Segment options={[{ value: 'a', label: 'A', disabledReason: 'No' }]} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a reason on disabled options', () => {
    render(<Segment options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabledReason: 'Not yet' }]} value="a" />);
    expect(screen.getByText('Not yet')).toBeTruthy();
  });
});
