"""The seam between the FORGE connector's protocol layer and its tools (contract §6).

The `/mcp` endpoint (services/mcp_server.py) speaks JSON-RPC and knows nothing about
tasks; the tools (services/bridge_mcp.py, which exports `TOOLS: list[ToolDef]`,
`PROMPTS: list[PromptDef]` and `SERVER_INSTRUCTIONS: str`) know nothing about JSON-RPC.
They meet here. Declarations only: no logic belongs in this module.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from forge_api.services.identity import Identity
from forge_api.services.state import StateDB


@dataclass(frozen=True)
class ToolContext:
    """Who is calling and where state lives, for one tool or prompt call. `identity` is
    the GitHub user the access token was issued to (sub, login); `db` is the process's
    StateDB (`get_state_db()`)."""

    identity: Identity
    db: StateDB


@dataclass(frozen=True)
class ToolOutput:
    """A tool's successful result. `text` is the human-readable answer, and what clients
    without structured output see; `structured`, when set, goes out as MCP
    `structuredContent` and must match the tool's `output_schema`."""

    text: str
    structured: dict[str, Any] | None = None


class ToolError(Exception):
    """An expected failure inside a tool (not claimed, not the holder, bad link...). The
    protocol layer returns it as a normal result with `isError: true` and the message as
    its text, so the agent reads the message: never put a secret, token or key in it."""


@dataclass(frozen=True)
class ToolDef:
    """One tool: what `tools/list` advertises and the handler `tools/call` runs.
    `input_schema` and `output_schema` are JSON Schema objects; `annotations` holds the MCP
    hints readOnlyHint, destructiveHint, idempotentHint and openWorldHint."""

    name: str
    title: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None
    annotations: dict[str, bool]
    handler: Callable[[ToolContext, dict[str, Any]], ToolOutput]


@dataclass(frozen=True)
class PromptDef:
    """One prompt: what `prompts/list` advertises and how `prompts/get` renders it.
    `arguments` lists {name, description, required}; `render` returns MCP PromptMessage
    dicts ({"role": "user", "content": {"type": "text", "text": ...}})."""

    name: str
    title: str
    description: str
    arguments: list[dict[str, Any]]
    render: Callable[[ToolContext, dict[str, str]], list[dict[str, Any]]]
