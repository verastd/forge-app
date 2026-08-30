# FORGE

FORGE is a contribution pipeline for this app. Instead of assigning work to
people and waiting, we publish a curated queue of well-specified tasks as
GitHub issues and let community members point whatever coding agent they
already use — Claude Code, Codex, Cursor, Gemini CLI, or anything else that
can read a repo and open a pull request — at the ones they want to take on.
Bring your own agent, on your own fork, on your own tokens: this repo never
runs your agent, it only judges what comes back.

Every contribution arrives the same way: a pull request from a fork. Before
a human ever looks at it, the PR passes through a protocol gate — enforced
by Foreman, a GitHub App operated by the core team — that checks it's linked
to a real claim and stays inside its task's declared scope, and then through
the Gauntlet, this repo's own CI (lint, tests, security scans, end-to-end
checks). None of that replaces a maintainer's judgment: humans keep merge
authority, and passing every check earns a PR a review, not a merge.

Rewards attach to work that gets merged and then survives a review window in
production, not to work that merely passes CI. See
[`docs/rewards.md`](docs/rewards.md) for what that means today, and
[`docs/architecture.md`](docs/architecture.md) for how the pieces fit
together.

## How to contribute

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) if you're a person, and have
your agent read [`AGENTS.md`](AGENTS.md) first — that file is its operating
manual and is authoritative for agents working in this repo.

The short version: open tasks are Task Specs — GitHub issues labeled
`agent-ready` and `status:open`, each with a goal, acceptance criteria, and a
machine-readable scope. Comment `/claim` (or run
`tools/forge/forge claim <issue-number>`) and get assigned before you start
work; a PR against a task claimed by someone else is closed regardless of
quality.

If you'd rather not leave the browser, the in-app Bridge at
[`/contribute`](apps/web/src/app/contribute) walks through the same pipeline
from a task board — pick a task, pick an agent, watch it move through
checks. It's a client for the same GitHub-native pipeline, not a shortcut
around it; see
[`docs/architecture.md`](docs/architecture.md#the-bridge) for exactly what's
wired up today versus still a stub.

## Build and run

This is a pnpm workspace (`apps/web` + `packages/*`) plus a Python API
(`apps/api`, managed with `uv`). The real `make` targets, run from the repo
root:

| Command | What it does |
|---|---|
| `make setup` | Installs the pnpm workspace and `apps/api`'s virtualenv, then builds the shared packages so cross-package imports resolve. |
| `make setup-ci` | The same, lockfile-frozen — what CI actually runs. Use it locally to reproduce a runner exactly. |
| `make lint` | eslint + `tsc --strict` across the workspace, `ruff` + `mypy --strict` for `apps/api`. |
| `make test` | The full test suite: workspace package tests plus `apps/api`'s pytest, including the per-task acceptance tests under `tests/acceptance/`. No network required. |
| `make test-coverage` | The same suites, plus the coverage reports the Gauntlet's changed-line gate reads. Run this before you push. |
| `make build` | Builds the workspace packages and sanity-checks that the API package imports. |
| `make e2e` | Playwright against `apps/web`, both the live and demo builds. |
| `make package` | Bundles the build output into a single tarball, the way the Gauntlet does for a merged PR. |

There are no other `make` targets — if a doc or an agent claims otherwise,
that's a bug, file it.

Local dev servers (not part of the Gauntlet, just for iterating):

```
pnpm --filter @forge/web dev
cd apps/api && uv run uvicorn forge_api.main:app --reload --port 8000
```

`apps/web` serves on port 3000, `apps/api` on port 8000. By default the web
app runs **live** — it talks to `apps/api` and nothing is ever faked; a
failed read shows an error and a failed write changes nothing. Building with
`NEXT_PUBLIC_FORGE_DEMO=1` produces a separate **demo** build instead, where
the app falls back to local fixtures and labels itself as practice data.
Both builds, and the difference between them, are covered in
[`docs/architecture.md`](docs/architecture.md).

## Repo map

| Path | What's there |
|---|---|
| `apps/web` | Next.js 15 (App Router, TypeScript strict): the app itself, including the [`/contribute`](apps/web/src/app/contribute) Bridge surface. |
| `apps/api` | FastAPI (Python 3.12, `uv`), package `forge_api`: the backend, and the Bridge's server-side service. See [`apps/api/README.md`](apps/api/README.md). |
| `packages/shared` | zod schemas — the reference copy of the web/API contract, hand-mirrored by `apps/api`'s Pydantic models. |
| `packages/flags` | The feature-flag client, backed by [`config/flags.json`](config/flags.json). Fails closed: code defaults are all off. |
| `packages/contracts-client` | The only module allowed to import a chain SDK; mock-only today. See [its README](packages/contracts-client/README.md). |
| `tests/e2e` | Playwright end-to-end tests, one project per build (demo and live). |
| `tests/acceptance/issue-<N>/` | Per-task acceptance tests, one directory per issue, owned by whoever wrote the Task Spec — never by whoever implements it. See [`tests/acceptance/README.md`](tests/acceptance/README.md). |
| `tools/forge` | The `forge` CLI and the Gauntlet's gate scripts (lockfile diff, coverage gate, test-mod detector). |
| `config/flags.json` | The checked-in feature-flag config. |
| `contracts/` | Placeholder for on-chain code, if any lands in this repo. See [its README](contracts/README.md). |

Foreman, the GitHub App that enforces the contribution protocol
server-side, is not in this repo — it runs as a service operated by the
core team.

## Project status

FORGE is running as a **small, invite-only pilot** — a handful of
contributors, not an open call. Reputation is the entire reward right now:
tiers, survival, and the public ledger, and nothing pays out yet. See
[`docs/rewards.md`](docs/rewards.md) for what that means concretely and
what's designed but not built.

The pieces vary in how finished they are — some (the shared schemas, the
flag client, the Gauntlet's CI jobs) are stable and exercised; others (the
Bridge's live dispatch, the on-chain client) are wired up as demos or
stubs. [`docs/architecture.md`](docs/architecture.md) has the honest
per-module breakdown.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) — please use
GitHub's private vulnerability reporting rather than a public issue.
