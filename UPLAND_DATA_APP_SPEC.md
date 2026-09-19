# Upland Data App Skeleton — Build Spec

## Goal
Transform forge-app into an Upland-centric data app (ledger.upland.me). Build a complete data skeleton so private beta users have access to ALL Upland blockchain data (last 90-180 days minimum). Use GCS buckets via Terraform for storage.

## Existing forge-app architecture (MUST follow these conventions)
- Monorepo: `apps/web` (Next.js 15, TypeScript strict) + `apps/api` (FastAPI, Python 3.12, `uv`, package `forge_api`)
- API pattern: thin routers in `apps/api/src/forge_api/routers/`, logic in `apps/api/src/forge_api/services/`
- Pydantic models in `apps/api/src/forge_api/models.py` (camelCase wire contract)
- Feature flags: `config/flags.json` + `packages/flags` + `apps/api/src/forge_api/services/flags.py` — fail-closed, all-off defaults
- zod schemas in `packages/shared/src/index.ts` mirror the Pydantic models
- `apps/api/pyproject.toml` for Python deps (uses `uv`)

## Existing Upland scraper code to PORT/ADAPT (read these files)
- `C:\Users\td\Desktop\upland-scraper\backend\app\hyperion.py` — Hyperion API client (chain-history.upland.me)
- `C:\Users\td\Desktop\upland-scraper\backend\app\scraper.py` — scraper orchestration + action processing
- `C:\Users\td\Desktop\upland-scraper\backend\app\db.py` — SQLite schema (WAL mode)
- `C:\Users\td\Desktop\upland-scraper\backend\app\action_codes.py` — obfuscated action name mappings
- `C:\Users\td\Desktop\upland-scraper\backend\app\main.py` — existing FastAPI endpoints (reference for API design)

## Key Upland facts
- Hyperion API: `https://chain-history.upland.me` (no auth, needs browser-like User-Agent)
- Chain API: `https://chain-api.upland.me`
- Contract: `playuplandme` on Upland's Antelope appchain
- ~172,800 blocks/day (0.5s block time)
- Hyperion caps: 1000 results per request, 9999 max skip
- Action names are obfuscated: n5=secondary buy, n2=list, n111=offer accept, a4=mint, n31=yield, etc.
- 90 days ≈ 15.5M blocks, 180 days ≈ 31M blocks
- 7 days ≈ 1.4M actions

## Files to CREATE

### 1. Terraform — GCS storage (`infra/terraform/`)
```
infra/terraform/main.tf          — GCS bucket for raw action data (JSONL), bucket for processed/parquet, service account
infra/terraform/variables.tf    — project_id, region, bucket names
infra/terraform/outputs.tf       — bucket URLs, service account email
infra/terraform/versions.tf     — provider versions
infra/terraform/README.md       — how to apply
```
GCS bucket structure:
- `gs://upland-data-raw/actions/YYYY/MM/DD/*.jsonl` — raw actions by date
- `gs://upland-data-processed/properties/*.parquet` — processed property data
- `gs://upland-data-processed/daily_stats/*.json` — aggregated daily stats
- `gs://upland-data-checkpoints/scraper_state.json` — resume points

### 2. Python backend — Upland data service
```
apps/api/src/forge_api/services/upland/__init__.py
apps/api/src/forge_api/services/upland/hyperion.py    — port from scraper, async Hyperion client
apps/api/src/forge_api/services/upland/action_codes.py — port from scraper
apps/api/src/forge_api/services/upland/scraper.py     — port from scraper, adapt to forge-api conventions
apps/api/src/forge_api/services/upland/db.py          — SQLite WAL mode, schema with actions + properties + scrape_progress
apps/api/src/forge_api/services/upland/storage.py     — GCS upload/sync (google-cloud-storage), local fallback
apps/api/src/forge_api/services/upland/analytics.py   — query functions for all analytics endpoints
apps/api/src/forge_api/routers/upland.py              — data query endpoints (thin, calls analytics service)
apps/api/src/forge_api/routers/upland_scrape.py       — scraper control endpoints
```

### 3. Pydantic models — add to `apps/api/src/forge_api/models.py`
Add these models (camelCase wire contract):
- `UplandAction` — globalSequence, ts, blockNum, trxId, contract, actionName, actionMeaning, category, actor, propertyId, priceUpx, fromAccount, toAccount
- `UplandActionList` — items, total, hasMore
- `UplandProperty` — propertyId, address, city, firstSeenBlock, firstSeenTs, mintPriceUpx, lastSalePriceUpx, lastSaleTs, totalSales, totalListings
- `UplandPropertyList` — items, total
- `SalesVolumeDay` — date, count, volumeUpx, avgPrice, minPrice, maxPrice
- `TimeSeriesPoint` — bucket, count, volume
- `PriceDistributionBucket` — range, count, avgPrice
- `ActionDistributionEntry` — actionName, actionMeaning, category, count
- `ActiveAccount` — actor, txCount, volumeUpx
- `ChainInfo` — headBlockNum, headBlockTime, chainId, blocksPerDay
- `ScrapeStatus` — running, phase, currentBlock, fetched, totalActions, startBlock, endBlock, error, lastResult
- `ScrapeRequest` — days (optional), startBlock (optional), endBlock (optional), chunkBlocks (default 100000)
- `GcsSyncResult` — synced, uploadedFiles, errors
- `UplandStatsOverview` — totalActions, dateRange {min, max}, byCategory, byType, totalProperties

### 4. Feature flag
Add `upland_data` flag to:
- `config/flags.json` — set to `true` for dev/beta
- `packages/flags/src/core.ts` — add to DEFAULT_FLAGS (false)
- `apps/api/src/forge_api/services/flags.py` — add to DEFAULT_FLAGS (false)

### 5. API endpoints (all under `/api/upland/`, gated by `upland_data` flag)

Data query endpoints (`routers/upland.py`):
```
GET  /api/upland/health           — scraper DB health + row counts
GET  /api/upland/stats/overview   — high-level stats
GET  /api/upland/actions          — paginated actions (filter by category, action_name, actor, property_id, date range)
GET  /api/upland/actions/sales   — recent sales (n5, n111, n13, n112, a4, a44 with prices)
GET  /api/upland/stats/sales_volume?days=90  — daily sales volume
GET  /api/upland/stats/action_distribution  — all action type counts
GET  /api/upland/stats/top_properties?limit=50&sort=sales  — top properties
GET  /api/upland/stats/active_accounts?limit=50  — most active accounts
GET  /api/upland/stats/time_series?interval=day&filter=trade  — time series charting
GET  /api/upland/stats/price_distribution  — sale price histogram
GET  /api/upland/properties/{property_id}  — single property detail
GET  /api/upland/properties       — paginated properties list
GET  /api/upland/codes            — action code mapping
GET  /api/upland/chain/info       — live chain head block
GET  /api/upland/estimate?days=90  — estimate action count for timeframe
GET  /api/upland/export?type=actions  — CSV export of actions
GET  /api/upland/export?type=sales  — CSV export of sales only
```

Scraper control endpoints (`routers/upland_scrape.py`):
```
POST /api/upland/scrape           — start scrape (days or block range), background task
GET  /api/upland/scrape/status    — current scrape progress
POST /api/upland/scrape/cancel    — cancel running scrape
POST /api/upland/gcs/sync         — sync local DB to GCS buckets
GET  /api/upland/gcs/status       — GCS sync status
```

### 6. Dependencies
Add to `apps/api/pyproject.toml`:
- `aiosqlite>=0.20` (SQLite async)
- `google-cloud-storage>=2.18` (GCS)
- `httpx>=0.27` (already likely present)

### 7. Wire into main app
- `apps/api/src/forge_api/main.py` — import and include upland + upland_scrape routers
- `apps/api/src/forge_api/__init__.py` — bump version

### 8. Frontend stub (minimal, just data hooks)
- `apps/web/src/lib/upland-api.ts` — typed API client for all upland endpoints
- `apps/web/src/app/upland/page.tsx` — stub page showing "Upland Data — Private Beta" with data availability summary

## Critical implementation notes
1. SQLite must use WAL mode + busy_timeout=30000 (the existing scraper pattern works)
2. The `_db()` helper MUST be an `@asynccontextmanager`, NOT `async def` returning a connection
3. Use `async with _db() as db:` (no await) — the old pattern double-starts aiosqlite thread
4. Store actions AND update properties in a single connection (store_and_update pattern)
5. Hyperion client needs browser-like User-Agent header or gets 403
6. Use recursive block-range chunking: start at 100K blocks, halve if >10K actions
7. GCS storage is optional — if no credentials, fall back to local SQLite only (don't crash)
8. All endpoints must be gated by the `upland_data` feature flag (fail-closed)
9. Keep routers THIN — all logic in services/
10. Follow existing forge-app code style (ruff + mypy --strict compatible)
11. Pydantic models use camelCase (they ARE the JSON wire contract)
12. Default scrape: 180 days of data available, 90 days as the quick-start option

## Testing
- Add `apps/api/tests/test_upland.py` — test the models, action processing, and that endpoints return proper structures
- Tests should not require network (mock Hyperion or use fixtures)
- Test the feature flag gating (upland_data off → 404)
