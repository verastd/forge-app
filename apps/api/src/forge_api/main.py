"""FORGE API application.

Routers are thin: they parse the request, call a service, and return the model.
Every piece of behaviour worth testing lives under services/ (AGENTS.md).
"""

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from forge_api import __version__
from forge_api.routers import bridge, export, flags, health, history
from forge_api.services.errors import ApiError

#: `next dev` (3000) and the Playwright web server (3100). Staging/production
#: origins arrive through FORGE_CORS_ORIGINS rather than a code change (PRD H.2).
DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://localhost:3100"


def allowed_origins(env: dict[str, str] | None = None) -> list[str]:
    """Parse FORGE_CORS_ORIGINS (comma-separated). Blank entries are dropped, and
    an unset or all-blank value falls back to {@link DEFAULT_CORS_ORIGINS}."""
    raw = (env if env is not None else os.environ).get("FORGE_CORS_ORIGINS")
    origins = [origin.strip() for origin in (raw or "").split(",") if origin.strip()]
    return origins or [
        origin.strip() for origin in DEFAULT_CORS_ORIGINS.split(",") if origin.strip()
    ]


ALLOWED_ORIGINS = allowed_origins()

app = FastAPI(title="FORGE API", version=__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Render service errors flat ({"error": ...}), not nested under "detail"."""
    return JSONResponse(status_code=exc.status_code, content=exc.payload)


app.include_router(health.router)
app.include_router(history.router)
app.include_router(export.router)
app.include_router(flags.router)
app.include_router(bridge.router)
