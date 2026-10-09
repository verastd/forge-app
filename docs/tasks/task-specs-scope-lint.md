# Task Spec: a test that keeps every Task Spec's scope block parseable

Issue: not yet posted.

## Goal

Every file in `docs/tasks/` (other than its README) is checked by `make
test` to carry exactly one `forge-scope` block that Foreman can read, whose
`in:` globs reach no protected path, under the issue template's headings,
so a spec can't be posted with the block that would close its contributors'
pull requests at G0.3.

## Civilian summary

Make the computer check every task description before it is published, so a
typo in one can't get a contributor's work thrown out.

## Acceptance criteria

1. `apps/api/tests/test_task_specs.py` loads `tools/forge/protocol-check.py`
   the way `test_protocol_check.py` does and, for each `docs/tasks/*.md`
   except `README.md`, asserts `parse_scope` succeeds, the block has at
   least one `in:` glob, and no `in:` glob is itself a protected path or
   lies under a protected directory from `.github/forge-protocol.json`.
2. The same test asserts each spec has the headings `## Goal`,
   `## Civilian summary`, `## Acceptance criteria`, `## Acceptance tests`,
   `## Scope`, `## Size class`, `## Tier floor` and `## Reward class`, that
   the size is `XS`, `S` or `M`, the tier `T0`, `T1` or `T2`, and the
   reward `none` or `R1` to `R4`.
3. A spec that breaks any rule fails the test naming the file and the
   rule, proved by a negative case over a temporary file, and `make lint`
   and `make test` pass.

## Acceptance tests

`tests/acceptance/issue-<N>/test_task_specs_lint.py` (committed by the spec
author, pytest, skipped until `apps/api/tests/test_task_specs.py` exists):
the test file loads the protocol check and names the eight headings, and
the five specs on `main` today pass the same rules when applied here.

## Scope

```forge-scope
in:
- apps/api/tests/test_task_specs.py
- docs/tasks/**
out:
- tools/forge/**
- .github/**
```

DEPS: none new.

## Context pack

- `tools/forge/protocol-check.py`: `parse_scope`, `glob_pattern`,
  `is_protected`.
- `apps/api/tests/test_protocol_check.py`: how the tool is loaded by path
  and exercised.
- `.github/ISSUE_TEMPLATE/task-spec.yml`: the headings and the enums.
- `docs/tasks/README.md`: why specs live in the repo first.

## Size class

S

## Tier floor

T0

## Reward class

R1
