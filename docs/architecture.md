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
| `apps/web` | Next.js 15 App Router, TypeScript strict. The app itself, including the Bridge's `/contribute` surface, GitHub sign-in (`src/app/auth/`, `src/app/bff/`), the FORGE connector's consent page (`src/app/oauth/`) and setup page (`src/app/connect/`), the Apps lobby at `/apps` (`src/components/lobby/`, with its LiveKit token route in `src/app/api/lobby/`), and the Propose floor at `/propose` (`src/app/propose/`) with its bell (`src/components/NotificationBell.tsx`) | `@verastd`; `src/app/auth/`, `src/app/bff/`, `src/app/oauth/`, `src/app/connect/`, `src/app/api/lobby/`, `src/middleware.ts`, `src/lib/session.ts`, `src/lib/auth/`, `src/lib/launch.ts`, `src/lib/mode.ts`, `src/lib/bff-forward.ts`, `src/lib/handoff.ts`, `src/lib/api.ts`, `src/components/contribute/` and `next.config.mjs` need cold-account approval | beta — live and demo builds both work end to end; no unit-test runner yet, so it's exempt from the changed-line coverage gate | Open to all tiers per task; the cold-account sub-paths above are effectively T2+ in practice |
| `apps/api` | FastAPI (Python 3.12, `uv`), package `forge_api`. App backend, the Bridge's server-side service, the FORGE connector (OAuth + MCP), and the Propose floor's rules, members and notifications | `@verastd`; `routers/auth*`, `routers/pay*`, `routers/oauth.py`, `routers/mcp.py`, `routers/bridge.py`, `services/identity.py`, `services/oauth.py`, `services/mcp_server.py`, `services/vault.py`, `services/rail_adapters/`, `services/bridge_mcp.py`, `services/bridge.py`, `services/brief.py`, `services/rails.py`, `models.py`, `main.py` and `fixtures/` need cold-account approval | beta — `health`, `flags`, `bridge`, `oauth`, `mcp`, `upland`/`upland_scrape`, and `proposals`/`notifications`/`members` routers are live, each with pytest coverage; `auth*`/`pay*` don't exist yet (identity verification lives in `services/identity.py`, consumed by the routers' dependencies, not a dedicated router) | `auth*`/`pay*`/`services/identity.py`, the connector, vault, rail and brief paths, the Bridge's key-carrying code and the task fixtures: cold-account approval, effectively T2+ in practice |
| `packages/shared` | zod schemas — reference copy of the web/API contract, hand-mirrored and test-locked against `apps/api`'s Pydantic models; also the rail registry (`src/rails.ts`) and the brief every agent gets (`src/brief.ts`), mirrored by `services/rails.py` and `services/brief.py` and held to golden fixtures in `tests/fixtures/` | `@verastd`; `src/rails.ts` and `src/brief.ts` need cold-account approval | stable — schemas populated, mirrored field-for-field by `models.py`, locked by contract tests | Open; `src/rails.ts` and `src/brief.ts`: cold-account approval |
| `packages/auth` | Sign-in with GitHub: PKCE, sealed session/transaction cookies, the API assertion, and revoking the Copilot rail's one-time GitHub token once it is used. Built on `jose` and Web Crypto only (no `node:` imports), so Next's Edge middleware can import it — see [ADR-003](adr/ADR-003-github-app-signin.md) | `@verastd` `@forge-cold` (cold-account approval) | stable — 100% coverage enforced in `vitest.config.ts`, includes the RFC 7636 PKCE test vector | **Tier floor T2** |
| `packages/flags` | Feature-flag client; layered load, fail-closed. `config/flags.json` -> `FORGE_FLAGS_PATH` -> `FORGE_FLAGS_JSON` | `@verastd` | stable — `csv_export`, `contribute_bridge`, `upland_data`, `github_signin`, `apps_lobby`, `mcp_connector` (the FORGE connector), `agent_start` (FORGE starting agents through vendor APIs; off in `config/flags.json` until those rails pass their live tests) and `proposals` (the Propose floor and its notifications), all real gates | Open |
| `packages/lobby` | The Apps lobby's pure logic: the wall's geometry, the free-roam camera and how it is saved, the app registry and the rules every entry must pass (slots, routes, and the sandbox and CSP for framed apps), which page chrome a route gets, and the presence packet, ranges and name rules. No DOM, no three.js and no runtime dependencies (its `tsconfig.json` and `eslint.config.mjs` enforce it) — see [ADR-004](adr/ADR-004-apps-lobby.md) | `@verastd` | stable — unit-tested in Node at full line coverage; the framed-app rules are enforced, though nothing framed ships yet | Open |
| `packages/contracts-client` | The only module allowed to import a chain SDK. Mock-only isolation layer | `@verastd` `@forge-cold` (cold-account approval) | experimental — mock-only; `mode: 'live'` throws, no chain wiring | **Tier floor T2** |
| `contracts/` | On-chain code, if any lands in-repo | `@verastd` `@forge-cold` (cold-account approval) | placeholder — no contract source yet | **Tier floor T2** |
| `tests/acceptance/issue-<N>/` | Per-task acceptance tests, one directory per issue | Spec author (core team, or a T3 steward once delegated) | stable pattern, structurally enforced by G0 and the Gauntlet | Never written by the implementer |
| `tests/e2e` | Playwright end-to-end tests, one project per build (demo + live) | `@verastd` | stable | Open |
| `tools/forge` | The `forge` CLI (`tasks`/`claim`/`status`) and the Gauntlet's gate scripts (`check-lockfile-diff.sh`, `coverage-gate.sh` + `changed_line_coverage.py`, `test-mod-detector.sh`) | `@verastd` | stable — all three gates enforce | Open |
| `.github/workflows` | `gauntlet.yml` (the four unprivileged jobs: `hygiene`/`tests`/`security`/`e2e`), `foreman-annotate.yml` (privileged: posts the merge decision brief once the Gauntlet finishes, never checks out fork code), plus `agents-md-lint.yml` and `deploy-staging.yml` | `@verastd` `@forge-cold` (cold-account approval via CODEOWNERS on `.github/`) | beta — the four Gauntlet jobs run and are merge-queue-safe; G0 runs inside Foreman and doesn't post its own commit status here yet | T3-only |
| `.github/rulesets` | Importable branch-protection ruleset JSON (`main-protection.json`) | `@verastd` `@forge-cold` | beta — schema is current, not yet imported into a live repo | Cold-account approval |
| Agent config: `.codex/`, `.agents/`, `.cursor/`, `.github/agents/`, `.gemini/`, `CLAUDE.md` | Points contributors' agents at `AGENTS.md` and the FORGE connector (see [The FORGE connector](#the-forge-connector)). The repo doesn't include `.mcp.json` yet; until it does, add the connector to Claude Code with `claude mcp add --transport http forge <url>` (or VS Code's button on `/connect`) | `@verastd` `@forge-cold` (cold-account approval) | beta — each file follows its client's docs as read on 2026-10-01; Antigravity 2.0 and Claude Code on the web are still to be live-tested ([`live-tests.md`](live-tests.md)) | T3-only (protected paths) |
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
   `middleware.ts` gates `/me/:path*`, `/apps/:path*` (the lobby itself and
   every app on it), the connector's consent page `/oauth/authorize` and the
   new-proposal form `/propose/new` on a valid session, redirecting to
   `/signin?next=<path and query>` otherwise.
4. Once the session is set, the callback tells the API that this GitHub
   account is a member (`POST /api/members/hello`, with the assertion; see
   [The Propose floor](#the-propose-floor)). It runs after the redirect has
   gone, tries once for at most 3 seconds and logs only a failure's code,
   so it can never hold up or break a sign-in.

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
| `GITHUB_APP_SLUG` | web — the Copilot rail's "Install FORGE's GitHub app on your fork" link (`https://github.com/apps/<slug>/installations/new`) on the task page | For that link | The App's URL name, as in `https://github.com/apps/<slug>`: lowercase letters, digits and inner dashes, anything else counts as unset. Unset, the install step is shown as plain text with no link. Server-side only, never `NEXT_PUBLIC_*`: the task page reads it on every request and hands it to the page as a prop, so a change needs no rebuild |
| `FORGE_PUBLIC_ORIGIN` | web — `publicOrigin()` (the OAuth `redirect_uri`, the callback's final redirect) and `isTrustedOrigin()` (the Origin check on `POST /auth/signout`, `POST /auth/demo`, `POST /bff/upland/*` and the other state-changing routes); API — the FORGE connector's public URLs (the OAuth metadata, the `iss` it sends back, the `<origin>/mcp` resource every token is bound to), the Origin check on `/mcp`, and the link a task published from a proposal carries (`<origin>/propose/<id>`) | Web: required outside `next dev`; optional in `next dev` only, where an unset value falls back to the request's own origin. API: required for the connector, which answers `503 connector_unavailable` without it; without a usable value, a published task links to a bare `/propose/<id>` | An `http(s)` URL with no path, query, fragment or credentials, e.g. `https://forge.example` (not `.../` ) — a set-but-invalid value refuses every state-changing request rather than guessing. On the API it must also be `https`, except `http` on a loopback host (`http://localhost:3000`) for development; anything else answers `503 connector_unavailable`. The same value on web and API: production is `https://forge-app-eta-mocha.vercel.app`; it is the connector's OAuth issuer and its address is this plus `/mcp`, so changing it disconnects every agent |
| `FORGE_SESSION_SECRET` | web — seals and (with `_PREVIOUS`) opens session and transaction cookies | Required outside `next dev` | >= 32 characters, ASCII (`MIN_SECRET_LENGTH` in `@forge/auth`). Unset or empty under `next dev` only: the public dev secret, for practice sessions only, and the BFF never mints (see The development secret, above). Set but shorter than 32 characters: sign-in is disabled in every mode, with one logged warning |
| `FORGE_SESSION_SECRET_PREVIOUS` | web, same | Optional | Same constraints; set only while rotating (see Operations) |
| `FORGE_API_ASSERTION_SECRET` | web — mints the BFF's assertion; API — `verify_assertion` checks it | Required for `/apps/data` to work end to end; its absence (or weakness) on the web side answers `503 not_configured` rather than pretending the Data app is merely down | >= 32 characters, ASCII, used exactly as stored (not trimmed); must be byte-for-byte identical on web and API |
| `FORGE_API_URL` | web — `apiUrl()`, where the BFF forwards `/bff/upland/*`, `/bff/bridge/*`, `/bff/oauth/*`, `/bff/proposals*` and `/bff/notifications*`, and where the consent page, the Copilot callback and the sign-in callback's members hello call the API; and `next.config.mjs`, which rewrites the connector's paths (`/mcp`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`, `/.well-known/oauth-*`, and the fallback `/register` and `/token`) to it | Optional for the BFF; required for the connector | Unset, the BFF uses `NEXT_PUBLIC_API_URL`, then `http://localhost:8000`. Whichever it uses must be `https`, or plain `http` only to `localhost`, `127.0.0.1` or `::1`, with no credentials, query or fragment, because pasted keys, the Copilot token and assertions go there. Anything else and the web server sends nothing to the API (the BFF answers `503 not_configured`, the consent page says "FORGE can't connect agents right now", a Copilot start fails) and logs one error, never the value. The rewrites are written when the app is built, and only if this is set to such a URL (plain `http` only to `localhost` or `127.0.0.1`): set it in Vercel before the build, or the connector's paths 404 on the web origin. The fallback `/authorize` is not a rewrite: the web app redirects it (`307`, query kept) to its own `/oauth/authorize` |
| `NEXT_PUBLIC_API_URL` | web, in the browser — `lib/api.ts`'s `apiBase` and the flag client (`@forge/flags/react`): every visitor's flag fetch, the Bridge's public reads while nobody is signed in (tasks, rails, status, checks), the Propose floor's public reads (`lib/proposals.ts`: the list, and a proposal's public record), and the base of the `prompt_url` Claude Code on the web fetches a long brief from (`<this>/api/bridge/tasks/<id>/brief`, used when the brief makes the link pass 7,000 characters) | Required for a deployed live build | The API's public origin, `https` in production, e.g. `https://api.forge.example` (a trailing slash is dropped). Browsers and claude.ai call it directly, so never a private address. Inlined when the app is built, like every `NEXT_PUBLIC_*`. Unset means `http://localhost:8000`. Its origin is also the API entry in the site's Content-Security-Policy `connect-src`, fixed when the app is built |
| `FORGE_CORS_ORIGINS` | API — the browser origins allowed to call it (`main.py`'s CORS policy, with credentials) on every route but the connector's | Required in production | Comma-separated origins, blanks ignored; unset or blank means `http://localhost:3000,http://localhost:3100` (`next dev` and the Playwright server). It must include the web origin (`FORGE_PUBLIC_ORIGIN`): browsers read the flags and the Propose floor's public reads, and signed-out visitors the Bridge's public data, from the API directly, and those reads fail without it. The connector's paths and the brief behind `prompt_url` answer any origin, whatever this says |
| `NEXT_PUBLIC_FORGE_DEMO` | web — `lib/mode.ts`'s `isDemoMode()`, read at build time only | Optional | `1` when building makes the demo build (practice sign-in, fixtures); anything else, or unset, a live build. Inlined by `next.config.mjs`'s `env`, so the value at runtime is ignored |
| `FORGE_ADMIN_IDS` | API — the admin check behind `require_admin`: the Upland scraper and GCS-sync controls, and on the Propose floor the Test timers switch, End debate now and Close the vote now, and finishing and publishing a passed proposal's task (see [The Propose floor](#the-propose-floor)) | Optional; without it nobody can publish a passed proposal | Comma-separated numeric GitHub user ids (not logins), each matching `^[1-9][0-9]{0,19}$`; entries trimmed, blanks ignored; unset means nobody is admin. One invalid entry makes nobody admin, with one logged warning |
| `LIVEKIT_URL` | web — the lobby's token route (`src/app/api/lobby/token/route.ts`), which hands it to the browser with each token (see [The Apps lobby](#the-apps-lobby)) | For presence and voice in the Apps lobby; without all three LiveKit settings the route answers `503 voice_unavailable` and the lobby works alone | A `wss:`, `ws:`, `https:` or `http:` URL with no credentials, e.g. `wss://<project>.livekit.cloud`; anything else counts as unset. Server-side only, never `NEXT_PUBLIC_*`. Read on every request, so a build without it still succeeds; but the site's Content-Security-Policy `connect-src` allows this host (as `wss:` and `https:`, or `ws:` and `http:` for an insecure URL) as it was when the app was built, so set it before building and rebuild after changing it, or the lobby can't connect |
| `LIVEKIT_API_KEY` | web, same — the key each token is issued under | Same | The LiveKit project's API key. Server-side only |
| `LIVEKIT_API_SECRET` | web, same — signs each token | Same | The LiveKit project's API secret. Server-side only: never sent to the browser or logged |
| `FORGE_OAUTH_SECRET` | API — signs the FORGE connector's client registrations and derives confidential clients' secrets (`services/oauth.py`; see [The FORGE connector](#the-forge-connector)) | For the connector; unset, or shorter than 32 characters, answers `503 connector_unavailable` | >= 32 characters. Generate it on the API box itself (`openssl rand -base64 32`) and never paste it anywhere; FORGE never sends or logs it. Changing it invalidates every registered client, so connected agents have to connect again |
| `FORGE_STATE_DB_PATH` | API — the state database: the Bridge's claims and timeline, saved agent keys, the connector's grants and token hashes, and the Propose floor's members, proposals and notifications (`services/state.py`; see [State, keys and GitHub reads](#state-keys-and-github-reads)) | Optional; set it in production | A file path, created on demand. Defaults to `var/forge-state.db` in the repo (git-ignored). Production: `/var/lib/forge-api/forge.db`, on a disk that survives a redeploy. It has no migrations yet: after an upgrade that changes its tables, the file is deleted and starts again empty (see [State, keys and GitHub reads](#state-keys-and-github-reads)) |
| `FORGE_VAULT_KEY` | API — encrypts the agent keys people ask FORGE to remember (`services/vault.py`) | Optional; without it nothing is saved and keys are typed in at each start | Base64 of 32 random bytes; generate it on the API box (`openssl rand -base64 32`). Surrounding whitespace is ignored. Unset or malformed turns the vault off (`vault: false` in `GET /api/bridge/rails`); a malformed value also logs one warning, which never includes the value. Changing it makes every saved key unreadable: each one then reads as not saved (it isn't listed, and a one-click start asks for a key), but nothing is deleted, so putting the old value back restores every key nobody has re-entered; otherwise each person enters their key again, which replaces the old one |
| `FORGE_START_RAILS` | API — which start rails may run (`GET /api/bridge/rails`, `POST /api/bridge/dispatch`) | Optional | Comma-separated rail ids from `copilot`, `jules`, `cursor`, `devin`, `openhands`, `claude-routine` (case and spaces don't matter; unknown ids are ignored); unset or empty means none. A rail runs only when it is listed here AND the `agent_start` flag is on. Add a rail only after it passes its live test ([`live-tests.md`](live-tests.md)) |
| `FORGE_MAX_ACTIVE_CLAIMS` | API — how many tasks one person may hold at once | Optional | An integer from 1 to 100; unset or anything else means 2. A task whose pull request merged no longer counts. One more claim answers `409 claim_limit` |
| `FORGE_MCP_ALLOWED_ORIGINS` | API — the Origin check on `/mcp` | Optional | Comma-separated origins (`https://host`), allowed besides `FORGE_PUBLIC_ORIGIN` and the hosted clients' origins FORGE always accepts (listed under [The FORGE connector](#the-forge-connector)). Agents running outside a browser send no `Origin` and are unaffected; a request whose `Origin` is in none of these, or is `null`, gets `403` |
| `FORGE_GITHUB_READ_TOKEN` | API — the GitHub reads behind status, check results, submission and the fork check (`services/github_reads.py`) | Optional in development; needed in production | A fine-grained token with read-only access to public repositories and no write permission of any kind, created by the operator and set on the API box by the operator, never pasted anywhere else; it raises GitHub's limit from 60 to 5,000 requests an hour. Without it the reads are anonymous: 60 an hour per IP, and every task someone is watching can cost two reads a minute (its pull request and its checks, each cached 60 seconds), plus a search a minute while no pull request is found on the task's branch, so a few watched tasks use the hour up and status and checks fall back to "GitHub can't be reached right now". When GitHub refuses the token (`401`: expired or revoked), each read is retried once without it and the API logs a warning that names this variable (never the token), so reads carry on at the anonymous rate until the token is replaced. The API reads only this variable, never a `GITHUB_TOKEN` that happens to be in its environment |

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
  its checks, and "Notes for your agent" when checks fail. While no pull
  request is known, a closed "Opened a pull request FORGE can't see?" box
  takes one by its link (`POST /bff/bridge/submit/<id>`, the same rules as
  the connector's `submit_task`, below), for an agent that opened it from
  another branch. What the agent wrote is shown only to the person holding
  the task; everyone else sees FORGE's own entries, because agent text on a
  public page would be a way to deface it. Calls that need
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
  OAuth token on the connector's.

  *Claims.* One person may hold `FORGE_MAX_ACTIVE_CLAIMS` tasks at once
  (default 2; a shipped task doesn't count) and make at most 20 claims in
  24 hours (`429 claim_rate_limit` with `Retry-After`). Once your claim on
  a task ends (you let it go, or its time ran out), you can't claim that
  task again for 24 hours (`409 claim_cooldown` with `Retry-After`);
  anyone else can claim it at once. Every account is T0 until Foreman's
  ledger is wired in, so a task whose tier floor is above T0 can't be
  claimed yet (`403 tier_too_low`).

  *Pull requests.* A pull request counts for a claim only when all of
  these hold: it targets `verastd/forge-app`; it comes from the holder's
  own fork (matched by GitHub user id, not login); it was opened after the
  claim (and, for a claim whose time ran out, before it did); and it names
  the task: it comes from the task's branch, or has `[#N]` in its title or
  `Closes`, `Fixes` or `Resolves #N` in its description. It counts for one
  task at most. FORGE looks on the task's branch first, then through
  GitHub's search for the holder's pull requests opened since the claim,
  and also takes one handed in (`submit_task`, or the task page's box) or
  named in a progress report when it passes the same rules. While that pull
  request is open, the claim holds past its clock and never shows less
  than a day left. When it closes without merging, the task goes back to
  *agent working* with a note, and the clock runs on from the close with
  at least 24 hours left. When it merges, the task is shipped: it stays
  off the open board and counts once on the profile, however often it is
  read.

  *Stages.* The stage comes only from real signals: *claimed* (the claim
  alone), *agent working* (a hand-off, an agent's report, or a pull
  request closed without merging), *ready to submit* (the agent says it
  pushed, opened the pull request or is done, but none is found upstream
  yet), *in checks* (an upstream pull request whose checks are pending or
  failing), *in review* (every check passed), *shipped* (merged). Status
  shows the newest 50 events (a task keeps its newest 200), and events an
  agent sent (`source: "agent"`) only to the holder. The same flag 404s
  every route with `{"error": "bridge-disabled"}`, except `GET` and
  `DELETE /api/bridge/me/keys`, so people can still see and remove their
  saved keys.
- Tasks come from the checked-in fixtures
  (`apps/api/src/forge_api/fixtures/tasks.json`) and from passed proposals
  an admin has published (see [The Propose floor](#the-propose-floor)).
  Published tasks are listed after the fixtures, numbered from 10001, well
  clear of the fixtures' issue numbers, and labelled `from-proposal`. A
  published task's text is the admin's: its summary starts as the mover's
  pitch, and the admin reads and edits it before publishing. Reading tasks
  from GitHub issues waits for the Foreman claim linkage; until then no
  issue author's text reaches a brief.
- Not built: FORGE doesn't fork, branch or open pull requests for anyone
  (the agent works in a fork the contributor already has, and the only
  GitHub writes FORGE makes are starting Copilot, on the contributor's
  one-time authorization, and revoking that authorization afterwards), and
  there are no webhooks, no notifications about tasks (the bell is the
  Propose floor's) and no automatic retries of a failed start. **Not joined
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
| Write fails (claim/hand-off/feedback) | throws, nothing on screen moves; when no answer comes back at all, the page says it may have gone through and reads the task again, never "nothing changed" | simulated |
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
has them. The task page uses the API's own copy of it (`TaskDetail.brief`);
only the practice app compiles its own. Once you hold the claim, the task
page offers two buttons.

**Start it for me** (start rails): FORGE calls the vendor's API and the
agent starts in the contributor's fork, on their own account and plan. A
rail runs only when the `agent_start` flag is on AND its id is in the API's
`FORGE_START_RAILS` (empty by default), and each one stays off until it
passes its live test ([`live-tests.md`](live-tests.md)). The calls, as
documented by each vendor on 2026-10-01:

| Rail | What FORGE calls | What the contributor needs |
|---|---|---|
| GitHub Copilot | `POST https://api.github.com/agents/repos/{login}/forge-app/tasks` with `X-GitHub-Api-Version: 2026-03-10` (public preview) | Copilot Pro, Pro+, Max, Business or Enterprise, and FORGE's GitHub app installed on the fork. Nothing to paste: FORGE asks GitHub for a one-time authorization at each start (GitHub may not show a page to someone who approved FORGE before), uses the token only to check it is the signed-in account's and to make that one start, never stores it, and revokes it straight after (`DELETE /applications/{client_id}/token`) |
| Google Jules | `POST https://jules.googleapis.com/v1alpha/sessions` | The Jules GitHub app on the fork, and an API key from <https://jules.google.com/settings> |
| Cursor cloud agent | `POST https://api.cursor.com/v1/agents` | A paid Cursor plan with GitHub connected, and an API key from <https://cursor.com/dashboard> (Integrations) |
| Devin | `POST https://api.devin.ai/v3/organizations/{org_id}/sessions` | GitHub connected in Devin, and an API key and organization ID from <https://app.devin.ai/settings> |
| OpenHands Cloud | `POST https://app.all-hands.dev/api/v1/app-conversations` | GitHub connected at <https://app.all-hands.dev>, and an API key from its settings |
| Claude Code routine | `POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire` with `anthropic-version: 2023-06-01` and `anthropic-beta: experimental-cc-routine-2026-04-01` (research preview) | A routine they create once in Claude Code for their fork, with FORGE's routine prompt and an API trigger: its URL and token |

A start rail's key is used for the call the contributor asked for, and is
never logged or echoed (`/dispatch` reads its own body, so not even a
validation error repeats it). If they tick "Remember it" (offered only
while the vault is on, and unticked until they tick it) it is saved
encrypted; otherwise it is dropped after the call. Before any vendor call,
`/dispatch` answers `400 rail_disabled`, `400 credential_required` (no key
sent and none saved that FORGE can open), `400 credential_invalid` (the
key's shape, Devin's organization ID or the routine's URL),
`409 already_started` (with the session link once there is one) when a
start on the same claim and rail went out, or is still on its way, in the
last 2 minutes, or `429 dispatch_limit` with `Retry-After`: vendor calls,
meaning starts and check notes relayed to an agent, failed ones included,
are limited to 10 per person per hour, counted and recorded in one
transaction. Then the vendor's answer: `400 credential_rejected` when it
refuses the key (a saved key it rejected is deleted), `400 rail_setup_needed`
with a plain sentence about what to connect when the fork or the vendor's
app isn't set up (Copilot's 403 and 404 mean this), and `502 rail_failed`
with the vendor's status for anything else. A success answer FORGE can't
read (not JSON, nested more than 32 deep, or not an object) still means the
agent started: the start is recorded, just without a session link. A
session link is kept only when it is a plain `https://` link on the
vendor's own host, with no backslash, whitespace, user info or port other
than 443 (Jules falls back to its own session page), and the task page
checks it again before showing it. A body over 16 KB answers
`413 body_too_large`, one nested more than 32 levels deep
`400 invalid_request`, any other malformed one `422 invalid_request`. Every
other Bridge route, and the consent page's `/api/oauth/*` calls, answer a
request that fails validation the same way:
`422 {"error": "invalid_request", "fields": [...]}`, which names the fields,
never repeats the input and holds no `null`; when such a body is nested
more than 32 levels deep, the answer is `400 invalid_request`.

The task page waits 60 seconds for a start or a relay, longer than the
BFF's own 45, and 30 seconds for a claim, a release or a hand-in, longer
than the BFF's 25; when the BFF's deadline passes it answers
`504 upstream_timeout`. With no answer either way, the page says it may
have happened ("It may have started. Checking…", "The notes may have been
sent. Checking…", or "FORGE didn't hear back in time, so it may have gone
through."), reads the task again and shows what it finds; it never says
nothing changed. Pressed again within two minutes, a start gets
`already_started` and the first start's link.

**Send the notes.** When checks fail on a task started with Jules, Cursor or
Devin, `POST /api/bridge/feedback/<id>` passes the notes on to that
session as a follow-up, but only with a saved key, and only with the one
that started the session: FORGE stores a keyed fingerprint of the key a
session started with (never the key itself) and compares it. The holder's
status says whether a relay would go out (`canRelay`), and the task page
shows "Send the notes" only then. A relay counts toward the 10 vendor calls
an hour. For the holder, anything that stops a relay (checks that haven't
failed, no matching saved key, the hourly limit, a vendor error) answers
`relayed: false` with the notes to show instead. A vendor that answers 401
to a relay has its saved key deleted; a 403 keeps it.

`/dispatch`, `/release`, `/feedback` and `/submit` act only for the person
holding the task, and check that before anything else: on a task nobody
holds any more (it was released, or its time ran out with no open pull
request) they answer `409 not_claimed`, and on one someone else holds,
`403 not_holder`. The task page says both as "This task isn't yours any
more, so nothing changed. Claim it again first.", and the connector's tools
give the agent a tool error instead ("Task #N isn't claimed by anyone. Call
claim_task first.").

**Open my agent** (open rails): a link that opens the agent with the brief
already typed in; the contributor presses send. Always on, except Google
Antigravity, which works only through the connector and so is offered only
while `mcp_connector` is on.

| Rail | How it opens |
|---|---|
| Claude Code on the web | `https://claude.ai/code?prompt=<brief>&repositories=<login>/forge-app`. When that would pass 7,000 characters, `prompt_url=` points at the API's `GET /api/bridge/tasks/<id>/brief?login=<login>` instead (plain text, readable from any origin) |
| Claude Code on your computer | `claude-cli://open?repo=<login>/forge-app&q=<brief>` (5,000-character cap; over it the link opens without the brief and the steps say "ask it: Start FORGE task #N") |
| Codex app | `codex://new?prompt=<brief>&originUrl=https://github.com/<login>/forge-app.git` (the desktop app, with the fork cloned) |
| VS Code agents | `vscode://agents/new?prompt=<brief>` (VS Code 1.140 or newer; the contributor picks Copilot, Claude or Codex and sends) |
| Cursor app | `cursor://anysphere.cursor-deeplink/prompt?text=<brief>` (10,000-character cap) |
| Google Antigravity | No link exists, so the page gives steps: press Sync fork on GitHub first if the fork is older than October 2026 (so it has `.agents/mcp_config.json`), open the fork in Antigravity, sign in to FORGE the first time (Settings → Customizations, Authenticate next to `forge`, then paste back the code the browser shows), and ask it "Start FORGE task #N" |

An agent opened this way has the brief; with the FORGE connector (below) it
can also claim, report progress and read check results by itself. Copy and
paste survives only in closed fallbacks: "Using another agent? Copy the
brief", and "Using another agent? Copy the notes" under failed checks.

The Bridge changes the pipeline's *reachability*, never its
*permeability*: whatever reaches upstream is a fork pull request, which
lands in the same Gauntlet and protocol checks that already assume hostile
authors. A full compromise of FORGE is still worse for contributors than it
used to be. Whoever holds the state database and `FORGE_VAULT_KEY` holds
every saved vendor key, and each works on whatever that vendor account can
reach, not only the fork; whoever controls the API can send connected agents
misleading task text. That is why keys are saved only when asked, can be
removed on `/me` (even with the Bridge or the vault switched off), and are
encrypted under a key that lives only on the API box; why no GitHub token is
ever stored, and the Copilot rail's one-time token is revoked once used; and
why the agent config, the connector, vault and rail code, the task fixtures,
and every file a key passes through on its way there are protected paths.

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
| `/authorize` | web redirect (`next.config.mjs`) | The same clients' consent path: a temporary `307` to `/oauth/authorize` with the query unchanged (not a `308`, which browsers would cache), where the sign-in gate applies as usual |
| `/oauth/authorize` | web page | GitHub sign-in if needed, then the consent screen; or, for a request the API refuses but may report back to the agent, a page saying "This connection request can't go ahead" and why, with a "Return to" button naming where it goes (never an automatic redirect) |
| `/oauth/authorize/decision` | web route | The Allow / Cancel form post; answers `303` back to the agent |
| `/connect` | web page | "Connect your agent to FORGE": the address and the steps for each client, with one-click installs for VS Code and Cursor |
| `/bff/oauth/grants` | web route | Your connected agents (list, disconnect), through the BFF |

**Connecting an agent** (OAuth 2.1, authorization code with PKCE):

1. The agent calls `/mcp` without a token and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="forge.tasks"`.
2. It reads the metadata and registers at `/oauth/register`. Registration
   keeps nothing on the server: the `client_id` it gets back carries the
   client's name, redirect URIs and auth method, signed (HMAC-SHA256) with
   a key derived from `FORGE_OAUTH_SECRET`.
3. It opens `/oauth/authorize` in the browser with a PKCE challenge (S256
   only). The person signs in with GitHub if needed (practice accounts are
   refused) and sees "Connect *name* to FORGE?", where it will send them
   back (the redirect host, shown because the name is whatever the agent
   chose to call itself), what the agent can and can't do, and Allow or
   Cancel. The page is never cached or framed, and the decision post needs
   the session and a same-origin request; the API takes Allow and Cancel
   alike only with the signed-in person's assertion.
4. Allow issues a single-use code (5 minutes, because Antigravity's
   sign-in has the person paste the code back by hand) bound to the
   client, the redirect URI, the PKCE challenge, the person and the
   resource, and the browser goes back to the agent with `code`, `state`
   and `iss`. A code presented a second time revokes the whole grant.
5. The agent trades the code at `/oauth/token` for an access token (1 hour)
   and a refresh token (30 days, replaced on every use). An old refresh
   token presented again within 30 seconds of being replaced is a retry
   (the agent lost the answer, or two of its sessions refreshed at once)
   and gets a fresh pair in the same grant, once: presenting it again, or
   after the 30 seconds, revokes the whole grant. A grant revoked any other
   way stays revoked, retry or not. A grant holds at most 5 live refresh
   tokens; minting a sixth revokes the oldest. Both tokens are random
   strings, stored only as SHA-256 hashes, and bound to `<origin>/mcp`.

Redirect URIs must match exactly, except that an `http` loopback address
(`127.0.0.1`, `localhost`, `[::1]`) matches on any port. A redirect URI is
`https`, `http` to loopback, or an app's own scheme (`scheme://host/...` or
`scheme:/path`) that is a known client's (`cursor`, `vscode`,
`vscode-insiders`, `windsurf`, `antigravity`, `claude`, `codex`, `zed`,
`kiro`) or reverse-domain (`com.example.app`). Refused: fragments;
backslashes; anything but printable ASCII; `javascript:`, `data:`, `file:`,
`vbscript:`, `about:` and `blob:`; schemes that open a browser on an address
they carry or that any web page can claim (`microsoft-edge`, `firefox`,
`brave`, `intent`, and any starting `x-safari-`, `googlechrome`, `opera`,
`web+` or `ms-`); an app scheme carrying another address
(`scheme:https://...`); and any http(s) host a browser could read
differently from Python (user info, percent-encoding, a trailing dot,
numeric shorthand like `127.1`). The address the consent page shows comes
from the same parse: the host in lowercase ASCII (an IDN in its `xn--`
form), `scheme://host` for an app scheme with a host, and "the app" plus
the scheme for `scheme:/path` (as in "the app com.example.app"). An error
about the client or its redirect URI is shown as a page, never redirected.
Each connection is a grant: `/me` lists your connected agents (name, where
it sends you back, when connected, last used), and Disconnect revokes the
grant and every token in it. While the connector is switched off the list
is hidden, and no token works anyway.

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
the hosted list only keeps those clients from being locked out. Each grant
(one connected agent, whichever of its tokens it uses) may make 120 calls a
minute (more answer JSON-RPC error `-32000` "rate limited"), so refreshing
a token buys no fresh budget. The tools
(`services/bridge_mcp.py`) call the same service functions as the HTTP
routes, as the person the token belongs to:

| Tool | What it does |
|---|---|
| `whoami` | Which GitHub account the agent is acting for |
| `list_tasks` | Open tasks, your own, or all (`filter`) |
| `get_task` | One task: the brief written for you, the acceptance criteria, your fork and branch, the issue, who holds it, and the compare link |
| `claim_task` / `release_task` | Claim the task in your name, or let it go |
| `report_progress` | `started`, `working`, `pushed`, `pr_opened`, `blocked` or `done`, with a message of up to 500 characters and, optionally, the pull request link (which counts only if it passes the rules under [The Bridge](#the-bridge)); at most 30 an hour per task |
| `get_check_results` | The current holder's pull request's checks, and plain notes on what failed |
| `submit_task` | Hand in the pull request: on `verastd/forge-app`, from your fork, opened after the claim, naming the task (its branch, `[#N]` in the title or `Closes #N` in the description), and not handed in for another task; at most 10 hand-ins a minute per person, web and connector together |

There is one prompt, `forge_task`, and short server instructions that tell
an agent the task flow. Anything an agent writes (progress messages, the
name it registers under) is untrusted: stored and shown as plain text only,
length-capped, with control characters and variation selectors stripped and
at most two combining marks kept on a character, and its progress messages
are shown only to the person holding the task.

**Switches.** `mcp_connector` or `github_signin` off: every connector route
answers `404 {"error": "connector-disabled"}`, so connected agents stop at
once and carry on when both are back on. `FORGE_PUBLIC_ORIGIN` unset or not
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
or `DELETE` on `/mcp` gets `405`. An id or method holding a lone surrogate
(which JSON can carry and UTF-8 can't) gets `-32600`, and any text echoed
back has one replaced with `?`, so such a request never gets a bare `500`;
a bad message in a batch leaves the others' answers alone.

**Where agents find it.** An agent opened in a contributor's fork finds the
connector in the repo itself, for these clients:

| Client | File | When it's used |
|---|---|---|
| Codex (CLI, IDE extension, ChatGPT desktop app) | `.codex/config.toml` | Only in a trusted project. Sign in once with `codex mcp login forge` |
| Google Antigravity (CLI and IDE; 2.0 is still to be live-tested) | `.agents/mcp_config.json` | Sign in under Settings → Customizations; Antigravity shows a code to paste back once. A fork older than October 2026 gets the file with Sync fork on GitHub |
| Cursor | `.cursor/mcp.json` | Cursor asks before it uses the server's tools |

Claude Code (and VS Code 1.140+, and GitHub Copilot CLI) would read a
`.mcp.json` at the repo root. The repo doesn't include `.mcp.json` yet;
until it does, add the connector to Claude Code with
`claude mcp add --transport http forge <url>` and sign in with `/mcp`, or
press "Add FORGE to VS Code" on `/connect`. There is no `.vscode/mcp.json`
either: VS Code 1.140 calls that file deprecated, reads the workspace's
`.mcp.json` instead, and would run the server twice if both existed. Claude
on claude.ai and in the desktop app, and ChatGPT, connect from their own
settings (`/connect` has the steps). Two custom
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
are `.mcp.json`, `.vscode/` and `.claude/`, which this repo doesn't include
yet: an agent connects to whatever server these files name, so a pull
request that repoints them would phish every contributor. The same goes for
the page that shows the connector's address and builds the one-click
installs (`apps/web/src/app/connect/`), the links that open agents
(`apps/web/src/lib/launch.ts`), the text every agent is given (the brief,
the rail registry with its key pages, the connector's tools, and the task
fixtures in `apps/api/src/forge_api/fixtures/`), and the code a pasted or
saved key or the Copilot token passes through, with the checks on the
links shown back (`apps/web/src/lib/bff-forward.ts`, `lib/handoff.ts`,
`lib/api.ts`, `apps/web/src/components/contribute/`, and the API's
`services/bridge.py`, `routers/bridge.py`, `models.py` and `main.py`).

## State, keys and GitHub reads

**The state database.** One SQLite file (`services/state.py`) at
`FORGE_STATE_DB_PATH`: `var/forge-state.db` in the repo by default (created
on demand, git-ignored), `/var/lib/forge-api/forge.db` in production. It
holds the Bridge's claims, hand-offs, progress events, merges and
submissions (`bridge_` tables, with the tasks published from proposals in
`bridge_published_tasks`), saved agent keys (`vault_`), the connector's
grants, codes and token hashes (`oauth_`), and the Propose floor: its
members (`members`), proposals with their votes, comments and timelines
(`proposal_`), and the bell (`notifications`). Write-ahead logging,
foreign keys and secure delete on (deleted rows are overwritten, not just
unlinked), one lock per process: it is built for the one API process on one
box that the pilot runs. Back it up, and keep the backups as private as
the box: losing the file forgets every claim, saved key, member and
proposal and disconnects every agent, and the file together with
`FORGE_VAULT_KEY` opens every saved key. Removing or replacing a key also
empties the write-ahead log, so the old sealed copy is gone from the live
files, but a backup taken before still holds it.

**No migrations yet.** Each table is created only if it doesn't exist yet,
so a file from an earlier build keeps its old tables, and the API fails on
the columns they lack. After an upgrade that changes the tables, stop the
API, delete the file together with its `-wal` and `-shm` files, and start
it again: claims and their timelines are forgotten, connected agents have
to connect again, and saved keys have to be entered again. Production has
no state database yet; a checkout that ran an earlier build deletes its
`var/forge-state.db` the same way. The Propose floor (Phase 5) changed no
table: its tables are all new, so a file from Phase 4 gains them at the
API's next start and keeps everything else.

**The vault.** A key a contributor asks FORGE to remember is encrypted
with AES-256-GCM under a key of its own for each person, derived from
`FORGE_VAULT_KEY` with HKDF-SHA256 and the person's GitHub id, with the
person and the rail bound in as associated data, so a row copied to another
person or rail won't decrypt (`services/vault.py`). Afterwards FORGE shows
only a hint (at most the last four characters), uses the key only for a
start the person asks for and to pass that session the check notes when
they ask (see Send the notes, above), and deletes it when they remove it on
`/me`, when a vendor rejects it at a start, or when a relay of check notes
gets a 401 (a 403 keeps it). A saved key that no longer opens
(`FORGE_VAULT_KEY` changed, or the row was altered) reads as not saved
everywhere, but no read deletes it: it stays stored, unused, until the
person saves a new key for that rail, which replaces it, and it opens again
if the old `FORGE_VAULT_KEY` comes back. With `FORGE_VAULT_KEY` unset or
malformed the vault is off: nothing is saved or used, "Remember it" isn't
offered, and starting still works with a key typed in each time; saved keys
are still listed on `/me` (hints only, with a note that FORGE can't use
them right now) and can still be removed. Copilot never touches the vault:
its one-time GitHub authorization is used for that one start and then
revoked.

**GitHub reads.** The API reads public GitHub data only
(`services/github_reads.py`): the contributor's pull request
(`GET /repos/verastd/forge-app/pulls?head=<login>:<branch>&state=all`; when
none is on the task's branch, GitHub's search for the holder's pull
requests opened since the claim,
`repo:verastd/forge-app is:pr author:<login> created:>=<claim time>`, whose
newest three that name the task are read in full), its check runs, a pull
request by number at submission, and whether the contributor's fork
exists. Results are cached for 60 seconds (the fork check for 5 minutes) in
a bounded cache that drops its least recently used entry when full. Each
read gets 5 seconds in all, connecting and the whole answer included. A
failed read is remembered for 60 seconds, and after 5 failures in a row
FORGE stops asking GitHub for 60 seconds. Production needs
`FORGE_GITHUB_READ_TOKEN`: a fine-grained token with read-only access to
public repositories, which the operator creates and sets on the API box,
raising GitHub's limit from 60 to 5,000 requests an hour. Anonymous reads
get 60 an hour per IP, and every task someone is watching can cost two a
minute, plus a search while no pull request is found on its branch. A
token GitHub refuses (`401`, expired or revoked) doesn't stop the reads:
each is retried once anonymously, with one warning in the API's log naming
the variable. On the task page and in the connector, a GitHub failure,
running out of that limit included, reads as "pending" or "GitHub can't be
reached right now" with a plain note, never an error. Only handing in a
pull request and the fork check, which can't go ahead without GitHub,
answer `503 github_unavailable` (the connector's `submit_task` says so as
a tool error).

## The Apps lobby

`/apps` is a 3D room: the operator's cave prototype, ported to plain
three.js (see [ADR-004](adr/ADR-004-apps-lobby.md) for why that, and why
LiveKit). It is a free-roam cave whose wall is a 32 × 90 grid of app slots,
2,880 in all. The Data app is lit in slot 0, the bottom panel straight ahead
of where everyone starts; every other slot is dark, waiting for a proposal.

It needs a sign-in, like the apps on it: the middleware sends a signed-out
visitor to `/signin?next=%2Fapps` (query and all, so `/apps?from=data` comes
back as itself).

**The page works without the 3D view.** `src/app/apps/page.tsx` renders the
heading and a directory on the server: one link per lit app in the registry,
and a count of the empty slots. With no JavaScript, no WebGL, the
`apps_lobby` flag off, or a view that stopped, the directory is still the
page, and still the way into every app. While the 3D wall is the page (from
the server's first render, through loading, to the wall on screen) both are
out of sight but still in the page for screen readers, and the directory
shows only while a keyboard user has focus in it (`:has(:focus-visible)`).

**The chrome around it.** On `/apps` only, the site nav steps out of the
cave's way (`src/components/LobbyNav.tsx`). On a desktop it is the usual bar
on arrival and slides up once the wall is up, coming back while the pointer
is in a 20 px strip along the top edge or over the bar, while focus is in it
(the strip is also a button, so Tab from the top lands in the nav), and
while the account menu or the bell's panel is open, then leaving 600 ms
after none of that holds; away, it floats and is `inert`. On a touch screen,
or at 640 px and under, it is a "Menu" button in the top left corner that
opens the nav as a panel. Without the wall the page is a normal page, so the
nav is the normal bar. The cave's own way out is Exit, beside it: a link
home, on screen whenever the wall is the page.

**The pieces.**

- `packages/lobby` (`@forge/lobby`): everything that isn't drawing, as pure
  functions tested in Node. The wall's geometry (`layout.ts`); the camera's
  limits, where it starts and how it's saved (`camera.ts`, `storage.ts`); the
  app registry and the rules every entry must pass (`registry.ts`,
  `csp.ts`); which chrome a route gets (`chrome.ts`, which `SiteChrome`
  uses); the presence packet, send rate, name rules, rate limit and the
  check that a peer's next position is one a camera could reach
  (`presence.ts`, with the camera's top speeds in `camera.ts`); and the
  voice: Fable's attenuation curves and acoustics (`attenuation.ts`,
  `acoustics.ts`, including the cave's synthesized impulse response) and
  the cave's settings and rules for them (`voice.ts`: the ranges, the
  reverb level, the cap on voices, the dwell and the backoff, when a panner
  moves, when someone counts as speaking, `nearness` and `permitted`).
- `src/components/lobby/Lobby.tsx`, the shell: the flag, a one-off WebGL2
  probe, the scene inside an error boundary, the presence feed, the touch
  stick and lift buttons, and what a tap does. `VoicePanel.tsx` beside it
  is the people panel (below).
- `src/components/lobby/scene/`: the scene itself, plain three.js with no
  React (`createCave.ts`, with `controls.ts`, `peers.ts`, `screen.ts`,
  `readout.ts` for an empty slot's readout and its light, and `palette.ts`,
  the cave's colours: FORGE's amber, the same values as the `--cave-*`
  custom properties on `Lobby.module.css`'s `.root`).
  `LobbyScene.tsx` loads it with `next/dynamic` and `ssr: false`, so three.js
  is downloaded on `/apps` only, and never in any route's first load.
- `src/components/lobby/presence/`: the presence feeds (below).
- `src/components/lobby/voice/engine.ts`: the voice engine, a close port of
  Fable's `ProximityVoiceEngine` (its own header lists what FORGE changed).
  Only the LiveKit feed loads it, by `import()`, so it and `livekit-client`
  ship in lazy chunks of their own, never in the `/apps` first load.
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

Beside it: `data-x`, `data-y`, `data-z`, `data-yaw` and `data-pitch` (the
camera, written ten times a second once the first frame is drawn), `data-focus` (the app
under the crosshair or the last tap, or `empty:<slot>`), `data-motion`
(`full`, or `reduced` while the visitor prefers reduced motion: no drift,
flicker or bob), `data-feed` (`none`, `local` or `livekit`: the feed presence
is actually running on), `data-peers` (the people drawn in the room, so not
anyone whose position hasn't arrived), `data-voice` (`unavailable`, `off`
or `on`), `data-sound` (`blocked` while the browser holds sound back until
a tap, `on`, or `none` without voice), `data-room-sound` (the cave's
reverb: `off`, `rendering`, `live` or `failed`), `data-deafened`, and
`data-hover-slot` and `data-hover-glow` (the empty slot whose readout is
showing, or empty, and whether its light is `on` or `off`). The people
panel marks each row `data-person-id`. The site nav's header on `/apps`
carries `data-nav-mode` and `data-nav` (`shown` or `hidden`).

**Moving and opening.** Drag to look (a drag pulls the cave, as a photo
sphere does: drag right and the view turns left); WASD, the arrow keys or
the touch stick to walk; Space and Shift, or the lift buttons, to rise and
fall. The camera stays 2.5 m inside the wall's ring, between eye height and 220 m. A
tap on a lit panel saves the camera in `sessionStorage`
(`forge.lobby.pos.v2`, so per tab) and opens the app; so does leaving the
lobby any other way. Any visit to `/apps` in that tab, the browser's Back
included, starts from the saved camera; a tab with nothing saved starts at
the centre. The app's `AppBar` links back to `/apps?from=<slug>` (with no
saved camera, it faces the app's slot). The cave is its own experience:
nothing in it leaves but a lit app and Exit. A tap on a dark slot stays in
the cave and only says "Empty slot"; the mouse over one (or, on a touch
screen, a tap on one, for 3 s) shows its readout in its panel, its number
(the slot index), row and column, and height, in the grid's own amber, and
lights the rock behind it with one light made with the scene, whose
intensity alone changes. When the page chrome changes (lobby, app, or site),
focus moves to the new page's `<h1>`, or to the element the page marks
`data-arrival-focus`: coming back from an app to a lobby without its wall,
that app's directory link; with the wall, nothing, so the hidden `<h1>`
takes it, and the camera keys work from there.

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

- signed out (a session that expired mid-visit; the middleware keeps
  everyone else out): `none`. The cave, alone, and nobody sees you.
- the practice build (`NEXT_PUBLIC_FORGE_DEMO=1`), signed in: `local`, a
  `BroadcastChannel('forge.lobby')` between tabs of one browser, with no
  server and no voice. It exists so the practice app, and e2e, can show
  presence end to end.
- a live build, signed in: `livekit`. It asks `POST /api/lobby/token` for a
  token, only then loads the voice engine and `livekit-client` with it
  (which then logs warnings and errors only), and joins the room `lobby`. If
  the route refuses (`401` signed out, `403` practice, `503` not
  configured) or answers anything else (`error`), or the join then fails in
  the browser (`failed`: the engine's chunk didn't load, no AudioContext,
  LiveKit's connect gave up), the feed settles on `none` with that reason,
  the people panel says why, and the lobby carries on alone. A join that
  failed in the browser tries once more by itself once the scene is up (a
  slow phone may only have been busy building it), and then offers "Try
  again".

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
dropped; and on LiveKit, somewhere they could have walked or flown to since
their last packet (16 m/s across the floor, 24 m/s up or down, which the
scene holds the camera to, plus 3 m for packets that arrive together; a
session's first packet is exempt), or it is dropped too. A member's position
never goes stale while they're in the room, so someone standing still, or
whose tab is hidden, keeps their place.

Voice (v2, [ADR-004's addendum](adr/ADR-004-apps-lobby.md#addendum-voice-v2-2026-10-04))
is LiveKit audio played through Web Audio, by the voice engine. A peer is at
full volume within 5 m, then fades along Unreal's natural-sound curve to
−40 dB at 35 m, and is silent past it. The engine subscribes to a peer's mic
itself (LiveKit's `autoSubscribe` is off): from 40 m, and it keeps it until
45 m, so someone on the edge doesn't flicker in and out, and once it has
taken or let go of a voice it holds that for 2 s, so nobody can make
everyone churn. It receives the nearest 8 voices at most on a phone or a
tablet (16 otherwise), plus anyone it already hears speaking, so a
conversation isn't cut off when someone else walks nearer; the rest are
listed as "too many voices nearby". A subscription the SFU refuses is
asked for again after 1 s, doubling to 30 s. Only a peer's microphone of
kind audio is ever subscribed or played. Each voice runs
through an HRTF panner (placed in the listener's own frame, so it comes from
where its speaker stands, whichever way you face), a lowpass that closes
from 18 kHz to 1.8 kHz with distance, and a dry gain, plus a send into one
shared convolver: the cave's reverb, an impulse response synthesized in the
browser (deterministic, so everyone hears the same cave: 3.4 s, a 28 ms
pre-delay, a tail that darkens). The send fades slower than the dry path,
so a far voice is mostly echo. A panner moves only once its speaker has
turned more than 3° around you or come 0.25 m nearer or farther, since
every move costs the browser an HRTF cross-fade. Who is speaking is what
this client hears: an analyser on each voice's chain, after its dry gain
and reverb send, read each tick with some hysteresis (and your own, from
your mic's meter), so "talking" means exactly "heard"; the SFU's own
room-wide speaker updates are never read (ADR-004 has the limit). Each
received track keeps one Web Audio source for the whole visit, since
Chrome never frees one while its context runs; past 32 idle ones the
engine starts a new context at a quiet moment. The engine runs on its own
10 Hz timer rather than the scene's frames, so a hidden tab keeps
evaluating, and keeps its 1 s position heartbeat. Its settings are all in
`@forge/lobby`'s `voice.ts`.

Nobody's mic is on when they arrive: the panel's "Mic" asks the browser for
the microphone the first time it's pressed (the press is the gesture the
permission prompt needs), and off stops the capture, so the browser's
recording indicator goes out. Browsers hold sound back until a gesture: the
first tap, click or key anywhere starts it, and until then the panel shows
"Turn on sound". A reconnect leaves the mic as the room has it, and the
panel says "Reconnecting…" meanwhile.

The range holds at the source as well as in each listener's own client,
because a modified client could otherwise listen from anywhere: while
someone is in the room, their client tells LiveKit who may receive their mic
(`setTrackSubscriptionPermissions`), which is every participant whose last
known position is within 50 m. A list that takes someone off goes out at
once (when they walk away or leave); one that adds someone, at most every
500 ms. Someone whose position hasn't arrived is never on it, and neither
is a new session of someone who just rejoined (a new participant sid),
until it says where it is. The list starts empty before the client even
connects, so LiveKit never hears its default of everyone, and goes back to
empty during a full reconnect, so what LiveKit resends as it reconnects is
nobody. A client that lies about its own position still gets in: positions
are peer to peer.

**The people panel** (`VoicePanel.tsx`, the "People nearby" aside) says
whether voice is on and, when it isn't, why: signed out, the practice
account, voice not set up (`503`), the server out of reach, a join that
failed in this browser ("Couldn't connect to voice.", with "Try again"), or
disconnected (with "Rejoin"); with sound held back it says "Voice on. Sound
is off until you press Turn on sound." beside that button. The practice
build, which has no voice and no GitHub sign-in, says so in its own words
(and its hint line leaves out the "Voices carry about 35 m" the live one
has). The panel has "Mic" (with the level meter), "Deafen", a room-sound
pill ("Rendering cave sound", "Cave sound", or "Cave sound failed" with
Retry), and a line saying why the mic didn't start (blocked by the browser,
no microphone, or anything else). It lists everyone else in the room,
nearest first with their distance, and anyone whose position hasn't
arrived as "joining" (with no orb), so nobody who could be listening is
invisible; "Nobody else is here yet." only when the feed can see the room.
Each row says why you can't hear someone ("mic off", "out of range" from
35 m, "too many voices nearby", "muted by you"), has a per-person "Mute",
and keeps the technical detail (the full name, direct and reverb levels,
the lowpass) behind a tooltip on its level bar, a button: shown on hover or
focus, toggled by a tap or a press, hidden by Escape whether hovered or
focused. Its top block keeps its size and only the list scrolls; the panel
is capped in height on every screen so it never runs under Exit, the menu
button, the stick, the lift buttons or the toast (a short touch screen held
sideways gets its own place at the top, and on a phone the toast moves to
the top right). On a phone it shows the nearest four, and anyone speaking,
then an "and N more" button that opens the rest. The order holds still
while the pointer is over the list or focus is in it. For screen readers,
its live regions (the status, the mic problem, the elsewhere notice, the
cave sound failing) are always in the page with their text set and
cleared, a control that goes away under focus hands it on (to Mic, or to
the next row), and toggles keep their words, with `aria-pressed` carrying
the state. In development builds the engine also exposes a debug view,
`window.__forgeVoice` (each voice's graph, the output's level,
`updateConfig` and `setPeerOcclusion`), and the practice feed takes
`?voice-fixture=full`, the panel's fullest state, for the layout e2e;
production builds compile both out.

The room holds each member once (identity `gh:<id>`), so opening the lobby
in another tab or device takes this one's seat: the first tab's feed
settles on `none` (`data-feed=none`), and it says "You're in the lobby in
another tab or device." with a "Rejoin here" button, which joins again and
moves the seat back.

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
secure origin. The site's Content-Security-Policy (`next.config.mjs`)
limits `connect-src` to this origin, the API origin in
`NEXT_PUBLIC_API_URL` and the LiveKit host in `LIVEKIT_URL` (as `wss:` and
`https:`), all read when the app is built. LiveKit Cloud's other regions
are not allowed, so a join that would fail over to another region fails
instead. LiveKit bills per participant-minute and everyone in the lobby is a
participant, talking or not; ADR-004 has the numbers.

## The Propose floor

`/propose` is where members bring ideas for FORGE to build and decide on
them in the open, by Robert's Rules with the pilot's numbers (see
[ADR-006](adr/ADR-006-proposals.md) for why). The `proposals` flag gates
all of it. Anyone can read the floor, every proposal and its whole record;
acting on it needs GitHub sign-in.

**The pieces.**

- `apps/web`'s `src/app/propose/`: `/propose` lists the proposals in four
  sections (Needs a second, In debate, Voting, Decided), each deadline as a
  countdown, with a "Bring a proposal" button and the rules collapsed
  under "How proposals work". `/propose/new` is the form; the middleware
  sends a signed-out visitor to sign in first. `/propose/<id>` is one
  proposal's record and whatever its reader may do now. The bell is
  `src/components/NotificationBell.tsx`.
- The floor's list, and a proposal's record for a signed-out visitor, are
  read straight from the API (`NEXT_PUBLIC_API_URL`), as the Contribute
  page's public reads are. Everything that needs to know who is asking
  goes through the same-origin BFF, `/bff/proposals*` and
  `/bff/notifications*`, which mints the assertion as `/bff/bridge/*` does
  (see [Identity](#identity)): the practice account is refused, writes must
  come from this origin, and bodies are capped at 32 KB (16 KB for the
  bell).
- `apps/api`: `routers/proposals.py` and `services/proposals.py` (the
  rules, the timeline, the draft task and the ticker), `routers/members.py`
  and `services/members.py` (who counts), and `routers/notifications.py`
  and `services/notifications.py` (the bell). Tasks published from
  proposals are served by the Bridge (`services/bridge.py`), after the
  fixtures.
- The practice build (`NEXT_PUBLIC_FORGE_DEMO=1`) runs a practice floor in
  the browser instead (`src/lib/proposals-offline.ts`): sample proposals
  the practice account can second, consent to and pass, with "Practice:
  nothing is saved." on every screen. Nothing reaches the API.

**Who takes part.** Anyone signed in with GitHub can bring a proposal,
second, consent or object, comment and vote. Signed-out visitors and the
practice account read everything and act on nothing. Throwaway GitHub
accounts can take part as well, which the pilot accepts (ADR-006). The API
makes every check itself (who is asking, who moved it, who is eligible,
who is an admin); a proposal's `you` block tells the page what its reader
may do.

**Members.** The API keeps one row per GitHub user id in `members`: the
login, and when FORGE first and last saw them. A member is recorded when
they sign in with GitHub, by the sign-in callback's
`POST /api/members/hello` (after the redirect, one try of at most 3
seconds; it never holds up or breaks a sign-in), and again on every
proposals or notifications request that carries their identity, the bell's
poll included. The table started empty with Phase 5 and was never
backfilled: an account FORGE knew before (a Bridge contributor, the owner
of a connected agent) becomes a member only when it signs in, or uses
FORGE signed in, after the deploy.

**States.**

| State | Shown as | What moves it on |
|---|---|---|
| `submitted` | Needs a second | Another member seconds it (→ `debate`), or nobody does in time (→ `lapsed`) |
| `debate` | In debate | Everyone in the eligible set consents (→ `passed`, at once); debate ends with no objection (→ `passed`, without a vote); debate ends after an objection (→ `voting`) |
| `voting` | Voting | The vote closes (→ `passed` or `failed`) |
| `passed` | Passed | An admin publishes its task (→ `building`) |
| `building` | Being built | The task's pull request merges (→ `shipped`) |
| `shipped`, `failed`, `lapsed`, `withdrawn` | Shipped, Failed, Lapsed, Withdrawn | Nothing: these are final |

`submitted`, `debate` and `voting` are the active states; the mover can
withdraw a proposal in any of them (→ `withdrawn`). There is no stored
`seconded` state: seconding opens debate at once, and the timeline records
the second as its own line.

**The rules, as built.**

- **Motion.** A title (1 to 100 characters) and a pitch in plain English
  (1 to 4,000), both plain text. A member with a proposal in an active
  state can't bring another (`409 one_active_proposal`, with its id), and
  nobody can bring more than 3 in 24 hours (`429 rate_limited`). The mover
  can edit the title and pitch until it is seconded, at most 10 times an
  hour (`429`) and 20 times in all (`409 edit_limit`); each edit adds 1 to
  the text's revision, which starts at 1.
- **Second.** Any member but the mover (`403 own_proposal`), on a proposal
  waiting for one, naming the revision they read: if the mover edited it
  since, the answer is `409 proposal_changed`, so nobody seconds text they
  never saw. Seconding opens debate, sets its deadline, records the mover's
  consent, and freezes the **eligible set**: every member seen in the 30
  days before the second (`members.last_seen`), plus the mover and the
  seconder whatever their dates. Members outside it can comment, but not
  consent, object or vote on it (`409 not_eligible`).
- **Debate: consent and objection.** From the second until debate ends,
  each member of the eligible set may consent or object, once. Both are
  final (`409 already_decided_consent`). The mover counts as consenting
  from the second; the seconder consents like anyone else.
  - When everyone in the eligible set has consented and nobody has
    objected, the proposal passes at once.
  - When debate's deadline comes with no objection, it passes without a
    vote: consent by silence.
  - One objection ends both paths: debate runs to its deadline, and then
    the vote opens. Consenting or objecting after an objection still goes
    on the record, and changes nothing else.
- **Comments.** Any member, eligible or not, from the second until the
  vote closes: 1 to 2,000 characters, at most 10 per member per proposal
  an hour. The thread is public. A proposal's page carries the newest 100,
  and `GET /api/proposals/<id>/comments?before=<commentId>` pages back
  through the rest, 100 at a time.
- **Vote.** Only the eligible set votes: Yes, No or Abstain, one ballot
  each, changeable until the vote closes. Until then only the turnout is
  shown ("3 of 5 have voted"), never the totals. At the close:
  - **quorum** is more than half of the eligible set casting a ballot,
    Abstain included;
  - with quorum, the proposal passes if Yes outnumber No, and fails on a
    tie or more No;
  - without quorum, it fails.

  The tally, and each member's final ballot by name, become public at the
  close.
- **Write limit.** Each member may second, consent, object, vote, edit or
  withdraw at most 60 times an hour across the floor (`429 rate_limited`).
- **Plain text.** Titles, pitches, comments and draft fields go through
  the Bridge's sanitizer for agent text (`clean_text`): control and format
  characters and variation selectors are dropped, and stacks of combining
  marks are capped. Pitches and comments keep their line breaks. Text that
  shows nothing, blank or made only of invisible characters (zero-width
  characters, Hangul fillers, the blank Braille pattern), is refused.
  Lengths count Unicode code points, the same on both sides. Nothing is
  rendered as HTML or markdown.

**The public record.** Anyone can read all of it: the mover, the seconder,
every consent and objection with its time, the debate thread, the tally
after the close, the outcome, and a timeline of every state change and
action (moved, edited, seconded, consented, objected, commented, the end
of debate, the vote opening, each ballot once the vote closes, passed or
failed, lapsed, withdrawn, the draft task, the task published, shipped,
the admin actions, Test timers switched, and the floor pausing and
resuming). A failed proposal keeps its record and its tally.

**Timers.** Each deadline is fixed when its period starts.

| Period | Pilot | Test timers on |
|---|---|---|
| To find a second, from the motion | 7 days | 10 minutes |
| Debate, from the second | 3 days | 5 minutes |
| The vote, from the end of debate | 2 days | 5 minutes |

**When things happen.** One pure function (`advance` in
`services/proposals.py`) works out every transition a proposal has due at
a given moment. It runs on every read and write of a proposal, so a reader
sees it as it stands at that moment, and in a ticker: a background
task in the API process (FastAPI's lifespan) that applies every passed
deadline on the floor every 60 seconds, logs and survives a failing beat,
and stops when the API shuts down. Each transition is written in one
transaction as a compare-and-set on the proposal's state and version, so
two readers, or a reader and the ticker, never apply it twice. A
transition applied late is dated at its deadline, so the record doesn't
depend on when somebody looked.

**The floor pauses while members can't act.** That is while the
`proposals` flag or the `github_signin` flag is off, or the flag
configuration fails closed (which turns every flag off).

- While it is closed, no transition applies. The API keeps when it closed
  (`proposal_floor`), and each active proposal's timeline says so.
- The floor notices at the ticker's next beat, at a read, or when a
  request is refused because `proposals` is off, so deadlines can run on
  for up to about a minute after a switch is thrown.
- When both flags are on again, before anything else, every deadline still
  running when the floor closed moves later by the time it was closed, and
  each active proposal's timeline says so ("The floor was closed for 2 h
  10 min; deadlines moved by that."). A deadline that had already passed
  before it closed stays put and applies straight away, dated at itself.
- With `proposals` on and sign-in off, the list and a proposal's page say
  `floorPaused: true`. With `proposals` off, every `/api/proposals*` route
  answers `404`.
- API downtime is not a pause: when the API comes back, whatever fell due
  meanwhile applies, dated at its deadline.

**Admins.** The admin is whoever's numeric GitHub user id is in the API's
`FORGE_ADMIN_IDS`, which today is the operator. An admin is a member like
anyone else (they can bring, second, consent and vote, and count in
eligible sets), and also:

- switches **Test timers** on or off (the switch on `/propose`,
  `PUT /api/proposals/settings`). The setting is stored in the database.
  While it is on, every visitor sees "Test timers are on: deadlines are
  minutes, not days." Each switch is logged, with the admin's login, on
  every active proposal, and only deadlines set afterwards change;
- presses **End debate now** on a proposal in debate, or **Close the vote
  now** on one in a vote, which act as if its deadline had passed that
  moment, and are logged in its timeline with the admin's login. Both work
  only while Test timers are on (`409 test_mode_off` otherwise): they are
  for testing, and can't cut a real debate or vote short;
- sees, edits and publishes the draft task of each passed proposal
  (below).

**From passed to shipped.**

1. Passing (by consent, by silence or by the vote) makes a **draft task**:
   the proposal's title, its pitch on one line as the summary, no
   acceptance criteria yet, size S, tier floor T0 and reward class `none`.
   Only admins see it.
2. An admin finishes it (`PUT /api/proposals/<id>/admin/draft-task`): a
   title (1 to 100 characters); a plain summary (1 to 500), which becomes
   the "Why" line of the brief every agent is given, so the admin reads the
   mover's words before they reach anyone's agent; what done means, as 1
   to 10 acceptance criteria of up to 300 characters each; the size (XS, S
   or M); the tier floor; and the reward class.
3. **Publish to the board** (`POST /api/proposals/<id>/admin/publish-task`)
   refuses:
   - an unfinished draft (`400 invalid_request`, naming the fields);
   - a tier floor above T0 (`400 tier_not_open`): every account is T0
     until Foreman's ledger exists, so nobody could claim it. Saving such
     a draft is refused the same way;
   - a title with no letter or digit from A to Z or 0 to 9
     (`400 task_title_needs_letters`), because the task's branch is named
     after it.
4. Otherwise, in one transaction, the task goes on the Contribute board and
   the proposal moves to `building`. The task:
   - is numbered from 10001 up, one more than the last published task
     (`bridge_published_tasks`), well clear of the fixtures' issue numbers.
     Its brief still asks for "Closes #<id>", so once forge-app's own
     issues and pull requests reach #10001 that would close an unrelated
     one; the repo is far from it, and it isn't handled yet;
   - is listed after the fixtures, and claimed, handed to an agent (the
     connector included) and merged like any other task;
   - carries the labels `agent-ready`, `status:open`, `size:<size>` and
     `from-proposal`, and its reward class (no task carries a dollar amount);
   - links to the proposal's page, `<FORGE_PUBLIC_ORIGIN>/propose/<id>`
     (a bare `/propose/<id>` while that is unset or unusable).
5. When the Bridge records the task's pull request as merged, the proposal
   moves to `shipped`: a hook inside the Bridge's own merge write, with the
   ticker catching any merge the hook missed.
6. A shipped proposal's panel in the lobby is still added by hand: an entry
   in `APPS` in `packages/lobby/src/registry.ts`, through a pull request.

**The bell.** It sits in the site header and in an app's bar, for members
signed in with GitHub only: never signed out, for the practice account or
on the practice build, and not at all while `proposals` is off. It reads
`GET /api/notifications` (through `/bff/notifications`) when it loads,
every 60 seconds while the tab is visible, and when it is opened: the
newest 30 and the unread count. Opening one marks it read, and "Mark all
read" marks the rest (`POST /api/notifications/read`, with `ids`, or
without them for all). Each member keeps their newest 200. A message quotes
the proposal's title in “ ”, with the title's own double quotation marks
made single and the title cut to 80 characters, so a title can't pass
itself off as another message. Every link is `/propose/<id>`.

| Kind | When | Who gets it |
|---|---|---|
| `proposal_moved` | A proposal is brought | Every member but the mover |
| `proposal_seconded` | It is seconded | The eligible set, except the mover and the seconder |
| `your_proposal_seconded` | It is seconded | The mover |
| `vote_opened` | Its vote opens | The eligible set |
| `proposal_passed`, `proposal_failed`, `proposal_lapsed` | It passes, fails or lapses | Everyone involved: the mover, the seconder, and everyone who consented, objected, voted or commented |
| `task_published` | An admin publishes its task | Everyone involved, as above |

Nothing is sent when a proposal is withdrawn or ships, and nothing leaves
the app: no e-mail, no push. While `proposals` is off, these notifications
are hidden from the list and the count, not deleted.

**Not built, on purpose** (see [ADR-006](adr/ADR-006-proposals.md)): a
shipped proposal's lobby panel, which is added by hand (above); any
backfill of members from before Phase 5; and any notification outside the
app.

**The API.** Every `/api/proposals*` route answers
`404 {"error": "proposals-disabled"}` while the flag is off, before any
identity check. "Member" means the BFF's assertion for a GitHub account
(`401 unauthenticated` without one); "admin" adds `FORGE_ADMIN_IDS`
(`403 admin_only`).

| Route | Who |
|---|---|
| `GET /api/proposals` | Anyone. Every active proposal and the newest 100 decided ones, newest first; `?decidedBefore=<id>` pages older decided ones, and `?state=` keeps one state |
| `GET /api/proposals/<id>` | Anyone. A member also gets `you` (what they may do now), and an admin the draft task |
| `GET /api/proposals/<id>/comments?before=<commentId>` | Anyone |
| `GET /api/proposals/me` | Member: admin or not, their active proposal, and whether Test timers are on |
| `POST /api/proposals` | Member (`201`) |
| `PATCH /api/proposals/<id>`, `POST …/withdraw` | The mover |
| `POST …/second` | A member other than the mover, with `{revision}` |
| `POST …/consent`, `POST …/vote` | The eligible set |
| `POST …/comments` | Member |
| `PUT /api/proposals/settings` | Admin (Test timers) |
| `POST …/admin/end-debate`, `POST …/admin/close-vote` | Admin, while Test timers are on |
| `PUT …/admin/draft-task`, `POST …/admin/publish-task` | Admin |
| `GET /api/notifications`, `POST /api/notifications/read` | Member; behind no flag of their own |
| `POST /api/members/hello` | Member; behind no flag (`204`) |

No JSON answer holds a `null`. Every refusal is a flat
`{"error": code, ...}`, and all but `proposals-disabled`,
`unauthenticated`, `admin_only` and `body_too_large` carry a plain-English
`message`:

| Status | `error` |
|---|---|
| `400` | `invalid_request` (with `fields`, never the input), `tier_not_open`, `task_title_needs_letters` |
| `403` | `admin_only`, `not_mover`, `own_proposal` |
| `404` | `proposals-disabled`, `proposal_not_found` (a missing proposal, or a number that isn't one) |
| `409` | `wrong_state` (with `state`), `one_active_proposal` (with `proposalId`), `already_seconded`, `already_decided_consent`, `not_eligible`, `proposal_changed` (with `revision`), `edit_limit`, `test_mode_off` |
| `413` | `body_too_large`: the API reads bodies up to 64 KB |
| `429` | `rate_limited`, with `Retry-After` |

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
`csv_export`), `/api/bridge/*` (gated by `contribute_bridge`, except
`GET` and `DELETE /api/bridge/me/keys`; see [The Bridge](#the-bridge)),
`/api/proposals*` (gated by `proposals`), `/api/notifications*` and
`/api/members/hello` (identity only, behind no flag; see
[The Propose floor](#the-propose-floor)), and the FORGE connector's
`/mcp`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`, their fallback
aliases `/register` and `/token`,
`/.well-known/oauth-*` and `/api/oauth/*` (gated by `mcp_connector` and
`github_signin`; see
[The FORGE connector](#the-forge-connector)), which the web origin reaches
through rewrites. `apps/web` answers one API route itself,
`POST /api/lobby/token`, the lobby's LiveKit room token (see
[The Apps lobby](#the-apps-lobby)); it never calls `apps/api`. Its other
server-side calls to the API (the BFF's `/bff/*`, the consent page and its
decision route, and `/auth/callback` finishing a Copilot start or saying
hello for a member who just signed in) carry the same short-lived
assertion whenever they act for a signed-in person.
Outbound, `apps/api` calls GitHub's public REST API for reads, and a
vendor's API only when a contributor starts a start rail or has FORGE send
the check notes. Every one of those calls follows no redirect, asks for an
uncompressed answer and refuses a compressed one, reads at most 1 MB, and
must finish within its budget, status line and headers included: 20
seconds for a vendor call and 5 for a GitHub read (5 of either to
connect). Its JSON is read only up to 32 levels deep. The web server calls
GitHub itself for sign-in, and for a Copilot start: to check whose the
one-time token is, and to revoke it afterwards.

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
  `/api/bridge/*` route with `{"error": "bridge-disabled"}`, except `GET`
  and `DELETE /api/bridge/me/keys`, so saved keys can still be seen and
  removed. The connector's tools close with it too.
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
  `/api/oauth/*`) answers `404 {"error": "connector-disabled"}` (as it
  also does while `github_signin` is off), `/connect` says "The FORGE
  connector is switched off right now.", and the task page stops offering
  Google Antigravity.
- `agent_start` — "Start it for me": off, no start rail runs whatever
  `FORGE_START_RAILS` lists, and the task page offers "Open my agent"
  only. Checked in off; turn it on only once at least one start rail has
  passed its live test ([`live-tests.md`](live-tests.md)).
- `proposals` — the Propose floor: off, every `/api/proposals*` route
  answers `404 {"error": "proposals-disabled"}` before any identity check,
  `/propose`, `/propose/new` and every proposal's page say "Proposals are
  switched off right now.", and the bell disappears, its notifications
  hidden but not deleted. The floor also pauses: nothing on it moves while
  it is off, and each deadline still running moves later by the time it
  was off once it is back on. Switching `github_signin` off pauses the
  floor the same way (see [The Propose floor](#the-propose-floor)).
  Checked in on, so the operator can try it.

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
   `protectedPaths` — `.github/`, `CODEOWNERS`, `.gitleaksignore`,
   `AGENTS.md`, `CLAUDE.md`, `.gemini/` and the other agent config
   (`.mcp.json`, `.codex/`, `.agents/`, `.cursor/`, `.vscode/`,
   `.claude/`), the sign-in/session paths from [Identity](#identity)
   above, the lobby's token route, the connector, vault, rail and brief
   code (see [The FORGE connector](#the-forge-connector)), the Bridge's
   key-carrying code and the task fixtures — needs T3 trust to
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
