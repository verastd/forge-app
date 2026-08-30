# Architecture

Module map, ownership, and data flow for the FORGE monorepo. For the
contribution pipeline at a glance, see [`README.md`](../README.md); for
what merged work is worth, see [`rewards.md`](rewards.md).

## Module map

Owners are read from the root [`CODEOWNERS`](../CODEOWNERS). A
**cold-account approval** path lists both `@verastd` and `@forge-cold`.
Read that honestly: both accounts belong to the same person, and GitHub's
code-owner requirement is satisfied when any one listed owner approves.
Since GitHub never counts the author's own approval, a `@verastd`-authored
change to such a path does force a sign-in to the hardware-2FA cold
account — real cost against a stolen hot-account session, no independent
judgment. It is not two-person control. `CODEOWNERS` records the upgrade
path to genuine two-person review: a second human maintainer, plus
`required_approving_review_count: 2`.

Stability grades describe what's actually in the repo today, not the
design intent: `stable` (working, exercised), `beta` (wired but
incomplete), `experimental` (scaffold/stub only).

| Path | Purpose | Owners | Stability | Tier-floor notes |
|---|---|---|---|---|
| `apps/web` | Next.js 15 App Router, TypeScript strict. The app itself, including the Bridge's `/contribute` surface | `@verastd` | beta — live and demo builds both work end to end; no unit-test runner yet, so it's exempt from the changed-line coverage gate | Open to all tiers per task |
| `apps/api` | FastAPI (Python 3.12, `uv`), package `forge_api`. App backend + the Bridge's server-side service | `@verastd`; `routers/auth*` and `routers/pay*` need cold-account approval | beta — `health`, `history`, `export`, `flags`, and `bridge` routers are live, each with pytest coverage; `auth*`/`pay*` don't exist yet | `auth*`/`pay*` paths: cold-account approval, effectively T2+ in practice |
| `packages/shared` | zod schemas — reference copy of the web/API contract, hand-mirrored and test-locked against `apps/api`'s Pydantic models | `@verastd` | stable — schemas populated, mirrored field-for-field by `models.py`, locked by contract tests | Open |
| `packages/flags` | Feature-flag client; layered load, fail-closed. `config/flags.json` -> `FORGE_FLAGS_PATH` -> `FORGE_FLAGS_JSON` | `@verastd` | stable — `csv_export` and `contribute_bridge`, both real gates | Open |
| `packages/contracts-client` | The only module allowed to import a chain SDK. Mock-only isolation layer | `@verastd` `@forge-cold` (cold-account approval) | experimental — mock-only; `mode: 'live'` throws, no chain wiring | **Tier floor T2** |
| `contracts/` | On-chain code, if any lands in-repo | `@verastd` `@forge-cold` (cold-account approval) | placeholder — no contract source yet | **Tier floor T2** |
| `tests/acceptance/issue-<N>/` | Per-task acceptance tests, one directory per issue | Spec author (core team, or a T3 steward once delegated) | stable pattern, structurally enforced by G0 and the Gauntlet | Never written by the implementer |
| `tests/e2e` | Playwright end-to-end tests, one project per build (demo + live) | `@verastd` | stable | Open |
| `tools/forge` | The `forge` CLI (`tasks`/`claim`/`status`) and the Gauntlet's gate scripts (`check-lockfile-diff.sh`, `coverage-gate.sh` + `changed_line_coverage.py`, `test-mod-detector.sh`) | `@verastd` | stable — all three gates enforce | Open |
| `.github/workflows` | `gauntlet.yml` (the four unprivileged jobs: `hygiene`/`tests`/`security`/`e2e`), `foreman-annotate.yml` (privileged: posts the merge decision brief once the Gauntlet finishes, never checks out fork code), plus `agents-md-lint.yml` and `deploy-staging.yml` | `@verastd` `@forge-cold` (cold-account approval via CODEOWNERS on `.github/`) | beta — the four Gauntlet jobs run and are merge-queue-safe; G0 runs inside Foreman and doesn't post its own commit status here yet | T3-only |
| `.github/rulesets` | Importable branch-protection ruleset JSON (`main-protection.json`) | `@verastd` `@forge-cold` | beta — schema is current, not yet imported into a live repo | Cold-account approval |
| `docs/` | This documentation suite, plus the ADRs recording stack decisions | `@verastd` | stable | Open (community-improvable) |

Foreman itself has no row here: it's the GitHub App that enforces the
protocol, and it runs as a service operated by the core team — its source
is not in this repo.

**One protection leg doesn't apply on a public repo.** GitHub only allows
push rulesets on private or internal repositories, so protection for
`.github/**`, `CODEOWNERS`, and `AGENTS.md` here rests on two legs, not
three: Foreman's protocol gate (G0) plus CODEOWNERS review. The push
ruleset's other jobs — blocking oversized files and binary extensions at
push time — have no equivalent here today: G0 caps a PR's file count and
changed lines, but nothing currently blocks a large or binary file that
stays under those caps. Review is the control; know that going in.

## The Bridge

The Bridge is the in-app, no-GitHub-account-needed client for the same
pipeline GitHub-native contributors use. It is not a separate system:
every action it takes lands on GitHub as the user's own authenticated
action, through the same lease, tier, and Gauntlet rules everyone else
goes through.

**Components:**

- [`apps/web`'s `/contribute`](../apps/web/src/app/contribute) — built.
  Task board, task detail with a rail picker and guided handoff, an in-app
  profile, a status stepper. Every screen hangs off
  [`apps/web/src/app/contribute/layout.tsx`](../apps/web/src/app/contribute/layout.tsx),
  the `contribute_bridge` kill switch: flag off (or unreachable — flags
  fail closed) and the whole surface is replaced by a plain-language
  notice instead.
- `apps/api`'s bridge service — built as a demo service:
  [`/api/bridge/*`](../apps/api/src/forge_api/routers/bridge.py) serves
  fixture task cards, an in-memory lease store, and compiled agent prompts
  for seven rails. The same flag gates it at the router level, so the kill
  switch 404s `{"error": "bridge-disabled"}` rather than leaving the API
  serving a UI that's switched off.
- Not built, and load-bearing before any real user touches it: GitHub
  identity, encrypted OAuth user tokens, fork authorization, vendor
  credential custody, durable session state, webhooks, retries, conflict
  handling, notifications, abuse prevention. The task source that would
  read real GitHub issues
  ([`GitHubTaskSource`](../apps/api/src/forge_api/services/bridge.py)) is
  a stub that raises `NotImplementedError`. The Bridge holds no merge or
  deploy authority of any kind and never will.

**Demo mode versus live mode.**
[`apps/web/src/lib/mode.ts`](../apps/web/src/lib/mode.ts) is the single
reader of `NEXT_PUBLIC_FORGE_DEMO`; the variable is inlined at build time,
so the live app and the demo app are different build artifacts.

| | Live (default, deployed) | Demo (`NEXT_PUBLIC_FORGE_DEMO=1`) |
|---|---|---|
| Read fails | typed error, per-page error state with retry | falls back to local fixtures |
| Write fails (claim/dispatch/feedback) | throws, nothing on screen moves | simulated |
| Status polling | holds the last server-reported stage | advances the simulation |
| `contribute_bridge` off | Bridge closed | forced open (demonstrating it is the job) |
| Labeling | none needed | persistent banner: practice data, nothing real or saved |

A 409 (already claimed) behaves the same in both — a real answer from a
healthy server. There's no durable outbox and no retry daemon, so live
mode never tells a contributor their claim will sync later; it says the
claim didn't happen, because it didn't.

**Dispatch rails.** One internal interface, seven vendors, two mechanisms
— five dispatch through an API call, two hand the contributor a compiled
prompt and a deep link instead:

| Rail | Mechanism | What it takes |
|---|---|---|
| GitHub Copilot | API dispatch | Nothing extra — the same account you signed in with |
| Google Jules | API dispatch | A pasted API key; the free tier covers 15 tasks/day |
| Cursor | API dispatch | A connected dashboard API key |
| Devin | API dispatch | A connected API key |
| OpenHands Cloud | API dispatch | A connected API key |
| Claude Code | Guided handoff | Copy the prompt, open claude.ai/code, paste it in |
| OpenAI Codex | Guided handoff | Copy the prompt, open chatgpt.com/codex, paste it in |

**No rail dispatches for real today** — the API rails return a stub
session reference rather than actually starting one, and for the handoff
rails the compiled prompt is genuinely all that gets handed over.

The Bridge changes the pipeline's *reachability*, never its
*permeability*: a worst-case full compromise of the Bridge yields the
ability to open fork PRs and claim tasks as Bridge users — which lands in
the same Gauntlet and protocol checks that already assume hostile PR
authors.

## Data flow

`apps/web` talks to `apps/api` over REST. `packages/shared`'s zod schemas
are the contract; `apps/api/src/forge_api/models.py` mirrors them
field-for-field — change the schema and both sides together, or not at
all (see [`AGENTS.md`](../AGENTS.md) and
[ADR-002](adr/ADR-002-stack-nextjs-fastapi.md) for why).

Neither `apps/web` nor `apps/api` talks to Foreman directly today. Foreman
operates entirely through GitHub webhooks and the GitHub API against
Issues and PRs, and is expected to expose its own state (tiers, claims,
settlements) through a public read API (`/ledger`) that the Bridge can
read for in-app profile/tier/reward views — not built yet.

Endpoints this app defines for itself today: `/api/history`,
`/api/export` (CSV, gated by `csv_export`), `/api/flags`, and
`/api/bridge/*` (gated by `contribute_bridge`; fixture data and an
in-memory lease store, per the Bridge section above).

## Flags flow

Flags are a deploy-safety kill switch, not a convenience toggle, so the
client is **fail-closed in code**: `DEFAULT_FLAGS` in both mirrors
(`packages/flags/src/core.ts` and
`apps/api/src/forge_api/services/flags.py`) is all-`false`. The enabled
dev/demo posture comes from [`config/flags.json`](../config/flags.json),
which is checked in with both flags `true` — from the file, never from a
default.

Resolution is layered, and identical in both languages: defaults ->
nearest `config/flags.json` (walking up the tree) -> `FORGE_FLAGS_PATH` ->
`FORGE_FLAGS_JSON`, with later valid layers merging over earlier ones. A
layer that's simply absent is skipped. A layer that's **present but
invalid** — unparseable JSON, an explicit path that can't be read, a
non-object top-level value, or a known flag key holding a non-boolean —
fails the *whole* resolution to all-false immediately and warns once. No
partial salvage: a typo on one kill switch must not leave a sibling
silently on.

Both flags are real gates, not decoration:

- `contribute_bridge` — `apps/web/src/app/contribute/layout.tsx` closes
  the entire Bridge UI, and a router-level FastAPI dependency 404s every
  `/api/bridge/*` route with `{"error": "bridge-disabled"}`.
- `csv_export` — gates `/api/export`; in live mode the web client follows
  the flag client's fail-closed default and shows no export affordance.

Flag flips are runtime config, not code — this is what lets features ship
dark-launched and get killed instantly on revert. The out-of-band kill
path is `FORGE_FLAGS_JSON` on the running service: it wins over the
checked-in file and needs no deploy.

What flags do **not** yet have: authenticated control, an audit log of who
flipped what when, environment scoping, versioned changes, or failure
monitoring. Anyone with environment access on the service can flip a kill
switch anonymously.

## The contribution pipeline

What a PR actually passes through, in order:

1. **G0 — the protocol gate**, enforced by Foreman before a human ever
   looks at the PR. It checks **claim linkage** (does this PR trace back
   to an active `/claim` lease on the linked issue?), **scope fencing**
   (does the diff stay inside the task's declared `forge-scope` globs —
   closing on anything unreadable rather than guessing?), **protected
   paths** (`.github/`, `CODEOWNERS`, and `AGENTS.md` need T3 trust to
   touch), and raises — never blocks on — a **tests-modified flag** for
   PRs that touch an existing test.
2. **The Gauntlet**, this repo's own CI
   ([`.github/workflows/gauntlet.yml`](../.github/workflows/gauntlet.yml)):
   `hygiene` (lint, build, the no-new-deps check, a secret scan), `tests`
   (the full suite plus the 80%-changed-lines coverage gate), `security`
   (CodeQL and semgrep), and `e2e` (Playwright against both builds). All
   four are required checks on `main`.
3. **Human review and merge** —
   [`foreman-annotate.yml`](../.github/workflows/foreman-annotate.yml)
   posts a decision brief summarizing the Gauntlet's results, but a
   maintainer still reads and merges by hand; nothing here auto-merges.
4. **The survival window** — a merged PR has to stay in production,
   un-reverted, for a set period before anything it's owed actually
   counts as owed. See [`rewards.md`](rewards.md) for what "counts as
   owed" means today.

**The per-repo contract.** G0's protected-path check and tests-modified
flag, and the Gauntlet's tests-modified detector, need to agree on two
things: where this repo's tests live, and which paths need T3 trust.
(Scope fencing is different — each task's `forge-scope` block in its own
issue declares that.) Rather than hand-syncing those two lists between a
GitHub App and a CI script, this repo declares them once, in
[`.github/forge-protocol.json`](../.github/forge-protocol.json), and both
sides read the same file: `tools/forge/test-mod-detector.sh` reads it as
of the PR's merge-base (so a PR can never loosen the very list that would
let it hide a change), and Foreman reads the default branch's copy over
the GitHub API. One declaration, two consumers, nothing to hand-sync. The
exact globs live in that file, not here.

Some later stages the design calls for — an advisory LLM review pass, a
hidden extended test suite, an ephemeral preview deploy — aren't wired up
yet; today's Gauntlet is the four jobs above.
