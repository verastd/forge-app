# tests/acceptance/

Acceptance tests are the load-bearing element of every Task Spec (PRD §4
Stage 1.3). The pattern:

- Each task gets its own directory: `tests/acceptance/issue-<N>/`.
- These tests are **committed by the spec author** (core team, or a T3
  steward once spec-authoring delegation is live) — never by the
  contributor implementing the fix. For bugfixes, the test is committed
  *failing*, and must pass post-patch. For features, this is the
  executable spec (Playwright/pytest) the implementation must satisfy.
- Contributors — and their agents — implement against these tests but
  **must never create, modify, or delete anything under an existing
  `tests/acceptance/issue-<N>/` directory.** New unit tests for your own
  changes belong elsewhere in the tree.

## Feature tasks: skipped until the work exists, never failing on `main`

A bugfix's acceptance test is committed failing and turns green with the
patch. A feature's cannot be: `make test` runs every directory here on every
pull request, so a failing feature test would turn `main` red for everyone.
The pattern for a feature, from issue #48 on:

- The directory's tests import `skip_until(issue, artefact, ...)` from
  `tests/acceptance/_shared.py` and name an artefact the implementation has
  to create and that the task's Scope puts in the contributor's hands (its
  e2e spec, its package manifest). While the artefact is missing the tests
  are skipped with the issue number in the reason; the pull request that
  creates it is the one whose Gauntlet run executes them.
- Criteria that are already true of `main` (the catalog's contents, say)
  are not skipped: they run now and guard against regression.
- **A pull request that leaves its own task's acceptance tests skipped has
  not met the spec**, whatever else is green: the artefact is a criterion,
  and the reviewer reads the skip count on the run.
- These tests are pytest, because pytest is what the Gauntlet runs for this
  directory. Where a criterion is behaviour in the browser, the task names a
  Playwright spec under `tests/e2e/` (which `make e2e` runs) and the
  acceptance test checks that spec exists and covers the named flows; the
  private suite does the rest.

## Why this is enforced, not just requested

Deleting or weakening tests is the #1 reward-hacking vector (PRD §5 T4,
§13 — SWE-bench+/UTBoost found roughly 31% of "passing" agent patches
gamed weak or known tests). Two independent layers catch violations:

- **G0 (Foreman protocol check):** a PR that touches an existing
  `tests/acceptance/` path outside its own declared scope is auto-closed.
- **G2 (tests-modified alarm):** `tools/forge/test-mod-detector.sh` flags
  any PR that modifies or deletes an existing file anywhere under
  `tests/`, routing it to mandatory extra human scrutiny
  (`flag:test-change`) even if the rest of the Gauntlet is green.

See `AGENTS.md` (repo root) for the contributor-facing version of this
rule, and `docs/architecture.md` ("The contribution pipeline") for the
Gauntlet layer overview.
