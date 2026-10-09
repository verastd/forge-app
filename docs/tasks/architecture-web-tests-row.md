# Task Spec: the module map stops saying apps/web has no unit tests

Issue: not yet posted.

## Goal

`docs/architecture.md`'s row for `apps/web` describes the unit-test runner
it now has, says plainly that `apps/web` is still outside the changed-line
coverage gate and why, and the same correction reaches every other place
the docs repeat the old claim.

## Civilian summary

Fix the architecture document where it still says the web app has no unit
tests, now that it does.

## Acceptance criteria

1. The `apps/web` row's stability cell names vitest (`apps/web/vitest.config.mts`,
   `pnpm --filter @forge/web test`) and the suites that exist today under
   `src/app/apps/ledger/_lib/`, and no longer says "no unit-test runner".
2. The row states that `apps/web` remains exempt from the changed-line
   coverage gate because `tools/forge/coverage-gate.sh` enforces
   `packages/*` and `apps/api` only, and that adding it is a core-team
   change to that script, not a doc change.
3. `grep -rn "no unit-test runner" docs README.md CONTRIBUTING.md` finds
   nothing, and `make lint` passes.

## Acceptance tests

`tests/acceptance/issue-<N>/test_web_tests_row.py` (committed by the spec
author, pytest, skipped until the row no longer contains "no unit-test
runner"): the phrase is gone from the docs, the row names the vitest
config and the exemption's reason, and the config file it names exists.

## Scope

```forge-scope
in:
- docs/architecture.md
- README.md
- CONTRIBUTING.md
out:
- tools/forge/**
- .github/**
```

DEPS: none new.

## Context pack

- `docs/architecture.md`, module map, the `apps/web` row.
- `apps/web/vitest.config.mts` and `apps/web/package.json`'s `test`
  script.
- `tools/forge/coverage-gate.sh`: the enforced roots, read-only for this
  task.

## Size class

XS

## Tier floor

T0

## Reward class

none
