# Task Spec: a test that locks the task fixtures' mirror

Issue: not yet posted.

## Goal

The web app's copy of the starter tasks (`apps/web/src/lib/fixtures.ts`,
`TASK_FIXTURES`) is proved identical to the API's
(`apps/api/src/forge_api/fixtures/tasks.json`) by a test that runs in
`make test`, so the two can no longer drift apart unnoticed.

## Civilian summary

Make sure the practice app and the real app always show the same eight
starter tasks, with a test that fails the moment they differ.

## Acceptance criteria

1. `apps/web/src/lib/fixtures.test.ts` reads `tasks.json` from disk at test
   time and asserts `TASK_FIXTURES` deep-equals it, field for field and in
   order, after stripping any key the web copy is documented not to carry.
2. The test fails when one side changes: proved by the test's own negative
   case (a cloned fixture with one field altered is reported as different,
   naming the task id and the field).
3. `apps/web`'s `pnpm test` (vitest) runs it, and `make lint` and `make test`
   pass.

## Acceptance tests

`tests/acceptance/issue-<N>/test_fixtures_mirror.py` (committed by the spec
author, pytest, skipped until `apps/web/src/lib/fixtures.test.ts` exists):
the test file reads `tasks.json` and uses a deep equality, and the two
sources agree today by a Python comparison of the JSON against the ids and
titles in the TypeScript. The private suite additionally mutates one field
and expects the vitest to fail.

## Scope

```forge-scope
in:
- apps/web/src/lib/fixtures.test.ts
- apps/web/src/lib/fixtures.ts
out:
- apps/api/src/forge_api/fixtures/**
- apps/web/src/lib/api.ts
```

DEPS: none new.

## Context pack

- `apps/web/src/lib/fixtures.ts`, header: the mirror rule, "Keep them
  identical", and why there was no test.
- `apps/api/src/forge_api/fixtures/tasks.json`: the source of truth; a
  protected path, which is why it is out of scope.
- `apps/web/vitest.config.mts` and the existing tests under
  `apps/web/src/app/apps/ledger/_lib/`: how a web unit test is written and
  run here.
- `verastd/forge`'s `docs/HANDOFF.md` named this "a strong first community
  Task Spec": small, verifiable, real.

## Size class

XS

## Tier floor

T0

## Reward class

R1
