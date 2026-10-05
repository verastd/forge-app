# apps/api — FORGE API

FastAPI (Python 3.12, uv) backend for the beta app, the Bridge, the FORGE
connector (PRD §4.9, Appendix I; `docs/adr/ADR-005-agent-handoff.md`), the
Propose floor (`docs/adr/ADR-006-proposals.md`) and the house model that
drafts a passed proposal's task (`docs/adr/ADR-007-house-model.md`).

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
                       the member and admin dependencies and the body reading all three share)
  services/
    flags.py           flag resolution
    identity.py        verifies the web tier's API assertion; the admin check
    errors.py          ApiError, the flat {"error": ...} body the services raise
    state.py           the SQLite state database (FORGE_STATE_DB_PATH; no migrations yet)
    brief.py           the brief every agent gets (mirrors packages/shared/src/brief.ts)
    rails.py           the rail registry (mirrors packages/shared/src/rails.ts)
    bridge.py          the Bridge: tasks, claims, hand-offs, status, checks, relays, submission;
                       also the tasks published from proposals (ids from 10001) and the hook
                       that tells the proposals service when one ships
    vault.py           saved agent keys, encrypted (FORGE_VAULT_KEY)
    github_reads.py    pull requests (by branch, number or search), check runs and forks from GitHub
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
