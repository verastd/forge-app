# Captured examples

- **Captured:** 2026-10-09 (status checked at 2026-10-09T00:21:04.723Z) against the live Upland
  Ledger at `http://127.0.0.1:3000` (ledger `/v1`, no auth, localhost on the
  OVH VM), after the upstream fixes for date filters, `/rates` paging,
  `/signals` timestamps, `/search` `likely_bot`, parsed neighborhood
  boundaries and the shared account validator. Chain `upland`, latest block
  91625496, ingest lag 1 s.
- **How:** `LEDGER_URL=http://127.0.0.1:3000 ./scripts/capture-examples.sh`
  (curl + jq; responses pretty-printed with `jq .`). Detail ids were taken from
  list responses captured in the same run, so every detail route is a real 200:
  global sequence and trx id from `GET_actions.json`; property id and buyer
  account from `GET_sales.json`.
- Date windows use closed UTC days before the capture day: analytics
  2026-10-02 .. 2026-10-08 (or just 2026-10-08); `/market/upx-usd`
  2026-10-06 .. 2026-10-08; `/market/cities` and `/rates` 2026-10-08 (rates
  with `offset=1` to show the paging echo).
- `GET_neighborhoods.json` uses `include_boundaries=true`, so it shows the
  parsed polygon shape.
- `GET_analytics_keys.json` is `[]`: the ledger's `data_keys` table is empty
  (no `pnpm analyze:keys` run yet), so no non-empty example exists. The schema
  comes from the source (`analytics/queries.ts` `DataKeyJson`).
- `GET_properties_{propertyId}.json` has `upland_api: null`; no property with
  an Upland API row could be found through the API. Its shape comes from the
  source (`entities/queries.ts` `getProperty`) and migration
  `0008_ext_upland.sql`.
- Errors: `ERROR_validation_error.json` (`GET /v1/actions?limit=5000`, 400) and
  `ERROR_not_found.json` (`GET /v1/properties/1`, 404). Gateway errors
  (`{"error":"unauthenticated"}` etc.) come from forge-app, not the ledger, and
  are documented in `openapi.yaml` (`GatewayError`).

## Exact requests (status, request, file)

These are the contents of `CAPTURED.log` from the capture run:

```
200 GET /v1/status -> GET_status
200 GET /v1/actions?limit=3 -> GET_actions
200 GET /v1/actions/351023578 -> GET_actions_{globalSequence}
200 GET /v1/transactions/46db20ec510a2efebe2f102ed80801425bc2be901dc2c941f33a48902e314edc -> GET_transactions_{trxId}
200 GET /v1/contracts?limit=3 -> GET_contracts
200 GET /v1/contracts/upxtokenacct/actions?limit=3 -> GET_contracts_{contract}_actions
200 GET /v1/transfers?limit=3&symbol=UPX -> GET_transfers
200 GET /v1/stats/actions?limit=3 -> GET_stats_actions
200 GET /v1/chains -> GET_chains
200 GET /v1/analytics/overview -> GET_analytics_overview
200 GET /v1/analytics/timeseries?metric=actions&bucket=day&after=2026-10-02T00:00:00Z&before=2026-10-08T23:59:59Z -> GET_analytics_timeseries
200 GET /v1/analytics/keys?contract=playuplandme&action=n5&limit=3 -> GET_analytics_keys
200 GET /v1/analytics/flows?symbol=UPX&after=2026-10-08T00:00:00Z&before=2026-10-08T23:59:59Z&limit=3 -> GET_analytics_flows
200 GET /v1/analytics/accounts/top?by=actions&after=2026-10-08T00:00:00Z&before=2026-10-08T23:59:59Z&limit=3 -> GET_analytics_accounts_top
200 GET /v1/analytics/calendar?metric=transactions&after=2026-10-02T00:00:00Z&before=2026-10-08T23:59:59Z -> GET_analytics_calendar
200 GET /v1/analytics/sales?bucket=day&bins=4&after=2026-10-02T00:00:00Z&before=2026-10-08T23:59:59Z -> GET_analytics_sales
200 GET /v1/ingest/windows?limit=3&sort=desc -> GET_ingest_windows
200 POST /v1/analytics/query {"source":"sales","range":{"after":"2026-10-02T00:00:00Z","before":"2026-10-08T23:59:59Z"},"dimensions":[{"field":"city"}],"measures":[{"fn":"count","alias":"sales"},{"fn":"median","field":"price_upx","alias":"median_price"}],"orderBy":[{"measure":"sales","dir":"desc"}],"limit":3} -> POST_analytics_query
200 GET /v1/market/upx-usd?method=weighted_comps&after=2026-10-06&before=2026-10-08&smooth=7 -> GET_market_upx-usd
200 GET /v1/market/cities?after=2026-10-08&before=2026-10-08&limit=3 -> GET_market_cities
200 GET /v1/market/fiat?days=7 -> GET_market_fiat
200 GET /v1/signals?limit=3 -> GET_signals
200 GET /v1/properties?limit=3&traded=true&sort=last_sale_at -> GET_properties
200 GET /v1/sales?limit=3 -> GET_sales
200 GET /v1/properties/81826746578110 -> GET_properties_{propertyId}
200 GET /v1/properties/81826746578110/history?limit=3 -> GET_properties_{propertyId}_history
200 GET /v1/accounts?limit=3&named=true&sort=buys -> GET_accounts
200 GET /v1/accounts/ymc55j4fboxi -> GET_accounts_{account}
200 GET /v1/accounts/ymc55j4fboxi/actions?limit=3 -> GET_accounts_{account}_actions
200 GET /v1/listings?limit=3 -> GET_listings
200 GET /v1/offers?limit=3 -> GET_offers
200 GET /v1/neighborhoods?limit=3&include_boundaries=true -> GET_neighborhoods
200 GET /v1/collections?limit=3 -> GET_collections
200 GET /v1/treasures?limit=3 -> GET_treasures
200 GET /v1/rates?after=2026-10-08T00:00:00Z&limit=3&offset=1 -> GET_rates
200 GET /v1/search?q=main&limit=2 -> GET_search
400 GET /v1/actions?limit=5000 -> ERROR_validation_error
404 GET /v1/properties/1 -> ERROR_not_found
```
