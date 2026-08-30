# @forge/contracts-client

Typed chain-interaction layer for FORGE.

## Isolation rule (PRD Appendix H.1)

This is the **only** module in the FORGE monorepo allowed to import a
chain SDK. All on-chain reads for the rest of the app go through the
`ContractsClient` interface exported here — nothing in `apps/web` or
`apps/api` should reach for a chain SDK directly. Keeping the boundary at
this one package is what makes the "web3-in-disguise" UI possible and
keeps the guarded review surface small.

## Cold-account approval path

Per the repo's `CODEOWNERS`, `/packages/contracts-client/` lists both
`@td` and `@forge-cold` as owners. What that enforces, stated plainly:
GitHub accepts an approval from **any one** listed owner, and both
accounts belong to the same person. Since GitHub never counts the author's
own approval, a `@td`-authored change here does force a sign-in to the
hardware-2FA cold account — real cost against a stolen hot-account
session, and no independent judgment at all. It is not two-person control;
the upgrade path to that is in `CODEOWNERS` and the operator runbook
(private core repo).

This package is also **tier-floor T2** (PRD Appendix F/H.1): only Trust
Tier T2+ contributors may pick up tasks scoped here.

## Modes

- `createContractsClient({ mode: 'mock' })` — deterministic synthetic
  data (same address always yields the same balance; fixed total supply;
  a seeded transfer history). No network access. Safe for local dev,
  tests, and the current Phase 0 beta/testnet app.
- `createContractsClient({ mode: 'live', rpcUrl })` — **throws** ("live
  mode requires cold-account review"). No chain SDK is wired in Phase 0.
  Implementing it is exactly the kind of change the approval path above
  exists to gate.

## Zero runtime dependencies

This package intentionally ships with no npm runtime dependencies — Node
built-ins only (`node:crypto` for the mock client's deterministic
hashing). When a live client is eventually built, its chain SDK
dependency should still be the only one this package adds; nothing else
in the workspace should need to depend on it.
