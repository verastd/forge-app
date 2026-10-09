# ADR-010: The protocol gate runs locally — `forge check`, and what Foreman owes a contributor

Why the rules Foreman closes a pull request with are now something a
contributor runs on their own branch before pushing, with the rule and the
manifest version behind every verdict, and what remains for Foreman itself.
Decided with the operator on 2026-10-09.

## Status

Accepted for `forge check` (`tools/forge/protocol-check.py`), which ships
with this ADR. The commitments under *Foreman* are the operator's to keep and
are listed so they can be checked.

## Context

FORGE's pitch is that nobody has to trust anybody: scoped tasks, acceptance
tests the implementer never writes, a Gauntlet anyone can read, review by a
human. One piece asked for trust instead of offering proof. Foreman, the
GitHub App that closes a pull request at G0, labels a task `spec:invalid`,
records a strike and keeps the agent-rail allowlist, runs from a private
repository: "its source is not in this repo" (`architecture.md`). The rules
were public, in `AGENTS.md` and `CONTRIBUTING.md`. The code that applied them
was not, and the only way to learn what Foreman would say about a diff was to
open the pull request and take the strike.

The Gauntlet never had this problem: its gate scripts are in `tools/forge`
and its workflows in `.github`, so a contributor can read exactly what will
run against them. The Bridge's Send for review already applied Foreman's
size, protected-path and tests-modified rules before opening a pull request
(`services/copies.py`, ADR-008), which proved those rules could be stated
outside Foreman, but only for contributors going through the Bridge.

## Decision

**Every rule Foreman can apply to a diff is applied locally too, by a script
in the repo, with the same grammar.** `tools/forge/forge check` runs
`protocol-check.py` against the working tree's diff from the merge-base with
`origin/main`, untracked files included, and reports each rule with its
Foreman name:

| Rule | Verdict | What it checks |
|---|---|---|
| G0.0 bot author | skip | only Foreman knows the agent-rail allowlist |
| G0.1 claim linkage | skip | only Foreman holds the leases |
| G0.2 scope fencing | fail | a changed path outside the task's `in:` globs or inside its `out:` globs (`--scope` gives the issue text) |
| G0.3 scope block | fail | the `forge-scope` block missing or malformed: the no-strike `spec:invalid` close |
| G0.4 diff size | fail | 300 or more files, or more than 20,000 changed lines |
| G0.5 protected paths | fail | any change under the manifest's `protectedPaths` |
| G0.6 acceptance tests | fail | anything created, changed or removed under `tests/acceptance/` |
| G2.4 tests modified | flag | an existing test under `testGlobs` modified or deleted; `--strict` fails it, as Send for review does |
| G1.4 dependencies | flag | a lockfile or dependency manifest changed: needs `deps-approved` |
| P.3 branch name | flag | not `task/<issue>-<slug>` |
| P.8 title | fail | `--title` given and not `[#<issue>] <goal>` |

Exit 0 passes (flags allowed), 1 fails, 2 could not evaluate. An unreadable
rule set is never a pass: no git, no manifest, or a manifest version this
script does not speak all exit 2.

**The grammars are Foreman's, not approximations.** Globs read as minimatch
and git's `:(glob)` pathspecs both read them: `*` and `?` within a segment,
`**` as a whole segment, and anything the two could disagree on (braces,
classes, escapes, negation) counts as unreadable, the same rule
`copies.glob_pattern` applies. Protected paths are directory prefixes when
they end in `/` and exact paths otherwise. The `forge-scope` block is exactly
`in:` and `out:` headers with `- <glob>` items, and anything else is
malformed, because a malformed block fails closed at G0.3 and a contributor
should learn that before Foreman tells them.

**The manifest at the merge-base wins.** `.github/forge-protocol.json` is
read as of the merge-base when it exists there, the way
`test-mod-detector.sh` reads it, so a diff cannot weaken the rules it is
judged by. The working-tree copy is used only when the merge-base has none.

**A spec can be checked before it is an issue.** `--scope` takes any file
holding the issue's text, so the Task Specs in `docs/tasks/` fence a branch
today, and a spec's author can run the check against their own block to see
it parse.

## Foreman

Three things only Foreman can do remain on the operator's side of the line:
the allowlist, the leases, and the strikes. For those, the commitments that
make the gate auditable without opening its source:

- **Every close or strike names its rule and the manifest version**, in the
  comment Foreman posts, in the same words this script uses, so a contributor
  can run `forge check` and see the same verdict.
- **A change to the written protocol and a change to the enforcing code land
  together.** `AGENTS.md`, `CONTRIBUTING.md` and this script are the public
  half; Foreman's rule set is versioned against them, and a contributor can
  ask on any issue which version is live.
- **Foreman's source is published** when the operator judges it ready. The
  App's private key, webhook secrets and per-person strike data stay private,
  as they do for every open-source GitHub App. Until then, this script is the
  reference for what a diff will be judged on, and a disagreement between the
  two is a bug in Foreman to be fixed in Foreman.

## Consequences

- `tools/forge/forge` gains `check`; it needs git and python3, not `gh`.
  `protocol-check.py` is stdlib-only like the sibling gates, and it is **not**
  one of the four protected gate files: a contributor may improve it, and the
  Gauntlet does not run it (Foreman does the closing; this script predicts
  it).
- Its tests live in `apps/api/tests/test_protocol_check.py` so `make test`
  runs them, against throwaway git repositories.
- `CONTRIBUTING.md` tells contributors to run it before pushing, beside
  `make test-coverage`.
- A contributor who sees `FAIL G0.3` has found a broken spec, not broken work:
  the script says so and points them at `@forge-foreman spec-gap`.
