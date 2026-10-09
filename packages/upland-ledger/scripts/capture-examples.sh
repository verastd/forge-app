#!/usr/bin/env bash
# Re-captures examples/*.json from a running Upland Ledger.
#
#   LEDGER_URL=http://127.0.0.1:3000 ./scripts/capture-examples.sh
#
# Talks to the ledger DIRECTLY (its /v1 prefix), not through /bff/ledger:
# this is a dev/ops tool, run on the ledger host. Detail-route ids are taken
# from list responses so every detail example is a real 200. Needs curl + jq.
# Every request and its HTTP status is appended to examples/CAPTURED.log.
set -euo pipefail

LEDGER_URL="${LEDGER_URL:-http://127.0.0.1:3000}"
V1="$LEDGER_URL/v1"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/examples"
LOG="$OUT/CAPTURED.log"
mkdir -p "$OUT"
: > "$LOG"

# get <file> <path?query> [expected-status]
get() {
  local file="$1" path="$2" want="${3:-200}" tmp status
  tmp="$(mktemp)"
  status="$(curl -sS -m 60 -o "$tmp" -w '%{http_code}' "$V1$path")"
  echo "$status GET /v1$path -> $file" >> "$LOG"
  if [[ "$status" != "$want" ]]; then
    echo "FAIL: GET /v1$path returned $status (wanted $want)" >&2
    cat "$tmp" >&2; rm -f "$tmp"; return 1
  fi
  jq . "$tmp" > "$OUT/$file.json"; rm -f "$tmp"
}

# post <file> <path> <json-body>
post() {
  local file="$1" path="$2" body="$3" tmp status
  tmp="$(mktemp)"
  status="$(curl -sS -m 60 -o "$tmp" -w '%{http_code}' -H 'content-type: application/json' -d "$body" "$V1$path")"
  echo "$status POST /v1$path $body -> $file" >> "$LOG"
  [[ "$status" == 200 ]] || { echo "FAIL: POST /v1$path returned $status" >&2; cat "$tmp" >&2; rm -f "$tmp"; return 1; }
  jq . "$tmp" > "$OUT/$file.json"; rm -f "$tmp"
}

# Analytics windows: one closed UTC day ending at the start of today.
TODAY="$(date -u +%Y-%m-%d)"
YDAY="$(date -u -d "$TODAY -1 day" +%Y-%m-%d)"
WEEK="$(date -u -d "$TODAY -7 day" +%Y-%m-%d)"

# --- system / raw chain ------------------------------------------------------
get GET_status '/status'
get GET_actions '/actions?limit=3'
GS="$(jq -r '.data[0].global_sequence' "$OUT/GET_actions.json")"
TRX="$(jq -r '.data[0].trx_id' "$OUT/GET_actions.json")"
get GET_actions_{globalSequence} "/actions/$GS"
get GET_transactions_{trxId} "/transactions/$TRX"
get GET_contracts '/contracts?limit=3'
get GET_contracts_{contract}_actions '/contracts/upxtokenacct/actions?limit=3'
get GET_transfers '/transfers?limit=3&symbol=UPX'
get GET_stats_actions '/stats/actions?limit=3'

# --- analytics ---------------------------------------------------------------
get GET_chains '/chains'
get GET_analytics_overview '/analytics/overview'
get GET_analytics_timeseries "/analytics/timeseries?metric=actions&bucket=day&after=${WEEK}T00:00:00Z&before=${YDAY}T23:59:59Z"
get GET_analytics_keys '/analytics/keys?contract=playuplandme&action=n5&limit=3'
get GET_analytics_flows "/analytics/flows?symbol=UPX&after=${YDAY}T00:00:00Z&before=${YDAY}T23:59:59Z&limit=3"
get GET_analytics_accounts_top "/analytics/accounts/top?by=actions&after=${YDAY}T00:00:00Z&before=${YDAY}T23:59:59Z&limit=3"
get GET_analytics_calendar "/analytics/calendar?metric=transactions&after=${WEEK}T00:00:00Z&before=${YDAY}T23:59:59Z"
get GET_analytics_sales "/analytics/sales?bucket=day&bins=4&after=${WEEK}T00:00:00Z&before=${YDAY}T23:59:59Z"
get GET_ingest_windows '/ingest/windows?limit=3&sort=desc'
post POST_analytics_query '/analytics/query' \
  "{\"source\":\"sales\",\"range\":{\"after\":\"${WEEK}T00:00:00Z\",\"before\":\"${YDAY}T23:59:59Z\"},\"dimensions\":[{\"field\":\"city\"}],\"measures\":[{\"fn\":\"count\",\"alias\":\"sales\"},{\"fn\":\"median\",\"field\":\"price_upx\",\"alias\":\"median_price\"}],\"orderBy\":[{\"measure\":\"sales\",\"dir\":\"desc\"}],\"limit\":3}"

# --- market layer --------------------------------------------------------------
get GET_market_upx-usd "/market/upx-usd?method=weighted_comps&after=$(date -u -d "$TODAY -3 day" +%Y-%m-%d)&before=${YDAY}&smooth=7"
get GET_market_cities "/market/cities?after=${YDAY}&before=${YDAY}&limit=3"
get GET_market_fiat '/market/fiat?days=7'
get GET_signals '/signals?limit=3'

# --- entities ----------------------------------------------------------------
get GET_properties '/properties?limit=3&traded=true&sort=last_sale_at'
get GET_sales '/sales?limit=3'
PID="$(jq -r '.data[0].property_id' "$OUT/GET_sales.json")"
get GET_properties_{propertyId} "/properties/$PID"
get GET_properties_{propertyId}_history "/properties/$PID/history?limit=3"
get GET_accounts '/accounts?limit=3&named=true&sort=buys'
ACCT="$(jq -r '.data[0].buyer' "$OUT/GET_sales.json")"
get GET_accounts_{account} "/accounts/$ACCT"
get GET_accounts_{account}_actions "/accounts/$ACCT/actions?limit=3"
get GET_listings '/listings?limit=3'
get GET_offers '/offers?limit=3'
get GET_neighborhoods '/neighborhoods?limit=3&include_boundaries=true'
get GET_collections '/collections?limit=3'
get GET_treasures '/treasures?limit=3'
get GET_rates "/rates?after=${YDAY}T00:00:00Z&limit=3&offset=1"
get GET_search '/search?q=main&limit=2'

# --- one error ---------------------------------------------------------------
get ERROR_validation_error '/actions?limit=5000' 400
get ERROR_not_found '/properties/1' 404

echo "captured $(ls "$OUT"/*.json | wc -l) examples into $OUT"
