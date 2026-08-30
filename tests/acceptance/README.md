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
