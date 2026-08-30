# apps/api — FORGE API

FastAPI (Python 3.12, uv) backend for the beta app plus the Bridge stubs
(PRD §4.9, Appendix I).

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
  main.py            app factory: title/version, CORS, routers, error handler
  models.py          pydantic mirrors of packages/shared zod schemas
  routers/           HTTP surface only (health, history, export, flags, bridge)
  services/          history generator, flags resolution, bridge lease/dispatch
  fixtures/tasks.json  8 agent-ready starter tasks (PRD H.3)
```
