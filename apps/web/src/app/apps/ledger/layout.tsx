'use client';

/**
 * The Upland Ledger UI's front door: theme (next-themes), server state
 * (TanStack Query), toasts, the `upland_ledger` flag gate, then the Embers
 * shell every screen under /apps/ledger hangs off. Flags fail closed, so an
 * unreachable flag service reads exactly like the switch being off.
 *
 * Self-contained on purpose: pages import UI only from `@forge/ui`, data
 * only via `@forge/upland-ledger`, and the host's session, flags and chrome
 * only through `_lib/forge-adapter.tsx`.
 */
import '@forge/ui/styles.css';
import '@forge/ui/fonts';

import Link from 'next/link';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell, Button, Card, EmbersThemeProvider, Icon, PageHeader, Skeleton, Spinner, TopBar, useEmbersTheme } from '@forge/ui';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { HostAccountControls, LOBBY_HREF, PRODUCT_NAME, useLedgerFlag } from './_lib/forge-adapter';
import { LEDGER_QUERY_DEFAULTS } from './_lib/hooks';
import { LedgerShell } from './_ui/Shell';

/** The frame while the flag is unknown or off: same TopBar, no search or nav. */
function GateFrame({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useEmbersTheme();
  return (
    <AppShell
      style={{ minHeight: '100dvh' }}
      topBar={
        <TopBar
          theme={theme}
          onTheme={setTheme}
          brand={<span style={{ font: 'var(--type-title)', marginRight: 8 }}>{PRODUCT_NAME}</span>}
          leading={
            <Link
              href={LOBBY_HREF}
              aria-label="Back to the lobby"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: 'var(--type-label)', color: 'var(--text-secondary)', textDecoration: 'none' }}
            >
              <Icon name="arrow-left" size={14} />
              Lobby
            </Link>
          }
          trailing={<HostAccountControls />}
        />
      }
      footer="Upland chain and market data from the Upland Ledger. An independent tool, not affiliated with Upland."
    >
      {children}
    </AppShell>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const flag = useLedgerFlag();
  if (flag.loading) {
    return (
      <GateFrame>
        <Card style={{ gap: 10 }}>
          <span role="status" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', font: 'var(--type-body)' }}>
            <Spinner size={16} label="" /> Checking access to the Upland Ledger…
          </span>
          <Skeleton width="45%" />
          <Skeleton width="70%" />
        </Card>
      </GateFrame>
    );
  }
  if (!flag.enabled) {
    return (
      <GateFrame>
        <PageHeader title={PRODUCT_NAME} />
        <div role="alert">
          <Card style={{ justifyItems: 'start' }}>
            <p style={{ margin: 0 }}>The Upland Ledger is in private beta and isn’t switched on for you yet.</p>
            <Button as={Link} href={LOBBY_HREF} icon="arrow-left">
              Back to the lobby
            </Button>
          </Card>
        </div>
      </GateFrame>
    );
  }
  return <LedgerShell>{children}</LedgerShell>;
}

export default function LedgerLayout({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: LEDGER_QUERY_DEFAULTS }));
  return (
    <EmbersThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Gate>{children}</Gate>
      </QueryClientProvider>
    </EmbersThemeProvider>
  );
}
