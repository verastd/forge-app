# FORGE root command contract (PRD Appendix A/D/H). Every target fails fast:
# each recipe line runs in its own shell and a nonzero exit aborts the
# target immediately (default `make` behavior — no `-` prefixes are used
# anywhere below). This is the same contract AGENTS.md documents to the
# swarm and CI runs verbatim (see .github/workflows/gauntlet.yml).

.PHONY: setup setup-ci lint test test-coverage build e2e package

# Full one-command environment bootstrap: the pnpm workspace (apps/web +
# packages/*) and the Python API (apps/api, via uv).
#
# The second line is not optional: packages/flags (and apps/web) resolve
# @forge/shared through packages/shared/dist/index.d.ts, which only exists
# after a build. Without it `make setup && make lint` fails on a fresh clone
# — the exact flow AGENTS.md documents. Building only packages/* keeps this
# cheap; apps/web is built by `make build`.
setup:
	pnpm install && (cd apps/api && uv sync)
	pnpm --filter './packages/*' -r --if-present run build

# CI bootstrap: same two surfaces as `setup`, but lockfile-frozen so a
# runner can never silently resolve a dependency the PR did not commit
# (G1.4's no-new-deps gate is meaningless if installs can drift). Used by
# .github/actions/setup, i.e. by every Gauntlet job that runs a make target.
setup-ci:
	pnpm install --frozen-lockfile && (cd apps/api && uv sync --locked)
	pnpm --filter './packages/*' -r --if-present run build

# Lint + typecheck everything: workspace packages (if they define the
# script) and the Python API (ruff + mypy).
lint:
	pnpm -r --if-present run lint && pnpm -r --if-present run typecheck && (cd apps/api && uv run ruff check . && uv run mypy src)

# Full test suite: workspace packages and the Python API (pytest).
test:
	pnpm -r --if-present run test && (cd apps/api && uv run pytest)

# Same suites as `test`, plus coverage reports in the exact shapes
# tools/forge/coverage-gate.sh consumes: istanbul JSON at
# <pkg>/coverage/coverage-final.json for every JS surface and Cobertura XML
# at apps/api/coverage.xml for the Python one. The Gauntlet runs this rather
# than `test` so G2.2 has something to measure; nothing else should depend on
# the reports, and they are not committed.
test-coverage:
	pnpm -r --if-present run test:coverage && (cd apps/api && uv run pytest --cov=forge_api --cov-report=xml --cov-report=term)

# Build everything. The Python API has no build step; importing the
# top-level module is used as a smoke check that the package is sane.
build:
	pnpm -r --if-present run build && (cd apps/api && uv run python -c "import forge_api.main")

# End-to-end tests against apps/web via Playwright.
e2e:
	cd apps/web && pnpm exec playwright test

# Build, then package build artifacts into a single tarball for the
# Gauntlet to upload (G5/G6). --ignore-failed-read makes this tolerant of
# paths that don't exist yet (e.g. before apps/api has any src/, or before
# a given package has a dist/) instead of failing the whole target.
# .next/cache is webpack's local build cache, not a deployable artifact —
# excluding it keeps the Gauntlet artifact ~10x smaller.
package: build
	tar -cf dist.tar --ignore-failed-read --exclude='apps/web/.next/cache' apps/web/.next apps/api/src packages/*/dist

# Local dev servers (convenience only — not part of the Gauntlet):
#   web: pnpm --filter @forge/web dev
#   api: cd apps/api && uv run uvicorn forge_api.main:app --reload --port 8000
