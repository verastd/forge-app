# ADR-006: Proposals — a floor run by Robert's Rules, open to anyone signed in with GitHub

Why `/propose` lets anyone signed in with GitHub bring, second, debate and
vote on proposals, how an admin tests the whole flow in minutes instead of
days, what a passed proposal becomes, and how members hear about it.
Source: FORGE v0.2 Phase 5 (Proposals), from PRD v0.2 §3, decided with the
operator on 2026-10-04. The three rules under "Decided while building"
were the orchestrator's (the agent coordinating the Phase 5 build), made
the same day after an adversarial review of the rules as first built.

## Status

Accepted (Phase 5). The `proposals` flag is off in code, like every flag,
and on in the checked-in `config/flags.json`, so the operator can try the
whole flow with a friend. [`architecture.md`](../architecture.md#the-propose-floor)
has the rules as built, with every limit and error.

## Context

PRD v0.2 §3 says proposals follow Robert's Rules of Order, with no custom
mechanics: a member moves a proposal in plain English, another member
seconds it, it is debated in the open and put to a vote, and a passed
proposal goes to the build queue. A single objection doesn't kill a
proposal: it forces debate and a vote. A proposal nobody objects to passes
by unanimous consent, without a vote. There is one active proposal per
person, a notification on every new proposal and every second, and a public
record of who moved and seconded it, the debate, the tally and the outcome.
A shipped proposal gets a panel in the lobby, and the building itself
happens outside FORGE (§6). Its open items (§7) included who votes, how
long debate lasts, and the quorum.

What FORGE had to build on:

- **Identity is GitHub sign-in and nothing else**
  ([ADR-003](ADR-003-github-app-signin.md)). There was no list of people:
  a session is one sealed cookie, and the API knows someone only from the
  assertion the web server mints for each request. The practice account is
  nobody on GitHub.
- **One admin role:** `FORGE_ADMIN_IDS`, the operator's numeric GitHub
  user id, checked by `require_admin`.
- **One state database**, a SQLite file on the API box
  ([ADR-005](ADR-005-agent-handoff.md)), and a Contribute board that served
  only the checked-in task fixtures.
- **No tiers yet.** Every account is T0 until Foreman's ledger is wired
  in, so a task whose tier floor is above T0 can't be claimed.
- **No notifications of any kind**, and no way to send mail.
- **A pilot of a handful of people.** The operator wants to try the whole
  flow with a friend, and with timers measured in days one try takes five
  days or more.

## Decision

**Anyone signed in with GitHub takes part.** A person signed in with
GitHub can bring a proposal, second, consent or object, comment and vote:
one member, one vote, the default PRD §7 named. Signed-out visitors and the
practice account can read everything and act on nothing. There is no tier
gate, invitation list or token weighting. Every check (who is asking, who
moved it, who is eligible, who is an admin) is made by the API on each
request, never only by the page.

**The rules are Robert's Rules with the pilot's numbers.** A proposal
nobody seconds within 7 days lapses. Seconding opens 3 days of debate and
freezes the eligible set (below). From the second, each member of the
eligible set may consent or object, once, and either is final. The mover
counts as consenting, and the seconder consents like anyone else. When
everyone in the eligible set has consented, the proposal passes at once;
when debate ends with no objection, it passes without a vote (consent by
silence). One objection sends it to a vote of the eligible set when debate
ends: 2 days, Yes, No or Abstain, changeable until the close, with the
totals hidden until then. Quorum is a majority of the eligible set casting
a ballot, Abstain included. With quorum it passes on more Yes than No; a
tie, more No, or no quorum fails it. Consents and votes are public by
name, as Robert's Rules has them: a vote shows next to the voter's name
after the close.

**Admin test mode.** Everyone runs on the real timers. An admin (the
operator, through `FORGE_ADMIN_IDS`) has a **Test timers** switch, stored
in the database and shown to everyone as a banner: while it is on, new
deadlines are minutes, not days (10 to find a second, 5 of debate, 5 of
voting). Each deadline is fixed when its period starts, so the switch
changes only deadlines set afterwards. While Test timers are on, an admin
also has **End debate now** and **Close the vote now**, which act as if
the deadline had passed that moment; each is logged in the proposal's
timeline with the admin's login. With Test timers off the API refuses both
(`409 test_mode_off`), so they can't cut a real debate or vote short.

**A passed proposal becomes a draft task an admin publishes.** Passing
makes a draft from the proposal: its title, the pitch as the summary, and
no acceptance criteria. An admin writes what done means (1 to 10 lines),
checks the rest (title, summary, size, tier floor and reward class) and
presses **Publish to the board**. That puts a task on the Contribute board,
numbered from 10001 so it stays clear of the fixtures' issue numbers, and
moves the proposal to `building`. When the Bridge records the task's pull
request as merged, the proposal moves to `shipped`. Building stays outside
FORGE, as PRD v0.2 §6 has it: contributors' own agents take the task like
any other.

**An in-app bell.** Members hear about the floor inside FORGE: a bell in
the site header (and in an app's bar) for members signed in with GitHub,
with an unread count read every 60 seconds while the tab is visible. It
carries eight kinds of notification: a new proposal, a second, a second of
your own proposal, a vote opening, a pass, a failure, a lapse, and a task
published.

**Decided while building.** The rules review found three places where the
rules as first written would decide outcomes nobody chose. The orchestrator
decided:

- **Quorum counts members active in the last 30 days.** The eligible set,
  frozen at the second, is the members FORGE has seen in the last 30 days
  (`ELIGIBLE_ACTIVITY_DAYS`), plus the mover and the seconder. Counted from
  everyone who ever signed in, dormant accounts would soon outnumber active
  ones. One objection would then fail any proposal for lack of quorum (the
  review's case: 10 active members all voting Yes, out of an eligible set
  of 21, fails), and unanimous consent could never happen.
- **The floor pauses while members can't act.** While the `proposals` or
  `github_signin` flag is off, or the flags fail closed, nothing on the
  floor moves. When both are on again, every deadline still running when
  the floor closed moves later by the time it was closed, and each
  proposal's timeline says so. Without this, a kill switch or a broken
  flags deploy would decide outcomes: debates would pass by silence, and
  votes fail, while nobody could object or vote.
- **Tasks are published at tier floor T0 until tiers exist.** A T1 or T2
  task nobody can claim would leave its proposal in `building` for good,
  so the API refuses a draft or a publish above T0 (`400 tier_not_open`).

## Not built, on purpose

- **A shipped proposal's lobby panel.** PRD v0.2 §3 gives a shipped
  proposal a panel in the lobby. That stays a manual step for now: an
  entry in `APPS` in `packages/lobby/src/registry.ts`, through an ordinary
  pull request, so every panel passes the registry's rules. The proposal's
  page and the rules on `/propose` say so.
- **No backfill of members.** The `members` table started empty with
  Phase 5. Accounts FORGE knew before (Bridge contributors, people with a
  connected agent) become members only when they sign in, or use FORGE
  signed in, after the deploy.
- **No e-mail, push or any other notification outside the app.** The bell
  is the only one. Nothing is sent when a proposal is withdrawn or ships.

## Consequences

- **Throwaway accounts can vote.** Anyone can make a GitHub account, so
  one person can bring several to the floor, each a member once it signs
  in. The pilot accepts that: it is a handful of people, every consent and
  vote is public by name, and each account has its own limits: 3
  proposals in 24 hours, and 60 actions an hour among seconding,
  consenting, objecting, voting, editing and withdrawing. Opening the floor
  beyond the pilot means revisiting who takes part.
- **The first eligible sets are small.** Only members seen in the last 30
  days count, and the table started empty. Right after the deploy, a
  proposal seconded between two members has an eligible set of two, so the
  seconder's consent passes it at once. That is the rule working as
  written on a small floor, and it grows as people sign in.
- **Counting depends on being around.** Signing in, the bell's poll and
  any action on the floor refresh a member's last-seen time. Someone away
  longer than 30 days misses the eligible sets frozen in the meantime, and
  counts again from their next visit.
- **The admin is trusted with the task text.** A passed proposal's pitch
  starts as its task's summary, which becomes the "Why" line of the brief
  every contributor's agent is given. The admin reads and edits that
  summary, and writes the acceptance criteria, before publishing; nothing
  else stands between a member's pitch and those agents.
- **One API process keeps the time.** Deadlines are applied by a ticker in
  the API's own process every 60 seconds, and by every read and write of a
  proposal. Each change is a compare-and-set on the proposal's state and
  version, so two readers never apply it twice, and a change applied late
  is dated at its deadline. This is ADR-005's one process on one box;
  scaling out means moving it.
- **A pause starts when it is seen.** The floor notices it can't act at
  the ticker's next beat, at a read, or when a request is refused, so
  deadlines can run on for up to about a minute after a switch is thrown.
  API downtime itself doesn't pause the floor: when the API comes back,
  whatever fell due meanwhile applies, dated at its deadline.
- **Published task numbers share GitHub's number space.** A published
  task's brief asks for "Closes #10001" in the pull request. Once
  forge-app's own issues and pull requests reach #10001, that would close
  an unrelated issue. The repo is around #18, so this is far off, and it
  isn't handled yet.
- **A published task has a reward class but no dollar amount.** The draft
  sets the class (`none` or R1 to R4); nothing maps it to an amount yet.
- **No migration.** Phase 5's tables are all new (`members`,
  `notifications`, the `proposal_` tables and `bridge_published_tasks`),
  so a state database from Phase 4 gains them at the API's next start and
  keeps everything else.
