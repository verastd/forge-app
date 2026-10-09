# @forge/upland-ledger

Contract and typed client for the **Upland Ledger** REST API, as a browser UI
sees it: same-origin `/bff/ledger/*`. Written for a Claude Code session that
is building Upland data screens. Read this, then `openapi.yaml`.

| File | What it is |
|---|---|
| `openapi.yaml` | **Source of truth.** OpenAPI 3.1 for all 36 routes: params, defaults, limits, enums, envelopes, errors, gotchas. |
| `src/schemas.ts` | zod schemas for every response, field-for-field with the spec (snake_case as on the wire). |
| `src/params.ts` | Typed request params for every operation. |
| `src/client.ts` | `createLedgerClient()`: one method per operation, validated responses, `LedgerError`, pagination. |
| `examples/` | One real response per route (captured 2026-10-08), plus `ERROR_*.json`. See `examples/CAPTURED.md`. |
| `scripts/capture-examples.sh` | Re-captures `examples/` from a running ledger. |

## What the data is

The Upland Ledger ingests every action on the Upland appchain (Antelope /
Hyperion) into ClickHouse and follows **RAW → CANONICAL → DERIVED**
(`/srv/upland-ledger/README.md`, `docs/ARCHITECTURE.md`): each upstream
document is archived untouched (RAW), normalised once into one canonical row
per action (`actions_raw`, CANONICAL — what `/actions`, `/transactions`,
`/transfers` read), and everything else is DERIVED from it: decoded game
events (`/properties/{id}/history`, `/sales`, `/listings`), the market layer
(`/properties`, `/accounts`, `/offers`, `/rates`, `/market/*`, `/signals`),
plus reference data pulled from Upland's Developers API (`/neighborhoods`,
`/collections`, `/treasures`, `upland_api` on a property). Concepts:
`docs/MARKET.md` (what a rate method or signal means), `docs/DATASETS.md`
(where each table comes from), `docs/ANALYTICS.md` (the query spec).

**Freshness** — show it on screens where it matters:

| Layer | Updated | Routes |
|---|---|---|
| Chain (canonical) | live, ~1 s lag (`/status` → `ingestion.lagSeconds`) | `/actions`, `/transactions`, `/transfers`, `/contracts`, `/stats/actions`, `/analytics/*` |
| Decoded events | every 15 min | `/properties/{id}/history`, `/sales`, `/listings` |
| Market layer | every 6 h, at :17 | `/properties`, `/accounts`, `/offers`, `/rates`, `/market/*`, `/signals` |
| Reference data | daily, 04:43 UTC | `/neighborhoods`, `/collections`, `/treasures`, `upland_api` |

So a sale can be in `/sales` minutes after it happens while
`/properties/{id}` still says `sales: 0` until the next market build.

## Auth: how the browser reaches it

```
browser ──(same-origin, session cookie)──▶ /bff/ledger/<path>        web app server: checks the session
        ──▶ forge-api /api/ledger/<path>                            allowlist + flag + timeouts
        ──▶ ledger /v1/<path>                                       localhost only, no auth
```

- **Only ever call `/bff/ledger/...`.** Never the ledger (`127.0.0.1:3000`) or
  forge-api directly; they are not reachable from a browser and must not be.
- There is no token to send. The client uses `credentials: 'same-origin'`.
- **401 = signed out** (or the practice/demo account). `err.isUnauthenticated`
  → send the user to sign in; do not retry.
- **404 from the gateway** (`err.source === 'gateway'`): `{"error":"not_found"}`
  = route not allowed; `{"error":"ledger-disabled"}` = the `upland_ledger` flag is off. A ledger 404
  (`err.isNotFound`) = that entity does not exist.
- 502/504 = the ledger is down / slow (`err.isRetryable`). 503 = not configured.
- `/health` and `/metrics` are not exposed.

## Using the client

```ts
import { createLedgerClient, isLedgerError } from '@forge/upland-ledger';

const ledger = createLedgerClient(); // baseUrl '/bff/ledger', globalThis.fetch, 30 s timeout

const prop = await ledger.properties.get('78641749916331');
const history = await ledger.properties.history('78641749916331', { limit: 50 });
const sales = await ledger.sales.list({ city: 'Rome', sort: 'price_upx', order: 'desc', limit: 20 });
const rate = await ledger.market.upxUsd({ method: 'weighted_comps' });
const q = await ledger.analytics.query({
  source: 'sales',
  range: { after: '2026-10-01T00:00:00Z', before: '2026-10-07T23:59:59Z' },
  dimensions: [{ field: 'city' }],
  measures: [{ fn: 'count', alias: 'sales' }, { fn: 'median', field: 'price_upx', alias: 'median_price' }],
  limit: 10,
});

try {
  await ledger.accounts.get('nosuchacct12');
} catch (err) {
  if (isLedgerError(err) && err.isUnauthenticated) redirectToSignIn();
  else if (isLedgerError(err) && err.isNotFound) showEmptyState();
  else throw err;
}
```

- Options: `createLedgerClient({ baseUrl?, fetch?, timeoutMs?, credentials? })`.
  Every method takes a last `{ signal }` arg — pass your effect's
  `AbortController.signal` (React Query: the `signal` it gives you).
- Params are typed; `undefined`/`null`/`''` are dropped; `Date` becomes an ISO
  instant (or `YYYY-MM-DD` on `/market/*`); booleans become `true`/`false`.
- Every 2xx body is validated with its zod schema. On anything unexpected the
  client **throws `LedgerError`** — it never returns partial or substituted
  data. `err.status`, `err.code`, `err.message`, `err.source`
  (`ledger` | `gateway` | `client`), `err.path`, `err.details`.
  Client codes: `network_error`, `timeout`, `aborted`, `invalid_response`,
  `schema_mismatch` (the contract drifted: fix `schemas.ts` + `openapi.yaml`,
  re-capture, don't paper over it in the UI).
- Pagination:
  - cursor routes: `ledger.actions.pages(params, { maxPages })`,
    `ledger.transfers.pages(...)`, `ledger.contracts.actionPages(contract, ...)`,
    `ledger.accounts.actionPages(account, ...)` — async iterators that follow
    `next_cursor`. Generic: `paginate(fetchPage, params)`.
  - offset routes (all entities): `paginateOffset((p) => ledger.sales.list(p), { limit: 100 })`,
    stops on `has_more: false`. Not snapshot-stable — prefer filters to deep paging.
  ```ts
  for await (const page of ledger.transfers.pages({ from: 'abc', symbol: 'UPX', limit: 500 }, { maxPages: 10 })) {
    rows.push(...page.data);
  }
  ```
- Types: `import type { PropertyDetail, Sale, AnalyticsResult } from '@forge/upland-ledger'`
  — every schema has a matching `z.infer` type.

## Endpoints → screens

Paths relative to `/bff/ledger`. Envelope: **C** = cursor `{data,next_cursor,count}`,
**A** = aggregate `{data,count,approximate}`, **O** = offset `{data,count,limit,offset,has_more}`,
**[]** = bare array, **{}** = object.

| Method | Path | Client | Env | Good for |
|---|---|---|---|---|
| GET | `/status` | `status()` | {} | Freshness badge, "data as of", ingest health |
| GET | `/chains` | `chains()` | [] | Chain picker (rarely needed: one chain) |
| GET | `/actions` | `actions.list/pages` | C | Raw activity feed, explorer |
| GET | `/actions/{globalSequence}` | `actions.get` | {} | Action detail / JSON viewer |
| GET | `/transactions/{trxId}` | `transactions.get` | {} | Transaction page (all actions of a trx) |
| GET | `/contracts` | `contracts.list` | A | Contract directory |
| GET | `/contracts/{contract}/actions` | `contracts.actions/actionPages` | C | Contract activity tab |
| GET | `/transfers` | `transfers.list/pages` | C | UPX/SPARKLT/STEM transfer ledger, wallet tab |
| GET | `/stats/actions` | `stats.actions` | A | Action-type breakdown table |
| GET | `/accounts/{account}/actions` | `accounts.actions/actionPages` | C | Account activity tab (role actor/receiver/notified) |
| GET | `/analytics/overview` | `analytics.overview` | {} | Home dashboard KPIs |
| GET | `/analytics/timeseries` | `analytics.timeseries` | {} | Activity / volume line charts, stacked by contract or symbol |
| GET | `/analytics/keys` | `analytics.keys` | [] | Query-builder field picker (currently empty, see Gotchas) |
| GET | `/analytics/flows` | `analytics.flows` | {} | Sankey / network of token flows, account flow tab |
| GET | `/analytics/accounts/top` | `analytics.topAccounts` | [] | Leaderboards (most active, biggest senders/receivers) |
| GET | `/analytics/calendar` | `analytics.calendar` | [] | Calendar heatmap |
| GET | `/analytics/sales` | `analytics.sales` | {} | Sale price trend + price histogram |
| POST | `/analytics/query` | `analytics.query` | {} | Custom charts / explorer (any source, group by, measures) |
| GET | `/ingest/windows` | `ingest.windows` | [] | Backfill coverage / ops page |
| GET | `/market/upx-usd` | `market.upxUsd` | {} | UPX↔USD rate chart, price converter (`preferred` method) |
| GET | `/market/cities` | `market.cities` | [] | City market table / city page trends |
| GET | `/market/fiat` | `market.fiat` | {} | FIAT market page (asked vs cleared) |
| GET | `/signals` | `signals.list` | [] | Opportunities feed |
| GET | `/properties` | `properties.list` | O | Property browser / filters (city, mint band, traded) |
| GET | `/properties/{propertyId}` | `properties.get` | {} | Property page header |
| GET | `/properties/{propertyId}/history` | `properties.history` | O | Property timeline (mint, listings, sales, fees) |
| GET | `/accounts` | `accounts.list` | O | Trader directory, bot filter |
| GET | `/accounts/{account}` | `accounts.get` | {} | Account profile (trading + yield/visit income) |
| GET | `/listings` | `listings.list` | O | Order book, open listings, under-mint asks |
| GET | `/sales` | `sales.list` | O | Recent sales, comps |
| GET | `/offers` | `offers.list` | O | Off-book (accepted offer) transfers |
| GET | `/neighborhoods` | `neighborhoods.list` | O | Neighborhood list / map (`include_boundaries`) |
| GET | `/collections` | `collections.list` | O | Collections and yield boosts |
| GET | `/treasures` | `treasures.list` | O | Treasure hunt leaderboard |
| GET | `/rates` | `rates.list` | O | Raw daily rate rows per method (prefer `/market/upx-usd` for charts) |
| GET | `/search` | `search` | {} | Global search box |

## Gotchas (verified 2026-10-09)

Checked against the source and the live ledger; see `openapi.yaml` descriptions.

1. **One shared heavy-query slot for the whole app.** Every analytics/market
   request that reaches ClickHouse (a cache miss on `/analytics/*`,
   `/ingest/windows`, `/market/*`, `/signals`, and every
   `POST /analytics/query`) goes through the ledger's query gate: 4 in flight
   in total, **1 per client IP**. The gateway is a single IP, so all users
   share one in-flight slot and those requests queue behind each other. The
   ledger has no knob for it (`QueryGate(4, 1)` is hard-coded). So: don't
   fire a burst of chart queries in parallel, never query per keystroke,
   debounce builders, and lean on the 15 s response cache (identical GET URLs
   are free). Entity and raw-chain routes don't go through the gate.
2. `/market/upx-usd` `limit` is the **newest N days per method**, returned
   oldest-first per method (ready to chart).
3. Entity routes ignore unknown query params (a typo silently returns
   everything); raw-chain/analytics/market routes 400 on them.
4. `/analytics/keys` is `[]` — the `data_keys` table is empty, so JSON-field
   queries in `POST /analytics/query` are rejected.
5. Account names: `/accounts/{account}`, `/accounts/{account}/actions` and the
   `buyer`/`seller` filters on `/sales` and `/offers` accept only a real
   Antelope account (`ANTELOPE_ACCOUNT` / `isAntelopeAccount()` exported here);
   anything else is a 400 `validation_error`, so validate user input first. The
   gateway allowlist also limits `{account}`/`{contract}` path segments to
   `[a-z1-5.]{1,13}` and rejects percent-encoded paths.
6. Property ids are up to 20 digits: keep them strings. `/properties` only
   holds properties seen on chain (~398 K of ~4.9 M); `/properties/{id}` falls
   back to the Upland API row (`chain_known: false`).
7. `/market/cities` medians are `null` on days with no data;
   `/neighborhoods` `boundaries` is parsed JSON (nested `[lng, lat]` arrays) or
   `null`. Numbers elsewhere are never null unless the schema says so.
8. Derived layers lag the chain (see Freshness): a sale is in `/sales` within
   15 min but `/properties/{id}` counts it only after the next 6-hourly build.

## Re-capturing the examples

On a machine where the ledger is reachable (it listens on `127.0.0.1:3000`):

```bash
cd packages/upland-ledger
LEDGER_URL=http://127.0.0.1:3000 ./scripts/capture-examples.sh   # needs curl + jq
pnpm test                                                        # schemas vs examples
```

The script picks real ids from list responses, writes pretty-printed
`examples/*.json` and a request log `examples/CAPTURED.log`; update the date
in `examples/CAPTURED.md`. If a schema test fails, the API changed: update
`openapi.yaml` and `src/schemas.ts` together (the tests also fail if the spec
and client operation lists drift apart).

## Package commands

`pnpm --filter @forge/upland-ledger run lint | typecheck | test | test:coverage | build`
(the workspace's `make lint` / `make test` run these).

## Moving to a new repo

The package is self-contained: no `@forge/*` imports, `zod` is the only
runtime dependency.

**Copy:** `packages/upland-ledger/` (all of it). Rename the package if you
like. It expects TypeScript strict + ESM; `tsconfig.json` extends
`../../tsconfig.base.json` — inline that file's `compilerOptions` (strict,
ES2022, ESNext, `moduleResolution: bundler`, `noUncheckedIndexedAccess`).
Dev deps: typescript ~5.6, vitest ^2.1, eslint ^9 + typescript-eslint ^8.

**The new repo must provide** a BFF at `/bff/ledger/*` (same origin as the UI)
that:
1. authenticates the user from the session cookie, answering
   `401 {"error":"unauthenticated"}` when signed out;
2. forwards `GET`/`POST` with the path after `/bff/ledger/` and the query
   string to a **server-side** gateway (today: forge-api `/api/ledger/*`) that
   holds the allowlist of the 36 routes in `openapi.yaml`, timeouts and size
   limits, and talks to the ledger's `/v1/*`;
3. passes the ledger's status and body through unchanged, and uses the
   `{"error":"<code>"}` shape for its own errors (404 not allowed, 502/504,
   503 not configured).

Never expose the ledger itself to browsers: it has no auth and is
localhost-only by design. Point `createLedgerClient({ baseUrl })` elsewhere
only if the BFF lives at another path.
