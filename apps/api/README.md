# apps/api — FORGE API

FastAPI (Python 3.12, uv) backend for the beta app, the Bridge, the FORGE
connector (PRD §4.9, Appendix I; `docs/adr/ADR-005-agent-handoff.md`), the
Propose floor (`docs/adr/ADR-006-proposals.md`), the house model that
drafts a passed proposal's task (`docs/adr/ADR-007-house-model.md`), and a
contributor's copy and Send for review (`docs/adr/ADR-008-copy-and-review.md`).

```bash
cd apps/api
uv sync                                  # install (creates .venv + uv.lock)
uv run uvicorn forge_api.main:app --reload --port 8000
uv run ruff check . && uv run mypy src   # lint + typecheck (make lint)
uv run pytest                            # unit + repo acceptance tests (make test)
```

Layout — routers stay thin, all logic lives in `services/` (AGENTS.md):

```
src/forge_api/
  main.py              app factory: title/version, CORS (and the connector paths' own), routers,
                       error handlers (flat JSON errors; on /api/bridge and /api/oauth a failed
                       validation is 422 invalid_request with field names only, 400 when nested
                       more than 32 deep), and the lifespan that runs the proposals ticker
                       (every 60 s) and the house worker (every 10 s, unless
                       FORGE_HOUSE_WORKER is off), both cancelled on shutdown; FORGE's own
                       INFO log lines to stderr
  models.py            pydantic mirrors of packages/shared zod schemas
  routers/             HTTP surface only: health, flags, bridge, upland, upland_scrape,
                       oauth (the connector's OAuth endpoints and the consent page's calls),
                       mcp (POST /mcp), proposals (/api/proposals*), notifications
                       (/api/notifications*, the bell), members (POST /api/members/hello, plus
                       the member and admin dependencies and the body reading all three share),
                       ledger (/api/ledger/*, the Upland Ledger gateway)
  services/
    flags.py           flag resolution
    identity.py        verifies the web tier's API assertion; the admin check
    errors.py          ApiError, the flat {"error": ...} body the services raise
    state.py           the SQLite state database (FORGE_STATE_DB_PATH; no migrations yet)
    brief.py           the brief every agent gets (mirrors packages/shared/src/brief.ts)
    rails.py           the rail registry (mirrors packages/shared/src/rails.ts)
    bridge.py          the Bridge: tasks, claims, hand-offs, status, checks, relays, submission;
                       also the tasks published from proposals (ids from 10001) and the hook
                       that tells the proposals service when one ships, and the contributor's
                       copy and Send for review (POST /api/bridge/copy and /review: the claim,
                       the hourly limit, the records, the timeline)
    copies.py          every GitHub call FORGE makes as a contributor, with their one-time
                       token: their copy (fork, sync, the task's branch) and Send for review
                       (the diff's pre-check, then the pull request and its description)
    vault.py           saved agent keys, encrypted (FORGE_VAULT_KEY)
    github_reads.py    public reads: pull requests (by branch, number or search), check runs,
                       forks, how far a copy's task branch is ahead of main, and upstream main's
                       .github/forge-protocol.json (the rules Send for review checks against)
    rail_adapters/     one module per start rail's vendor API, and the outbound rules (base.py)
    bridge_mcp.py      the connector's tools, prompt and server instructions
    mcp_types.py       the seam between the MCP server and those tools
    mcp_server.py      the MCP server: JSON-RPC 2.0 over POST /mcp
    oauth.py           the connector's OAuth 2.1 authorization server
    members.py         members: every GitHub account seen signed in, and when it was last seen
    proposals.py       the Propose floor: the rules (advance), the timeline, the floor's pause,
                       the draft task and its publishing, and the 60 s ticker
    notifications.py   the bell: storing, listing and marking notifications read
    house.py           the house model: what it reads, its two calls to Anthropic's API,
                       cleaning the spec, the jobs and their 10 s worker, the admin's view,
                       and what publishing changed
    upland/            the Upland scraper, storage and analytics
    ledger/            the Upland Ledger gateway: allowlist.py (the routes) and gateway.py (the call)
  tools/live_rails.py  runs one start rail outside the web app (docs/live-tests.md)
  tools/house_eval.py  the house model's eval on tests/fixtures/house-eval/ (real calls, --yes)
  fixtures/tasks.json  8 agent-ready starter tasks (PRD H.3): the Bridge's checked-in tasks,
                       listed before the ones published from proposals
```

**Robot avatars** (`services/avatars.py`, behind `lobby_avatars`) keep each member's
robot (four colours, a head from the library, a chestplate image) and the head library
in the state database. Files are stored once by sha256 and served from
`/api/avatars/assets/{sha256}`, cacheable forever; an image's type and size are read from
its own bytes, and a head must be a self-contained binary glTF 2.0. Writes are admin-only
(`FORGE_ADMIN_IDS`).

**The Upland Ledger gateway** (`routers/ledger.py`, `services/ledger/`, behind
`upland_ledger`) is the only way to the Upland Ledger, which has no auth and no public
route: the web's `/bff/ledger/*` mints an assertion for a signed-in (never practice)
member and forwards to `/api/ledger/{path}`, which is 404 `ledger-disabled` while the
flag is off, then 401 without a valid assertion. An allowlist of the ledger's `/v1/*`
routes (`services/ledger/allowlist.py`: GETs, and `POST analytics/query` with a JSON body
of at most 16 KiB) is forwarded to `UPLAND_LEDGER_URL` (default `http://127.0.0.1:3000`)
with the query string as sent (at most 4 KiB, else 414), and nothing of the caller's but
that; anything else is 404 `not_found` with no call made, and the ledger's `/health` and
`/metrics` are never reachable. Path parameters must match their pattern (an Antelope name
`[a-z1-5.]{1,13}`, digits, or 64 hex for a transaction). Upstream's status and JSON body
come back with `Cache-Control: private, no-store`; 3 s to connect and 25 s in all
(`504 ledger_timeout`), unreachable is `502 ledger_unavailable`, and an answer over 8 MiB
or not JSON is `502 ledger_response_too_large` / `ledger_bad_response`. Tests answer as
the ledger through httpx's `MockTransport` (`tests/test_ledger.py`).

**The house model** (`services/house.py`; `docs/architecture.md`, "The
house model") drafts the task of every passed proposal with an Anthropic
model, and an admin publishes it. It is on while the `house_spec` and
`proposals` flags are on and `ANTHROPIC_API_KEY` is set. Optional:
`FORGE_HOUSE_MODEL` (default `claude-opus-5-5`, passed through as it is),
`FORGE_HOUSE_EFFORT` (`low`, `medium`, `high`, `xhigh` or `max`, in any
case; default `high`, and anything else means `low`),
`FORGE_HOUSE_DAILY_LIMIT` (jobs a UTC day, default 30, at most 500; 0, or
anything but a whole number, runs nothing) and `FORGE_HOUSE_REPO_ROOT`
(default: this checkout, which must be a git checkout: the house reads the
files git tracks). A trailing `# comment` in the model, the effort or the
limit is ignored. The worker assumes it is the only one on its database:
run the API as one process, never with `--workers N`. Tests never reach
the network:
`tests/conftest.py` unsets the key and those settings, starts the app with
no worker (`FORGE_HOUSE_WORKER=off`), and a test must install the fake
client; `tests/test_house_sdk.py` drives the real SDK over an in-process
transport. The eval runs the real model and costs money, so it prints an
estimate and needs `--yes`:

```bash
uv run python -m forge_api.tools.house_eval --model <id> --out house-eval.md --yes
```

**Your copy and Send for review** (`services/copies.py`, `services/bridge.py`;
`docs/architecture.md`, "Your copy and Send for review"). `POST
/api/bridge/copy` and `POST /api/bridge/review` take `{taskId, token}`:
the one-time GitHub token the web server got from FORGE's OAuth App
(scope `public_repo`) for that one press, which the web revokes right
after. Only the web server calls them (the BFF forwards neither); each
reads its own body so nothing echoes the token, which is never logged or
stored. Both act only for the claim's holder, 10 times an hour each, and
check with `GET /user` that the token is the caller's before anything
else. Copy forks `verastd/forge-app` into the caller's account, syncs it
and makes the task's branch; review checks the diff against upstream
main's `.github/forge-protocol.json`, then opens the pull request as the
caller with the template's test attestation checked. Every GitHub call
is in `copies.py`, only to `https://api.github.com`, with 8 s a call
and 40 s for the whole action. Tests never reach GitHub:
`tests/test_bridge_copies.py` answers as GitHub through httpx's
`MockTransport` and asserts every request FORGE sends.
