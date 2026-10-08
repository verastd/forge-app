# Captured examples

- **Captured:** 2026-10-08 (~17:14 UTC) against the live Upland Ledger at
  `http://127.0.0.1:3000` (ledger `/v1`, no auth, localhost on the OVH VM).
  Chain `upland`, latest block 91574249, ingest lag ~2 s.
- **How:** `LEDGER_URL=http://127.0.0.1:3000 ./scripts/capture-examples.sh`
  (curl + jq; responses pretty-printed with `jq .`). Detail ids were taken from
  list responses captured in the same run, so every detail route is a real 200:
  global sequence and trx id from `GET_actions.json`; property id and buyer
  account from `GET_sales.json`.
- Analytics windows use closed UTC days: 2026-10-01 .. 2026-10-07 (or just
  2026-10-07).
- `GET_analytics_keys.json` is `[]`: the ledger's `data_keys` table is empty
  (no `pnpm analyze:keys` run yet), so no non-empty example exists. The schema
  comes from the source (`analytics/queries.ts` `DataKeyJson`).
- `GET_market_upx-usd.json` uses `limit=3` instead of `after=`: `after`/`before`
  return 500 upstream on `/market/upx-usd`, `/market/cities` and `/rates`.
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
200 GET /v1/actions/350804370 -> GET_actions_{globalSequence}
200 GET /v1/transactions/97cbf835eb8eef2e043f05758c54cbdf91fe4a7a4e65173ab068dfc3927eef70 -> GET_transactions_{trxId}
200 GET /v1/contracts?limit=3 -> GET_contracts
200 GET /v1/contracts/upxtokenacct/actions?limit=3 -> GET_contracts_{contract}_actions
200 GET /v1/transfers?limit=3&symbol=UPX -> GET_transfers
200 GET /v1/stats/actions?limit=3 -> GET_stats_actions
200 GET /v1/chains -> GET_chains
200 GET /v1/analytics/overview -> GET_analytics_overview
200 GET /v1/analytics/timeseries?metric=actions&bucket=day&after=2026-10-01T00:00:00Z&before=2026-10-07T23:59:59Z -> GET_analytics_timeseries
200 GET /v1/analytics/keys?contract=playuplandme&action=n5&limit=3 -> GET_analytics_keys
200 GET /v1/analytics/flows?symbol=UPX&after=2026-10-07T00:00:00Z&before=2026-10-07T23:59:59Z&limit=3 -> GET_analytics_flows
200 GET /v1/analytics/accounts/top?by=actions&after=2026-10-07T00:00:00Z&before=2026-10-07T23:59:59Z&limit=3 -> GET_analytics_accounts_top
200 GET /v1/analytics/calendar?metric=transactions&after=2026-10-01T00:00:00Z&before=2026-10-07T23:59:59Z -> GET_analytics_calendar
200 GET /v1/analytics/sales?bucket=day&bins=4&after=2026-10-01T00:00:00Z&before=2026-10-07T23:59:59Z -> GET_analytics_sales
200 GET /v1/ingest/windows?limit=3&sort=desc -> GET_ingest_windows
200 POST /v1/analytics/query {"source":"sales","range":{"after":"2026-10-01T00:00:00Z","before":"2026-10-07T23:59:59Z"},"dimensions":[{"field":"city"}],"measures":[{"fn":"count","alias":"sales"},{"fn":"median","field":"price_upx","alias":"median_price"}],"orderBy":[{"measure":"sales","dir":"desc"}],"limit":3} -> POST_analytics_query
200 GET /v1/market/upx-usd?method=weighted_comps&limit=3&smooth=7 -> GET_market_upx-usd
200 GET /v1/market/cities?limit=3 -> GET_market_cities
200 GET /v1/market/fiat?days=7 -> GET_market_fiat
200 GET /v1/signals?limit=3 -> GET_signals
200 GET /v1/properties?limit=3&traded=true&sort=last_sale_at -> GET_properties
200 GET /v1/sales?limit=3 -> GET_sales
200 GET /v1/properties/78641749916331 -> GET_properties_{propertyId}
200 GET /v1/properties/78641749916331/history?limit=3 -> GET_properties_{propertyId}_history
200 GET /v1/accounts?limit=3&named=true&sort=buys -> GET_accounts
200 GET /v1/accounts/smfvx4j4dqsb -> GET_accounts_{account}
200 GET /v1/accounts/smfvx4j4dqsb/actions?limit=3 -> GET_accounts_{account}_actions
200 GET /v1/listings?limit=3 -> GET_listings
200 GET /v1/offers?limit=3 -> GET_offers
200 GET /v1/neighborhoods?limit=3 -> GET_neighborhoods
200 GET /v1/collections?limit=3 -> GET_collections
200 GET /v1/treasures?limit=3 -> GET_treasures
200 GET /v1/rates?limit=1 -> GET_rates
200 GET /v1/search?q=main&limit=2 -> GET_search
400 GET /v1/actions?limit=5000 -> ERROR_validation_error
404 GET /v1/properties/1 -> ERROR_not_found
```
