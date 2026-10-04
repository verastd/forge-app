# ADR-005: Agent hand-off without copy and paste — start rails, open rails and the FORGE connector

Why the Contribute page hands a task to a contributor's own agent by
starting it through the vendor's API, or by opening it with the task
already typed in, and why both lean on an MCP server of FORGE's own, the
FORGE connector, instead of a copy box. Source: FORGE Phase 4 (Contribute
hand-off v2), decided with the operator on 2026-10-01. Every vendor fact
below was read in the vendor's own documentation on 2026-10-01; preview
APIs change, so check them again before relying on one.

## Status

Accepted (Phase 4). The start rails ship switched off (`agent_start` off,
`FORGE_START_RAILS` empty) and are turned on one at a time as each passes
its live test in [`live-tests.md`](../live-tests.md). Supersedes the
"guided handoff" (copy, open the agent, paste) design in PRD Appendix I.3
(as verified Aug 2026); the PRD, in the private core repo, has its
Appendix I revised to match.

## Context

Until now the Bridge simulated every dispatch and showed the compiled
prompt in a copy box on every rail. On 2026-10-01 the operator rejected
copy and paste: the people the Bridge is for (PRD persona P2b, who may
never have used git) shouldn't have to carry a long prompt from one app to
another on a phone, and a pasted prompt can't tell FORGE anything back, so
the task page can't follow the work.

What the vendors allow, as of 2026-10-01:

- **Starting an agent through an API, on the user's own account.** GitHub
  Copilot's agent tasks API, in public preview: a GitHub App *user* token
  or a fine-grained token with the "Agent tasks" repository permission,
  `X-GitHub-Api-Version: 2026-03-10`, and Copilot Pro, Pro+ and Max since
  2026-06-04
  ([reference](https://docs.github.com/en/rest/agent-tasks/agent-tasks),
  [changelog](https://github.blog/changelog/2026-06-04-agent-tasks-rest-api-now-available-for-copilot-pro-pro-and-max/)).
  Jules sessions with an API key, v1alpha
  ([reference](https://jules.google/docs/api/reference/)). Cursor cloud
  agents v1; v0, which the PRD named, is legacy
  ([reference](https://cursor.com/docs/cloud-agent/api/endpoints)). Devin
  v3; v1 and v2 are deprecated
  ([overview](https://docs.devin.ai/api-reference/overview.md)). OpenHands
  Cloud V1; V0 was removed on 2026-04-01
  ([reference](https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md)).
  And a Claude Code routine's fire endpoint, a research preview, which runs
  on the user's Claude plan once they have created the routine
  ([docs](https://code.claude.com/docs/en/routines.md)).
- **No start API for the most-used subscriptions.** Anthropic does not let
  third parties offer claude.ai sign-in or subscription limits
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)).
  Codex Cloud has no public task API, and "Sign in with ChatGPT" for hosted
  apps needs OpenAI's approval
  ([docs](https://developers.openai.com/siwc/token-sharing-open-source)).
  GitHub's Agent HQ runs Claude and Codex on a Copilot plan, but no API lets
  a third party choose them
  ([docs](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)).
  Antigravity has no API, task endpoint or link scheme.
- **Links that open an agent with the task typed in**, where the user
  presses send: Claude Code on the web (`claude.ai/code?prompt=…`, with
  `prompt_url` for long text)
  ([docs](https://code.claude.com/docs/en/claude-code-on-the-web.md)),
  Claude Code on a computer (`claude-cli://open`, 5,000 characters)
  ([docs](https://code.claude.com/docs/en/deep-links.md)), the Codex
  desktop app (`codex://new`)
  ([docs](https://learn.chatgpt.com/docs/reference/commands#deep-links)),
  VS Code 1.140's agents window (`vscode://agents/new`)
  ([docs](https://code.visualstudio.com/docs/configure/command-line)) and
  Cursor (`cursor://anysphere.cursor-deeplink/prompt`, 10,000 characters)
  ([docs](https://cursor.com/docs/reference/deeplinks)). Codex Cloud on the
  web and Jules have none.
- **MCP servers with OAuth.** Claude (custom connectors, on every plan),
  Codex (CLI, IDE extension and desktop app), Antigravity, VS Code, Cursor
  and ChatGPT's developer mode all connect to a remote MCP server and sign
  in with OAuth; all but claude.ai and ChatGPT, which connect from their
  own settings, also read the server from a file in the repo
  ([Claude Code](https://code.claude.com/docs/en/mcp),
  [Codex](https://learn.chatgpt.com/docs/extend/mcp),
  [Antigravity](https://antigravity.google/docs/mcp),
  [Cursor](https://cursor.com/docs/mcp),
  [VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)).
  Codex Cloud can't, the Copilot cloud agent takes remote servers with
  header secrets only, not OAuth
  ([docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)),
  and Jules offers a curated list only.
- **Google.** Gemini CLI stopped serving free, Google AI Pro and Ultra users
  on 2026-06-18 and Antigravity CLI replaced it for them; paid Gemini API
  keys and Gemini Code Assist Standard and Enterprise keep it
  ([announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli)).
  The consumer Gemini Code Assist GitHub app, which only reviewed code, shut
  down on 2026-07-17. Google's ways in are now Jules (an API) and
  Antigravity (MCP).

## Decision

Four options were weighed:

| | Copy and paste (the beta) | Prefill links only | Vendor APIs only | Connector, APIs and links (chosen) |
|---|---|---|---|---|
| What the contributor does | Copy, switch apps, paste, send | Tap, then send | Tap (after a one-time key) | Tap for a start rail; tap and send for an open rail |
| Agents covered | Any | Claude Code, Codex app, VS Code, Cursor | Copilot, Jules, Cursor, Devin, OpenHands, Claude routines | All of those, plus Antigravity and any MCP client |
| FORGE sees progress | No | No | What the vendor's API reports | Yes: agents report through the connector, and start rails return a session link |
| Failed checks reach the agent | Pasted back by hand | Pasted back by hand | As a follow-up, where the vendor allows one | The agent reads them itself, or FORGE relays them to a start rail |
| Credentials FORGE keeps | None | None | Vendor keys | Vendor keys, only when asked and encrypted; connector tokens, hashed |
| Weak spots | Long prompts on phones; the step the operator rejected | Length caps; no link for Jules, Antigravity or Codex Cloud | Preview APIs; leaves out Claude and Codex subscriptions | Everything on the left, each with a fallback; more to build and secure |

**Two buttons, no copy box.** Once you hold a claim, the task page offers
**Start it for me** and **Open my agent**. Copy and paste survives only as
a closed "Using another agent? Copy the brief" fallback, for agents FORGE
doesn't know.

**Start rails run on the contributor's own account.** For Copilot, Jules,
Cursor, Devin, OpenHands and a Claude Code routine, FORGE calls the
vendor's API with the contributor's own credential and the agent works in
their fork, on their plan, so FORGE still pays for no agent time (bring
your own agent holds). Copilot needs nothing pasted: a one-time GitHub
authorization at each start, used for that one start and then revoked. The
other rails take a key, which FORGE uses for the call the person asked for
and keeps only if they tick "Remember it" (the box starts unticked).

**Open rails are links built from one brief.** Claude Code (web and
computer), the Codex app, VS Code's agents window and the Cursor app open
with the brief typed in; the contributor presses send. Antigravity has no
link, so its steps say to open the fork in Antigravity (after Sync fork on
GitHub, for a fork older than October 2026), sign in to FORGE the first
time, and ask it "Start FORGE task #N"; because it works only through the
connector, it is offered only while the connector is on. Every rail, start
or open, gets the same brief, built by one function in each language and
held byte-identical by a shared golden fixture.

**The FORGE connector.** An MCP server at `<web origin>/mcp`, protected by
OAuth 2.1 (dynamic client registration, PKCE, a consent screen behind
GitHub sign-in), with the tools an agent needs to work a task alone:
`get_task`, `claim_task`, `report_progress`, `get_check_results`,
`submit_task`, plus `whoami`, `list_tasks` and `release_task`. It is
hand-written JSON-RPC with no new dependency, stateless, and lives on the
web origin through rewrites, so its address survives the API moving.
[`architecture.md`](../architecture.md#the-forge-connector) has the flow.

**The repo tells agents where the connector is.** `.codex/config.toml`,
`.agents/mcp_config.json` and `.cursor/mcp.json` name the connector, so an
agent opened in a fork finds it, and `AGENTS.md` gains a short "Working on
a FORGE task" section for any agent. `.mcp.json` (Claude Code, and VS Code
1.140+) is part of this decision, but the repo doesn't include `.mcp.json`
yet; until it does, add the connector to Claude Code with
`claude mcp add --transport http forge <url>` (or press VS Code's button on
`/connect`). There is no `.vscode/mcp.json`: VS Code 1.140 calls it
deprecated and reads `.mcp.json`. Two custom agents, for GitHub Copilot
(`.github/agents/forge.agent.md`) and Antigravity
(`.agents/agents/forge.md`), carry the same task flow and are never a
maintainer's default: each runs only when someone picks it.

**Google: Jules and Antigravity.** Jules is a start rail; Antigravity is an
open rail that works through the connector. Gemini CLI is dropped as a
rail. `.gemini/settings.json` stays, because Gemini CLI still reads it for
the people who keep Gemini CLI.

**Off until live-tested.** Each start rail is coded against its vendor's
documentation and unit-tested against the documented requests and
responses, but none has run against a real account. The `agent_start` flag
and the `FORGE_START_RAILS` allowlist keep all six off until the operator
runs [`live-tests.md`](../live-tests.md); the connector itself ships on
(`mcp_connector`), since it acts only for people who connect it.

## Trust posture, against PRD Appendix I.5

| | PRD I.5 (Aug 2026) | Now |
|---|---|---|
| GitHub tokens | OAuth user tokens, encrypted at rest | None stored. Sign-in drops its token after one read ([ADR-003](ADR-003-github-app-signin.md)). The Copilot rail asks GitHub for a one-time authorization at each start (GitHub may not show a page to someone who approved FORGE before); the token is used for that start and then revoked (`DELETE /applications/{client_id}/token`) |
| Vendor keys | Encrypted, per user, revocable in the app | Saved only when the person ticks "Remember it" (unticked to start with); AES-256-GCM under a per-person key derived from `FORGE_VAULT_KEY`; only a hint is ever shown back; removable on `/me`, even with the Bridge or the vault switched off; deleted when a vendor rejects it at a start, or answers 401 to a relay (a 403 keeps it); check notes are relayed only with the saved key that started the session, compared by a keyed fingerprint; a key that no longer opens reads as not saved, and no read deletes it; no vault at all unless the key is set. The code a key or the Copilot token passes through (`apps/web/src/lib/{api,bff-forward,handoff}.ts`, `apps/web/src/components/contribute/`, and the API's `services/bridge.py`, `routers/bridge.py`, `models.py`, `main.py`, `services/vault.py` and `services/rail_adapters/`) is a protected path |
| Agents acting on FORGE | Not part of the design | Connector tokens: scope `forge.tasks` only, stored as SHA-256 hashes, 5-minute single-use codes, 1-hour access and 30-day refresh that rotates; an old refresh token reused within 30 seconds is a retry and gets a fresh pair, once, and any further reuse revokes the grant; a grant keeps at most 5 live refresh tokens; one connected agent gets 120 calls a minute, whichever of its tokens it uses; every connection listed on `/me` with Disconnect while the connector is on (with it or GitHub sign-in off, no token works) |
| What steers agents | Not covered (`AGENTS.md`, `CLAUDE.md` and `.gemini/` were already protected paths) | Also protected: every agent config file (`.codex/`, `.agents/`, `.cursor/`, and `.mcp.json`, `.vscode/` and `.claude/`, which the repo doesn't include yet), the brief, the rail registry, the connector's tools, the `/connect` page, the launch links and the task fixtures, because a pull request that repoints the connector would phish every contributor, and one that rewrites a task would reach every agent given it |
| Worst case | Open fork pull requests and claim tasks as Bridge users | Still only fork pull requests reach upstream. New: the state database plus `FORGE_VAULT_KEY` yields every saved vendor key, each good for whatever that vendor account can reach; and whoever controls the API can send connected agents misleading task text |
| Unchanged | No repo write access, no Foreman admin surface, no deploy or merge | Same |

## Consequences

- **A database.** Claims, hand-offs, progress, saved keys and connector
  grants live in one SQLite file on the API box (`FORGE_STATE_DB_PATH`),
  which has to sit on a disk that survives a redeploy and be backed up.
  One API process on one box is the design; scaling out means moving it.
  It has no migrations yet: after an upgrade that changes its tables, the
  file is deleted, so connected agents connect again and saved keys are
  entered again.
- **Two new secrets.** `FORGE_OAUTH_SECRET` signs client registrations and
  `FORGE_VAULT_KEY` encrypts saved keys. Both are generated on the API box
  and never pasted anywhere else. Changing the first makes every connected
  agent connect again; changing the second makes every saved key
  unreadable, so it reads as not saved until its owner enters it again
  (nothing is deleted: the old rows stay stored, unused, until replaced,
  and open again if the old value comes back).
- **Preview APIs move under us.** Copilot's tasks API is in public preview,
  Jules is v1alpha, Cursor's API is in beta and routines are a research
  preview. Each adapter names the documentation it was written against, a
  vendor change shows up as `rail_failed` with the status rather than a
  broken page, and `FORGE_START_RAILS` switches off one rail without a
  deploy.
- **The connector's address is load-bearing.** It is written into every
  agent config file and every contributor's agent, so it lives on the web
  origin (`FORGE_PUBLIC_ORIGIN`) rather than on the API. Moving the web
  origin means a protected-path pull request to the agent config and every
  contributor connecting again.
- **The connector is a way into contributors' agents.** What FORGE returns
  is text an agent reads and may act on, so it is limited to task data:
  the brief, criteria, status and check notes. Agents' own approval prompts
  and the brief's rules (only this fork and branch, never `.github/` or the
  agent config, never secrets) are the other half. In the other direction,
  everything an agent writes is untrusted: capped, stripped of control
  characters and shown as plain text.
- **Not live-tested yet:** all six start rails, including Copilot on a
  fork, whether FORGE's GitHub App can be given the "Agent tasks"
  permission, whether a Copilot task keeps running once FORGE revokes its
  one-time token, and where Jules's automatic pull request lands; Claude
  Code on the web using the connector; Antigravity 2.0 reading
  `.agents/mcp_config.json`. Asking Claude or Codex through `@claude` or
  `@codex` comments on a fork's pull request is a candidate, not built.
- **Bridge claims and Foreman's `/claim` are separate.** A claim made on
  the Contribute page, or with `claim_task`, lives in FORGE's database;
  Foreman's G0 reads `/claim` leases on GitHub. Until they are joined, a
  Bridge contributor's pull request would fail G0's claim check once
  Foreman runs.
