# Task Spec: move the Upland data app's build spec into docs, without the laptop paths

Issue: not yet posted.

## Goal

`UPLAND_DATA_APP_SPEC.md` lives under `docs/` as
`docs/upland-data-app-spec.md`, reads as a record of what was built rather
than instructions to port files from one person's desktop, and names no
machine-local path.

## Civilian summary

Tidy an old planning note so it reads as history, not as a to-do list that
points at someone's laptop.

## Acceptance criteria

1. `docs/upland-data-app-spec.md` exists, `UPLAND_DATA_APP_SPEC.md` does
   not, and no file in the repository contains a Windows drive path
   (`C:\`) or a home-directory path.
2. The moved document opens with a two-sentence status line saying it is the
   September 2026 build spec the Upland data app and ledger were built from,
   and that `docs/architecture.md` and `docs/upland-ledger-ui/` describe
   what shipped; the "Existing Upland scraper code to PORT/ADAPT" section
   becomes "What was ported", naming the files under
   `apps/api/src/forge_api/services/upland/` that came from it.
3. Any link to the old filename elsewhere in the repository is updated, and
   `make lint` passes.

## Acceptance tests

`tests/acceptance/issue-<N>/test_upland_spec_moved.py` (committed by the
spec author, pytest, skipped until `docs/upland-data-app-spec.md` exists):
the old path is gone, no tracked file contains `C:\` or `/Users/`, the new
file carries the status line and the "What was ported" heading, and the
files it names exist.

## Scope

```forge-scope
in:
- UPLAND_DATA_APP_SPEC.md
- docs/upland-data-app-spec.md
- README.md
- docs/architecture.md
out:
- apps/**
- packages/**
```

DEPS: none new.

## Context pack

- `UPLAND_DATA_APP_SPEC.md`: the file as it is.
- `apps/api/src/forge_api/services/upland/`: what the port became.
- `docs/upland-ledger-ui/`: the ledger's own docs.

## Size class

XS

## Tier floor

T0

## Reward class

none
