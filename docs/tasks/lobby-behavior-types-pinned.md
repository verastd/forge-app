# Task Spec: pin the behaviour kernel's public types

Issue: not yet posted.

## Goal

The shapes the scene, the feeds and the future world participant code
against (`BehaviorEntry`, `BehaviorBudget`, `BehaviorStates`, `Entity`,
`Claim`, `World`) are pinned in `packages/lobby/src/index.test.ts` with
`expectTypeOf`, the way the lobby's other public types are, so a change to
them is a visible diff in the export test rather than a silent break in a
consumer.

## Civilian summary

Write down the exact shape of the lobby's new building blocks in the test
that already guards the rest, so nobody changes them by accident.

## Acceptance criteria

1. `packages/lobby/src/index.test.ts`'s "keeps its types" case gains
   `expectTypeOf` pins for `BehaviorEntry`, `BehaviorBudget`,
   `BehaviorStates`, `BehaviorStateName`, `Entity`, `Authority`, `Claim` and
   `World`, each written out in full as the other pins are.
2. `BEHAVIOR_STATES` is pinned as the exact six-element tuple, and
   `CELLS` as `{ sectors: 8, bands: 4 }`, so a change to either is a
   deliberate edit here.
3. `pnpm --filter @forge/lobby typecheck` and `test` pass. This task edits
   an existing test on purpose; the Gauntlet's tests-modified flag is
   expected, and the reviewer checks that nothing was weakened.

## Acceptance tests

`tests/acceptance/issue-<N>/test_behavior_types_pinned.py` (committed by
the spec author, pytest, skipped until `index.test.ts` mentions
`expectTypeOf<BehaviorEntry>`): each named type has a pin, the states tuple
and the cells constant are pinned, and no existing pin was removed (the
count of `expectTypeOf<` calls is at least the count on `main` today plus
the ten this task adds).

## Scope

```forge-scope
in:
- packages/lobby/src/index.test.ts
out:
- packages/lobby/src/behaviors/**
- packages/lobby/src/index.ts
```

DEPS: none new.

## Context pack

- `packages/lobby/src/index.test.ts`, "keeps its types": the pattern.
- `packages/lobby/src/behaviors/`: the types as declared.
- `docs/adr/ADR-009-shared-behaviours.md`: why these shapes are the
  contract.

## Size class

XS

## Tier floor

T0

## Reward class

none
