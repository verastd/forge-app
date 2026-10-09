import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TextField } from './TextField';

describe('TextField', () => {
  it('edits, submits on Enter and shows an error', () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    const { rerender } = render(<TextField label="Buyer" value="" onChange={onChange} onEnter={onEnter} icon="search" mono size="standard" />);
    const input = screen.getByLabelText('Buyer');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'a' });
    rerender(<TextField label="Buyer" value="x!" onChange={onChange} error="Not an account" />);
    expect(screen.getByRole('alert').textContent).toBe('Not an account');
    expect(screen.getByLabelText('Buyer').getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(screen.getByLabelText('Buyer'), { key: 'Enter' });
  });

  it('stays focusable with a reason when disabled and ignores edits', () => {
    const onChange = vi.fn();
    render(<TextField label="Collection" value="" onChange={onChange} disabledReason="Not filterable yet" size="comfortable" />);
    const input = screen.getByLabelText('Collection');
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'x' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Not filterable yet')).toBeTruthy();
  });
});
