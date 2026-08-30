#!/usr/bin/env bash
# check-lockfile-diff.sh — Gauntlet G1.4: no new dependencies without spec
# pre-approval (PRD §4 Stage 5 constraint, §5 T1/T3 mitigation).
#
# Usage: tools/forge/check-lockfile-diff.sh <BASE_REF>
#
# Compares pnpm-lock.yaml and apps/api/uv.lock against the merge-base with
# BASE_REF. If any lockfile changed and the
# environment variable DEP_APPROVED is not exactly "1", this fails the
# Gauntlet with a machine-readable reason. Lockfiles that don't exist yet
# (early in the repo's life) are silently skipped, not treated as errors.
#
# DEP_APPROVED is set by gauntlet.yml from the `deps-approved` PR label — the
# machine-readable form of an issue's DEPS pre-approval. Without that wiring
# the escape hatch below is unreachable and a spec-approved dependency can
# never merge, so the label and this variable must stay connected.

set -euo pipefail

BASE_REF="${1:-}"

if [[ -z "${BASE_REF}" ]]; then
  echo "check-lockfile-diff: usage: $0 <BASE_REF>" >&2
  exit 2
fi

LOCKFILES=(
  "pnpm-lock.yaml"
  "apps/api/uv.lock"
)

# Make sure we actually have BASE_REF locally (shallow CI checkouts often
# don't). Best-effort: if this fails, fall through and let the merge-base
# lookup below handle it.
if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  git fetch origin "${BASE_REF#origin/}" --depth=1 2>/dev/null || \
    git fetch origin 2>/dev/null || true
fi

if ! MERGE_BASE="$(git merge-base "${BASE_REF}" HEAD 2>/dev/null)"; then
  echo "check-lockfile-diff: could not compute a merge-base against '${BASE_REF}' — falling back to a direct diff against '${BASE_REF}'." >&2
  MERGE_BASE="${BASE_REF}"
fi

changed=()
for lockfile in "${LOCKFILES[@]}"; do
  # Tolerate lockfiles that don't exist at either revision yet.
  if ! git cat-file -e "${MERGE_BASE}:${lockfile}" 2>/dev/null && [[ ! -f "${lockfile}" ]]; then
    continue
  fi

  if ! git diff --quiet "${MERGE_BASE}" -- "${lockfile}" 2>/dev/null; then
    changed+=("${lockfile}")
  fi
done

if [[ "${#changed[@]}" -eq 0 ]]; then
  echo "check-lockfile-diff: no lockfile changes vs ${BASE_REF}. OK."
  exit 0
fi

if [[ "${DEP_APPROVED:-}" == "1" ]]; then
  echo "check-lockfile-diff: lockfile(s) changed (${changed[*]}), but DEP_APPROVED=1 — treating as pre-approved per issue Scope/DEPS section."
  exit 0
fi

echo "gauntlet: FAIL G1.4 — lockfile changed without dependency pre-approval: ${changed[*]}"
exit 1
