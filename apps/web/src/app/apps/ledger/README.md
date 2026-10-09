# Upland Ledger UI (`/apps/ledger`)

Screens over the Upland Ledger, styled with the Embers design system and
gated on the `upland_ledger` flag.

## Layout

| Path | What |
|---|---|
| `layout.tsx` | Flag gate, fonts, Embers shell |
| `page.tsx` | Overview |
| `properties/`, `properties/[id]/` | Property list, property detail |
| `market/` | Sales, listings, offers, rates (`?tab=`) |
| `opportunities/` | Signals |
| `accounts/[account]/` | Account profile and chain actions |
| `_components/` | Embers primitives (`primitives.tsx`, `embers.css`), DataState, DataTable, FilterBar, shell, charts |
| `_lib/` | Client, data hooks (`hooks.ts` over the framework-free `query-core.ts`), formatters, transforms, URL filters |
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

Copy this directory and `packages/upland-ledger/`, then rewrite
`_lib/forge-adapter.tsx` against the new app's session, flags and account
chrome. Dependencies: `next`, `react`, `recharts`, `@forge/upland-ledger`;
`vitest` for the tests (`*.test.ts`, fixtures from the package's `examples/`).
