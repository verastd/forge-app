# Contributing to FORGE

Human-facing mirror of the swarm protocol in `AGENTS.md`. Source: PRD §4 Stages 2-6, Appendix F.

If you're pointing a coding agent at this repo, have it read `AGENTS.md`
first — that file is authoritative for agents. This document is the
human-readable version of the same rules, plus the context `AGENTS.md`
doesn't need (tiers, rewards, etiquette).

## Finding a task

Open tasks are GitHub Issues labeled `agent-ready` + `status:open`, also
mirrored on the Projects board.

```
gh issue list --label agent-ready --label status:open
tools/forge/forge tasks     # thin wrapper around the same gh call
```

Each Task Spec is self-contained: goal, acceptance criteria, acceptance
tests, scope (in/out), size class (XS/S/M — L is never open-claimed, it's
decomposed first), and, if reward-eligible, a reward class and tier floor.
If your agent can't execute an `agent-ready` issue without asking a
question, that's our bug, not yours — flag it (see "Decline etiquette and
spec gaps" below) and get reputation credit for the report.

## Claiming a task

Comment `/claim` on the issue, or run `tools/forge/forge claim <issue-number>`.
Foreman (our GitHub App) checks your tier floor and concurrent-claim cap,
then assigns you the issue and labels it `status:claimed` with your lease
terms.

**Lease terms:**

| Size | Lease |
|---|---|
| XS / S | 48 hours |
| M | 96 hours |

The clock pauses while a draft PR is open and the ball is in the core
team's court. One `/extend` (+50%) is available per lease, T1+ only. Let a
lease expire and it's blameless — Foreman unassigns and reopens the task
automatically. Two consecutive expirations trigger a 7-day claim cooldown.

A PR against a task claimed by someone else, opened during their active
lease, is auto-closed regardless of quality — claim before you build, every
time.

## Build and submit (fork + PR flow)

1. Fork the repo.
2. `make setup`, then work on branch `task/<issue-number>-<slug>` off `main`.
3. `make test` locally before opening a PR — it's the same suite the
   Gauntlet runs, so a green local run is a strong signal.
4. Open a PR from your fork. Title: `[#<issue>] <goal>`. Fill in every
   section of the PR template, including the AI-assistance disclosure
   checkbox — this is a courtesy norm (Linux kernel / Django precedent);
   the Gauntlet treats all PRs identically regardless of the answer.
5. One issue, one PR. Squash-merge only, so keep commits however you like
   inside the branch.

## What the Gauntlet runs

Every fork PR runs the same layered, automated checks before a human ever
looks at it:

| Layer | What it checks |
|---|---|
| G0 Protocol | PR is linked to your claimed task, in scope, under 300 files, template complete, no `.github/` edits |
| G1 Hygiene | Lint, typecheck, build, no-new-deps check, secret scan |
| G2 Tests | Full suite + your task's acceptance tests, **80% coverage on the lines you changed**, tests-modified alarm, browser E2E |
| G3 Security | CodeQL, semgrep, dependency review |
| G4 LLM review | Advisory only — spec-conformance and suspicion flags for the human, never a gate |
| G5 Private suite | Hidden extended tests in a separate private repo, rotated quarterly; posts pass/fail only |
| G6 Preview deploy | Ephemeral preview environment + smoke tests, for UI-touching PRs |

Failures post a machine-readable reason. Iterate against them freely — a
failed Gauntlet run costs the core team nothing, so there is no penalty for
retrying.

Three things about G0 are worth knowing before your first PR:

- **The task's Scope is a machine-readable block**, not prose — a fenced
  `forge-scope` section listing `in:` and `out:` globs. If it is missing or
  malformed, your PR is closed at `G0.3` **with no strike**: that is a
  broken spec, which is our fault, and the task gets labeled
  `spec:invalid` for repair. Say so on the issue and you have done us a
  favour.
- **New dependencies need a label, not just permission in the issue
  text.** The no-new-deps gate reads the `deps-approved` label on your PR,
  which only the core team can apply. Ask for it in the PR.
- **If your agent opens the PR from its own bot account**, that account
  has to be one we recognize. A recognized rail's PR is treated as yours —
  the credit and the accountability both land on you. An unrecognized
  automation account is closed at `G0.0` with no strike, since there is no
  human behind it. When in doubt, open the PR yourself.

Run `make test-coverage` before you push. The coverage gate measures the
lines your diff added or modified in `packages/*` and `apps/api`, and a
missing coverage report for a directory you touched is a hard failure,
not a pass.

## Decline etiquette and spec gaps

If the spec is ambiguous, wrong, or you get stuck, don't guess: comment
`@forge-foreman spec-gap` on the issue. Validated spec-gap reports earn
reputation; guessing and burning your lease on a wrong interpretation does
not.

If a PR is declined at merge review, you'll get one of a fixed set of
reasons plus one sentence: spec-miss, quality, superseded, or scope. Don't
expect a line-by-line review — the core team's time is spent on decisions,
not education; the Gauntlet's error messages and the tier ladder are where
the mentoring happens.

## Trust tiers

Tiers are earned by surviving code only — never purchasable, never
token-gated.

| Tier | Entry | Claimable size | Concurrent claims | Reward-eligible |
|---|---|---|---|---|
| T0 Newcomer | GitHub account + one-click contributor agreement | XS, S | 1 | No |
| T1 Contributor | 2 merged + surviving PRs, 0 open strikes | XS-M | 2 | Yes |
| T2 Regular | 8 merged + surviving, >=80% survival, 90-day tenure | XS-M + contests | 4 | Yes |
| T3 Steward | 20+ merged, >=90% survival, core nomination | All + spec authoring | Uncapped | Yes + retro-jury seat |

The tier ladder above is what Foreman enforces.

## Rewards

Reward-eligible tasks (T1+) become payable on **merge and survival**,
never on submission. See `docs/rewards.md` for amounts, vesting,
and the legal posture.

**Nothing pays out today.** Phase 1 is reputation only: a matured
settlement is marked `payable` — the ledger records that it is owed — and
no payout machinery exists. Fixed USD-denominated rewards through an
established provider come in Phase 2; a token election, if ever, is Phase
3 and only after legal review. Contribute for the reputation and the
software, not for a payment date we have not set.

One thing worth knowing up front: if a merged PR is reverted in production
inside its survival window, the reward is currently clawed back
mechanically — the ledger records that a revert happened, not why. A
revert that was not your fault (something else broke it, the requirement
changed, infrastructure failed) is appealable through the core team, and
we intend to replace the mechanical path with adjudication before
clawback. Until then, appeal it; that is not a formality.

## Code of conduct

Be respectful, assume good faith, and don't waste other contributors' or
the core team's time on purpose. Repeated bad-faith behavior (snipe
attempts, spam claims, abusive comments) is handled through the strike
system above and, if needed, an org-level block.
