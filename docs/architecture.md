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
| `apps/web` | Next.js 15 App Router, TypeScript strict. The app itself, including the Bridge's `/contribute` surface, GitHub sign-in (`src/app/auth/`, `src/app/bff/`), the FORGE connector's consent page (`src/app/oauth/`) and setup page (`src/app/connect/`), and the Apps lobby at `/apps` (`src/components/lobby/`, with its LiveKit token route in `src/app/api/lobby/`) | `@verastd`; `src/app/auth/`, `src/app/bff/`, `src/app/oauth/`, `src/app/connect/`, `src/app/api/lobby/`, `src/middleware.ts`, `src/lib/session.ts`, `src/lib/auth/`, `src/lib/launch.ts`, `src/lib/mode.ts` and `next.config.mjs` need cold-account approval | beta — live and demo builds both work end to end; no unit-test runner yet, so it's exempt from the changed-line coverage gate | Open to all tiers per task; the cold-account sub-paths above are effectively T2+ in practice |
| `apps/api` | FastAPI (Python 3.12, `uv`), package `forge_api`. App backend, the Bridge's server-side service and the FORGE connector (OAuth + MCP) | `@verastd`; `routers/auth*`, `routers/pay*`, `routers/oauth.py`, `routers/mcp.py`, `services/identity.py`, `services/oauth.py`, `services/mcp_server.py`, `services/vault.py`, `services/rail_adapters/`, `services/bridge_mcp.py`, `services/brief.py` and `services/rails.py` need cold-account approval | beta — `health`, `flags`, `bridge`, `oauth`, `mcp`, and `upland`/`upland_scrape` routers are live, each with pytest coverage; `auth*`/`pay*` don't exist yet (identity verification lives in `services/identity.py`, consumed by the `upland` and `bridge` routers' dependencies, not a dedicated router) | `auth*`/`pay*`/`services/identity.py` and the connector, vault, rail and brief paths: cold-account approval, effectively T2+ in practice |
| `packages/shared` | zod schemas — reference copy of the web/API contract, hand-mirrored and test-locked against `apps/api`'s Pydantic models; also the rail registry (`src/rails.ts`) and the brief every agent gets (`src/brief.ts`), mirrored by `services/rails.py` and `services/brief.py` and held to golden fixtures in `tests/fixtures/` | `@verastd`; `src/rails.ts` and `src/brief.ts` need cold-account approval | stable — schemas populated, mirrored field-for-field by `models.py`, locked by contract tests | Open; `src/rails.ts` and `src/brief.ts`: cold-account approval |
| `packages/auth` | Sign-in with GitHub: PKCE, sealed session/transaction cookies, the API assertion. Built on `jose` and Web Crypto only (no `node:` imports), so Next's Edge middleware can import it — see [ADR-003](adr/ADR-003-github-app-signin.md) | `@verastd` `@forge-cold` (cold-account approval) | stable — 100% coverage enforced in `vitest.config.ts`, includes the RFC 7636 PKCE test vector | **Tier floor T2** |
| `packages/flags` | Feature-flag client; layered load, fail-closed. `config/flags.json` -> `FORGE_FLAGS_PATH` -> `FORGE_FLAGS_JSON` | `@verastd` | stable — `csv_export`, `contribute_bridge`, `upland_data`, `github_signin`, `apps_lobby`, `mcp_connector` (the FORGE connector) and `agent_start` (FORGE starting agents through vendor APIs; off in `config/flags.json` until those rails pass their live tests), all real gates | Open |
| `packages/lobby` | The Apps lobby's pure logic: the wall's geometry, the free-roam camera and how it is saved, the app registry and the rules every entry must pass (slots, routes, and the sandbox and CSP for framed apps), which page chrome a route gets, and the presence packet, ranges and name rules. No DOM, no three.js and no runtime dependencies (its `tsconfig.json` and `eslint.config.mjs` enforce it) — see [ADR-004](adr/ADR-004-apps-lobby.md) | `@verastd` | stable — unit-tested in Node at full line coverage; the framed-app rules are enforced, though nothing framed ships yet | Open |
| `packages/contracts-client` | The only module allowed to import a chain SDK. Mock-only isolation layer | `@verastd` `@forge-cold` (cold-account approval) | experimental — mock-only; `mode: 'live'` throws, no chain wiring | **Tier floor T2** |
| `contracts/` | On-chain code, if any lands in-repo | `@verastd` `@forge-cold` (cold-account approval) | placeholder — no contract source yet | **Tier floor T2** |
| `tests/acceptance/issue-<N>/` | Per-task acceptance tests, one directory per issue | Spec author (core team, or a T3 steward once delegated) | stable pattern, structurally enforced by G0 and the Gauntlet | Never written by the implementer |
| `tests/e2e` | Playwright end-to-end tests, one project per build (demo + live) | `@verastd` | stable | Open |
| `tools/forge` | The `forge` CLI (`tasks`/`claim`/`status`) and the Gauntlet's gate scripts (`check-lockfile-diff.sh`, `coverage-gate.sh` + `changed_line_coverage.py`, `test-mod-detector.sh`) | `@verastd` | stable — all three gates enforce | Open |
| `.github/workflows` | `gauntlet.yml` (the four unprivileged jobs: `hygiene`/`tests`/`security`/`e2e`), `foreman-annotate.yml` (privileged: posts the merge decision brief once the Gauntlet finishes, never checks out fork code), plus `agents-md-lint.yml` and `deploy-staging.yml` | `@verastd` `@forge-cold` (cold-account approval via CODEOWNERS on `.github/`) | beta — the four Gauntlet jobs run and are merge-queue-safe; G0 runs inside Foreman and doesn't post its own commit status here yet | T3-only |
| `.github/rulesets` | Importable branch-protection ruleset JSON (`main-protection.json`) | `@verastd` `@forge-cold` | beta — schema is current, not yet imported into a live repo | Cold-account approval |
| Agent config: `.mcp.json`, `.codex/`, `.agents/`, `.cursor/`, `.github/agents/`, `.gemini/`, `CLAUDE.md` | Points contributors' agents at `AGENTS.md` and the FORGE connector (see [The FORGE connector](#the-forge-connector)) | `@verastd` `@forge-cold` (cold-account approval) | beta — each file follows its client's docs as read on 2026-10-01; Antigravity 2.0 and Claude Code on the web are still to be live-tested ([`live-tests.md`](live-tests.md)) | T3-only (protected paths) |
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

## Identity

GitHub sign-in (FORGE v0.2 Phase 1; see [ADR-003](adr/ADR-003-github-app-signin.md)
for why it's an in-house flow on a dedicated GitHub App). Nothing here is a
database: every fact about who's signed in lives in one encrypted cookie the
browser holds, sealed and opened by `packages/auth`.

**The sign-in flow.**

1. `GET /auth/signin?next=` mints a `state` and a PKCE verifier/challenge
   pair, seals `{state, verifier, next}` into the short-lived transaction
   cookie (10 minutes, `Path=/`), and 302s to
   `https://github.com/login/oauth/authorize` with `code_challenge_method=S256`
   and no `scope` — a GitHub App's permissions come from its own registration,
   and `GET /user` needs none. In production that cookie is
   `__Host-forge_oauth`, like the session's `__Host-forge_session`: the
   prefix (which requires `Secure`, `Path=/` and no `Domain`) stops a sibling
   subdomain or an HTTP man-in-the-middle from planting their own sign-in
   attempt in a visitor's browser, which would sign the visitor in as them
   (login CSRF). Under `next dev`, which has no HTTPS, both cookies drop the
   prefix: `forge_oauth` and `forge_session`.
2. GitHub redirects back to `GET /auth/callback` with `code` and `state` (or
   an `error`, e.g. `access_denied`, if the visitor declined). The callback
   opens the transaction cookie, compares `state` in constant time, exchanges
   `code` plus the PKCE verifier for a user access token, calls `GET /user`
   once, and drops the token — no GitHub token is ever stored.
3. The result is sealed into the session cookie (JWE, `alg: dir`,
   `enc: A256GCM`; claims: GitHub id, login, display name, avatar URL,
   `demo: false`) and set with a 7-day absolute lifetime. The transaction
   cookie is cleared on every path out of the callback, success or failure.
   `middleware.ts` gates `/me/:path*` and `/apps/data/:path*` on a valid session,
   redirecting to `/signin?next=<path>` otherwise.

No database, no server-side session store, and no way to revoke one session
without changing a secret that revokes every session (see Operations below).

**How the Data app reaches the API.** The browser never calls FastAPI
directly for Upland data. It calls the same origin's
`/bff/upland/*` (`apps/web/src/app/bff/upland/[...path]/route.ts`), which
checks the session, mints a 60-second HS256 assertion
(`iss: forge-web`, `aud: forge-api`, `sub`/`login` from the session), and
forwards to `${FORGE_API_URL}/api/upland/...`. Every `/api/upland/*` route
on the FastAPI side verifies that assertion through `require_identity` (and
`require_admin` for the scrape/GCS control routes) — a fresh assertion is
minted on every BFF call, never cached or reused. Each router's dependency
order is fixed and produces a specific status in this order: the
`upland_data` flag first (404 `upland-disabled` if it's off), then identity
(401 `unauthenticated`), then admin (403 `admin_only`) where it applies, and
on the CSV export its own `csv_export` flag (403 `flag_disabled`, with no
`WWW-Authenticate` challenge: signing in again can't change it). A
demo session never reaches this path: the BFF 401s it before minting
anything, because a practice account is nobody on GitHub for the API to
serve. What comes back to the browser is upstream's status and body with
three headers only, whatever upstream sends: `Content-Type` when it is JSON
or CSV (anything else becomes `application/octet-stream`, so nothing
upstream says is HTML ever renders on this origin), `Content-Disposition`,
and `Cache-Control: private, no-store`.

**The demo practice account.** A build with `NEXT_PUBLIC_FORGE_DEMO=1` offers
`POST /auth/demo` (404 in every other build) instead of GitHub: it seals
`{sub: 'demo', login: 'you', name: 'Practice account', demo: true}` under the
same session mechanism. A demo session passes the middleware gate — the
practice account can look at `/me` and `/apps/data`'s pages — but, as above,
can never mint an API assertion, so under a demo session every `/apps/data`
page shows the sign-in card in place of data: the practice account can't open
the Data app because it isn't tied to a real GitHub account, and the card
offers no button, since no sign-in on this build changes that.

Practice sign-in is decided when the app is built, never at runtime.
Next only inlines a `NEXT_PUBLIC_*` variable that is set at compile time,
so `next.config.mjs` lists `NEXT_PUBLIC_FORGE_DEMO` under `env`, which
inlines it always (as `''` when unset): setting it on a running live
deployment changes nothing. And a live build refuses practice sessions
outright: the middleware, `getSession()` and the BFF all treat one as
signed out, even if it was sealed under the server's own secret.

**The development secret.** `next dev` with `FORGE_SESSION_SECRET` unset
(or empty) seals sessions with a hard-coded, public secret
(`DEV_SESSION_SECRET` in `packages/auth`), so a fresh checkout of the demo
build can use the practice account with no setup. Anyone can seal a cookie
under a public secret, so it is practice-only:

- Only practice sessions count under it. A GitHub-shaped session sealed
  with it is treated as signed out, and GitHub sign-in is unavailable.
- The BFF never mints an assertion while it is in use: every
  `/bff/upland/*` call answers `503 {"error": "not_configured"}`.
- The fallback happens only under `next dev`, and never when
  `FORGE_SESSION_SECRET` is set but shorter than 32 characters. That case
  disables sign-in in every mode and logs `FORGE_SESSION_SECRET is set but
  shorter than 32 characters; sign-in is disabled` once per server process
  (the Edge middleware may log it once more).
- Set on purpose as `FORGE_SESSION_SECRET`, in any mode, the public value
  gets exactly the same practice-only treatment. As
  `FORGE_SESSION_SECRET_PREVIOUS` it is dropped, so it can never open a
  real session.

The rules are one pure function, `resolveSessionKeys` in
`packages/auth/src/keys.ts`, with its own unit tests.

**Environment variables.**

| Variable | Used by | Required? | Constraints |
|---|---|---|---|
| `GITHUB_APP_CLIENT_ID` | web — `lib/auth/config.ts`'s `githubAppConfig()` | For real GitHub sign-in | The GitHub App's client ID; sign-in reads as `'unavailable'` without it |
| `GITHUB_APP_CLIENT_SECRET` | web, same | For real GitHub sign-in | Never sent to the browser or logged; only used server-side in the `/auth/callback` code exchange |
| `GITHUB_APP_SLUG` | web — the Copilot rail's "Install FORGE's GitHub app on your fork" link (`https://github.com/apps/<slug>/installations/new`) | For that link; unset hides it | The App's URL name, as in `https://github.com/apps/<slug>`. Server-side only: handed to the page as a prop, never `NEXT_PUBLIC_*` |
| `FORGE_PUBLIC_ORIGIN` | web — `publicOrigin()` (the OAuth `redirect_uri`, the callback's final redirect) and `isTrustedOrigin()` (the Origin check on `POST /auth/signout`, `POST /auth/demo`, `POST /bff/upland/*` and the other state-changing routes); API — the FORGE connector's public URLs (the OAuth metadata, the `iss` it sends back, the `<origin>/mcp` resource every token is bound to) and the Origin check on `/mcp` | Web: required outside `next dev`; optional in `next dev` only, where an unset value falls back to the request's own origin. API: required for the connector, which answers `503 connector_unavailable` without it | An `http(s)` URL with no path, query, fragment or credentials, e.g. `https://forge.example` (not `.../` ) — a set-but-invalid value refuses every state-changing request rather than guessing. On the API it must also be `https`, except `http` on a loopback host (`http://localhost:3000`) for development; anything else answers `503 connector_unavailable`. The same value on web and API: production is `https://forge-app-eta-mocha.vercel.app`; it is the connector's OAuth issuer and its address is this plus `/mcp`, so changing it disconnects every agent |
| `FORGE_SESSION_SECRET` | web — seals and (with `_PREVIOUS`) opens session and transaction cookies | Required outside `next dev` | >= 32 characters, ASCII (`MIN_SECRET_LENGTH` in `@forge/auth`). Unset or empty under `next dev` only: the public dev secret, for practice sessions only, and the BFF never mints (see The development secret, above). Set but shorter than 32 characters: sign-in is disabled in every mode, with one logged warning |
| `FORGE_SESSION_SECRET_PREVIOUS` | web, same | Optional | Same constraints; set only while rotating (see Operations) |
| `FORGE_API_ASSERTION_SECRET` | web — mints the BFF's assertion; API — `verify_assertion` checks it | Required for `/apps/data` to work end to end; its absence (or weakness) on the web side answers `503 not_configured` rather than pretending the Data app is merely down | >= 32 characters, ASCII, used exactly as stored (not trimmed); must be byte-for-byte identical on web and API |
| `FORGE_API_URL` | web — `apiUrl()`, where the BFF forwards `/bff/upland/*` and `/bff/bridge/*`; and `next.config.mjs`, which rewrites the connector's paths (`/mcp`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`, `/.well-known/oauth-*`, and the fallback `/register` and `/token`) to it | Optional for the BFF; required for the connector | Defaults to `http://localhost:8000` for the BFF. The rewrites are written when the app is built, and only if this is set to an absolute `http(s)` URL: set it in Vercel before the build, or the connector's paths 404 on the web origin |
| `NEXT_PUBLIC_FORGE_DEMO` | web — `lib/mode.ts`'s `isDemoMode()`, read at build time only | Optional | `1` when building makes the demo build (practice sign-in, fixtures); anything else, or unset, a live build. Inlined by `next.config.mjs`'s `env`, so the value at runtime is ignored |
| `FORGE_ADMIN_IDS` | API — the admin check behind `require_admin` | Optional | Comma-separated numeric GitHub user ids (not logins), each matching `^[1-9][0-9]{0,19}$`; entries trimmed, blanks ignored; unset means nobody is admin. One invalid entry makes nobody admin, with one logged warning |
| `LIVEKIT_URL` | web — the lobby's token route (`src/app/api/lobby/token/route.ts`), which hands it to the browser with each token (see [The Apps lobby](#the-apps-lobby)) | For presence and voice in the Apps lobby; without all three LiveKit settings the route answers `503 voice_unavailable` and the lobby works alone | A `wss:`, `ws:`, `https:` or `http:` URL with no credentials, e.g. `wss://<project>.livekit.cloud`; anything else counts as unset. Server-side only, never `NEXT_PUBLIC_*`. Read on every request, so a build without it still succeeds |
| `LIVEKIT_API_KEY` | web, same — the key each token is issued under | Same | The LiveKit project's API key. Server-side only |
| `LIVEKIT_API_SECRET` | web, same — signs each token | Same | The LiveKit project's API secret. Server-side only: never sent to the browser or logged |
| `FORGE_OAUTH_SECRET` | API — signs the FORGE connector's client registrations and derives confidential clients' secrets (`services/oauth.py`; see [The FORGE connector](#the-forge-connector)) | For the connector; unset, or shorter than 32 characters, answers `503 connector_unavailable` | >= 32 characters. Generate it on the API box itself (`openssl rand -base64 32`) and never paste it anywhere; FORGE never sends or logs it. Changing it invalidates every registered client, so connected agents have to connect again |
| `FORGE_STATE_DB_PATH` | API — the state database: the Bridge's claims and timeline, saved agent keys, and the connector's grants and token hashes (`services/state.py`; see [State, keys and GitHub reads](#state-keys-and-github-reads)) | Optional; set it in production | A file path, created on demand. Defaults to `var/forge-state.db` in the repo (git-ignored). Production: `/var/lib/forge-api/forge.db`, on a disk that survives a redeploy |
| `FORGE_VAULT_KEY` | API — encrypts the agent keys people ask FORGE to remember (`services/vault.py`) | Optional; without it nothing is saved and keys are typed in at each start | Base64 of 32 random bytes; generate it on the API box (`openssl rand -base64 32`). Surrounding whitespace is ignored. Unset or malformed turns the vault off (`vault: false` in `GET /api/bridge/rails`); a malformed value also logs one warning, which never includes the value. Changing it makes every saved key unreadable, so people enter them again |
| `FORGE_START_RAILS` | API — which start rails may run (`GET /api/bridge/rails`, `POST /api/bridge/dispatch`) | Optional | Comma-separated rail ids from `copilot`, `jules`, `cursor`, `devin`, `openhands`, `claude-routine` (case and spaces don't matter; unknown ids are ignored); unset or empty means none. A rail runs only when it is listed here AND the `agent_start` flag is on. Add a rail only after it passes its live test ([`live-tests.md`](live-tests.md)) |
| `FORGE_MAX_ACTIVE_CLAIMS` | API — how many tasks one person may hold at once | Optional | An integer from 1 to 100; unset or anything else means 2. One more claim answers `409 claim_limit` |
| `FORGE_MCP_ALLOWED_ORIGINS` | API — the Origin check on `/mcp` | Optional | Comma-separated origins (`https://host`), allowed besides `FORGE_PUBLIC_ORIGIN` and the hosted clients' origins FORGE always accepts (listed under [The FORGE connector](#the-forge-connector)). Agents running outside a browser send no `Origin` and are unaffected; a request whose `Origin` is in none of these, or is `null`, gets `403` |
| `FORGE_GITHUB_READ_TOKEN` | API — the GitHub reads behind status, check results, submission, the fork check and the GitHub task source (`services/github_reads.py`) | Optional in development; needed in production | A fine-grained token with read-only access to public repositories and no write permission of any kind, created by the operator and set on the API box by the operator, never pasted anywhere else; it raises GitHub's limit from 60 to 5,000 requests an hour. Without it the reads are anonymous: 60 an hour per IP, and every task someone is watching can cost two reads a minute (its pull request and its checks, each cached 60 seconds), so a few watched tasks use the hour up and status and checks fall back to "couldn't reach GitHub". The API reads only this variable, never a `GITHUB_TOKEN` that happens to be in its environment |
| `FORGE_TASK_SOURCE` | API — where the Bridge's tasks come from | Optional | `github` reads open issues labelled `agent-ready` + `status:open` from `verastd/forge-app` (cached 5 minutes); anything else, or unset, uses the checked-in fixture tasks |

**Operations.**

- **Rotating `FORGE_SESSION_SECRET`.** Move the current value to
  `FORGE_SESSION_SECRET_PREVIOUS` and set a new current value: existing
  sessions keep working (`openSession` tries the current secret, then the
  previous one) while every newly-sealed session already uses the new
  secret. Drop `_PREVIOUS` once the old secret's 7-day session lifetime has
  fully elapsed. Replacing the current secret outright, with no `_PREVIOUS`,
  signs everyone out at once — sometimes that's the point (a suspected leak),
  but it's a blunt instrument.
- **No individual revocation.** There is no server-side session store to
  delete a row from, so a single compromised session cannot be revoked on
  its own before its 7-day lifetime is up — only a full secret rotation
  (everyone signed out) reaches it. Real GitHub sign-in still lets a person
  revoke FORGE's *GitHub* access at
  <https://github.com/settings/apps/authorizations> (linked from
  `/me/settings`), which matters for the GitHub App relationship but doesn't
  end an existing FORGE session cookie by itself.
- **`FORGE_ADMIN_IDS` is by GitHub user id, not login.** A login can be
  renamed and the old name registered by someone else; the numeric id
  stays with the account. To find an operator's id, fetch
  `https://api.github.com/users/<login>`, whose JSON carries it as `id`.
  The check compares that id with the assertion's `sub`, so renaming an
  admin account changes nothing. A typo fails closed: one entry that isn't
  an id (a login, say) means nobody is admin until it is fixed, and the API
  logs one warning saying so.

**Deployment note.** The web server evaluates the `github_signin` flag with
`loadFlags()` (see Flags flow, below), which needs the nearest
`config/flags.json` (found by walking up from the working directory) or
`FORGE_FLAGS_JSON`/`FORGE_FLAGS_PATH`. A deployment that ships neither has
`github_signin` read as off — fail-closed, same as every other flag — so
`/signin` falls back to `'unavailable'` even with a complete GitHub App
config in the environment.

## The Bridge

The Bridge is the in-app client for the same pipeline GitHub-native
contributors use: [`/contribute`](../apps/web/src/app/contribute) in the
web app and `/api/bridge/*` in the API. It is not a separate system. The
work happens in the contributor's own fork, by their own agent, on their
own account, and reaches upstream as an ordinary pull request that goes
through the same Gauntlet as everyone else's. FORGE never pays for an
agent, never pushes code and never opens a pull request for anyone: the
agent does that. How a task reaches the agent without copy and paste is
[ADR-005](adr/ADR-005-agent-handoff.md).

**Components:**

- [`apps/web`'s `/contribute`](../apps/web/src/app/contribute): the task
  board, and a task page that, once you hold the claim, offers two ways to
  hand the task to your agent (below) and then follows it: the stage, a
  short timeline of what FORGE and the agent reported, the pull request and
  its checks, and "Notes for your agent" when checks fail. What the agent
  wrote is shown only to the person holding the task; everyone else sees
  FORGE's own entries, because agent text on a public page would be a way
  to deface it. Calls that need
  to know who you are go through the same-origin BFF (`/bff/bridge/*`),
  which mints the API assertion exactly as `/bff/upland/*` does (see
  [Identity](#identity)); a practice session never gets one. Your saved
  agent keys and connected agents are on [`/me`](../apps/web/src/app/me).
  Every `/contribute` screen hangs off
  [`layout.tsx`](../apps/web/src/app/contribute/layout.tsx), the
  `contribute_bridge` kill switch: flag off (or unreachable — flags fail
  closed) and the whole surface is a plain-language notice instead.
- `apps/api`'s Bridge service
  ([`routers/bridge.py`](../apps/api/src/forge_api/routers/bridge.py),
  `services/bridge.py`): tasks, claims, hand-offs, the progress timeline,
  check results and submission, kept in the state database (see
  [State, keys and GitHub reads](#state-keys-and-github-reads)). The
  caller is identified by the BFF's assertion on the web's side and by an
  OAuth token on the connector's. One person may hold
  `FORGE_MAX_ACTIVE_CLAIMS` tasks at once (default 2). The stage comes
  only from real signals: *claimed* (the claim alone), *agent working* (a
  hand-off or an agent's report), *ready to submit* (the agent says it
  pushed or opened the pull request, but none is found upstream yet), *in
  checks* (an upstream pull request whose checks are pending or failing),
  *in review* (every check passed), *shipped* (merged). Status shows the
  newest 50 events, and events an agent sent (`source: "agent"`) only to
  the holder. The same flag 404s every route with
  `{"error": "bridge-disabled"}`.
- Tasks come from the checked-in fixtures unless `FORGE_TASK_SOURCE=github`,
  which reads open issues labelled `agent-ready` + `status:open` from
  `verastd/forge-app`.
- Not built: FORGE doesn't fork, branch or open pull requests for anyone
  (the agent works in a fork the contributor already has, and the only
  GitHub write FORGE makes is starting Copilot, on the contributor's
  one-time authorization), and there are no webhooks, notifications or
  retries. **Not joined
  yet:** the Bridge's claims live in FORGE's own database, while Foreman's
  G0 claim check reads `/claim` leases on GitHub, so once Foreman runs, a
  Bridge contributor's pull request fails claim linkage until the two are
  joined. The Bridge holds no merge or deploy authority of any kind and
  never will.

**Demo mode versus live mode.**
[`apps/web/src/lib/mode.ts`](../apps/web/src/lib/mode.ts) is the single
reader of `NEXT_PUBLIC_FORGE_DEMO`; the variable is inlined at build time
(`next.config.mjs` lists it under `env`, so it is inlined even when unset),
so the live app and the demo app are different build artifacts.

| | Live (default, deployed) | Demo (`NEXT_PUBLIC_FORGE_DEMO=1`) |
|---|---|---|
| Read fails | typed error, per-page error state with retry | falls back to local fixtures |
| Write fails (claim/hand-off/feedback) | throws, nothing on screen moves | simulated |
| Status polling | holds the last server-reported stage | advances the simulation |
| "Start it for me" | FORGE calls the vendor | nothing is sent, and the page says so ("Practice: nothing was sent") |
| "Open my agent" | real links | real links |
| `contribute_bridge` off | Bridge closed | forced open (demonstrating it is the job) |
| Labeling | none needed | persistent banner: practice data, nothing real or saved |

A 409 (already claimed) behaves the same in both — a real answer from a
healthy server. There's no durable outbox and no retry daemon, so live
mode never tells a contributor their claim will sync later; it says the
claim didn't happen, because it didn't.

**Handing a task to an agent.** One registry lists every agent in display
order, mirrored in Python (`services/rails.py`) and TypeScript
(`packages/shared/src/rails.ts`) and held to
`tests/fixtures/rails-golden.json`. Every agent gets the same text, the
*brief* (`services/brief.py` and `packages/shared/src/brief.ts`,
byte-identical, held to `tests/fixtures/brief-golden.json`): the task and
why it matters, when it's done, the fork and branch to work in, the rules,
how to open the pull request, and which FORGE tools to call if the agent
has them. Once you hold the claim, the task page offers two buttons.

**Start it for me** (start rails): FORGE calls the vendor's API and the
agent starts in the contributor's fork, on their own account and plan. A
rail runs only when the `agent_start` flag is on AND its id is in the API's
`FORGE_START_RAILS` (empty by default), and each one stays off until it
passes its live test ([`live-tests.md`](live-tests.md)). The calls, as
documented by each vendor on 2026-10-01:

| Rail | What FORGE calls | What the contributor needs |
|---|---|---|
| GitHub Copilot | `POST https://api.github.com/agents/repos/{login}/forge-app/tasks` with `X-GitHub-Api-Version: 2026-03-10` (public preview) | Copilot Pro, Pro+, Max, Business or Enterprise, and FORGE's GitHub app installed on the fork. Nothing to paste: a one-time GitHub authorization for each start, used for that one call and never stored |
| Google Jules | `POST https://jules.googleapis.com/v1alpha/sessions` | The Jules GitHub app on the fork, and an API key from <https://jules.google.com/settings> |
| Cursor cloud agent | `POST https://api.cursor.com/v1/agents` | A paid Cursor plan with GitHub connected, and an API key from <https://cursor.com/dashboard> (Integrations) |
| Devin | `POST https://api.devin.ai/v3/organizations/{org_id}/sessions` | GitHub connected in Devin, and an API key and organization ID from <https://app.devin.ai/settings> |
| OpenHands Cloud | `POST https://app.all-hands.dev/api/v1/app-conversations` | GitHub connected at <https://app.all-hands.dev>, and an API key from its settings |
| Claude Code routine | `POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire` with `anthropic-version: 2023-06-01` and `anthropic-beta: experimental-cc-routine-2026-04-01` (research preview) | A routine they create once in Claude Code for their fork, with FORGE's routine prompt and an API trigger: its URL and token |

A start rail's key is used for the one vendor call the contributor asked
for, and is never logged or echoed (`/dispatch` reads its own body, so not
even a validation error repeats it). If they tick "Remember it" (offered
only while the vault is on) it is saved encrypted; otherwise it is dropped
after the call. Before any vendor call, `/dispatch` answers
`400 rail_disabled`, `400 credential_required` (no key sent and none
saved), `400 credential_invalid` (the key's shape, Devin's organization ID
or the routine's URL) or `429 dispatch_limit` with `Retry-After`: vendor
calls, meaning starts and check notes relayed to an agent, failed ones
included, are limited to 10 per person per hour. Then the vendor's answer:
`400 credential_rejected` when it refuses the key (a saved key it rejected
is deleted), `400 rail_setup_needed` with a plain sentence about what to
connect when the fork or the vendor's app isn't set up (Copilot's 403 and
404 mean this), and `502 rail_failed` with the vendor's status for anything
else. A body over 16 KB answers `413 body_too_large`, any other malformed
one `422 invalid_request`.

**Open my agent** (open rails): a link that opens the agent with the brief
already typed in; the contributor presses send. Always on.

| Rail | How it opens |
|---|---|
| Claude Code on the web | `https://claude.ai/code?prompt=<brief>&repositories=<login>/forge-app`. When that would pass 7,000 characters, `prompt_url=` points at the API's `GET /api/bridge/tasks/<id>/brief?login=<login>` instead (plain text, readable from any origin) |
| Claude Code on your computer | `claude-cli://open?repo=<login>/forge-app&q=<brief>` (5,000-character cap; over it the link opens without the brief and the steps say "ask it: Start FORGE task #N") |
| Codex app | `codex://new?prompt=<brief>&originUrl=https://github.com/<login>/forge-app.git` (the desktop app, with the fork cloned) |
| VS Code agents | `vscode://agents/new?prompt=<brief>` (VS Code 1.140 or newer; the contributor picks Copilot, Claude or Codex and sends) |
| Cursor app | `cursor://anysphere.cursor-deeplink/prompt?text=<brief>` (10,000-character cap) |
| Google Antigravity | No link exists: open the fork in Antigravity and ask it "Start FORGE task #N"; the connector is already set up in the repo |

An agent opened this way has the brief; with the FORGE connector (below) it
can also claim, report progress and read check results by itself. Copy and
paste survives only as a closed "Using another agent? Copy the brief"
fallback.

The Bridge changes the pipeline's *reachability*, never its
*permeability*: whatever reaches upstream is a fork pull request, which
lands in the same Gauntlet and protocol checks that already assume hostile
authors. A full compromise of FORGE is still worse for contributors than it
used to be. Whoever holds the state database and `FORGE_VAULT_KEY` holds
every saved vendor key, and each works on whatever that vendor account can
reach, not only the fork; whoever controls the API can send connected agents
misleading task text. That is why keys are saved only when asked, can be
removed on `/me`, and are encrypted under a key that lives only on the API
box; why no GitHub token is ever stored; and why the agent config and the
connector, vault and rail code are protected paths.

## The FORGE connector

An MCP server with OAuth, so a contributor's own agent can read a task,
claim it, report progress, read check results and submit the pull request
by itself: nothing is pasted, and the task page shows what the agent
reports. Claude (claude.ai, the desktop app, Claude Code), Codex,
Antigravity, Cursor, VS Code and ChatGPT's developer mode can connect; the
GitHub Copilot cloud agent and Jules can't, and don't need to, because
FORGE starts them. [ADR-005](adr/ADR-005-agent-handoff.md) has the
reasoning.

**One public address.** Every public URL lives on the web origin
(`FORGE_PUBLIC_ORIGIN`, production `https://forge-app-eta-mocha.vercel.app`),
so the connector's address, `<origin>/mcp`, survives the API moving
elsewhere. `next.config.mjs` rewrites (`beforeFiles`) the protocol paths to
the same path on `FORGE_API_URL`; the pages a person sees stay in the web
app.

| Path (web origin) | Served by | What |
|---|---|---|
| `/mcp` | API `POST /mcp`, via rewrite | The connector: MCP over Streamable HTTP, answered as plain JSON with no session |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | API, via rewrite | Which authorization server protects `/mcp` (RFC 9728) |
| `/.well-known/oauth-authorization-server` | API, via rewrite | The authorization server's endpoints and abilities (RFC 8414) |
| `/oauth/register`, `/oauth/token`, `/oauth/revoke` | API, via rewrite | Client registration (RFC 7591), tokens, revocation (RFC 7009) |
| `/register`, `/token` | API, via rewrite | MCP 2025-03-26's default paths, for a client that didn't keep the metadata (the MCP Python SDK refreshes at `/token` after a restart): the same handlers, switches and CORS as `/oauth/register` and `/oauth/token`, and never named in the metadata |
| `/authorize` | web redirect | To `/oauth/authorize` with the same query, for the same clients |
| `/oauth/authorize` | web page | GitHub sign-in if needed, then the consent screen |
| `/oauth/authorize/decision` | web route | The Allow / Cancel form post; answers `303` back to the agent |
| `/connect` | web page | "Connect your agent to FORGE": the address and the steps for each client, with one-click installs for VS Code and Cursor |
| `/bff/oauth/grants` | web route | Your connected agents (list, disconnect), through the BFF |

**Connecting an agent** (OAuth 2.1, authorization code with PKCE):

1. The agent calls `/mcp` without a token and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="forge.tasks"`.
2. It reads the metadata and registers at `/oauth/register`. Registration
   keeps nothing on the server: the `client_id` it gets back carries the
   client's name, redirect URIs and auth method, signed with
   `FORGE_OAUTH_SECRET` (HMAC-SHA256).
3. It opens `/oauth/authorize` in the browser with a PKCE challenge (S256
   only). The person signs in with GitHub if needed (practice accounts are
   refused) and sees "Connect <name> to FORGE?", where it will send them
   back (the redirect host, shown because the name is whatever the agent
   chose to call itself), what the agent can and can't do, and Allow or
   Cancel. The page is never cached or framed, and the decision post needs
   the session and a same-origin request.
4. Allow issues a single-use code (5 minutes, because Antigravity's
   sign-in has the person paste the code back by hand) bound to the
   client, the redirect URI, the PKCE challenge, the person and the
   resource, and the browser goes back to the agent with `code`, `state`
   and `iss`. A code presented a second time revokes everything issued
   from it.
5. The agent trades the code at `/oauth/token` for an access token (1 hour)
   and a refresh token (30 days, replaced on every use). An old refresh
   token presented again within 30 seconds of being replaced is a retry
   (the agent lost the answer, or two of its sessions refreshed at once)
   and gets a fresh pair in the same grant; after that, reusing it revokes
   the whole grant. A grant revoked any other way stays revoked, retry or
   not. Both tokens are random strings, stored only as SHA-256 hashes, and
   bound to `<origin>/mcp`.

Redirect URIs must match exactly, except that a loopback address
(`127.0.0.1`, `localhost`, `[::1]`) matches on any port. Fragments,
`javascript:`, `data:`, `file:`, `vbscript:`, `about:` and `blob:` URIs,
and plain `http:` to anything but loopback, are refused, and an error about
the client or its redirect URI is shown as a page, never redirected. Each
connection is a grant: `/me` lists your connected agents (name, where it
sends you back, when connected, last used), and Disconnect revokes the grant
and every token in it.

**The MCP server.** Hand-written JSON-RPC 2.0 over `POST /mcp`
(`services/mcp_server.py`, `routers/mcp.py`; no MCP library and no new
dependency). It answers `application/json`, never a stream, and keeps no
session. Protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`.
Every call needs a bearer token issued for `<origin>/mcp`; one issued for
anything else gets `401 invalid_token`. Agents outside a browser send no
`Origin` header. One that is sent must be `FORGE_PUBLIC_ORIGIN`, one of
the hosted clients' origins (`https://claude.ai`, `https://chatgpt.com`,
`https://chat.openai.com`, `https://antigravity.google`,
`https://cursor.com`, `https://www.cursor.com`, `https://vscode.dev`,
`https://insiders.vscode.dev`, `https://github.com`) or one listed in
`FORGE_MCP_ALLOWED_ORIGINS`; anything else, and `null`, gets `403`. The
token, not the origin, is what protects `/mcp` (there are no cookies), so
the hosted list only keeps those clients from being locked out. Each
token may make 120 calls a minute (more answer JSON-RPC error `-32000`
"rate limited"). The tools
(`services/bridge_mcp.py`) call the same service functions as the HTTP
routes, as the person the token belongs to:

| Tool | What it does |
|---|---|
| `whoami` | Which GitHub account the agent is acting for |
| `list_tasks` | Open tasks, your own, or all (`filter`) |
| `get_task` | One task: the brief written for you, the acceptance criteria, your fork and branch, the issue, who holds it, and the compare link |
| `claim_task` / `release_task` | Claim the task in your name, or let it go |
| `report_progress` | `started`, `working`, `pushed`, `pr_opened`, `blocked` or `done`, with a message of up to 500 characters and, optionally, the pull request link; at most 200 reports per claim |
| `get_check_results` | The pull request's checks, and plain notes on what failed |
| `submit_task` | Submit the pull request (it must be yours, against `verastd/forge-app`) |

There is one prompt, `forge_task`, and short server instructions that tell
an agent the task flow. Anything an agent writes (progress messages, the
name it registers under) is untrusted: stored and shown as plain text only,
length-capped, with control characters stripped, and its progress messages
are shown only to the person holding the task.

**Switches.** `mcp_connector` off: every connector route answers
`404 {"error": "connector-disabled"}`. `FORGE_PUBLIC_ORIGIN` unset or not
`https` (loopback `http` aside), or `FORGE_OAUTH_SECRET` unset or shorter
than 32 characters: `503 {"error": "connector_unavailable"}`. CORS on
`/.well-known/*`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`,
`/register`, `/token` and `/mcp` allows any origin with no credentials, so
an agent running in a browser can connect; every other API route keeps its
existing CORS policy.

**Limits.** OAuth request bodies up to 16 KiB (`413` above that); up to 10
redirect URIs per client, each up to 512 characters; client names cut to
64 characters; `state` up to 2,048 characters. MCP bodies up to 256 KiB
(`413`), JSON only (`415` otherwise), batches of up to 32 messages; an
`MCP-Protocol-Version` header naming another version gets `400`, and `GET`
or `DELETE` on `/mcp` gets `405`.

**Where agents find it.** An agent opened in a contributor's fork finds the
connector in the repo itself:

| Client | File | When it's used |
|---|---|---|
| Claude Code; also VS Code 1.140+ and GitHub Copilot CLI | `.mcp.json` | Claude Code asks once before using a project's servers; VS Code follows Workspace Trust. Sign in with `/mcp` in Claude Code, or when VS Code asks |
| Codex (CLI, IDE extension, ChatGPT desktop app) | `.codex/config.toml` | Only in a trusted project. Sign in once with `codex mcp login forge` |
| Google Antigravity (CLI and IDE; 2.0 is still to be live-tested) | `.agents/mcp_config.json` | Sign in under Settings → Customizations; Antigravity shows a code to paste back once |
| Cursor | `.cursor/mcp.json` | Cursor asks before it uses the server's tools |

There is no `.vscode/mcp.json`: VS Code 1.140 calls that file deprecated,
reads the workspace's `.mcp.json` instead, and would run the server twice
if both existed. Claude on claude.ai and in the desktop app, and ChatGPT,
connect from their own settings (`/connect` has the steps). Two custom
agents carry the same task flow as `AGENTS.md`:
`.github/agents/forge.agent.md` for GitHub Copilot and
`.agents/agents/forge.md` for Antigravity. Neither is ever the default:
Copilot's sets `disable-model-invocation: true` and Antigravity's
`subagent: false`, so each runs only when a person picks it. The Copilot
cloud agent supports remote MCP servers with header secrets only, not
OAuth, so it can't use the connector; FORGE starts it through the tasks API
instead. `.gemini/settings.json` still points Gemini CLI, which people with
a paid Gemini API key or a Gemini Code Assist Standard or Enterprise license
still have, at `AGENTS.md`.

Every one of these files is a protected path (cold-account approval in
`CODEOWNERS`, and `.github/forge-protocol.json`'s `protectedPaths`), and so
are `.vscode/` and `.claude/`, which this repo doesn't use yet: an agent
connects to whatever server these files name, so a pull request that
repoints them would phish every contributor. The same goes for the page
that shows the connector's address and builds the one-click installs
(`apps/web/src/app/connect/`), the links that open agents
(`apps/web/src/lib/launch.ts`), and the text every agent is given (the
brief, the rail registry with its key pages, and the connector's tools).

## State, keys and GitHub reads

**The state database.** One SQLite file (`services/state.py`) at
`FORGE_STATE_DB_PATH`: `var/forge-state.db` in the repo by default (created
on demand, git-ignored), `/var/lib/forge-api/forge.db` in production. It
holds the Bridge's claims, hand-offs, progress events and submissions
(`bridge_` tables), saved agent keys (`vault_`), and the connector's
grants, codes and token hashes (`oauth_`). Write-ahead logging, foreign
keys on, one lock per process: it is built for the one API process on one
box that the pilot runs. Back it up, and keep the backups as private as
the box: losing the file forgets every claim and saved key and disconnects
every agent, and the file together with `FORGE_VAULT_KEY` opens every saved
key.

**The vault.** A key a contributor asks FORGE to remember is encrypted
with AES-256-GCM under a key of its own for each person, derived from
`FORGE_VAULT_KEY` with HKDF-SHA256 and the person's GitHub id, with the
person and the rail bound in as associated data, so a row copied to another
person or rail won't decrypt (`services/vault.py`). Afterwards FORGE shows
only a hint (the last four characters), uses the key only for a start the
person asks for, and deletes it when they remove it on `/me` or the vendor
rejects it. With `FORGE_VAULT_KEY` unset or malformed the vault is off:
nothing is saved, "Remember it" isn't offered, and starting still works
with a key typed in each time. Copilot never touches the vault: its
one-time GitHub authorization is used for that one call and dropped.

**GitHub reads.** The API reads public GitHub data only
(`services/github_reads.py`): the contributor's pull request
(`GET /repos/verastd/forge-app/pulls?head=<login>:<branch>&state=all`), its
check runs, a pull request by number at submission, and whether the
contributor's fork exists (and, with `FORGE_TASK_SOURCE=github`, the open
task issues). Results are cached for 60 seconds (the fork check and the
task list for 5 minutes). Production needs `FORGE_GITHUB_READ_TOKEN`: a
fine-grained token with read-only access to public repositories, which
the operator creates and sets on the API box, raising GitHub's limit from
60 to 5,000 requests an hour. Anonymous reads get 60 an hour per IP, and
every task someone is watching can cost two a minute. Any GitHub failure,
running out of that limit included, reads as "pending" or "couldn't reach
GitHub" with a plain note, never an error.

## The Apps lobby

`/apps` is a 3D room: the operator's cave prototype, ported to plain
three.js (see [ADR-004](adr/ADR-004-apps-lobby.md) for why that, and why
LiveKit). It is a free-roam cave whose wall is a 32 × 90 grid of app slots,
2,880 in all. The Data app is lit in slot 0, the bottom panel straight ahead
of where everyone starts; every other slot is dark, waiting for a proposal.

**The page works without the 3D view.** `src/app/apps/page.tsx` renders the
heading and a directory on the server: one link per lit app in the registry,
and a count of the empty slots. With no JavaScript, no WebGL, the
`apps_lobby` flag off, or a view that stopped, the directory is still the
page, and still the way into every app.

**The pieces.**

- `packages/lobby` (`@forge/lobby`): everything that isn't drawing, as pure
  functions tested in Node. The wall's geometry (`layout.ts`); the camera's
  limits, where it starts and how it's saved (`camera.ts`, `storage.ts`); the
  app registry and the rules every entry must pass (`registry.ts`,
  `csp.ts`); which chrome a route gets (`chrome.ts`, which `SiteChrome`
  uses); and the presence packet, send rate, voice ranges, name rules and
  rate limit (`presence.ts`).
- `src/components/lobby/Lobby.tsx`, the shell: the flag, a one-off WebGL2
  probe, the scene inside an error boundary, the presence feed, the mic
  button, the touch stick and lift buttons, and what a tap does.
- `src/components/lobby/scene/`: the scene itself, plain three.js with no
  React (`createCave.ts`, with `controls.ts`, `peers.ts` and `screen.ts`).
  `LobbyScene.tsx` loads it with `next/dynamic` and `ssr: false`, so three.js
  is downloaded on `/apps` only, and never in any route's first load.
- `src/components/lobby/presence/`: the presence feeds (below).
- `src/app/api/lobby/token/route.ts`: the LiveKit room token (below).

**States.** The lobby's root element, `<div data-lobby>`, reports what it is
doing, for e2e and for anyone debugging:

| `data-lobby-state` | Meaning |
|---|---|
| `loading` | The flags, or the scene, are still loading. The scene builds its heavy parts a slice per frame behind a veil, so the page stays responsive |
| `ready` | The 3D view is up |
| `unsupported` | No WebGL2: "This browser can't show the 3D lobby." |
| `lost` | The WebGL context was lost, or the scene threw while building or in a frame: "The 3D view stopped. Reload to try again." |
| `off` | The `apps_lobby` flag is off: "The 3D lobby is switched off right now." |

Beside it: `data-x`, `data-y`, `data-z` and `data-yaw` (the camera, written
ten times a second once the first frame is drawn), `data-focus` (the app
under the crosshair or the last tap, or `empty:<slot>`), `data-motion`
(`full`, or `reduced` while the visitor prefers reduced motion: no drift,
flicker or bob), `data-feed` (`none`, `local` or `livekit`: the feed presence
is actually running on), `data-peers` (the people drawn in the room, so not
anyone whose position hasn't arrived) and `data-voice` (`unavailable`, `off`
or `on`).

**Moving and opening.** Drag to look; WASD, the arrow keys or the touch
stick to walk; Space and Shift, or the lift buttons, to rise and fall. The
camera stays 2.5 m inside the wall's ring, between eye height and 220 m. A
tap on a lit panel saves the camera in `sessionStorage`
(`forge.lobby.pos.v2`, so per tab) and opens the app; so does leaving the
lobby any other way. Any visit to `/apps` in that tab, the browser's Back
included, starts from the saved camera; a tab with nothing saved starts at
the centre. The app's `AppBar` links back to `/apps?from=<slug>`, which
also puts keyboard focus on that app's link in the directory (with no saved
camera, it faces the app's slot). A tap on a dark slot opens
`/propose?slot=<index>`, where one line after the heading and lede says the
slot is free. When the page chrome changes (lobby, app, or site), focus
moves to the new page's `<h1>`, or to the element the page marks
`data-arrival-focus` (the directory link, coming back from an app).

**The screen's video.** The Data panel shows a 1280×720 H.264 loop
(`public/lobby/lobby-screen.mp4`, 5.1 MB), or a 640×360 encode of it
(`lobby-screen-360.mp4`, 1.3 MB, the registry's `srcLow`) on a light client:
a coarse pointer, four or fewer cores, or Save-Data
(`navigator.connection.saveData`). A panel loads nothing until it is within
40 m of the camera or in view; seen only from farther away, its video
preloads metadata alone, and loads in full once the camera comes within
40 m. Media is same-origin only (the registry refuses anything with a
scheme), because the scene samples the pixels for the room's light.

**Presence and voice.** One feed per visit, picked by `createPresenceFeed`
in `presence/`:

- signed out: `none`. The cave, alone, and nobody sees you.
- the practice build (`NEXT_PUBLIC_FORGE_DEMO=1`), signed in: `local`, a
  `BroadcastChannel('forge.lobby')` between tabs of one browser, with no
  server and no voice. It exists so the practice app, and e2e, can show
  presence end to end.
- a live build, signed in: `livekit`. It asks `POST /api/lobby/token` for a
  token, only then downloads `livekit-client` (which then logs warnings and
  errors only), and joins the room `lobby`. If the route refuses (`401`
  signed out, `403` practice, `503` not configured) or anything else fails,
  the feed settles on `none` and the lobby carries on alone.

Both feeds send the same 9-byte position packet (`encodePosition`: a version
byte, then centimetres and milliradians as int16s), at most ten a second
while moving and one a second while still, and treat everything that
arrives as untrusted: a packet must decode to a place inside the cave, each
sender is held to 30 packets a second, and names pass through
`sanitizeName` (no control or bidi characters, at most 39 code points) and
reach the page only as `textContent`. On LiveKit, positions are lossy data
packets on the topic `pos`, and a peer's identity and name come only from
their participant record, which our token signed; a packet carries nothing
but a position. A packet has to place its sender somewhere a camera can be
(the walking disk, eye height to 220 m, give or take a centimetre), or it is
dropped. Voice is LiveKit audio: a peer is at full volume within 2 m, fades
to silence at 9 m, and isn't received at all past 14 m (and received again
from 13 m, so someone on the edge doesn't flicker in and out). Only a peer's
microphone plays: any other source is refused on arrival, and the token
lets members publish nothing else anyway. The mic button asks for the
microphone only when pressed, reads "Voice unavailable" whenever the feed
can't carry voice, and shows the feed's own word on the mic.

The range holds at the source as well as in each listener's own client,
because a modified client could otherwise listen from anywhere: while
someone's mic is on, their feed tells LiveKit every 500 ms who may receive
it (`setTrackSubscriptionPermissions`), which is every participant whose
last known position is within 14 m. Someone whose position hasn't arrived
is never in range. The list is sent before the mic goes live, and lifted
when it goes off or the room goes. So nobody who could be listening is
invisible, the people panel lists everyone in the room, nearest first with
their distance, and anyone whose position hasn't arrived as
"<name> · joining" (with no orb).

A reconnect that has to rejoin the room (LiveKit restarted, or the network
was gone too long to resume) comes back with the mic off: LiveKit would
otherwise publish it again, live, behind a button that reads off. The room
holds each member once (identity `gh:<id>`), so opening the lobby in another
tab or device takes this one's seat: the first tab's feed settles on `none`
(`data-feed=none`), and it says "You're in the lobby in another tab or
device." with a "Rejoin here" button, which joins again and moves the seat
back.

**The token route.** `POST /api/lobby/token` (Node runtime, never cached)
answers, checking in this order:

1. no session: `401 {"error": "unauthenticated"}`, with
   `WWW-Authenticate: Bearer`;
2. the practice account: `403 {"error": "practice_session"}`, since it is
   nobody on GitHub (a live build never counts a practice session at all,
   so there it is the `401`);
3. a request from anywhere but this origin, by the BFF's `Origin` check
   against `FORGE_PUBLIC_ORIGIN` plus `Sec-Fetch-Site: same-origin` when the
   browser sends it: `403 {"error": "bad_origin"}`;
4. the LiveKit settings missing or unusable, or session keys anyone can seal
   under (the public dev secret): `503 {"error": "voice_unavailable"}`;
5. otherwise `200 {"url", "token"}` with `Cache-Control: private, no-store`:
   a LiveKit token for the room `lobby`, with identity `gh:<GitHub user id>`
   and the login (sanitised) as the name, valid for one hour, allowed to
   join, publish a microphone and nothing else (`canPublishSources`),
   subscribe and send data, and not to change its own metadata.

An empty setting counts as unset, so the practice build's e2e server, which
`playwright.config.ts` gives empty `LIVEKIT_*` values, never uses a
machine's real LiveKit project.

`GET` is `405` with `Allow: POST`, and no request body is ever read. The
route reads `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (see
the env table under [Identity](#identity)) on every request. It is a
protected path, in `CODEOWNERS` and in `forge-protocol.json`'s
`protectedPaths`, because it decides whose name and voice everyone else
sees.

**Operations.** Voice needs HTTPS: browsers only open the microphone on a
secure origin. If a `connect-src` Content-Security-Policy is ever added
(today the only policy is `frame-ancestors`), it has to allow the LiveKit
origin. LiveKit bills per participant-minute and everyone in the lobby is a
participant, talking or not; ADR-004 has the numbers.

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

Endpoints this app defines for itself today: `/api/flags`, `/api/upland/*`
(gated by `upland_data`; its `/export` route additionally requires
`csv_export`), `/api/bridge/*` (gated by `contribute_bridge`; see
[The Bridge](#the-bridge)), and the FORGE connector's `/mcp`,
`/oauth/register`, `/oauth/token`, `/oauth/revoke`, their fallback aliases
`/register` and `/token`, `/.well-known/oauth-*` and `/api/oauth/*` (gated
by `mcp_connector`; see
[The FORGE connector](#the-forge-connector)), which the web origin reaches
through rewrites. `apps/web` answers one API route itself,
`POST /api/lobby/token`, the lobby's LiveKit room token (see
[The Apps lobby](#the-apps-lobby)); it never calls `apps/api`. Its other
server-side calls to the API (the BFF's `/bff/*`, the consent page and its
decision route, and `/auth/callback` finishing a Copilot start) carry the
same short-lived assertion whenever they act for a signed-in person.
Outbound, `apps/api` calls GitHub's public REST API for reads, and a
vendor's API only when a contributor starts a start rail.

## Flags flow

Flags are a deploy-safety kill switch, not a convenience toggle, so the
client is **fail-closed in code**: `DEFAULT_FLAGS` in both mirrors
(`packages/flags/src/core.ts` and
`apps/api/src/forge_api/services/flags.py`) is all-`false`. The enabled
dev/demo posture comes from [`config/flags.json`](../config/flags.json),
which is checked in with every flag `true` except `agent_start` (off until
the start rails pass their live tests) — from the file, never from a
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

The flags are real gates, not decoration. For example:

- `contribute_bridge` — `apps/web/src/app/contribute/layout.tsx` closes
  the entire Bridge UI, and a router-level FastAPI dependency 404s every
  `/api/bridge/*` route with `{"error": "bridge-disabled"}`.
- `csv_export` — gates `/api/upland/export` (`routers/upland.py`); in live
  mode the web client follows the flag client's fail-closed default and
  shows no export affordance.
- `apps_lobby` — `src/components/lobby/Lobby.tsx` shows the lobby's 3D view
  only while it is on. Off, or in a live build unreachable, `/apps` is its
  heading, its directory and "The 3D lobby is switched off right now." The
  practice build falls back to every flag on when the flag service is down,
  as it does for the Bridge.
- `mcp_connector` — the FORGE connector: off, every connector route on the
  API (`/mcp`, `/oauth/*`, `/register`, `/token`, `/.well-known/oauth-*`,
  `/api/oauth/*`) answers
  `404 {"error": "connector-disabled"}`, and `/connect` says "The FORGE
  connector is switched off right now."
- `agent_start` — "Start it for me": off, no start rail runs whatever
  `FORGE_START_RAILS` lists, and the task page offers "Open my agent"
  only. Checked in off; turn it on only once at least one start rail has
  passed its live test ([`live-tests.md`](live-tests.md)).

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
   paths** (everything in `.github/forge-protocol.json`'s
   `protectedPaths` — `.github/`, `CODEOWNERS`, `AGENTS.md`, `CLAUDE.md`,
   `.gemini/` and the other agent config (`.mcp.json`, `.codex/`,
   `.agents/`, `.cursor/`, `.vscode/`, `.claude/`), the sign-in/session
   paths from [Identity](#identity) above, the lobby's token route, and
   the connector, vault, rail and brief code (see
   [The FORGE connector](#the-forge-connector)) — needs T3 trust to
   touch), and raises —
   never blocks on — a **tests-modified flag** for PRs that touch an
   existing test.
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
