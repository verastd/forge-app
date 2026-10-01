"""FORGE API application.

Routers are thin: they parse the request, call a service, and return the model.
Every piece of behaviour worth testing lives under services/ (AGENTS.md).
"""

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from forge_api import __version__
from forge_api.routers import bridge, flags, health, mcp, oauth, upland, upland_scrape
from forge_api.services.errors import ApiError

#: `next dev` (3000) and the Playwright web server (3100). Staging/production
#: origins arrive through FORGE_CORS_ORIGINS rather than a code change (PRD H.2).
DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://localhost:3100"

#: The FORGE connector's public paths (contract §5): any origin may call them, without
#: credentials, because MCP clients and their OAuth flows run on origins FORGE can't list.
#: `/register` and `/token` are routers/oauth.py's fallback aliases for the `/oauth/` ones.
CONNECTOR_PATHS = frozenset(
    {"/mcp", "/mcp/", "/oauth/register", "/oauth/token", "/oauth/revoke", "/register", "/token"}
)
CONNECTOR_PATH_PREFIX = "/.well-known/"
CONNECTOR_PREFLIGHT_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": (
        "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id"
    ),
    "Access-Control-Max-Age": "600",
}


def is_connector_path(path: str) -> bool:
    return path in CONNECTOR_PATHS or path.startswith(CONNECTOR_PATH_PREFIX)


class ConnectorCORSMiddleware:
    """CORS for the connector paths: `Access-Control-Allow-Origin: *`, no credentials,
    `WWW-Authenticate` exposed. It sits outside the app-wide CORSMiddleware, answers the
    connector paths' preflights itself and rewrites their responses' CORS headers; every
    other path passes through untouched, so existing routes keep FORGE_CORS_ORIGINS."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not is_connector_path(scope["path"]):
            await self.app(scope, receive, send)
            return
        if scope["method"] == "OPTIONS" and "access-control-request-method" in Headers(scope=scope):
            preflight = Response(status_code=204, headers=CONNECTOR_PREFLIGHT_HEADERS)
            await preflight(scope, receive, send)
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                del headers["access-control-allow-credentials"]
                headers["Access-Control-Allow-Origin"] = "*"
                headers["Access-Control-Expose-Headers"] = "WWW-Authenticate"
            await send(message)

        await self.app(scope, receive, send_with_cors)


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
# Added last, so it runs first: the connector paths' CORS, before the app-wide policy.
app.add_middleware(ConnectorCORSMiddleware)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Render service errors flat ({"error": ...}), not nested under "detail"."""
    return JSONResponse(status_code=exc.status_code, content=exc.payload, headers=exc.headers)


app.include_router(health.router)
app.include_router(flags.router)
app.include_router(bridge.router)
app.include_router(upland.router)
app.include_router(upland_scrape.router)
app.include_router(oauth.router)
app.include_router(mcp.router)
