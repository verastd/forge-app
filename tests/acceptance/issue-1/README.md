# Task Spec — Issue #1: Polish the CSV export in the Data app

Committed by the spec author (core team) per `tests/acceptance/README.md`.
Contributors implement against this directory and **must not modify it**
(PRD §5 T4 — G0 auto-closes out-of-scope edits, G2.4 flags any test change).

Format: PRD Appendix B (Task Spec issue template).

## Goal

A signed-in user can download the Upland actions in the Data app (`/apps/data`)
as a CSV file that starts streaming at once, however many actions there are.

## Civilian summary

Let people download the Upland data they are looking at as a spreadsheet file.

## Acceptance criteria

1. GET /api/upland/export returns text/csv whose first line is the 13-column action header
2. Export CSV button visible on /apps/data for signed-in users (flag: csv_export)
3. 10k-row export completes < 3s in CI fixture data

The 13 columns, in order: `global_sequence`, `timestamp`, `block_num`,
`trx_id`, `contract`, `action_name`, `action_meaning`, `category`, `actor`,
`property_id`, `price_upx`, `from_account`, `to_account`.

## Acceptance tests

- `tests/acceptance/issue-1/test_csv_export.py` (this directory) — public
  suite, runs in `make test` and `make test-coverage` via
  `cd apps/api && uv run pytest`. It seeds a temp database with 10,000
  deterministic actions, signs its requests the way the web tier does, and
  checks: a `text/csv` response; an attachment named `upland-actions.csv`;
  `test_headers` (the 13 columns, in order); exactly 10,000 data rows in
  strictly increasing `global_sequence`; 13 fields per row with an ISO 8601
  `timestamp` and an integer `block_num`; the whole export in under 3 seconds.
- Criterion 2 is a browser check, in the E2E suite (`make e2e`): the export
  button shows on `/apps/data` while `csv_export` is on and is gone while it
  is off.
- The private suite (G5) additionally probes: export behaviour when the
  `csv_export` flag is off, formula-injection safety of the text cells a
  contract controls (accounts and decoded fields), and streaming
  back-pressure on a slow client.

## Scope

```forge-scope
in:
- apps/api/src/forge_api/routers/upland.py
- apps/api/src/forge_api/services/upland/analytics.py
- apps/web/src/app/apps/data/**
out:
- contracts/**
- .github/**
- tests/acceptance/**
- apps/api/src/forge_api/services/identity.py
```

DEPS: none new — CSV generation must use the Python stdlib `csv` module.

## Context pack

- the Task Spec issue template (`.github/ISSUE_TEMPLATE/task-spec.yml`)
- `apps/api/README.md` (layout: thin routers, logic in `services/`)
- `apps/api/src/forge_api/services/upland/db.py` (the `actions` table) and
  `scraper.py` (`process_action` and `store_and_update`, which fill it)
- `config/flags.json` + `apps/api/src/forge_api/services/flags.py` (flag lookup)
- `apps/web/src/lib/upland-api.ts` (`uplandExportUrl()`: the browser downloads
  through the same-origin BFF at `/bff/upland/export`, never from the API)

## Size / tier floor / reward

Size `S` · tier floor `T0` · reward class `none`.
