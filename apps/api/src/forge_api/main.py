"""FORGE API application.

Routers are thin: they parse the request, call a service, and return the model.
Every piece of behaviour worth testing lives under services/ (AGENTS.md).
"""

import asyncio
import logging
import os
import sys
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from forge_api import __version__
from forge_api.routers import (
    avatars,
    bridge,
    flags,
    health,
    ledger,
    mcp,
    members,
    notifications,
    oauth,
    proposals,
    upland,
    upland_scrape,
)
from forge_api.services import house as house_service
from forge_api.services import proposals as proposals_service
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

#: Routes whose every error is flat JSON, `{"error": ...}`, request validation included:
#: the Bridge, and the consent page's calls to the OAuth server.
FLAT_ERROR_PREFIXES = ("/api/bridge", "/api/oauth")
#: A request body nested deeper than this is refused outright (400 invalid_request).
MAX_BODY_DEPTH = 32


def uses_flat_errors(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in FLAT_ERROR_PREFIXES)


def nested_deeper_than(value: object, limit: int) -> bool:
    """Whether a parsed JSON value nests arrays and objects more than `limit` deep, found
    without recursion: a hostile body is exactly what makes recursion fail."""
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        children: Iterable[object]
        if isinstance(item, dict):
            children = item.values()
        elif isinstance(item, list):
            children = item
        else:
            continue
        if depth >= limit:
            return True
        stack.extend((child, depth + 1) for child in children if isinstance(child, dict | list))
    return False


def invalid_fields(errors: Sequence[Any]) -> list[str]:
    """The fields a request got wrong, named the way /dispatch names them ("taskId",
    "credential.key"): where they came from (body, path, query) is dropped, and "body"
    stands for a body that is missing or isn't JSON. Never the input itself."""
    fields: set[str] = set()
    for error in errors:
        loc = tuple(error.get("loc") or ()) if isinstance(error, Mapping) else ()
        if len(loc) < 2 or error.get("type") == "json_invalid":
            fields.add("body")
        else:
            fields.add(".".join(str(part) for part in loc[1:]))
    return sorted(fields)


def invalid_request(status: int, fields: list[str]) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": "invalid_request", "fields": fields})


#: FORGE's own loggers: their INFO lines go to stderr (journald on the box).
FORGE_LOGGER = "forge_api"
#: Loggers held at WARNING whatever the environment says: at DEBUG, Anthropic's SDK and its
#: HTTP client print each request whole, the house's prompt (members' text) included, and
#: on one path the key. ANTHROPIC_LOG must never be set on the box.
QUIET_LOGGERS = ("anthropic", "httpx2", "httpcore2")


class StderrHandler(logging.Handler):
    """FORGE's INFO lines on stderr, under uvicorn, whose logging configuration leaves
    every logger but its own at WARNING with no handler. It writes to whatever stderr is
    when a line is logged, and stays quiet while the root logger has a handler of its own
    (a log configuration that prints everything, or the tests' capture), so no line is
    ever printed twice."""

    def emit(self, record: logging.LogRecord) -> None:
        if logging.getLogger().handlers:
            return
        try:
            sys.stderr.write(self.format(record) + "\n")
            sys.stderr.flush()
        except Exception:
            self.handleError(record)


def configure_logging() -> None:
    """INFO and above from FORGE's own code reach stderr through one handler, added once
    however often this runs; the SDK's loggers stay at WARNING. Nothing turns DEBUG on."""
    forge = logging.getLogger(FORGE_LOGGER)
    forge.setLevel(logging.INFO)
    if not any(isinstance(handler, StderrHandler) for handler in forge.handlers):
        handler = StderrHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s: %(name)s: %(message)s"))
        forge.addHandler(handler)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Two loops run for the app's lifetime: the proposals ticker, which every 60 s applies
    the proposal deadlines that have passed (services/proposals.py `run_ticker`), and the
    house worker, which every 10 s runs the house model's next due job
    (services/house.py `run_worker`), unless FORGE_HOUSE_WORKER is off (the tests switch
    it off). A failing beat of either is logged and the next one tries again. Both are
    cancelled cleanly on shutdown, and the worker hands back the job it was running. The
    house assumes one worker per database: run the API as one process, never with
    `--workers N`."""
    loops = [asyncio.create_task(proposals_service.run_ticker(), name="proposals-ticker")]
    if house_service.worker_enabled():
        loops.append(asyncio.create_task(house_service.run_worker(), name="house-worker"))
    try:
        yield
    finally:
        for loop in loops:
            loop.cancel()
        await asyncio.gather(*loops, return_exceptions=True)


app = FastAPI(title="FORGE API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # The Propose countdowns run on the server's clock, read from this header: a browser
    # hides it from a cross-origin page unless it is exposed (it isn't CORS-safelisted).
    expose_headers=["Date"],
)
# Added last, so it runs first: the connector paths' CORS, before the app-wide policy.
app.add_middleware(ConnectorCORSMiddleware)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Render service errors flat ({"error": ...}), not nested under "detail"."""
    return JSONResponse(status_code=exc.status_code, content=exc.payload, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> Response:
    """On the flat-error routes, `422 {"error": "invalid_request", "fields": [...]}` as
    /dispatch answers, naming fields only: FastAPI's own answer echoes the input (a JSON
    null included), and recursing through a deeply nested input to echo it was a 500. A
    body nested deeper than MAX_BODY_DEPTH is 400. Other routes keep FastAPI's answer."""
    if not uses_flat_errors(request.scope["path"]):
        return await request_validation_exception_handler(request, exc)
    if nested_deeper_than(exc.body, MAX_BODY_DEPTH):
        return invalid_request(400, ["body"])
    return invalid_request(422, invalid_fields(exc.errors()))


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> Response:
    """FastAPI answers a body it can't parse at all (nested past the JSON parser's own
    recursion limit, or not UTF-8) with `400 {"detail": ...}`, raised from the parse
    error; the flat-error routes say invalid_request instead. Any other HTTP error is
    FastAPI's own answer."""
    if exc.status_code == 400 and exc.__cause__ is not None:
        if uses_flat_errors(request.scope["path"]):
            return invalid_request(400, ["body"])
    return await http_exception_handler(request, exc)


app.include_router(health.router)
app.include_router(flags.router)
app.include_router(bridge.router)
app.include_router(upland.router)
app.include_router(upland_scrape.router)
app.include_router(ledger.router)
app.include_router(oauth.router)
app.include_router(mcp.router)
app.include_router(members.router)
app.include_router(proposals.router)
app.include_router(notifications.router)
app.include_router(avatars.router)
