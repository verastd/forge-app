#!/usr/bin/env bash
# test-mod-detector.sh — Gauntlet G2.4: tests-modified alarm.
#
# Usage: tools/forge/test-mod-detector.sh <BASE_REF>
#
# Diffs HEAD against the merge-base with BASE_REF, restricted to the CANONICAL
# TEST LOCATIONS. Modified-or-Deleted (M/D) files are flagged; Added files are
# explicitly ignored, since new tests are expected and welcome. Deleting or
# weakening existing tests is the #1 reward-hacking vector (PRD §5 T4), so any
# hit here is a NEUTRAL FLAG, not a hard failure: exit 78 signals
# "flag, don't block" to the calling workflow (see gauntlet.yml's
# continue-on-error handling of this script), which should still route the PR
# to mandatory extra human scrutiny (flag:test-change).
#
# The location list is no longer compiled into this script. It is declared by
# the governed repo itself in `.github/forge-protocol.json` (`testGlobs`), and
# both detectors read that one file: this script reads it at the MERGE-BASE
# (working-tree fallback only while the manifest is being introduced — see the
# resolution order below), and the Foreman App reads the default branch's copy
# over the GitHub Contents API when it runs G0, falling back to its compiled-in
# list only if that fetch fails. One declaration, two consumers, nothing to
# hand-sync — a path one side watches and the other does not is a detection
# hole, and that hole gets much easier to open once the two live in different
# repos.
#
# Watching only tests/ (the pre-repair behaviour) missed every suite that
# actually guards the product: apps/api/tests, the co-located package tests,
# and the runner configs that decide which of them
# execute at all. Runner configs count as tests: silencing vitest.config.ts or
# playwright.config.ts disables a suite as effectively as deleting it, and
# apps/api/pyproject.toml carries [tool.pytest] and [tool.coverage], so
# excluding lines there silences the API suite and the changed-line gate as
# effectively as deleting a test.

set -euo pipefail

BASE_REF="${1:-}"

if [[ -z "${BASE_REF}" ]]; then
  echo "test-mod-detector: usage: $0 <BASE_REF>" >&2
  exit 2
fi

MANIFEST=".github/forge-protocol.json"

if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  git fetch origin "${BASE_REF#origin/}" --depth=1 2>/dev/null || \
    git fetch origin 2>/dev/null || true
fi

if ! MERGE_BASE="$(git merge-base "${BASE_REF}" HEAD 2>/dev/null)"; then
  echo "test-mod-detector: could not compute a merge-base against '${BASE_REF}' — falling back to a direct diff against '${BASE_REF}'." >&2
  MERGE_BASE="${BASE_REF}"
fi

# CANONICAL TEST LOCATIONS, loaded from the manifest. The resolution order is a
# SECURITY property, not a convenience — keep it in this order:
#
#   1. the manifest AS OF THE MERGE-BASE. Reading the base revision is what
#      stops a PR from weakening its own detection: a diff that shortens
#      `testGlobs` in the same push is still judged by the list that was in
#      force before it. Whenever the base has a manifest, the base wins.
#   2. the working-tree file, if and ONLY if the merge-base has none — the
#      introduction window (PRs whose base predates this file, plus fresh local
#      checkouts). Safe precisely because there is nothing to weaken: measured
#      against an empty base list a working-tree manifest can only ADD
#      coverage, and the compiled-in list this replaced is gone either way.
#   3. neither, or a manifest we cannot trust → exit 2. Fail closed: an
#      unreadable protocol contract is not a permissive one, and exiting 0 here
#      would assert "no tests were touched" on the strength of a broken file.
#
# `git show` is run under `if !` (never bare) so a missing file cannot kill the
# script through `set -e` before the fallback gets its turn. Existence at the
# base revision is probed separately with `cat-file -e`, so "no manifest at the
# base" (fall back) stays distinguishable from "the base manifest is there but
# unreadable" (a real error — never silently reach for the working tree, which
# is the PR's own copy).
if git cat-file -e "${MERGE_BASE}:${MANIFEST}" 2>/dev/null; then
  if ! manifest_json="$(git show "${MERGE_BASE}:${MANIFEST}")"; then
    echo "test-mod-detector: ${MANIFEST} exists at merge-base ${MERGE_BASE} but could not be read." >&2
    exit 2
  fi
  manifest_source="${MANIFEST} at merge-base ${MERGE_BASE}"
elif [[ -f "${MANIFEST}" ]]; then
  if ! manifest_json="$(cat "${MANIFEST}")"; then
    echo "test-mod-detector: ${MANIFEST} exists in the working tree but could not be read." >&2
    exit 2
  fi
  manifest_source="${MANIFEST} in the working tree (no manifest at merge-base ${MERGE_BASE})"
else
  echo "test-mod-detector: no ${MANIFEST} at merge-base ${MERGE_BASE} or in the working tree." >&2
  echo "test-mod-detector: this repo must declare its canonical test locations there before G2.4 can run — see the Foreman protocol contract." >&2
  exit 2
fi

# Parsing is python3 stdlib only — same no-extra-deps CI stance as the sibling
# gates, and .github/actions/setup guarantees python3. Validation is deliberately
# strict: a manifest we only half understand is exactly the case where failing
# open would be silent. `version` is the forward-compat lever — an unknown
# version means THIS SCRIPT is out of date, and it says so rather than guessing
# at a schema it has never seen. (Only `testGlobs` is consumed here;
# `protectedPaths` is the Foreman App's half of the contract.)
if ! globs_out="$(printf '%s' "${manifest_json}" | python3 -c '
import json
import sys

MANIFEST = ".github/forge-protocol.json"

try:
    doc = json.load(sys.stdin)
except ValueError as exc:
    sys.exit("test-mod-detector: %s is not valid JSON: %s" % (MANIFEST, exc))

if not isinstance(doc, dict):
    sys.exit("test-mod-detector: %s must hold a JSON object at the top level." % MANIFEST)

version = doc.get("version")
if isinstance(version, bool) or not isinstance(version, int) or version != 1:
    sys.exit(
        "test-mod-detector: %s declares version %r; this script only speaks version 1, "
        "so it is too old for this manifest. Update tools/forge/test-mod-detector.sh."
        % (MANIFEST, version)
    )

globs = doc.get("testGlobs")
if not isinstance(globs, list) or not globs:
    sys.exit("test-mod-detector: %s must declare a non-empty testGlobs array." % MANIFEST)

for entry in globs:
    if not isinstance(entry, str) or not entry.strip():
        sys.exit(
            "test-mod-detector: %s has a testGlobs entry that is not a non-empty string: %r"
            % (MANIFEST, entry)
        )
    # One glob per line is the contract with the bash side, so an entry carrying
    # a newline would arrive there as two pathspecs. Rejected by construction.
    if "\n" in entry or "\r" in entry:
        sys.exit(
            "test-mod-detector: %s has a testGlobs entry containing a newline: %r"
            % (MANIFEST, entry)
        )

sys.stdout.write("".join(entry + "\n" for entry in globs))
')"; then
  echo "test-mod-detector: ${manifest_source} is not a usable protocol manifest (see the message above)." >&2
  exit 2
fi

mapfile -t TEST_GLOBS <<<"${globs_out}"

# Every entry becomes a `:(glob)` pathspec, uniformly. `:(glob)` makes `**`
# path-aware, so `*` cannot swallow a directory separator; a literal path with
# no wildcards is still a valid `:(glob)` pathspec that matches itself, so
# there is no second code path here to get subtly wrong.
TEST_PATHS=()
for glob in "${TEST_GLOBS[@]}"; do
  TEST_PATHS+=(":(glob)${glob}")
done

# --diff-filter=MD: Modified or Deleted only. Added files are excluded by
# construction (no "A" in the filter) -- new tests never trip this alarm.
#
# --no-renames: without it, a suite MOVED out of a canonical location is
# reported as a single R entry at its new path, which matches none of the
# pathspecs above -- the suite disappears from every runner and the alarm stays
# silent. With it the same move is D(old) + A(new): the D trips the M/D filter
# and names the path that left, and the A is ignored the way any new test is.
#
# A git failure here is an operator error (2), NOT an all-clear. This used to
# end in `|| true`, which was safe only while the pathspecs were compiled in:
# now that they come from a file, one malformed entry (bad pathspec magic, a
# path outside the repo) would make git exit non-zero, print nothing, and hand
# us an empty list indistinguishable from "no tests were touched" — the alarm
# silenced by editing the manifest. git's own stderr passes straight through to
# the job log, which is what the operator needs to see.
modified=()
if ! diff_out="$(git diff --name-only --no-renames --diff-filter=MD "${MERGE_BASE}" -- "${TEST_PATHS[@]}")"; then
  echo "test-mod-detector: git diff against '${MERGE_BASE}' failed with the pathspecs from ${manifest_source} — the alarm could NOT be evaluated (this is not an all-clear)." >&2
  exit 2
fi
if [[ -n "${diff_out}" ]]; then
  mapfile -t modified <<<"${diff_out}"
fi

if [[ "${#modified[@]}" -eq 0 ]]; then
  echo "test-mod-detector: no existing tests were modified or deleted. OK."
  exit 0
fi

echo "gauntlet: FLAG G2.4 — existing tests modified: ${modified[*]}"
exit 78
