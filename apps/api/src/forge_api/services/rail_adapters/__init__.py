"""Start-rail adapters: one module per vendor FORGE starts on the contributor's account
(contract §2). Each module names the vendor docs it was coded against and the date
they were read; base.py holds the shapes and the outbound HTTP rules they share."""

import httpx

from forge_api.models import StartRail
from forge_api.services.rail_adapters.base import (
    AdapterError,
    AdapterRequest,
    AdapterResult,
    CheckResult,
    OutboundCall,
    RailAdapter,
    RailCredential,
    make_client,
)
from forge_api.services.rail_adapters.claude_routine import ClaudeRoutineAdapter
from forge_api.services.rail_adapters.copilot import CopilotAdapter
from forge_api.services.rail_adapters.cursor import CursorAdapter
from forge_api.services.rail_adapters.devin import DevinAdapter
from forge_api.services.rail_adapters.jules import JulesAdapter
from forge_api.services.rail_adapters.openhands import OpenHandsAdapter

ADAPTERS: dict[StartRail, type[RailAdapter]] = {
    "copilot": CopilotAdapter,
    "jules": JulesAdapter,
    "cursor": CursorAdapter,
    "devin": DevinAdapter,
    "openhands": OpenHandsAdapter,
    "claude-routine": ClaudeRoutineAdapter,
}


def adapter_for(rail: StartRail, client: httpx.Client) -> RailAdapter:
    """The adapter for `rail`, sending through `client`."""
    return ADAPTERS[rail](client)


__all__ = [
    "ADAPTERS",
    "AdapterError",
    "AdapterRequest",
    "AdapterResult",
    "CheckResult",
    "OutboundCall",
    "RailAdapter",
    "RailCredential",
    "adapter_for",
    "make_client",
]
