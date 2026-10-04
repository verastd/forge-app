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

If you'd rather not leave the browser, claim a task in the in-app Bridge at
[`/contribute`](apps/web/src/app/contribute) and press **Open my agent**
(your agent opens with the task already typed in) or, once it is switched
on, **Start it for me** (FORGE starts your agent through its maker's API,
on your own account; each of those rails stays off until it passes a live
test). Connect your agent to FORGE once at
[`/connect`](https://forge-app-eta-mocha.vercel.app/connect) and it can
claim the task, report progress and read its check results by itself, with
nothing to copy and paste; an agent FORGE can't start, open with a link or
reach through the connector still gets the task from a "Copy the brief"
box.
It's a client for the same GitHub-native pipeline, not a shortcut around
it;
[`docs/architecture.md`](docs/architecture.md#the-bridge) and
[ADR-005](docs/adr/ADR-005-agent-handoff.md) say what's wired up today and
what's still switched off.

Have an idea for FORGE rather than a task to take on? Bring it to the
Propose floor at [`/propose`](apps/web/src/app/propose) (see
[The Propose floor](#the-propose-floor), below).

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

### Sign-in

The demo build (`NEXT_PUBLIC_FORGE_DEMO=1`) offers a practice account
instead of GitHub — `/signin` shows a "Continue with the practice account"
button, no GitHub App needed. Which build you get is fixed when the app is
compiled; a live build refuses practice sessions, whatever its environment
says at runtime. `next dev` also falls back to a hard-coded, obviously-named
dev-only session secret when `FORGE_SESSION_SECRET` is unset, so a fresh
checkout of the demo build can sign in and poke around `/me` and `/apps/data`
without any setup. That secret is public, so it only ever signs in the
practice account, and the Data app never calls the API under it (the BFF
answers `503 not_configured`). A `FORGE_SESSION_SECRET` that is set but
shorter than 32 characters turns sign-in off instead, with a warning in the
server log.

Real GitHub sign-in — the live build, or `next dev` with a full config —
needs a registered GitHub App and several environment variables
(`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `FORGE_PUBLIC_ORIGIN`,
`FORGE_SESSION_SECRET`, `FORGE_API_ASSERTION_SECRET`; on the API side,
`FORGE_API_ASSERTION_SECRET` again and `FORGE_ADMIN_IDS`, the numeric GitHub
user ids of the operators). See
[`docs/architecture.md`](docs/architecture.md#identity) for the full flow,
the complete env var table, and how to rotate a secret without signing
everyone out.

### The Apps lobby

`/apps` is a 3D lobby: a cave you walk around, whose wall holds every app
(three.js, loaded on that page only). Members signed in with GitHub see and
hear each other there through [LiveKit](https://livekit.io), which needs
`LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` on the server;
without them the lobby still works, just alone. The demo build shows
presence between tabs of one browser instead, with no voice. See
[`docs/architecture.md`](docs/architecture.md#the-apps-lobby) and
[ADR-004](docs/adr/ADR-004-apps-lobby.md) for why it's built this way.

### The Propose floor

`/propose` is where members decide what FORGE builds next, by Robert's
Rules. Anyone signed in with GitHub can bring a proposal (a title and a
pitch in plain English), second someone else's, consent or object, comment
and vote; anyone at all can read the floor. A proposal nobody seconds
within 7 days lapses. A seconded one is debated for 3 days: if every
eligible member consents it passes at once, and if debate ends with no
objection it passes without a vote. One objection means a 2-day vote once
debate ends. A passed proposal becomes a draft task, which an admin
finishes and publishes to the Contribute board.

- **The flag.** It all sits behind the `proposals` flag, which
  `config/flags.json` has on. Switching it off, or switching off
  `github_signin`, pauses the floor: its deadlines wait until members can
  act again.
- **Who counts.** A member is anyone the API has seen signed in with
  GitHub, and members aren't backfilled from earlier phases: only accounts
  that sign in, or use FORGE signed in, after the deploy count. Who may
  consent, object and vote on a proposal, and whom its quorum counts, is
  fixed when it is seconded: the members seen in the 30 days before, plus
  its mover and seconder. Throwaway GitHub accounts can take part too; the
  pilot accepts that.
- **The admin** is whoever's GitHub user id is in the API's
  `FORGE_ADMIN_IDS`: the operator. An admin can switch on **Test timers**,
  which make new deadlines minutes instead of days (10 to find a second, 5
  of debate, 5 of voting) so the whole flow fits in one sitting; only then
  do **End debate now** and **Close the vote now** work. An admin also
  writes what done means for a passed proposal and publishes it as a
  Contribute task, numbered from 10001.
- **The bell.** Members signed in with GitHub get an in-app bell for new
  proposals, seconds, votes opening, outcomes and published tasks. Nothing
  is e-mailed.
- **The demo build** runs a practice floor in the browser instead, where
  nothing is saved.

[`docs/architecture.md`](docs/architecture.md#the-propose-floor) has the
rules as built, every limit and the API, and
[ADR-006](docs/adr/ADR-006-proposals.md) why.

## Repo map

| Path | What's there |
|---|---|
| `apps/web` | Next.js 15 (App Router, TypeScript strict): the app itself, including the [`/contribute`](apps/web/src/app/contribute) Bridge surface, the 3D Apps lobby at `/apps` and the Propose floor at [`/propose`](apps/web/src/app/propose). |
| `apps/api` | FastAPI (Python 3.12, `uv`), package `forge_api`: the backend, and the Bridge's server-side service. See [`apps/api/README.md`](apps/api/README.md). |
| `packages/shared` | zod schemas — the reference copy of the web/API contract, hand-mirrored by `apps/api`'s Pydantic models. |
| `packages/flags` | The feature-flag client, backed by [`config/flags.json`](config/flags.json). Fails closed: code defaults are all off. |
| `packages/lobby` | The Apps lobby's pure logic: the wall, the camera, the app registry and the presence rules. No DOM, no three.js. |
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
flag client, the Gauntlet's CI jobs) are stable and exercised; others
aren't live yet: the Bridge's start rails are built but switched off until
each passes a live test, and the on-chain client is a mock.
[`docs/architecture.md`](docs/architecture.md) has the honest per-module
breakdown.

## Security

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) — please use
GitHub's private vulnerability reporting rather than a public issue.
