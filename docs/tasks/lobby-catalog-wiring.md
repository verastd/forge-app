# Task Spec: register catch, throw and wave in the behaviour catalog

Issue: [verastd/forge-app#48](https://github.com/verastd/forge-app/issues/48) (draft until its acceptance tests merge and it is labelled `agent-ready` + `status:open`).

## Goal

The lobby's three shipped behaviours (wave, catch, throw) are entries in
`@forge/lobby`'s behaviour catalog, so their budgets and visible states are
declared data the kernel enforces rather than constants spread through the
scene.

## Civilian summary

Give the lobby one list of everything a robot can do, so each new trick comes
with its own speed limit and its own on-screen feedback.

## Acceptance criteria

1. Every action kind the lobby sends today (`wave`, `ball`, `throw`, `catch`)
   is an intent of exactly one entry in `BEHAVIORS`
   (`packages/lobby/src/behaviors/catalog.ts`), `validateBehaviors(BEHAVIORS)`
   passes, each entry names the `apps_lobby` flag, and each entry's
   `budget.intentsPerSecond` equals `MAX_ACTIONS_PER_SECOND` from
   `actions.ts`.
2. The LiveKit and practice feeds (`apps/web/src/components/lobby/presence/`)
   drop an inbound action whose kind has no catalog entry, and drop one that
   exceeds its entry's `intentsPerSecond` using `createBehaviorMeter`, with a
   unit test in `packages/lobby` for the meter path and an e2e spec in
   `tests/e2e/` showing a flooded sender is ignored in the practice build.
3. `make lint`, `make test` and `make test-coverage` pass with the behaviours
   folder at or above 80% changed-line coverage.

## Acceptance tests

`tests/acceptance/issue-48/test_catalog_wiring.py` (committed by the spec
author, pytest): the catalog covers the four kinds under the lobby flag at
the wire's rate (runs now), and, once `tests/e2e/lobby-behaviors.spec.ts`
exists, that both feeds consult the catalog and meter inbound actions and
that the e2e spec floods a sender. The private suite additionally probes a
malformed action kind.

## Scope

```forge-scope
in:
- packages/lobby/src/behaviors/**
- packages/lobby/src/index.ts
- packages/lobby/src/index.test.ts
- apps/web/src/components/lobby/presence/**
- tests/e2e/lobby-behaviors.spec.ts
out:
- packages/lobby/src/actions.ts
- packages/lobby/src/play.ts
- apps/web/src/components/lobby/voice/engine.ts
```

DEPS: none new.

## Context pack

- [ADR-009](../adr/ADR-009-shared-behaviours.md): why a catalog, why budgets.
- `packages/lobby/src/behaviors/catalog.ts`, `budget.ts`: the contract and
  the meter.
- `packages/lobby/src/actions.ts`: the wire format and `acceptAction`, which
  the meter generalises (keep `acceptAction` working; the feeds may call
  either).
- `apps/web/src/components/lobby/presence/localFeed.ts`: the practice build's
  feed, which e2e can drive with two tabs.

## Size class

S

## Tier floor

T1

## Reward class

R2
