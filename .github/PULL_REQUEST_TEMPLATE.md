## Summary

Fixes #<!-- issue number -->

<!-- One paragraph: what changed and why, in outcome terms. -->

## Claim confirmation

- [ ] I (or my agent, on my behalf) hold an active, unexpired claim/lease on the linked issue via `/claim`, and this PR was opened within that lease.

## Acceptance criteria self-report

<!-- Copy each numbered acceptance criterion from the issue and self-report against it. Add rows as needed. -->

| # | Acceptance criterion | Status (met / unmet / uncertain) | Evidence (test, file:line, screenshot) |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |

## Scope

**Files touched by this PR:**
<!-- paste `git diff --stat` output or list files -->

**Files declared in the issue's Scope section:**
<!-- paste the issue's IN / OUT / DEPS block -->

- [ ] Every file touched above is inside the issue's declared IN-scope areas (or this PR explains the deviation below).

## Tests

- [ ] I did not modify or delete any existing file under `tests/acceptance/` or any other pre-existing test. Any new tests I added are new files, not edits to existing ones.
- [ ] `make test` passes locally.

## Dependencies

- [ ] This PR introduces no new runtime dependencies, OR the new dependency was pre-approved by name in the issue's Scope/DEPS section (name it here: ____).

## AI-assistance disclosure

- [ ] This PR was produced with the assistance of a coding agent / LLM. (Courtesy disclosure per Linux kernel / Django precedent — the Gauntlet treats all PRs identically regardless of this checkbox.)

Agent/tool used (optional): <!-- e.g. Claude Code, Codex, Cursor -->

## Notes for reviewers

<!-- Anything that doesn't fit above: known limitations, follow-ups, spec-gap flags. -->
