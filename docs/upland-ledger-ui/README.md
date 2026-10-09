# Upland Ledger UI — screenshots

Screenshots of `/apps/ledger` for the PR that adds it. They come from a local
`next dev` (live build) with a sealed member session, the `upland_ledger` flag
on, and `/bff/ledger/*` answered with the **captured ledger responses** in
`packages/upland-ledger/examples/` (2026-10-09). The numbers are real ledger
output, but small samples (3 sales, 3 signals, 3 days of rates), because the
capture used small limits.

| File | What |
|---|---|
| `overview-1440-dark.png` | Overview: KPIs, chain status, data freshness, UPX/USD chart, top cities |
| `properties-1440-dark.png` | Properties list with filters and sortable headers |
| `property-1440-dark.png`, `property-1280-light.png` | Property detail: header, history, listings, offers |
| `market-*-1440-dark.png` | Market tabs: sales, listings, offers, rates |
| `opportunities-1440-dark.png`, `opportunities-1280-light.png` | Signals with their evidence explained |
| `account-1440-dark.png` | Account profile and chain actions |
| `overview-390-dark.png`, `market-sales-390-dark.png` | Phone width: drawer nav, tables as cards |
| `overview-1280-dark-slow.png` | Loading: skeletons, the "Checking" live dot |
| `overview-1280-dark-502.png` | Ledger down: each section says so, with Retry |
| `overview-1280-dark-401.png` | A member the ledger answers with 401: sign-in prompt, no data |
| `market-sales-1280-dark-empty.png` | Empty result, with "Reset filters" |
