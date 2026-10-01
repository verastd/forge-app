"""The FORGE connector's MCP server: JSON-RPC 2.0 over Streamable HTTP (contract §6).

Hand-written, stateless, JSON only: every POST to /mcp is answered on its own with
`application/json` (never SSE), and no `Mcp-Session-Id` is minted, so there is nothing
to resume or delete. routers/mcp.py does the HTTP checks the transport puts on the
endpoint (Origin, bearer token, MCP-Protocol-Version, body); this module answers the
JSON-RPC.

Protocol versions: 2025-11-25, 2025-06-18 and 2025-03-26 (initialize-based, "legacy" in
2026-07-28's terms). `initialize` echoes the client's version when it is one of these and
answers the newest otherwise. Revision 2026-07-28 removes `initialize` and `ping`, makes
`server/discover` mandatory and changes every result's shape, so it is not offered: a
dual-era client that tries it first gets a 400 that is not a modern JSON-RPC error
(routers/mcp.py) and falls back to `initialize` with one of the versions above.

Methods: initialize, ping, tools/list, tools/call, prompts/list, prompts/get,
resources/list and resources/templates/list (both empty), notifications/* (accepted,
202). Batches (JSON arrays, 2025-03-26) are answered element by element.

The tools, prompts and server instructions come from services/bridge_mcp.py (`TOOLS`,
`PROMPTS`, `SERVER_INSTRUCTIONS`, typed by services/mcp_types.py), imported on first use
through `get_mcp_registry`, which tests override with fakes. A tool's `ToolError` becomes
a normal result with `isError: true`; any other exception becomes the same with a
generic message, logged with the tool's name and never its arguments.
"""

import functools
import importlib
import json
import logging
import re
import threading
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from forge_api import __version__
from forge_api.services.mcp_types import PromptDef, ToolContext, ToolDef, ToolError, ToolOutput
from forge_api.services.oauth import ConnectorConfig, normalize_origin

logger = logging.getLogger(__name__)

SUPPORTED_PROTOCOL_VERSIONS: Final = ("2025-11-25", "2025-06-18", "2025-03-26")
LATEST_PROTOCOL_VERSION: Final = SUPPORTED_PROTOCOL_VERSIONS[0]
SERVER_NAME: Final = "forge"
SERVER_TITLE: Final = "FORGE"
TOOLS_MODULE: Final = "forge_api.services.bridge_mcp"

#: Per access token: at most this many JSON-RPC requests in any window of this many seconds.
RATE_LIMIT: Final = 120
RATE_WINDOW: Final = 60.0
MAX_BATCH: Final = 32
MAX_BODY_BYTES: Final = 256 * 1024

PARSE_ERROR: Final = -32700
INVALID_REQUEST: Final = -32600
METHOD_NOT_FOUND: Final = -32601
INVALID_PARAMS: Final = -32602
INTERNAL_ERROR: Final = -32603
RATE_LIMITED: Final = -32000

TOOL_CRASHED: Final = "The FORGE tool failed unexpectedly. Try again in a minute."

_BEARER = re.compile(r"bearer +(\S+)", re.IGNORECASE | re.ASCII)


# --- the tools and prompts -------------------------------------------------------------


@dataclass(frozen=True)
class McpRegistry:
    """What the server offers: services/bridge_mcp.py's exports, or a test's fakes."""

    tools: tuple[ToolDef, ...] = ()
    prompts: tuple[PromptDef, ...] = ()
    instructions: str = ""

    def tool(self, name: str) -> ToolDef | None:
        return next((tool for tool in self.tools if tool.name == name), None)

    def prompt(self, name: str) -> PromptDef | None:
        return next((prompt for prompt in self.prompts if prompt.name == name), None)


def registry_from(module: object) -> McpRegistry:
    """A registry from a module exporting TOOLS, PROMPTS and SERVER_INSTRUCTIONS."""
    tools = tuple(getattr(module, "TOOLS", ()))
    prompts = tuple(getattr(module, "PROMPTS", ()))
    instructions = getattr(module, "SERVER_INSTRUCTIONS", "")
    if not all(isinstance(tool, ToolDef) for tool in tools):
        raise TypeError(f"{TOOLS_MODULE}.TOOLS must hold ToolDef instances")
    if not all(isinstance(prompt, PromptDef) for prompt in prompts):
        raise TypeError(f"{TOOLS_MODULE}.PROMPTS must hold PromptDef instances")
    if not isinstance(instructions, str):
        raise TypeError(f"{TOOLS_MODULE}.SERVER_INSTRUCTIONS must be a string")
    return McpRegistry(tools=tools, prompts=prompts, instructions=instructions)


@functools.lru_cache(maxsize=1)
def _bridge_registry() -> McpRegistry:
    return registry_from(importlib.import_module(TOOLS_MODULE))


def get_mcp_registry() -> McpRegistry:
    """FastAPI dependency: the Bridge's tools, imported on first use (so this module loads
    without them). Tests override it."""
    return _bridge_registry()


# --- rate limiting ---------------------------------------------------------------------


class RateLimiter:
    """A sliding-window limit per key (a token's hash), in process memory."""

    #: Past this many keys, forget the ones with no request inside the window.
    MAX_KEYS: Final = 10_000

    def __init__(self, limit: int = RATE_LIMIT, window: float = RATE_WINDOW) -> None:
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, now: float) -> bool:
        """Count one request for `key` at `now`, unless the window is already full."""
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= self.MAX_KEYS:
                    self._forget_idle(now)
                hits = self._hits[key] = deque()
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def _forget_idle(self, now: float) -> None:
        idle = [
            key for key, hits in self._hits.items() if not hits or hits[-1] <= now - self.window
        ]
        for key in idle:
            del self._hits[key]


_RATE_LIMITER = RateLimiter()


def get_rate_limiter() -> RateLimiter:
    """FastAPI dependency: the process's limiter. Tests override it with a fresh one."""
    return _RATE_LIMITER


# --- HTTP-level helpers routers/mcp.py uses --------------------------------------------


def origin_allowed(config: ConnectorConfig, origin: str) -> bool:
    """An `Origin` header FORGE accepts: its own origin, a hosted client's
    (oauth.HOSTED_CLIENT_ORIGINS) or one in FORGE_MCP_ALLOWED_ORIGINS (DNS-rebinding
    protection; server-side clients send no Origin at all)."""
    normalized = normalize_origin(origin)
    return normalized is not None and normalized in config.mcp_origins


def bearer_token(authorization: str) -> str | None:
    """The token in `Authorization: Bearer <token>` (scheme case-insensitive), or None."""
    match = _BEARER.fullmatch(authorization.strip())
    return match.group(1) if match else None


def is_json(content_type: str | None) -> bool:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    return media == "application/json" or (
        media.startswith("application/") and media.endswith("+json")
    )


def error_response(request_id: object, code: int, message: str) -> dict[str, Any]:
    """A JSON-RPC error object. `request_id` is null when the request's id is unknown."""
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


# --- JSON-RPC --------------------------------------------------------------------------


class RpcError(Exception):
    """A JSON-RPC error for the request being answered."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Session:
    """One HTTP request's worth of context: who is calling, what is offered, and the
    caller's rate limit (`allow()` counts one request and says whether it may run)."""

    registry: McpRegistry
    context: ToolContext
    allow: Callable[[], bool]


def handle_payload(payload: object, session: Session) -> tuple[int, Any]:
    """(HTTP status, JSON body) for a parsed POST body; the body is None for 202 Accepted
    (only notifications or client responses, nothing to answer)."""
    if isinstance(payload, list):
        if not payload:
            return 400, error_response(None, INVALID_REQUEST, "Invalid Request: empty batch")
        if len(payload) > MAX_BATCH:
            message = f"Invalid Request: a batch holds at most {MAX_BATCH} messages"
            return 400, error_response(None, INVALID_REQUEST, message)
        replies = [reply for reply, _ in (handle_message(item, session) for item in payload)]
        answered = [reply for reply in replies if reply is not None]
        return (200, answered) if answered else (202, None)
    reply, malformed = handle_message(payload, session)
    if reply is None:
        return 202, None
    return (400 if malformed else 200), reply


def handle_message(message: object, session: Session) -> tuple[dict[str, Any] | None, bool]:
    """(reply, malformed): the reply is None for a notification or a client's response;
    `malformed` is True when the message was not valid JSON-RPC at all."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return error_response(_id_of(message), INVALID_REQUEST, "Invalid Request"), True
    if "method" not in message:
        if "id" in message and ("result" in message or "error" in message):
            return None, False  # a response to a server request: nothing to do
        return error_response(_id_of(message), INVALID_REQUEST, "Invalid Request"), True
    method = message["method"]
    if not isinstance(method, str):
        return error_response(_id_of(message), INVALID_REQUEST, "Invalid Request: method"), True
    if "id" not in message:
        return None, False  # a notification: accepted, never answered
    request_id = message["id"]
    if not _valid_id(request_id):
        message_text = "Invalid Request: id must be a string or an integer"
        return error_response(None, INVALID_REQUEST, message_text), True
    params = message.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return error_response(request_id, INVALID_PARAMS, "params must be an object"), False
    if not session.allow():
        return error_response(request_id, RATE_LIMITED, "rate limited"), False
    try:
        result = _dispatch(method, params, session)
    except RpcError as exc:
        return error_response(request_id, exc.code, exc.message), False
    return {"jsonrpc": "2.0", "id": request_id, "result": result}, False


def _dispatch(method: str, params: dict[str, Any], session: Session) -> dict[str, Any]:
    handler = _METHODS.get(method)
    if handler is None:
        raise RpcError(METHOD_NOT_FOUND, f"Method not found: {_clip(method)}")
    return handler(params, session)


def _initialize(params: dict[str, Any], session: Session) -> dict[str, Any]:
    requested = params.get("protocolVersion")
    if not isinstance(requested, str) or not requested:
        raise RpcError(INVALID_PARAMS, "initialize needs params.protocolVersion")
    version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
    result: dict[str, Any] = {
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
        "serverInfo": {"name": SERVER_NAME, "title": SERVER_TITLE, "version": __version__},
    }
    if session.registry.instructions:
        result["instructions"] = session.registry.instructions
    return result


def _ping(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return {}


def _tools_list(params: dict[str, Any], session: Session) -> dict[str, Any]:
    _single_page(params)
    return {"tools": [tool_description(tool) for tool in session.registry.tools]}


def tool_description(tool: ToolDef) -> dict[str, Any]:
    """A tool as `tools/list` describes it."""
    description: dict[str, Any] = {
        "name": tool.name,
        "title": tool.title,
        "description": tool.description,
        "inputSchema": tool.input_schema,
    }
    if tool.output_schema is not None:
        description["outputSchema"] = tool.output_schema
    if tool.annotations:
        description["annotations"] = dict(tool.annotations)
    return description


def _tools_call(params: dict[str, Any], session: Session) -> dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise RpcError(INVALID_PARAMS, "tools/call needs params.name")
    tool = session.registry.tool(name)
    if tool is None:
        raise RpcError(INVALID_PARAMS, f"Unknown tool: {_clip(name)}")
    arguments = params.get("arguments")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise RpcError(INVALID_PARAMS, "params.arguments must be an object")
    problem = argument_problem(tool.input_schema, arguments)
    if problem is not None:
        # MCP: input validation errors are tool results, so the model can correct itself.
        return _tool_error(f"Invalid arguments for {tool.name}: {problem}.")
    try:
        output = tool.handler(session.context, arguments)
    except ToolError as exc:
        return _tool_error(str(exc) or "The tool failed.")
    except Exception as exc:  # any crash becomes an isError result, never a 500
        logger.exception("FORGE tool %r raised %s", tool.name, type(exc).__name__)
        return _tool_error(TOOL_CRASHED)
    if not isinstance(output, ToolOutput) or not isinstance(output.text, str):
        logger.error("FORGE tool %r returned something other than a ToolOutput", tool.name)
        return _tool_error(TOOL_CRASHED)
    result: dict[str, Any] = {"content": [{"type": "text", "text": output.text}], "isError": False}
    if output.structured is not None:
        result["structuredContent"] = output.structured
    if not _serializable(result):
        logger.error("FORGE tool %r returned output that isn't JSON", tool.name)
        return _tool_error(TOOL_CRASHED)
    return result


def _tool_error(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def _prompts_list(params: dict[str, Any], session: Session) -> dict[str, Any]:
    _single_page(params)
    return {
        "prompts": [
            {
                "name": prompt.name,
                "title": prompt.title,
                "description": prompt.description,
                "arguments": [dict(argument) for argument in prompt.arguments],
            }
            for prompt in session.registry.prompts
        ]
    }


def _prompts_get(params: dict[str, Any], session: Session) -> dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise RpcError(INVALID_PARAMS, "prompts/get needs params.name")
    prompt = session.registry.prompt(name)
    if prompt is None:
        raise RpcError(INVALID_PARAMS, f"Unknown prompt: {_clip(name)}")
    arguments = params.get("arguments")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict) or not all(
        isinstance(value, str) for value in arguments.values()
    ):
        raise RpcError(INVALID_PARAMS, "params.arguments must map names to strings")
    for argument in prompt.arguments:
        argument_name = argument.get("name")
        if argument.get("required") and argument_name not in arguments:
            raise RpcError(INVALID_PARAMS, f"Missing required argument: {argument_name}")
    try:
        messages = prompt.render(session.context, dict(arguments))
    except ToolError as exc:
        raise RpcError(INVALID_PARAMS, str(exc) or "The prompt can't be built.") from None
    except Exception as exc:  # a crash is a JSON-RPC internal error, never a 500
        logger.exception("FORGE prompt %r raised %s", prompt.name, type(exc).__name__)
        raise RpcError(INTERNAL_ERROR, "Internal error") from None
    result = {"description": prompt.description, "messages": messages}
    if not isinstance(messages, list) or not _serializable(result):
        logger.error("FORGE prompt %r rendered something that isn't a message list", prompt.name)
        raise RpcError(INTERNAL_ERROR, "Internal error")
    return result


def _resources_list(params: dict[str, Any], session: Session) -> dict[str, Any]:
    _single_page(params)
    return {"resources": []}


def _resource_templates_list(params: dict[str, Any], session: Session) -> dict[str, Any]:
    _single_page(params)
    return {"resourceTemplates": []}


_METHODS: Final[Mapping[str, Callable[[dict[str, Any], Session], dict[str, Any]]]] = {
    "initialize": _initialize,
    "ping": _ping,
    "tools/list": _tools_list,
    "tools/call": _tools_call,
    "prompts/list": _prompts_list,
    "prompts/get": _prompts_get,
    "resources/list": _resources_list,
    "resources/templates/list": _resource_templates_list,
}


# --- tool arguments --------------------------------------------------------------------

_JSON_TYPES: Final[Mapping[str, Callable[[object], bool]]] = {
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "number": lambda value: isinstance(value, int | float) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "null": lambda value: value is None,
}


def argument_problem(schema: Mapping[str, Any], arguments: Mapping[str, Any]) -> str | None:
    """What is wrong with a tool's arguments against the top level of its input schema
    (`required`, `additionalProperties: false`, each property's `type` and `enum`), or
    None. Deeper rules are the tool's own business; this only keeps handlers from
    receiving the wrong shapes."""
    properties = schema.get("properties")
    declared: Mapping[str, Any] = properties if isinstance(properties, dict) else {}
    required = schema.get("required")
    for name in required if isinstance(required, list) else ():
        if isinstance(name, str) and name not in arguments:
            return f"{_clip(name)} is required"
    if schema.get("additionalProperties") is False:
        for name in arguments:
            if name not in declared:
                return f"{_clip(name)} is not one of its arguments"
    for name, value in arguments.items():
        spec = declared.get(name)
        if isinstance(spec, dict):
            problem = _value_problem(spec, value)
            if problem is not None:
                return f"{_clip(name)} {problem}"
    return None


def _value_problem(spec: Mapping[str, Any], value: object) -> str | None:
    declared = spec.get("type")
    names: Sequence[object] = (
        [declared] if isinstance(declared, str) else declared if isinstance(declared, list) else []
    )
    known = [name for name in names if isinstance(name, str) and name in _JSON_TYPES]
    if known and not any(_JSON_TYPES[name](value) for name in known):
        return "must be " + " or ".join(known)
    choices = spec.get("enum")
    if isinstance(choices, list) and not any(_same(value, choice) for choice in choices):
        return "must be one of " + ", ".join(json.dumps(choice) for choice in choices)
    return None


def _same(value: object, choice: object) -> bool:
    # JSON equality: true is not 1, though Python says it is.
    return value == choice and isinstance(value, bool) == isinstance(choice, bool)


# --- small helpers ---------------------------------------------------------------------


def _single_page(params: Mapping[str, Any]) -> None:
    """Lists come in one page: FORGE never hands out a cursor, so any cursor is invalid."""
    if params.get("cursor") is not None:
        raise RpcError(INVALID_PARAMS, "Invalid cursor")


def _valid_id(value: object) -> bool:
    # MCP request ids are strings or integers; never null, a bool or a float.
    return isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool))


def _id_of(message: object) -> object:
    if isinstance(message, dict):
        request_id = message.get("id")
        if _valid_id(request_id):
            return request_id
    return None


def _serializable(value: object) -> bool:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False
    return True


def _clip(text: str, limit: int = 100) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
