#!/usr/bin/env bash
# coverage-gate.sh — Gauntlet G2.2: coverage floor on the lines this PR changed.
#
# Usage: tools/forge/coverage-gate.sh --changed-lines <N> [--base <REF>]
#
# Diffs merge-base(BASE, HEAD)..working tree and requires that at least N% of
# the added/modified lines in enforced source roots are covered by the reports
# `make test-coverage` produces. BASE defaults to origin/main; the Gauntlet
# passes the event-correct base (PR base ref, or the merge group's base sha).
#
# Fail-closed by design: if a root has changed source lines and its report is
# missing, that is a FAIL, not a skip. The previous version of this script
# checked TOTAL coverage and passed when no report existed at all, which made
# G2.2 unfalsifiable. All parsing lives in changed_line_coverage.py (stdlib
# only); this wrapper owns the CLI surface and base-ref availability.

set -euo pipefail

CHANGED_LINES_THRESHOLD=""
BASE_REF="origin/main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --changed-lines)
      CHANGED_LINES_THRESHOLD="${2:-}"
      shift 2
      ;;
    --changed-lines=*)
      CHANGED_LINES_THRESHOLD="${1#*=}"
      shift
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --base=*)
      BASE_REF="${1#*=}"
      shift
      ;;
    *)
      echo "coverage-gate: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${CHANGED_LINES_THRESHOLD}" || -z "${BASE_REF}" ]]; then
  echo "coverage-gate: usage: $0 --changed-lines <N> [--base <REF>]" >&2
  exit 2
fi

# Shallow CI checkouts often lack the base ref. Best-effort, same as the
# sibling gates: if this fails, the Python side falls back to a direct diff.
if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  git fetch origin "${BASE_REF#origin/}" --depth=1 2>/dev/null || \
    git fetch origin 2>/dev/null || true
fi

exec python3 "$(dirname "$0")/changed_line_coverage.py" \
  --changed-lines "${CHANGED_LINES_THRESHOLD}" \
  --base "${BASE_REF}"
