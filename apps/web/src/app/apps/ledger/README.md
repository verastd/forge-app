# Upland Ledger UI (`/apps/ledger`)

Screens over the Upland Ledger, gated on the `upland_ledger` flag and built
only from `@forge/ui` (`packages/ui`), the port of the Embers design system
handoff. The stack follows its COMPONENT_MAP: `@forge/ui` components, TanStack
Query for server state, ECharts for charts, next-themes for light/dark,
lucide-react icons and self-hosted Work Sans / Geist Mono.

## Layout

| Path | What |
|---|---|
| `layout.tsx` | Flag gate, fonts, Embers shell |
| `page.tsx` | Overview |
| `properties/`, `properties/[id]/` | Property list, property detail |
| `market/` | Sales, listings, offers, rates (`?tab=`) |
| `opportunities/` | Signals |
| `accounts/[account]/` | Account profile and chain actions |
| `_ui/` | Ledger glue over `@forge/ui`: shell (AppShell + TopBar + SidebarNav), `Region` (query → DataState), sign-in prompt, links, toasts, filter fields, rate chart |
| `_lib/` | Client, TanStack Query hooks (`hooks.ts`, heavy slot in `query-core.ts`), formatters, transforms, URL filters |
| `_lib/forge-adapter.tsx` | **The only file that imports FORGE** (session, flags, account menu) |

## Rules this tree keeps

- Data comes only from `createLedgerClient()` (`@forge/upland-ledger`), which
  calls the same-origin BFF at `/bff/ledger/*`.
- Heavy reads (`/analytics/*`, `/market/*`, `/signals`) go through
  `useLedgerQuery(..., { heavy: true })`: one in flight per tab, queued in
  order, because the ledger gives the whole app a single heavy-query slot.
  Sections below the fold load when scrolled near.
- 401 shows a sign-in prompt, a failure shows what happened plus Retry, and
  nothing is ever substituted for real data.

## Moving it to its own repo

Copy this directory, `packages/ui/` and `packages/upland-ledger/`, then rewrite
`_lib/forge-adapter.tsx` against the new app's session, flags and account
chrome. Dependencies: `next`, `react`, `@tanstack/react-query`, `@forge/ui`,
`@forge/upland-ledger`; `vitest` for the tests (`*.test.ts`, fixtures from the package's `examples/`).
