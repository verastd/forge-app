# Security Policy

How to report a vulnerability in FORGE. Source: PRD §4 Stage 0 ("Security reports"), §5 T5.

## Reporting

Report suspected vulnerabilities using **GitHub private vulnerability
reporting** on this repository (Security tab -> "Report a vulnerability").

Do **not** open a public issue or Discussion for a suspected vulnerability,
and do not post details anywhere public (including Discord) before it is
resolved. Public disclosure of an unpatched issue is itself treated as a
security incident.

Private vulnerability reporting is enabled on this repository.

## What to include

- Affected component/path and, if known, commit or PR.
- Steps to reproduce, or a minimal proof of concept.
- Impact as you understand it (what an attacker gains).
- Whether you've shared this with anyone else.

## Response SLO

The core team targets an initial response within **72 hours**. Response
means acknowledgment and triage, not resolution — fix timelines depend on
severity and are communicated in the advisory thread.

## Rewards

Security reports are, initially, **unpaid**. This is a deliberate,
hard-learned choice, not an oversight: a paid public vulnerability program
attracts low-effort/AI-generated submissions faster than any other surface
(curl ended its bounty in January 2026 for exactly this reason — see PRD
§13). If a paid program launches later, it will be announced here and will
remain private-reporting-only.

## Supported scope

FORGE is in **beta**. There is no older supported version line; report
against `main` / whatever is currently deployed to staging or beta. Nothing
is in production yet (see `README.md` "Project status").

### Sign-in and session code is security-critical, and explicitly in scope

The GitHub sign-in flow and everything that seals, opens or trusts a
session are a priority target for review, precisely because a flaw there
can impersonate any visitor rather than misbehave for one. This is the
hand-written code ADR-003 describes (`docs/adr/ADR-003-github-app-signin.md`),
plus the agent hand-off and the FORGE connector that ADR-005 adds
(`docs/adr/ADR-005-agent-handoff.md`):

- `packages/auth/` — PKCE, session/transaction sealing and opening, the
  API assertion, and revoking Copilot's one-time GitHub token.
- `apps/web/src/app/auth/` — the `/auth/signin`, `/auth/callback`,
  `/auth/signout` and `/auth/demo` routes, and `/auth/github/agent`, the
  one-time GitHub authorization that starts Copilot on a contributor's
  fork (spent on that one start, never stored, then revoked). After a
  GitHub sign-in the callback also records the new member with the API
  (`members-hello.ts`).
- `apps/web/src/app/bff/` (with `apps/web/src/lib/bff-forward.ts`, which
  does the minting) — the same-origin proxy that mints the API assertion
  for `/apps/data`'s data, the Contribute page's Bridge calls, the
  connected-agents list, every action on the Propose floor and the bell.
- `apps/web/src/app/api/lobby/` — the lobby's LiveKit room-token route,
  which signs who each voice and name tag in the Apps lobby belongs to.
- `apps/web/src/middleware.ts` — the `/me`, `/apps/data`,
  `/oauth/authorize` and `/propose/new` sign-in gate.
- `apps/web/src/lib/session.ts` and `apps/web/src/lib/auth/` — the session
  helpers, the Origin check, and where every secret is read from the
  environment.
- `apps/web/src/lib/mode.ts` and `apps/web/next.config.mjs` — whether the
  build offers the practice account at all (fixed at build time), and the
  security headers.
- `apps/api/src/forge_api/services/identity.py` — where the API verifies
  that assertion, and the `FORGE_ADMIN_IDS` operator check, which also
  decides who may switch the Propose floor's Test timers, end a debate or
  close a vote early, publish a passed proposal as a Contribute task, and
  ask the house model for a new draft of it.
- `.gitleaksignore` — fingerprints the secret scan skips (known false
  positives only). Core-owned, so no PR can suppress a finding about itself.
- `AGENTS.md`, `CLAUDE.md` and `.gemini/` — the operating manual coding
  agents follow, and the files they load as their instructions, each
  pointing at `AGENTS.md`. Core-owned, so no PR can rewrite what every
  contributor's agent reads.
- `.codex/`, `.agents/`, `.cursor/` and `.github/agents/` — agent config:
  they tell every contributor's agent where the FORGE connector is, and
  the custom agents in `.agents/agents/` and `.github/agents/` how to work
  a task, so a PR that repoints them would phish every contributor.
  `.mcp.json`, `.vscode/` and `.claude/` are protected the same way; the
  repo doesn't include any of them yet.
- `apps/api/src/forge_api/services/oauth.py`, `services/mcp_server.py`,
  `routers/oauth.py`, `routers/mcp.py` and `apps/web/src/app/oauth/` — the
  FORGE connector: its OAuth server (registration, consent, tokens,
  revocation), the consent page, and the MCP server that acts for a
  connected agent.
- `apps/api/src/forge_api/services/vault.py` and `services/rail_adapters/`
  — the encrypted store of contributors' saved agent keys, and the only
  code that sends a key (or Copilot's one-time GitHub authorization) to a
  vendor.
- `apps/web/src/lib/bff-forward.ts`, `apps/web/src/lib/api.ts`,
  `apps/web/src/lib/handoff.ts`, `apps/web/src/components/contribute/`,
  `apps/api/src/forge_api/services/bridge.py`, `routers/bridge.py`,
  `models.py` and `main.py` — every place a pasted or saved agent key, or
  the Copilot token, passes through on its way to the vault or a vendor
  (the form, the browser's request, the BFF, the API's dispatch and relay),
  and the checks on the session and key links shown back.
- `apps/web/src/app/connect/`, `apps/web/src/lib/launch.ts`, the brief
  (`packages/shared/src/brief.ts`, `services/brief.py`), the rail registry
  (`packages/shared/src/rails.ts`, `services/rails.py`), the connector's
  tools (`services/bridge_mcp.py`) and the task fixtures
  (`apps/api/src/forge_api/fixtures/`) — what every agent is told, and the
  links that send people to an agent or a key page.

These same paths are cold-account-owned in `CODEOWNERS` and listed in
`.github/forge-protocol.json`'s `protectedPaths`, so a PR touching them
needs a sign-in to the hardware-2FA cold account to merge (see
`CODEOWNERS`'s own header for exactly what that does and doesn't buy). A
report against any of them gets priority triage within the response SLO
above.

### The Propose floor's rules are in scope too

`apps/api/src/forge_api/services/proposals.py`, `services/members.py`,
`services/notifications.py` and their routers (`routers/proposals.py`,
`routers/members.py`, `routers/notifications.py`) decide who may second,
consent, object, vote and publish on the Propose floor (the API makes
every one of those checks, never only the page), whose notifications each
member sees, and what a passed proposal's Contribute task says, which
becomes the brief every contributor's agent is given. A way to act as
someone else, vote outside a proposal's eligible set, publish without being
an admin, read someone else's notifications, or get text past the admin
into a published task is worth a report. Like the paths above, they are
protected paths: a pull request that changes them needs the cold account's
review (`CODEOWNERS`, `.github/forge-protocol.json`).

Known and accepted for the pilot, so not worth a report: anyone signed in
with GitHub takes part, throwaway accounts included; consents and votes are
public by name; and an admin is trusted with the text of the tasks they
publish ([ADR-006](docs/adr/ADR-006-proposals.md)).

### The house model is in scope too

When a proposal passes, FORGE's house model drafts its task: the API sends
the proposal and files from this repository to an Anthropic model and
cleans the spec it writes ([ADR-007](docs/adr/ADR-007-house-model.md)).

- **It reads untrusted text, and its output is advisory.** What it reads
  first is what members wrote: a proposal's title, pitch and the debate's
  newest comments (50 at most, and at most 5 from any one member), which
  anyone signed in with GitHub can write. The API fences that text as
  data, in a fence named afresh for every request, one JSON object per
  line, with every `<`, `>` and `&` in it replaced, so no member text can
  close the fence or pass itself off as another entry or author; and the
  system prompt tells the model to ignore any instruction in it and note
  the attempt as a risk. That makes a pitch harder to steer the house
  with; it doesn't make it impossible, which is why nothing the house
  writes is acted on by itself. The API cleans what comes back: a scope
  entry that reaches a protected path, or isn't a plain repository path,
  is moved out of scope with a risk line; a key-shaped string is replaced
  with `[removed]`; and each link, email address, @mention and
  download-and-run command gets a risk line for the admin.
- **An admin publishes.** The house never publishes. Its spec fills a draft
  task nobody has saved yet, and it goes on the Contribute board only when
  an admin (`FORGE_ADMIN_IDS`) has checked it and pressed Publish to the
  board. Members never see the house's draft, only a line on the
  proposal's timeline.
- **It never sees secrets.** It reads only the files git tracks in the
  repository checkout the API runs from, so nothing a deploy left beside
  them, read-only: root-level `*.md`, and `apps/`, `packages/`, `docs/`,
  `tests/`, `tools/` and `config/`, for source and text extensions only
  (`.py`, `.ts`, `.tsx`, `.js`, `.mjs`, `.md`, `.json`, `.css`, `.toml`,
  `.yml`, `.yaml`). The walk skips the directories `node_modules`, `dist`,
  `build`, `coverage`, `.venv`, `__pycache__`, `public`, `test-results`
  and `playwright-report`, and every directory whose name starts with a
  dot (`.git`, `.next*` and the rest). It skips every file whose name
  starts with `.env` or contains `secret`, in any case, every `*.pem` and
  `*.key`, every file over 64 KB, and every name that could break the
  prompt. It opens each file by walking down from the checkout one
  directory at a time, following no symlink, refuses anything but a
  regular file and any file with another hard link, and reads nothing
  outside the checkout. Without the checkout's protected-path list
  (`.github/forge-protocol.json`'s `protectedPaths`) it drafts nothing.
  From the state database it reads only the proposal and its comments,
  and nothing from the API's environment ever reaches a prompt; git,
  which lists the files, gets none of it but its `PATH`.
- **The key lives only in the box's env file.** `ANTHROPIC_API_KEY` is
  pasted by the operator into the API box's environment file, and nowhere
  else: not this repository, CI, the web app's hosting, a chat or an
  issue. FORGE sends it only to Anthropic's API. It never logs the key, a
  prompt or member text: an unexpected error is logged by its kind only,
  and Anthropic's SDK and its HTTP client are held at WARNING, since at
  DEBUG they print whole requests. Without the key the house is off.

Its code, its eval and the eval's cases are protected paths,
cold-account-owned in `CODEOWNERS` and listed in `.github/forge-protocol.json`'s
`protectedPaths`: `apps/api/src/forge_api/services/house.py` (the prompt,
what it reads and how it cleans a spec),
`apps/api/src/forge_api/tools/house_eval.py` and
`apps/api/tests/fixtures/house-eval/` (the bar a model has to pass). A way
to make the house read a secret, a file git doesn't track or a file
outside the checkout, leak its key, get its text onto the board without
an admin, or run more jobs than its daily cap is worth a report.

Known and accepted, so not worth a report: a pitch can still steer what the
house writes (the admin, who reads every line before publishing, is the
control); and what it sends to Anthropic (the proposal, its comments with their authors'
logins, and files from this public repository) is public already.

## What is actually enforced today

So a reporter does not spend time on a control we already know is
missing, the headlines:

- **Sensitive-path review is cold-account approval, not two-person
  control.** `CODEOWNERS` lists `@verastd` and `@forge-cold` on `.github/`,
  `CODEOWNERS` itself, `contracts/`, `packages/contracts-client/`, the
  `auth*`/`pay*` routers, and every path listed above, but GitHub accepts an
  approval from any one listed owner and
  both accounts belong to the same person. What it buys is a forced
  sign-in to a hardware-2FA account — friction against a stolen session.
  It is not independent review, and it does not constrain a compromised or
  mistaken operator. Reports that turn on that distinction are welcome;
  reports that it exists are already known.
- **The Gauntlet's unprivileged layer is live** (`hygiene`, `tests`,
  `security`, `e2e`), and G0's protocol checks are implemented in Foreman.
  G4, G5, and G6 are designed and not built. Foreman is not yet registered
  as a GitHub App, so nothing is processing real webhooks.
- **Push rulesets cannot be imported on a public repository**, so the
  large-file and banned-extension blocks documented in the PRD are caught
  in the PR by CI, not before a push.
- **Nothing pays out.** The reward ledger records `payable`; there is no
  payout execution, so there is no money-movement surface to attack yet.

## Coordinated disclosure

The core team will work with reporters on a disclosure timeline once a fix
is available. Credit is offered by default (name/handle in the advisory and
release notes) unless the reporter asks to stay anonymous.
