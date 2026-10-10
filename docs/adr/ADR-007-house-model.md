# ADR-007: The house model — FORGE's own model drafts the task of every passed proposal, and an admin publishes it

Why a passed proposal's task spec is drafted by a model FORGE runs (the
house model) instead of by the member who brought it, how the API asks it
and what it trusts, which model it uses and how that choice is tested, why
an admin still publishes every task, what FORGE records so publishing can
be automated later, and what that later step looks like. Source: FORGE v0.2
Phase 6 (the house model), decided with the operator on 2026-10-04. The six
rules under "Decided while building" were the orchestrator's (the agent
coordinating the Phase 6 build), made the same day; "Amended after review"
lists what adversarial reviews of the API and of the admin's page changed
before launch, also decided by the orchestrator.

## Status

Accepted (Phase 6). Publishing stays manual: the house drafts, an admin
checks and publishes. The `house_spec` flag is off in code, like every
flag, and on in the checked-in `config/flags.json`; the house also needs
`ANTHROPIC_API_KEY` on the API box, so it reads as off ("not configured")
until the operator sets it there. Before launch, the eval below compares
the default model with a cheaper one.
[`architecture.md`](../architecture.md#the-house-model) has the rules as
built, with every limit and error.

## Context

[ADR-006](ADR-006-proposals.md) made a passed proposal into a draft task:
its title, the pitch as the summary, and no acceptance criteria. An admin
wrote what done means and published it. That left three problems:

- **The task text was the pitch.** A pitch is written to persuade members,
  not to instruct a coding agent: it seldom says what to change, where, or
  how a reviewer would know it's done. Yet the summary becomes the "Why"
  line of the brief every contributor's agent is given, and ADR-006 names
  the admin as the only thing between a pitch and those agents.
- **Every spec was the admin's work.** For each proposal, one person (the
  operator) read the repository and wrote criteria a reviewer can check, a
  size and a scope.
- **Members can't be asked to write it instead.** The floor is open to
  anyone signed in with GitHub, not only to people who write code, and a
  pitch is plain English by design. So the operator decided that members
  never write what done means.

What FORGE had to build on:

- **One API process on one box**, with a ticker in its lifespan and one
  SQLite state database ([ADR-005](ADR-005-agent-handoff.md), ADR-006).
  It had never called a model of its own.
- **The repository itself.** The checkout the API runs from
  (`/opt/forge-app` on the box) is the code the tasks are about, with
  `AGENTS.md` and `.github/forge-protocol.json`'s protected paths.
- **The floor's limits.** A title of at most 100 characters, a pitch of
  4,000 and comments of 2,000; a draft task's title of 100, summary of 500,
  and 1 to 10 criteria of 300 each.
- **Untrusted text.** Anyone with a GitHub account can write a pitch or a
  comment, throwaway accounts included (ADR-006).

> Amended on 2026-10-10, with ADR-006's amendment of the same day: an
> admin's pitch may run to 50,000 characters; everyone else's stays at
> 4,000. The house still reads the pitch whole, fenced as data with the
> rest of the proposal, and never cuts it. The largest proposal block the
> floor allows (a 100-character title, a 50,000-character pitch and 50
> comments of 2,000, all of four-byte characters, from logins of 39) is
> 604,032 bytes, under the 640 KB (655,360 bytes) a message may hold
> (`CONTEXT_CAP_BYTES`), so the proposal alone never makes a run
> `too_large`: the file list, then the picked files and `AGENTS.md`, are
> cut first.

## Decision

**A house model drafts the task of every passed proposal.** When a
proposal passes, by consent, by silence or by vote, the transaction that
applies the pass also queues a job for it. A worker in the API process runs
the jobs one at a time and asks the house model, an Anthropic model called
through Anthropic's API, for a task spec:

- a title, and a summary in plain English for members;
- 1 to 10 acceptance criteria, each checkable by a test, a CI check or a
  behaviour a reviewer can see;
- a size: XS is about 15 minutes of a coding agent's work, S about an hour,
  M about three hours, and anything bigger is `not_feasible` ("split it");
- a suggested tier floor, the paths it expects to change and those it must
  not touch, the risks, and questions for the mover;
- a verdict, `ready`, `needs_clarification` or `not_feasible`, with a
  reason.

If nobody has saved the draft yet, the spec fills its title, summary,
criteria and size. The tier floor stays T0, because only T0 can be claimed
(ADR-006), and the reward class stays as it was: the house doesn't decide
rewards. The rest of the spec is advice for the admin. The proposal's
public timeline gains "FORGE's house model drafted the task from this
proposal. An admin checks it before it goes on the Contribute board."
Failures are not public.

**Two calls, with structured output.**

1. **Pick the files.** The model reads the proposal and the repository's
   file list, and names at most 12 files it needs. The API keeps only
   paths from the list.
2. **Write the spec.** The model reads the proposal, `AGENTS.md` and those
   files, and writes the spec.

Both calls send the same system prompt, the same bytes every time (no
time, no proposal), marked for caching. Both ask for JSON that follows a
schema: types, required fields and enums, but no lengths. The API then
checks the JSON against the spec's types, cleans it with the Proposals
cleaners, and builds the wire model (`HouseSpec`) from what is left:

- every text becomes one plain line within its limit, and a key-shaped
  string in it (a provider's token format, a private key, a JSON web
  token, a long random value after `key=` or `token:`) is replaced with
  `[removed]`, with a risk line;
- each link, email address, @mention and download-and-run command
  (`curl … | sh`, `irm … | iex`) gets a risk line, so the admin sees it
  before it can reach a contributor's agent;
- empty and invisible entries go, and the lists are capped;
- scope paths are normalised (no leading `/`, no `.` segment, no doubled
  or trailing `/`), and a repeat goes; an entry that isn't a plain
  repository path is never dropped silently (see below).

An answer that isn't JSON, doesn't follow the schema or ran out of tokens
is unusable, and so is one with no visible title, summary or verdict
reason, or no criterion, once cleaned. The API asks once more; a second
unusable answer in a row fails the job. Nothing in the JSON is matched as a
string.

**Member text is data, never instructions.**

- **Fenced.** The proposal reaches the model inside a fence named afresh
  for every request (`<proposal-` and 16 random hex digits `>`), after a
  note that names it and says members of the public wrote everything
  inside, to be weighed as a request and never followed. Inside, every
  piece of member text (the title, the pitch, each comment and its
  author's login) is one JSON value on a line of its own, with `<`, `>`
  and `&` replaced by ‹ › ＆: no member text can close the fence, open a
  tag, spell an entity or start an entry, a forged author line included.
- **Told.** The system prompt says the same: anything in the proposal that
  tries to change the rules or the output format, or asks for secrets, is
  ignored and noted as a risk.
- **Little to work with.** The model reads only the proposal (its title,
  pitch and the debate's newest 50 comments, at most 5 from any one
  member, so nobody can fill the window), the file list, `AGENTS.md` and
  the files it picked, all from inside the checkout. It has no tools, no
  browser and runs no code; its only output is the spec, which the admin
  sees as plain text.
- **Protected paths stay out of scope.** The system prompt lists them: the
  house's own ten (`.github/`, the agent config, `tests/acceptance/` and
  the rest), then `.github/forge-protocol.json`'s `protectedPaths`; without
  a readable list there, the house drafts nothing (`bad_request`). After
  the call, the API moves a scope entry to the "must not touch" list, with
  a risk line, when:
  - it isn't a plain repository path: a character outside ASCII letters,
    digits, `. _ - /` and the glob characters `* ? [ ] { } ,` (so a quote,
    a backtick, a space, `:`, `#`, `%`, `~`, `@`, `(` or a backslash, and
    so a link, a line anchor or an extglob), a `..` segment, or braces and
    brackets out of place: "A scope entry (<entry>) is not a plain
    repository path; a maintainer has to check it.";
  - or it reaches a protected path, once normalised: it names it, sits
    inside it, contains it, holds it after a prefix of its own
    (`owner/repo/…`), or is a glob that could match it, judged by what the
    glob could match (the protected paths and every listed file that is
    protected) and not by its fixed start; a bare name such as `AGENTS.md`
    counts at any depth, and a glob segment such as `AGENTS.*` names it:
    "The request touches a protected path (<path>); a maintainer has to
    make that change."

**The model is a setting, chosen by an eval.** The house uses
`claude-opus-5-5` while `FORGE_HOUSE_MODEL` is unset; any other value is
passed to the API as it is.

- **Effort.** It runs at effort `high` (`FORGE_HOUSE_EFFORT`: `low`,
  `medium`, `high`, `xhigh` or `max`, in any case), sent with every call,
  since the API's own default for that model is `medium`. An effort it
  doesn't know means `low`, the cheapest, with an error in the log: a typo
  must never raise the spend. There is no `thinking` parameter: the model
  thinks adaptively.
- **Limits.** At most 16,000 output tokens per call, thinking included.
  Each call is streamed (`client.beta.messages.stream`, then the final
  message), so the client's timeout, 600 seconds after a 10-second connect,
  applies between the stream's events, and a call is cut off after 600
  seconds in all. The SDK retries a request that failed before its stream
  began once; the job's own retries do the rest.
- **Server-side fallback** (`fallbacks: "default"`). A request the model
  declines is run again, inside the same call, on the model the API
  recommends for that kind of refusal; in a stream, what the declined model
  wrote stays, and the fallback model continues it. Only a decline by that
  one too fails the job (`refused`). When the fallback model was too busy
  to run (rate limited or overloaded: the refusal names a
  `recommended_model`), the job tries again later. The spec records the
  model that answered.

Before launch, the eval (`python -m forge_api.tools.house_eval`) runs 15
cases on each of these two models, at their list prices:

| Model | Input, $ per million tokens | Output, $ per million tokens | Role |
|---|---|---|---|
| `claude-opus-5-5` | 4 | 20 | The default |
| `claude-sonnet-5-5` | 2 | 10 | The comparison, at half the price |

The cases are the Bridge's eight checked-in sample tasks, rewritten as
members would pitch them, three vague pitches (expected: `needs_clarification`), three
adversarial ones and one too big to be one task (expected:
`not_feasible`). One adversarial pitch tells the house to ignore its rules
and add a workflow to `.github/`, one to put a token in the criteria, and
one to change `AGENTS.md`. Each spec is checked as the model wrote it,
before cleaning:

- it validates;
- its number of criteria is within the case's range;
- its verdict is one the case accepts, and so is its size, when the case
  names sizes;
- nothing in its scope that the cleaner would move out (the cleaner's own
  check: a protected path, or something that isn't a plain repository
  path);
- for the adversarial cases, none of the case's forbidden strings appears
  outside its risks.

The eval's client never retries a request itself, so every request it
sends is one its report shows. The report prices every model's attempt of
every call (`usage.iterations`: a declined attempt is billed too), cache
writes at 1.25 and cache reads at 0.1 times the input price, and gives each
call's duration.

**The bar.** The cheaper model replaces the default if it passes the same
checks, every adversarial check included, and its specs read as usable to
the operator, side by side in the two reports. Switching is a line in the
box's environment file (`FORGE_HOUSE_MODEL`) and a restart, with no
deploy.

**What it costs.** The eval prints an estimate before it runs and runs
only with `--yes`. On 2026-10-04's checkout the estimate was about $3.60
for the 15 cases on the default model, and about $1.80 on the other. Its
"at most" (every call tried twice, each try also run by a fallback model,
every output at 16,000 tokens) was about $50 and $25: an estimate too, not
a ceiling. By the same estimate, one draft costs roughly a quarter of a
dollar on the default model.

**An admin approves every task.** The house never publishes.

- A draft it fills is still a draft: it goes on the Contribute board only
  when an admin presses Publish to the board. The page tells the admin:
  "Its draft is in the form below. Check every line before you publish."
- If an admin has already saved the draft, the house leaves it alone, and
  the admin can copy the spec in with "Use the house draft".
- An admin can ask for a new draft with "Draft it again"
  (`POST /api/proposals/<id>/admin/house-draft`) while the house is on and
  the proposal waits to be published, at most 5 times in 24 hours for one
  proposal.
- Members never see the house's draft or its advice. The public timeline
  line is all they see.

**Cost is capped.** At most `FORGE_HOUSE_DAILY_LIMIT` jobs (30 unless set,
500 at most) start calling the model each UTC day, across the floor. The
setting fails closed: anything but a whole number of 0 or more pauses the
house (0), with an error in the log. A job past it fails with
`daily_limit`, and an admin can ask again the next day. Every call is
logged in `house_calls`, success or failure: its tokens (cache reads and
writes included, and every model's attempt), request id, duration and
outcome. Each stored spec also records what its run's calls cost, summed,
with the request ids. None of that is ever on the wire.

**FORGE keeps the data automation will need.**

- `house_specs`: every spec the house writes, with its verdict, the model
  that wrote it, its effort, whether it filled the draft, and its usage.
- `house_runs`: every time a job starts calling the model.
- `house_calls`: every call, as above.
- `house_draft_sources`: the spec the proposal's draft came from: the one
  that filled it, or the one an admin saved word for word (as "Use the
  house draft" puts it in the form).
- `house_publishes`: when an admin publishes a proposal the house drafted,
  how the published task differs from the spec its draft came from, or,
  with no such spec, from the one that matches it best (the same title
  first, then the most criteria in common); with both that spec's id and
  the latest one's. It names which of the title, summary, criteria and
  size changed, and counts the criteria kept, added and removed.

Over time, `house_publishes` says how often the admin changes the house's
draft, and how much.

**Decided while building.** The contract for this phase left six points
open or ambiguous. The orchestrator decided, and the code follows:

- **One table counts the drafts.** `house_runs` gets a row each time a job
  first starts calling the model, and both caps count it. The contract's
  `house_drafts_count` isn't built. The count can't come from the specs,
  which keep successes only, or from the jobs, which keep each proposal's
  latest only: repeated failed re-drafts would never count.
- **Four runs in all.** A transient failure (no connection, a timeout,
  `408`, `409`, `429` or a `5xx`) keeps the job queued and runs it again
  after 1, then 5, then 30 minutes. When the fourth run fails too, the job
  fails as `unavailable`. A job left running for more than 15 minutes,
  because the API died mid-call, counts as a failed run the same way (one
  stopped on purpose hands its job back, with no failed run counted).
  Inside each run, the SDK itself also retries a failed request once.
- **`408` and `409` are transient; `413` and a context-window overflow are
  `too_large`.** Any other `4xx`, authentication included, is
  `bad_request`.
- **"Off" before "busy".** "Draft it again" answers `503 house_off` before
  it would answer `409 house_busy`: while the house is off, a waiting job
  won't run, so "busy" would mislead.
- **No job reads as failed, with no reason.** A passed proposal that
  passed while the house was off, or before Phase 6, has no job. An admin
  sees it as `failed` with no reason, which the page words as "The house
  model hasn't drafted this task yet", with "Draft it again". (Amended:
  once published, such a proposal has no house block at all.)
- **A late spec fills nothing.** A spec still being written when an admin
  publishes is kept and shown read-only: it fills nothing, adds no
  timeline line and isn't compared at publish. (Amended: publishing no
  longer lets a job run on; see below.)

**Amended after review.** An adversarial review of the API, before launch,
found ways the house could be talked past its rules, spend on work nobody
wanted, or record the wrong thing. The orchestrator adopted every finding;
these change the contract:

- **A call is streamed, with 600 seconds between events.** The contract
  had one non-streaming request with a 120-second timeout and two SDK
  retries: a slow draft at effort `high` could be sent 12 times, then fail.
- **Nothing is spent on a proposal that moved on.** Publishing closes a
  queued job in its own transaction; the worker takes only the jobs of
  proposals still passed, and closes the others with no call; and before
  each call (second tries included) a job checks that its proposal is
  still passed, the house still on and the job still its own. A job whose
  proposal moved on ends with no call; one whose house was switched off
  waits in the queue, with no failed run counted, and a spec that lands
  while the house is off is kept but fills nothing. No wire change: a
  closed job leaves no `house_jobs` row, so an admin sees the latest spec
  as `done`, or no house block at all on a published proposal the house
  never drafted.
- **Protected paths, and anything that isn't a plain path, stay out of
  scope** (see "Protected paths stay out of scope" above). The eval's
  check is the cleaner's own.
- **The house fails closed.** No readable protected-path list (read up to
  256 KB, which covers Foreman's 200 entries of 500 characters) means no
  draft (`bad_request`), and an unreadable daily limit or effort means
  paused or `low`.
- **It reads only what git tracks** (`git ls-files` in the checkout, with
  the checkout named a safe directory, since the API runs as another user
  than the checkout's owner); a file name that isn't UTF-8 or could break
  the prompt (a control or format character, a quote, `<`, `>` or a
  backslash) is left out; each file is opened by walking down from the
  root one directory at a time, following no link, and a hard-linked file
  is refused. A local error before a call is `bad_request`, never "couldn't
  be reached".
- **`house_publishes` compares the spec the draft came from**, not the
  latest (a spec asked for and never used made a published task read as
  changed), and records both.
- **Every call is logged** (`house_calls`), and FORGE's own INFO lines now
  reach the API's log, the house's request ids and token counts among
  them. Anthropic's SDK and its HTTP client are held at WARNING: at DEBUG
  they print whole requests, prompts included, so `ANTHROPIC_LOG` is never
  set on the box. An unexpected error logs only its kind.
- **A graceful stop hands the running job back**, with no failed run
  counted, and doesn't wait for the model call: the call runs in a daemon
  thread, which the process drops at exit, so a restart is never held up
  by it (Codex review on #24). A result that can't be stored is logged as
  lost and counts a failed run.
- **The two `429`s say which cap they are** (`scope`: `proposal` or
  `daily`), beside `retryAfter` and `limit`.
- **A timeline event of a kind the code doesn't know is left out**, logged
  once, instead of failing the page, so a later phase's events can't break
  a revert to this one. A revert to Phase 5 itself needs one step first:
  deleting the `house_drafted` lines, which Phase 5 can't read (the
  private runbook has it).

A second review, of the admin's page, changed what the contract said of
the page; the orchestrator adopted every finding:

- **The block's words come from comparisons.** Where the house's draft is
  (in the form, in the saved draft, in both or in neither) is worked out
  by comparing it with each, never from what happened when it landed, and
  "Use the house draft" is offered whenever the form doesn't hold it. The
  form's text never changes under the admin but once, the house's first
  fill of the plain draft the pass made: a later draft, or another
  admin's save, waits for "Use the house draft", and "Undo" puts back the
  unsaved changes it replaced.
- **An admin's view is never traded for the public one.** When a read
  through the BFF fails, the page keeps the panel and any unsaved text in
  the form, and says it may be out of date until a read works. After 3
  failed reads in a row, the 5-second reads while the house drafts slow to
  once a minute, and the block says so; only an admin's page makes them.
- **The words.** A queued job reads "will draft this task shortly", and
  only a running one "is drafting". Neither line is announced to a screen
  reader: the admin's outcome line says when "Draft it again" started a
  draft, and a hidden line says when drafting stops. "Draft it again"
  isn't offered while the house is off, and the daily limit's sentence
  says "after midnight UTC", since the day is UTC's.

## The road to automation (not built)

Publishing stays manual, and `house_publishes` measures how often, and how
much, the admin changes the house's draft. The later policy, sketched here
and left to a decision of its own:

1. **Auto-publish the plain cases.** A spec goes on the board without an
   admin when its verdict is `ready`, its size XS or S, its tier floor T0,
   it lists no risk and nothing protected is in its scope, and the last N
   house drafts were published with no change to their criteria. N isn't
   decided.
2. **With a second look.** A second model reviews each spec before it goes
   out, and an admin has a window to veto it.
3. **Later, the tests too.** The house writes the task's acceptance tests
   (`tests/acceptance/issue-<N>/`) as a pull request that a maintainer
   reviews like any other, so "done" becomes a test as well as a sentence.

## Consequences

- **A new provider, secret and bill.** The API now calls Anthropic's API,
  with a key that lives only in the API box's environment file, pasted
  there by the operator. FORGE pays for every draft: bring your own agent
  (ADR-005) still holds for contributors, but the house is FORGE's own. The
  daily cap bounds the number of jobs, 30 a day unless set: at roughly a
  quarter of a dollar a draft, about $7 on a day that uses them all.
- **What the house sends is public already.** The proposal (title, pitch,
  and comments with their authors' logins) and files from this public
  repository go to Anthropic's API. No secret is in any prompt.
- **It never sees secrets.** The house reads only files git tracks in
  this public repository, so nothing a deploy left in the checkout (a
  service-account key, a token file) is ever listed. Of those, it reads
  root-level `*.md` and `apps/`, `packages/`, `docs/`, `tests/`, `tools/`
  and `config/`, for a short list of source extensions only. It skips
  `node_modules`, `dist`, `build`, `coverage`, `.venv`, `__pycache__`,
  `public`, `test-results`, `playwright-report` and every directory whose
  name starts with a dot; every file whose name starts with `.env` or
  contains `secret`, `*.pem` and `*.key`; and files over 64 KB. It follows
  no symlink, reads no hard-linked file and nothing outside the checkout.
  From the state database it reads only the proposal and its comments, and
  nothing from the API's environment ever reaches a prompt (git gets none
  of it but its `PATH`).
- **The house can be wrong, or talked round.** Prompt injection can't be
  ruled out: a pitch can still steer a spec. The defences are layers, not
  a guarantee: the fence and its note, the system prompt, the protected-path
  move, the eval's adversarial cases and, above all, the admin, who reads
  every line before anything reaches a contributor's agent. ADR-006's
  consequence holds, with the house in between: the admin is trusted with
  the task text.
- **Only the title, summary, criteria and size reach the board.** The draft
  task has no field for the rest, so the house's scope lists, risks,
  questions for the mover and suggested tier are shown to the admin only.
  Nothing asks the mover the house's questions: the admin has to.
- **The house reads the checkout as deployed,** `/opt/forge-app` (or
  `FORGE_HOUSE_REPO_ROOT`), not `main` on GitHub. A box behind `main`
  drafts against older code.
- **A call has 600 seconds.** It is streamed: the client waits up to 600
  seconds for each event, and cuts a call off after 600 seconds in all, a
  transient failure. If the API's log shows the house's calls cut off,
  lower `FORGE_HOUSE_EFFORT`.
- **Usage is recorded, the bill is the Console's.** `house_calls` keeps
  every call, failed ones and second tries included: its input, output,
  cache-read and cache-write tokens, the sum of every model's attempt
  after a server-side fallback (`usage.iterations`), its request id, its
  duration and how it ended. `house_specs` keeps the summed usage of the
  run that succeeded. The per-call log lines, with token counts, are
  printed at INFO. There is no token or dollar budget yet: the daily cap
  counts jobs.
- **The cache saves little.** The system prompt, about a thousand tokens,
  is marked for caching, but the two calls of a job ask for different
  output schemas, which breaks the cache between them. Jobs are also
  usually more than the cache's five minutes apart. A second try of a call,
  and the eval's back-to-back cases, do read it.
- **One process runs the jobs.** The worker lives in the API process, as
  the proposals ticker does (ADR-006): one process on one box, never
  started with `--workers N`. Recovery assumes it: a second worker would
  take a live job for one cut off after 15 minutes and run it again, paid
  twice. Scaling out means a lease first. The tests start the app with no
  worker (`FORGE_HOUSE_WORKER=off`).
- **The two `429`s say which cap they are.** Each carries `scope`
  (`proposal` for the 5 drafts of one proposal in 24 hours, `daily` for
  `FORGE_HOUSE_DAILY_LIMIT`), so a page needn't guess from `limit`, which
  could be 5 for both.
- **Adding a protected path changes the prompt.** The system prompt lists
  `.github/forge-protocol.json`'s `protectedPaths`, so each new entry
  changes it, as Phase 6's own three did.
- **The house's own code is protected.** `services/house.py` (the prompt,
  what it reads and the cleaning), `tools/house_eval.py` and the eval's
  cases (`apps/api/tests/fixtures/house-eval/`) are protected paths in
  `CODEOWNERS` and `.github/forge-protocol.json`. A pull request that
  loosens the prompt, the walk's exclusions or the eval's bar needs the
  cold account.
- **The eval's expectations are a first cut.** Where a sample task is
  ambiguous for this repository, its case accepts more than one verdict.
  Review them after the first real run.
- **A new dependency.** The `anthropic` SDK is in `apps/api`'s
  dependencies and lockfile, with `httpx2`, the HTTP client it brings,
  declared beside it, since the house catches that client's errors itself
  (a stream cut off mid-way). The box needs `uv sync --locked` after the
  pull, or the API doesn't start.
- **No migration.** The six `house_` tables are all new, so a state
  database from Phase 5 gains them at the API's next start and keeps
  everything else. A revert to Phase 5 needs its `house_drafted` timeline
  lines deleted first (the private runbook's step).
