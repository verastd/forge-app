import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Block, Card, FactList, PageHeader, TileRow } from './Page';

describe('kit page blocks', () => {
  it('renders the page header with eyebrow, lede and aside', () => {
    render(<PageHeader eyebrow="Property #1" title="2506 Searsdale Ave" lede="A property." aside={<span>LIVE</span>} />);
    expect(screen.getByRole('heading', { level: 1, name: '2506 Searsdale Ave' })).toBeTruthy();
    expect(screen.getByText('Property #1')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    render(<PageHeader title="Bare" />);
  });

  it('labels a Block section by its title', () => {
    render(
      <Block id="rate" title="UPX / USD" note="Market layer" aside={<button type="button">x</button>}>
        <Card>body</Card>
      </Block>,
    );
    expect(screen.getByRole('region', { name: 'UPX / USD' })).toBeTruthy();
    render(<Block>plain</Block>);
    render(<Block note="only a note">n</Block>);
  });

  it('lays out tiles and facts', () => {
    render(
      <TileRow min={150}>
        <span>tile</span>
      </TileRow>,
    );
    render(<FactList items={[{ term: 'Block', value: '91,625,496', mono: true }, { term: 'City', value: 'Cleveland' }]} />);
    expect(screen.getByText('91,625,496').className).toBe('em-num');
    expect(screen.getByText('Cleveland').className).toBe('');
  });
});
