# ADR-008: Your copy and Send for review — FORGE sets up your copy and sends your work for review, as you

Why a contributor's task page now makes their copy of FORGE's code (a fork
of `verastd/forge-app` on GitHub), keeps it up to date and makes the task's
branch in it, and, once their agent has pushed, opens the pull request in
their name; why FORGE does this through an OAuth App of its own, with one
token per press, rather than through its sign-in GitHub App; and what FORGE
checks before it puts the contributor's name to a pull request. Source:
FORGE Phase 7 ("your copy" and "Send for review"), decided with the
operator on 2026-10-05. The rules under "Decided while building" were the
orchestrator's (the agent coordinating the Phase 7 build), made the same
day after adversarial reviews of the API and of the web app. The GitHub
facts below were read in GitHub's own documentation on 2026-10-05.

## Status

Accepted (Phase 7). Amends [ADR-005](ADR-005-agent-handoff.md), under
which FORGE never forked, branched or opened a pull request for anyone: it
now does all three as the contributor, when they press a button, and it
still never writes code. There is no flag of its own: the feature is on
wherever the web server has the OAuth App's settings
(`GITHUB_REPO_CLIENT_ID`, `GITHUB_REPO_CLIENT_SECRET`) and sign-in is
GitHub, and without them the task page hands the task to an agent as
before. It hasn't run against real GitHub yet: test 11 in
[`live-tests.md`](../live-tests.md) is the check.
[`architecture.md`](../architecture.md#your-copy-and-send-for-review) has
the rules as built, with every limit and error.

## Context

On 2026-10-05 the operator made a promise for the Contribute page: a
contributor never needs to know what a fork is. Until then they did. Every
agent's setup steps began with "Fork forge-app on GitHub.", the brief told
the agent to work in `<login>/forge-app`, and the pull request was the
agent's job, or the person's, through a compare link on the task page. For
the people the Bridge is for (PRD persona P2b, who may never have used
git), that is three new ideas (a fork, keeping it in step, a pull request
from one repository to another) before any work starts; and a fork made
before October 2026 also lacked the connector's settings until someone
pressed Sync fork. ADR-005 took out copy and paste. The fork was what was
left.

What GitHub allows, as of 2026-10-05:

- **A GitHub App can fork for someone only with a standing grant.**
  GitHub's "Create a fork" endpoint works with GitHub Apps, but "the
  GitHub App must be installed on the destination account with access to
  all repositories"
  ([reference](https://docs.github.com/en/rest/repos/forks#create-a-fork)).
  For FORGE's sign-in App ([ADR-003](ADR-003-github-app-signin.md)),
  which has no repository permission at all, that would mean every
  contributor installing it on their whole account, every repository
  included, for as long as it stays installed.
- **An OAuth App can, with one scope.** A classic OAuth App's
  `public_repo` scope gives "read/write access to code, commit statuses,
  repository projects, collaborators, and deployment statuses for public
  repositories and organizations"
  ([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
  That covers making a fork of a public repository, syncing it
  (`merge-upstream`), creating a branch in it and opening a pull request
  from it, as the user. FORGE gets such a token only through the web flow,
  while the person is at the browser, and GitHub takes PKCE (S256) from
  OAuth Apps
  ([web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
- **The scope is wide, and the token lasts.** `public_repo` reaches every
  public repository the person can write to, not only the one FORGE
  needs. An OAuth App's token doesn't expire unless the app opts in to
  expiring tokens: it ends when the app revokes it
  (`DELETE /applications/{client_id}/token`, with the app's own client id
  and secret), when the person removes the app in their settings, which
  revokes every token it holds, when GitHub drops it because the same
  person, app and scope have more than ten (an unused or the least
  recently used one goes first), or after a year unused
  ([revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation),
  [app tokens](https://docs.github.com/en/rest/apps/oauth-applications)).
- **GitHub keeps the approval.** Revoking a token leaves the person's
  authorization of the app in place; only deleting the grant, or the
  person removing the app, ends it. GitHub normally doesn't show its page
  again to someone who approved the app before (ADR-005 expects the same
  of the Copilot rail's one-time authorization); the live test checks it.

What FORGE had to build on:

- **One-time tokens.** The Copilot rail already asks GitHub for a token at
  each start, checks it is the signed-in account's, spends it on that one
  start and revokes it (ADR-005).
- **The Bridge's pull request rules.** It matches a pull request to a
  claim, holds the claim while that pull request is open, counts its merge,
  and reads GitHub publicly (`services/github_reads.py`).
- **The protocol rules.** `.github/forge-protocol.json` declares where
  tests live (`testGlobs`) and which paths only the core team may change
  (`protectedPaths`). Foreman's G0 and the Gauntlet's test-mod detector
  both read it.
- **G0 wants the attestation.** Foreman's G0 closes a pull request whose
  description lacks the pull request template's test attestation, checked
  ("- [x] I did not modify or delete any existing file under
  `tests/acceptance/` or any other pre-existing test. …"). A pull request
  FORGE opens has to carry it, and in the contributor's name it may only
  say it when it is true.

## Decision

**Three steps on the task page, and "fork" in none of them.** Once you
hold the claim, the task page shows:

1. **Your copy.** "FORGE makes your own copy of FORGE's code on GitHub for
   your agent to work in. GitHub asks you once to allow it." and **Get
   started**. Afterwards: "Your copy is ready: <owner/name>, up to date
   <time ago>." and a quiet **Refresh your copy**, which does it again.
2. **Your agent.** ADR-005's Start it for me and Open my agent, pointed
   at the copy. Before step 1 they still work, for someone who forked by
   hand, with "Your agent needs your copy first: press Get started above."
3. **Send for review.** Once the agent has pushed, FORGE checks the change
   and opens the pull request in the contributor's name, and the usual
   stages follow it.

Only step 1's closed "What's this?" says what GitHub calls it: a fork. The
agents' setup steps and setup errors, the start line and `/connect` say
"copy" too; the brief, which an agent reads, names the fork once.

**FORGE's own OAuth App, one token per press.** Each press is one round
trip through GitHub:

1. The button posts a form to `POST /auth/github/repo` with the task and
   the action: `copy` for Get started and Refresh your copy, `review` for
   Send for review. Same-origin only, a GitHub sign-in only (never the
   practice account), and only while the OAuth App is set up.
2. The web server seals a `repo` attempt (a fresh state and PKCE verifier,
   the task and the action) into the transaction cookie, a third kind
   beside sign-in and agent attempts, and sends the browser to GitHub's
   authorize page for the OAuth App: `scope=public_repo` and nothing wider
   (fixed in `@forge/auth`), PKCE S256, `allow_signup=false`.
3. `GET /auth/github/repo/callback` spends the attempt (one use), compares
   the state in constant time, exchanges the code with the OAuth App's
   credentials and the verifier, and uses the token once: `GET /user` must
   name the signed-in account, then the API does the one action with it,
   and then the token is revoked with the OAuth App's own credentials,
   whatever happened. The browser lands back on the sealed task's page,
   which says what happened in one plain sentence.

The token is never stored, logged, put in a URL or a cookie, or sent
anywhere but GitHub and FORGE's API, whose two routes for it the browser
can't reach. The sign-in GitHub App is unchanged and still has no
repository permission. The OAuth App is a separate registration: the web
server refuses to use the sign-in App's client id for it.

**What the API does with the token, and nothing else.**
`POST /api/bridge/copy` and `POST /api/bridge/review` act only for the
person holding the task (an active claim, or one held past its clock by
its open pull request), at most 10 times an hour each per person, counted
before GitHub is asked and failed ones included. Each first checks with
`GET /user` that the token is the caller's own account. Every call goes to
`https://api.github.com` and nowhere else, follows no redirect and keeps no
cookie, and these are the only calls:

| Action | GitHub calls, in order |
|---|---|
| Get started, Refresh your copy | `GET /user`; `POST /repos/verastd/forge-app/forks` (`default_branch_only`); `GET /repos/{copy}`, every 2 seconds for up to 15 while GitHub makes a new copy; `POST /repos/{copy}/merge-upstream`; `GET /repos/verastd/forge-app/git/ref/heads/main`; `GET /repos/{copy}/git/ref/heads/{branch}`; `POST /repos/{copy}/git/refs` when the branch is missing (and, when GitHub refuses upstream's commit there, `GET /repos/{copy}/git/ref/heads/{its default branch}` to start from that instead) |
| Send for review | `GET /user`; `GET /repos/verastd/forge-app/compare/main...{owner}:{branch}?per_page=1`; `GET /repos/verastd/forge-app/pulls?head={owner}:{branch}&base=main&state=open`; `POST /repos/verastd/forge-app/pulls` |

- **The copy has to be theirs.** GitHub answers a fork request with the
  copy the person already has, if any, possibly under another name
  (`forge-app-1`). Before any write FORGE checks that it is owned by the
  caller and is a fork whose parent is `verastd/forge-app` itself:
  `merge-upstream` syncs with the parent, so a fork of someone else's fork
  would bring in theirs.
- **Nobody's work is reset.** `merge-upstream` brings the copy's main up
  to date, or can't because it has changes of its own, which stops
  nothing. The task's branch is made at upstream main's latest commit only
  when it is missing, and a branch that is there is left as it is. FORGE
  never overwrites or deletes a ref, and pushes no commit.
- **One pull request per claim, and only the contributor's own.** A claim
  that already has an open pull request gets it back. An open pull request
  from the task's branch is returned when the contributor opened it, and
  refused (`409 head_taken`) when anyone else did: anyone can open a pull
  request from a public fork's branch.

**FORGE checks the diff before it sends anything.** The comparison's first
page gives the commits ahead, the changed files and the head commit it was
made at, and the main commit it was made against. FORGE reads the rules
from `.github/forge-protocol.json` at that very commit (so a change to the
rules is never checked against older ones; no base commit means
`503 checks_unavailable`), publicly, never from the branch and never with
the contributor's token, and refuses before any write:

- `409 too_large` when GitHub can't show the whole diff (300 files, its
  cap, or a comparison over 8 MiB) or the diff changes more than 20,000
  lines, Foreman's G0.4 cap;
- `409 tests_modified` when a file matching `testGlobs` was changed in any
  way but being added: modified, removed, renamed (both names count),
  copied, or a status GitHub adds later. New test files are welcome;
- `409 protected_paths` when any name in the diff is under
  `protectedPaths`, read as Foreman reads them: a trailing `/` is a
  directory, anything else one exact path, and case counts;
- `503 checks_unavailable` when the rules can't be read, aren't a
  manifest Foreman would take, or use glob syntax that minimatch (Foreman)
  and git (the detector) could read differently.

FORGE's glob matcher is held by a test to minimatch's and git's answers on
the manifest's own patterns. On tests FORGE is stricter than G0, which only
flags a changed test: FORGE won't send one at all, because the attestation
it writes would then be false.

**The pull request FORGE writes.** The title is `[#N] <task title>`, with
`"` as `'`, as the brief asks. The description is FORGE's own lines and the
task's text, never anything an agent or a member wrote, with FORGE's lines
first, because G0 takes the first match of each thing it looks for:

```text
Closes #N

## Tests

- [x] I did not modify or delete any existing file under `tests/acceptance/` or any other pre-existing test. Any new tests I added are new files, not edits to existing ones. FORGE checked the diff at <commit> before sending it.

## AI-assistance disclosure

- [x] This PR was produced with the assistance of a coding agent / LLM.

## Summary

Sent for review through FORGE by @<login>; their agent did the work.

FORGE task #N: <task title>
<task link>

## Acceptance criteria

- <criterion>
```

The attestation is the template's line, word for word and checked, and
then the commit FORGE checked (seven characters of the head the comparison
was made at). FORGE writes it only once the diff has passed, so what it
says in the contributor's name is what FORGE verified of that commit. If
the branch moves between the check and the pull request, the timeline says
so. The task's title, link and criteria are neutralised so they can't
speak for FORGE: one line each, `&` escaped first, a zero-width space after
every `@` and between `#` and a digit (no mention, no issue reference), and
`<` and `[` escaped (no HTML comment or tag, no checkbox, no link). The
pull request lets maintainers edit it. Next to the button, the page tells
the contributor what it will say for them.

**Recorded like any other pull request.** FORGE records the pull request
for the claim through the Bridge's own rules, so the stages, the hold while
it is open and the merge count work as they do for one an agent opened.
The claim is checked again just before the pull request is opened, and the
timeline says "Sent for review: pull request #N." only once it is
recorded. One rule changed for every pull request: it counts for a claim
only when the holder opened it, not only when it comes from their fork.

**The brief follows the copy.** With a copy, the agent works in it, on the
branch FORGE made, pushes, and tells FORGE; "the person sends it for review
from the task page", and an agent that can open pull requests may still
open one itself. Without one, the brief asks the person to press Get
started first, and an agent that can fork may fork. The start rails, the
Open my agent links and the connector name the copy once FORGE knows it,
else `<login>/forge-app`.

**Time.** The callback is a Vercel function with 60 seconds. The API gives
each GitHub call 8 seconds (5 to connect) and a whole action 40, its claim
lookup and public reads included. The web waits at most 45, less whatever
the code exchange took, so 12 are always left for the revocation.

**Practice.** The practice app goes through all three steps in the browser,
says each one is pretend, and sends nothing.

## Decided while building

The reviews found places where the contract, or the code as first built,
would have opened, attested or recorded the wrong thing. The orchestrator
decided, and the code follows:

- **FORGE checks the diff, then attests.** The contract's description left
  out the template's attestation, so G0 would have closed every pull
  request FORGE sent. The contributor can't vouch for what their agent did,
  and FORGE can't vouch blind, so FORGE checks the diff against the rules
  G0 and the detector use and writes the line only then, naming the commit.
  The size cap and the fail-closed cases (commits with no changed files are
  `no_changes`; an unknown status, and `copied`, count as a change) came
  with the reviews.
- **Only the holder's own pull request.** As first built, any open pull
  request from the branch was taken as the contributor's, including one a
  stranger opened from the contributor's public branch with a forged
  attestation, and FORGE could then never open the real one. Now that is
  `head_taken`, and every pull request needs the holder as its author.
- **A copy follows its repository, not its name.** After a GitHub rename
  the old name can be registered by anyone, and FORGE would have kept
  naming `oldlogin/forge-app` to every agent, which would clone it and
  follow its `AGENTS.md`. A first fix compared the stored name with the
  person's login, but that login is the session's, sealed at sign-in for
  up to 7 days. So FORGE now records the copy's repository id and its
  owner's id, finds its current name by id (a public read, cached 5
  minutes), and names it only while GitHub says it is a fork of
  `verastd/forge-app` owned by the person's GitHub id.
- **FORGE's lines first, and the task text can't speak.** A title with
  "closes #3" in it, or a criterion starting "I did not modify", would
  have been read by G0 ahead of FORGE's own lines.
- **The commit is named,** because the branch can move between the check
  and the pull request.
- **Only a direct fork of `verastd/forge-app`**, so a sync never brings in
  a third party's commits.
- **One pull request per claim, and the claim checked again** before the
  write.
- **The copy note is the holder's.** "FORGE set up your copy, <owner/name>,
  and the branch <branch>." speaks to the holder and names their fork, so
  only they see it on the timeline.
- **40 seconds per action, 60 for the callback.** Vercel can't be assumed
  above 60 seconds.
- **The revocation starts at once.** Handed to Next's `after()` as a
  function, it would only have run once the connection closed, which had
  already happened when the person left while FORGE waited on GitHub: the
  token would have stayed live with nothing logged. It now starts as soon
  as the action is over, `after()` keeps the function alive until GitHub
  answers, and the log says either way.
- **No "fork" anywhere a contributor reads**, except "What's this?".

## Consequences

- **ADR-005 is amended.** FORGE now forks, branches and opens pull
  requests, always as the contributor, on a button they press, with a
  token good for that one action. It still never writes code: every commit
  is the agent's, and the only ref FORGE makes is the task's branch, at
  upstream main's latest commit (or at the copy's own main, which the page
  then says). It opens a pull request only when the person presses Send
  for review, never because an agent reported the work done. What reaches
  upstream is still a fork pull request, through the same G0 and Gauntlet,
  and FORGE still holds no merge or deploy authority.
- **What the contributor approves.** GitHub's page names FORGE's OAuth App
  and its owner, and asks for the person's public repositories, read and
  write. That is GitHub's `public_repo`: every public repository they can
  write to, and their organizations' too unless an organization restricts
  OAuth Apps (GitHub lists those organizations; FORGE needs none of them,
  since the copy is made in the person's own account). FORGE uses far
  less, and only its own code holds it to that: one action per token, the
  calls above on `verastd/forge-app` and the caller's own copy, and the
  token revoked as soon as the action is over. GitHub keeps the approval
  itself (FORGE revokes each token, not the authorization), so later
  presses come straight back, and the person can remove it under Settings
  → Applications → Authorized OAuth Apps; the next press asks again.
- **Revocation.** On every path that got a token, success or not, FORGE
  revokes it with the OAuth App's client id and secret and logs "repo
  authorization: one-time GitHub token revoked", or a warning that GitHub
  didn't confirm it; never the token. A token whose revocation failed
  (GitHub down, the function stopped first) is still good: nobody holds it,
  since it was never stored or logged, but it doesn't expire. It ends when
  the person removes FORGE's OAuth App, when GitHub drops it once the same
  person, app and scope have more than ten, or after a year unused. The
  person's GitHub security log should show each token made and then
  deleted; live test 11 checks.
- **A new worst case.** Whoever controls FORGE's web server or its API
  while people press these buttons gets their tokens, each good for every
  public repository that person can write to until they remove FORGE's
  OAuth App. ADR-005's worst case (every saved vendor key, misleading task
  text to connected agents) stands beside it. That is why the routes,
  `services/copies.py` and every file the token passes through are
  protected paths, and why FORGE asks for a token per press rather than
  keeping one. After the first approval GitHub shows no page, so the
  same-origin check is what stops a script on FORGE's origin from pressing
  the buttons for someone.
- **The check is only as strong as the manifest.** FORGE vouches for what
  `.github/forge-protocol.json` covers. The API review found the Gauntlet's
  own gates outside it: the `Makefile` and the gate scripts in `tools/forge/`
  run from the pull request's own checkout, so a pull request could rewrite
  the checks run on itself, and FORGE would have attested it. Both are
  protected paths now (the four gate files by name, so the `forge` CLI beside
  them stays open to contributors),
  and so is FORGE's own checking code, `services/copies.py` and
  `services/github_reads.py`. A test runner's config added as a new file
  (a `conftest.py`, a `pytest.ini`) is an addition, which neither FORGE nor
  the detector counts as a changed test.
- **Foreman's claim linkage is still missing, and FORGE now opens the
  pull request.** Bridge claims are not Foreman's `/claim` leases
  (ADR-005). Once Foreman runs on forge-app, G0 closes a pull request
  FORGE sent for a fixture task ("task #N is not claimed") and ledgers a
  strike against its author, who is the contributor. The two have to be
  joined, or G0 taught about Bridge claims, before Send for review is used
  with Foreman live.
- **`Closes #10001` names no GitHub issue.** FORGE writes `Closes #N` as
  the brief asks. A task published from a proposal (numbered from 10001)
  has no issue, so G0 can't read a Task Spec for it, and once forge-app's
  own numbers reach 10001 a merge would close an unrelated issue
  ([ADR-006](ADR-006-proposals.md)'s caveat, now in FORGE's own words).
- **An agent's bot pull request isn't the holder's.** Since only the
  holder's own pull request counts, one an agent's bot account opens
  upstream for them (the agent bots Foreman allows) isn't tracked by the
  stages, can't be handed in (`403 not_your_pr`), and, while it is open
  from the task's branch, makes Send for review answer `head_taken`.
  Start-rail agents normally open theirs inside the fork; live tests 1 and
  3 check where. Tracking them needs a list of agent bots in the API, a
  configuration decision not made yet.
- **Sixty seconds.** Vercel can't be assumed above 60 seconds for the
  callback, so a new copy gets 15 seconds for GitHub to make it
  (`copy_not_ready` otherwise; pressing again is safe, since GitHub hands
  back the copy it made), and every action keeps within 40 on the API.
  When the web stops waiting first, the page says it may have gone through,
  and the API may finish it anyway. If the platform stops the function
  before GitHub confirms the revocation, the token stays live, as above.
- **GitHub's own token limits.** GitHub keeps at most ten tokens per
  person, app and scope, and creates at most ten an hour, while FORGE
  allows ten copies and ten reviews an hour. Someone who presses more than
  ten times in an hour may meet GitHub's limit first, as "GitHub didn't
  finish the approval".
- **The API can't tell the feature is off.** It doesn't know whether the
  web server has the OAuth App, so with the settings unset the brief still
  asks for Get started (and tells an agent that can fork to fork), and so
  does every agent's first setup step ("Press Get started on the task
  page, and FORGE makes your copy of its code."), whose link then lands on
  step 1's "Setting up your copy isn't available yet."
- **When GitHub can't say, the stored name stands in.** If GitHub can't be
  read, FORGE names the copy it stored only while its owner id is the
  person's and it is still named after the session's login. Someone who
  renamed their GitHub account and hasn't signed in to FORGE since can
  then be pointed at the old name for the minute or two until GitHub
  answers again. Before any copy exists, FORGE names `<login>/forge-app`
  from the session's login, as it did before Phase 7.
- **Not live-tested yet:** GitHub's approval page and whether it is
  skipped after the first approval, the fork, sync, branch and pull
  request as a real account, the revocation, and how GitHub renders the
  neutralised task text ([`live-tests.md`](../live-tests.md), test 11).
- **No migration.** Phase 7's two tables, `bridge_copies` and
  `bridge_repo_actions`, are new, so a Phase 6 state database gains them
  at the API's next start and keeps everything else. A revert to Phase 6
  needs the `copy_ready` and `review_sent` timeline lines deleted first:
  Phase 6 can't read them.
