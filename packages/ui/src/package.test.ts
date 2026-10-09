import { describe, expect, it, vi } from 'vitest';

vi.mock('@fontsource/work-sans/400.css', () => ({}));
vi.mock('@fontsource/work-sans/500.css', () => ({}));
vi.mock('@fontsource/work-sans/600.css', () => ({}));
vi.mock('@fontsource/work-sans/700.css', () => ({}));
vi.mock('@fontsource/geist-mono/400.css', () => ({}));
vi.mock('@fontsource/geist-mono/500.css', () => ({}));
vi.mock('@fontsource/geist-mono/600.css', () => ({}));

describe('@forge/ui entry points', () => {
  it('exports every Embers component from one barrel', async () => {
    const ui = await import('./index');
    for (const name of [
      'AppShell', 'TopBar', 'SidebarNav', 'FeatureGrid',
      'Button', 'AsyncButton', 'Badge', 'Countdown', 'DataState', 'Hint', 'Icon', 'LiveIndicator', 'LockedFeature',
      'Skeleton', 'Spinner', 'StatTile', 'StatusBanner', 'StatusGlyph', 'Toast', 'ToastStack',
      'AlertToggle', 'Check', 'Chips', 'CodeInput', 'HoldToConfirm', 'NumberField', 'SearchableSelect', 'Segment', 'Select',
      'SlideToConfirm', 'SpeedSlider', 'Toggle',
      'DataTable', 'Pager', 'Dialog', 'EventTimeline', 'FillGauge', 'FilterBar', 'FilterField', 'GlowCard', 'JobPhaseList',
      'LiveTicker', 'ProgressRing', 'RecommendedBeam', 'StepFlow', 'Receipt', 'WaitIndicator',
      'PageHeader', 'Block', 'Card', 'TileRow', 'FactList', 'TextField', 'TimeSeriesChart', 'Sparkline', 'EmbersThemeProvider',
    ]) {
      expect(ui, name).toHaveProperty(name);
    }
  });

  it('names the self-hosted faces', async () => {
    const { EMBERS_FONTS } = await import('./fonts');
    expect(EMBERS_FONTS).toEqual(['Work Sans', 'Geist Mono']);
  });
});
