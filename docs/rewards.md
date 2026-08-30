# Rewards

How merged, surviving contributions are recognized today. For how a PR
gets from opened to merged, see
[`architecture.md`](architecture.md#the-contribution-pipeline); for how to
actually contribute, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Philosophy

FORGE's reward layer is **recognition and acceleration, not wages**.
Rewards are kept modest, delayed, and dignity-preserving rather than aimed
at out-bidding gig-work rates. Paying strangers top dollar per task, sight
unseen, is exactly the incentive shape that produces gamed submissions and
low-effort noise on other projects' bounty programs — this system is
deliberately conservative so it doesn't repeat that.

## Two streams

**Stream A — task bounties.** Some Task Specs carry a bounty, in one of
four size classes — `R1` through `R4`, smallest to largest — shown as a
`bounty:R1`…`bounty:R4` label on the issue. The class is set by the core
team **at the time the spec is written** — never afterward, and never by
whoever ends up doing the work — so you know what a task is worth before
you claim it.

**Stream B — the retro pool.** A quarterly pool, allocated by the core
team against a published rubric, for contributions a per-task bounty
doesn't capture well: sharp bug reports, spec authoring, review work,
tooling, documentation. If you did something valuable that nobody
attached a bounty to in advance, this is the mechanism that can still
recognize it.

## Timing

Nothing is payable on submission, and nothing is payable on merge either.
A reward becomes payable only after a PR **merges and then survives** —
stays in production, un-reverted — for a set window. The window exists
specifically so a patch that looks fine at merge time but doesn't hold up
— gamed, broken, or reverted — fails *before* anything is owed, not
after. A revert inside that window currently cancels the reward attached
to it; [`CONTRIBUTING.md`](../CONTRIBUTING.md) covers how to appeal one
that wasn't your fault.

## Eligibility

Reward eligibility starts at **T1** — new contributors build reputation
first, then become reward-eligible once their code has shown it holds up.
T0 work is real and welcome, it just isn't paid. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full trust-tier ladder and
how tiers are earned.

## Where things actually stand

Read this section before any of the above, because everything above
describes the design and this describes what's running today:

- **Nothing pays out today.** This pilot is reputation-only.
- The ledger does correctly record when a survival window has matured —
  that state is called `payable` — but **no payout rail exists yet**.
  `payable` means the ledger agrees you're owed something, not that
  anything has moved.
- Policy can change going forward, but **never retroactively** for work
  that's already inside a survival window at the time of the change — the
  terms you claimed a task under are the terms that apply to it.

Contribute for the reputation and the software today; a payment date
hasn't been set.

---

Amounts and the exact settlement mechanics are published per Task Spec
and governed by the core team's fuller policy. If something above is
unclear for a specific task, ask on the issue.
