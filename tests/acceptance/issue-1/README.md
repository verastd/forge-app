# Task Spec — Issue #1: CSV export of activity history

Committed by the spec author (core team) per `tests/acceptance/README.md`.
Contributors implement against this file and **must not modify it**
(PRD §5 T4 — G0 auto-closes out-of-scope edits, G2.4 flags any test change).

Format: PRD Appendix B (Task Spec issue template).

## Goal

Users can export their full activity history as a CSV file from the history
page, without waiting on it.

## Civilian summary

Download everything you've done in the app as a spreadsheet file.

## Acceptance criteria

1. `GET /api/export` returns `text/csv` with columns `[ts, type, amount]` — the
   first line is exactly `ts,type,amount` — and an attachment
   `Content-Disposition` naming `history.csv`.
2. The export contains every history row (10,000 in the fixture data set), with
   every `ts` parseable as ISO 8601, every `type` one of `earn|spend|transfer`,
   and every `amount` a number.
3. A 10k-row export completes in under 3 seconds against CI fixture data.

## Acceptance tests

- `tests/acceptance/issue-1/test_csv_export.py` (this directory) — public suite,
  runs in `make test` via `cd apps/api && uv run pytest`.
- The private suite (G5) additionally probes: export behaviour when the
  `csv_export` flag is off, header-injection safety of memo-derived fields, and
  streaming back-pressure on a slow client.

## Scope

```
IN:  apps/api/src/forge_api/routers/export.py
     apps/api/src/forge_api/services/export.py
     apps/api/src/forge_api/services/history.py
     apps/web/app/history/**  (the Export button, behind flag csv_export)
OUT: auth, payments, anything under contracts/, anything under .github/,
     any existing directory under tests/acceptance/
DEPS: none new — CSV generation must use the Python stdlib `csv` module.
```

## Context pack

- the Task Spec issue template (`.github/ISSUE_TEMPLATE/task-spec.yml`)
- `apps/api/README.md` (layout: thin routers, logic in `services/`)
- `config/flags.json` + `apps/api/src/forge_api/services/flags.py` (flag lookup)

## Size / tier floor / reward

Size `S` · tier floor `T0` · reward class `none`.
