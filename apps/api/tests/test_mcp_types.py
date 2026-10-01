"""The connector's seam (contract §6): exactly the agreed fields, frozen, no logic. A fake
tool and prompt show how the protocol layer calls what services/bridge_mcp.py exports."""

from dataclasses import FrozenInstanceError, fields
from typing import Any

import pytest

from forge_api.services.identity import Identity
from forge_api.services.mcp_types import PromptDef, ToolContext, ToolDef, ToolError, ToolOutput
from forge_api.services.state import get_state_db


def test_the_seam_has_exactly_the_contract_fields() -> None:
    assert [f.name for f in fields(ToolContext)] == ["identity", "db"]
    assert [f.name for f in fields(ToolOutput)] == ["text", "structured"]
    assert [f.name for f in fields(ToolDef)] == [
        "name",
        "title",
        "description",
        "input_schema",
        "output_schema",
        "annotations",
        "handler",
    ]
    assert [f.name for f in fields(PromptDef)] == [
        "name",
        "title",
        "description",
        "arguments",
        "render",
    ]
    assert issubclass(ToolError, Exception)


def _whoami(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    if args.get("fail"):
        raise ToolError("You don't hold task #7.")
    login = ctx.identity.login
    return ToolOutput(text=f"You are {login}.", structured={"login": login})


def _forge_task(ctx: ToolContext, args: dict[str, str]) -> list[dict[str, Any]]:
    text = f"Start FORGE task #{args['task_id']} for {ctx.identity.login}."
    return [{"role": "user", "content": {"type": "text", "text": text}}]


def test_a_fake_tool_and_prompt_run_through_the_seam() -> None:
    ctx = ToolContext(identity=Identity(sub="1001", login="octo-contributor"), db=get_state_db())
    tool = ToolDef(
        name="whoami",
        title="Who am I",
        description="The GitHub account this connection acts for.",
        input_schema={"type": "object", "properties": {}},
        output_schema=None,
        annotations={"readOnlyHint": True, "openWorldHint": False},
        handler=_whoami,
    )
    output = tool.handler(ctx, {})
    assert output == ToolOutput(
        text="You are octo-contributor.", structured={"login": "octo-contributor"}
    )
    assert ToolOutput(text="plain").structured is None
    with pytest.raises(ToolError, match="task #7"):
        tool.handler(ctx, {"fail": True})

    prompt = PromptDef(
        name="forge_task",
        title="Start a FORGE task",
        description="Claim a task and work on it.",
        arguments=[{"name": "task_id", "description": "The task number", "required": True}],
        render=_forge_task,
    )
    messages = prompt.render(ctx, {"task_id": "7"})
    assert messages[0]["content"]["text"] == "Start FORGE task #7 for octo-contributor."


def test_the_seam_values_are_frozen() -> None:
    output = ToolOutput(text="x")
    with pytest.raises(FrozenInstanceError):
        output.text = "y"  # type: ignore[misc]
