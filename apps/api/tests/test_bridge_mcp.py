"""The connector's tools and prompt (services/bridge_mcp.py), called the way the MCP
server calls them: handler(ToolContext, arguments). Every structured result is checked
against the tool's own output schema."""

import re
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.services import bridge_mcp
from forge_api.services.bridge import FixtureTaskSource
from forge_api.services.bridge_mcp import PROMPTS, SERVER_INSTRUCTIONS, TOOLS
from forge_api.services.brief import compile_brief
from forge_api.services.identity import Identity
from forge_api.services.mcp_types import ToolContext, ToolDef, ToolError, ToolOutput
from forge_api.services.state import get_state_db

from .bridge_helpers import OTHER, TEST_TASKS, USER, BridgeEnv, install_bridge
from .conftest import FakeClock

CSV_BRANCH = "task/1-polish-the-csv-export-in-the-data-app"
PR_12 = "https://github.com/verastd/forge-app/pull/12"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


def tool(name: str) -> ToolDef:
    return next(item for item in TOOLS if item.name == name)


def call(name: str, args: dict[str, Any] | None = None, who: Identity = USER) -> ToolOutput:
    definition = tool(name)
    output = definition.handler(ToolContext(identity=who, db=get_state_db()), args or {})
    assert isinstance(output, ToolOutput)
    if definition.output_schema is not None:
        assert output.structured is not None
        problems = validate(output.structured, definition.output_schema)
        assert problems == [], (name, problems, output.structured)
    return output


def fails(name: str, args: dict[str, Any] | None = None, who: Identity = USER) -> str:
    with pytest.raises(ToolError) as caught:
        tool(name).handler(ToolContext(identity=who, db=get_state_db()), args or {})
    message = str(caught.value)
    assert message.endswith(".") and len(message) < 400
    return message


# --- a small JSON Schema checker: the subset the tools use ---------------------------------

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def validate(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    problems: list[str] = []
    kind = schema.get("type")
    if kind is not None and not _TYPES[kind](value):
        return [f"{path}: not {kind}"]
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{path}: {value!r} not in enum")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 10**9):
            problems.append(f"{path}: length")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            problems.append(f"{path}: pattern")
    if isinstance(value, int) and "minimum" in schema and value < schema["minimum"]:
        problems.append(f"{path}: minimum")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                problems.append(f"{path}.{name}: missing")
        for name, item in value.items():
            if name in properties:
                problems.extend(validate(item, properties[name], f"{path}.{name}"))
            elif schema.get("additionalProperties") is False:
                problems.append(f"{path}.{name}: not allowed")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            problems.extend(validate(item, schema["items"], f"{path}[{index}]"))
    return problems


# --- the declarations ---------------------------------------------------------------------


def test_the_contract_tools_in_order() -> None:
    assert [item.name for item in TOOLS] == [
        "whoami",
        "list_tasks",
        "get_task",
        "claim_task",
        "release_task",
        "report_progress",
        "get_check_results",
        "submit_task",
    ]


@pytest.mark.parametrize("definition", TOOLS, ids=lambda item: item.name)
def test_every_tool_is_well_formed(definition: ToolDef) -> None:
    assert definition.title and definition.description.endswith(".")
    schema = definition.input_schema
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    assert set(schema["required"]) <= set(schema["properties"])
    for spec in schema["properties"].values():
        assert spec.get("description") or spec.get("enum")
    assert set(definition.annotations) == {
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
    }
    assert all(isinstance(flag, bool) for flag in definition.annotations.values())
    if definition.annotations["readOnlyHint"]:
        assert definition.annotations["destructiveHint"] is False
    output = definition.output_schema
    assert output is not None and output["type"] == "object"
    assert output["additionalProperties"] is False


def test_only_release_is_destructive() -> None:
    destructive = [item.name for item in TOOLS if item.annotations["destructiveHint"]]
    assert destructive == ["release_task"]
    read_only = {item.name for item in TOOLS if item.annotations["readOnlyHint"]}
    assert read_only == {"whoami", "list_tasks", "get_task", "get_check_results"}


def test_server_instructions_lead_with_the_flow_inside_512_characters() -> None:
    head = SERVER_INSTRUCTIONS[:512]
    first_paragraph = SERVER_INSTRUCTIONS.split("\n", 1)[0]
    assert len(first_paragraph) <= 512 and first_paragraph.endswith(".")
    positions = [
        head.index(name)
        for name in (
            "get_task",
            "claim_task",
            "report_progress",
            "submit_task",
            "get_check_results",
        )
    ]
    assert positions == sorted(positions)
    for rule in ("AGENTS.md", ".github/", "acceptance tests"):
        assert rule in first_paragraph
    assert "secrets" in SERVER_INSTRUCTIONS and ".mcp.json" in SERVER_INSTRUCTIONS


# --- the tools ------------------------------------------------------------------------------


def test_whoami(env: BridgeEnv) -> None:
    alone = call("whoami")
    assert alone.structured == {"login": USER.login, "activeTasks": []}
    assert "don't hold any task" in alone.text
    call("claim_task", {"task_id": 1})
    holding = call("whoami")
    assert holding.structured is not None
    assert holding.structured["activeTasks"] == [
        {
            "taskId": 1,
            "title": "Polish the CSV export in the Data app",
            "leaseEndsAt": "2026-08-12T09:00:00Z",
        }
    ]
    assert "#1 Polish the CSV export" in holding.text


def test_list_tasks_filters(env: BridgeEnv) -> None:
    everything = call("list_tasks")
    assert everything.structured is not None and len(everything.structured["tasks"]) == 8
    assert "Call get_task" in everything.text
    call("claim_task", {"task_id": 6})
    call("claim_task", {"task_id": 3}, who=OTHER)
    open_ids = [task["id"] for task in call("list_tasks", {"filter": "open"}).structured["tasks"]]  # type: ignore[index]
    assert open_ids == [1, 2, 4, 5, 7, 8]
    mine = call("list_tasks", {"filter": "mine"})
    assert [task["id"] for task in mine.structured["tasks"]] == [6]  # type: ignore[index]
    assert f"claimed by {USER.login}" in mine.text
    assert len(call("list_tasks", {"filter": "all"}).structured["tasks"]) == 8  # type: ignore[index]
    assert (
        "don't hold any task"
        in call("list_tasks", {"filter": "mine"}, who=Identity("1009", "nobody")).text
    )
    assert fails("list_tasks", {"filter": "closed"}) == 'filter must be "open", "mine" or "all".'


def test_get_task_gives_the_personal_brief_and_the_lease(env: BridgeEnv) -> None:
    task = FixtureTaskSource(TEST_TASKS).get_task(1)
    assert task is not None
    unclaimed = call("get_task", {"task_id": 1})
    assert unclaimed.structured is not None
    assert unclaimed.structured["brief"] == compile_brief(task, task.acceptanceCriteria, USER.login)
    assert unclaimed.structured["lease"] == {"state": "open"}
    assert unclaimed.structured["branch"] == CSV_BRANCH
    assert unclaimed.structured["fork"] == f"{USER.login}/forge-app"
    assert unclaimed.structured["issueUrl"] == task.url
    assert "compareUrl" not in unclaimed.structured
    assert unclaimed.text.startswith(unclaimed.structured["brief"])
    assert "call claim_task" in unclaimed.text

    call("claim_task", {"task_id": 1})
    mine = call("get_task", {"task_id": 1})
    assert mine.structured is not None
    assert mine.structured["lease"]["state"] == "yours"
    assert mine.structured["compareUrl"].endswith(f"{USER.login}:{CSV_BRANCH}?expand=1")
    theirs = call("get_task", {"task_id": 1}, who=OTHER)
    assert theirs.structured is not None
    assert theirs.structured["lease"] == {
        "state": "taken",
        "holder": USER.login,
        "leaseEndsAt": "2026-08-12T09:00:00Z",
    }
    assert "pick another one" in theirs.text
    assert fails("get_task", {"task_id": 999}).startswith("There's no FORGE task #999.")


def test_claim_task(env: BridgeEnv) -> None:
    first = call("claim_task", {"task_id": 1})
    assert first.structured == {
        "taskId": 1,
        "claimedBy": USER.login,
        "leaseEndsAt": "2026-08-12T09:00:00Z",
        "leaseHours": 48,
        "branch": CSV_BRANCH,
        "fork": f"{USER.login}/forge-app",
    }
    assert CSV_BRANCH in first.text and "report_progress" in first.text
    assert call("claim_task", {"task_id": 1}).structured == first.structured  # idempotent
    assert f"already claimed by {USER.login}" in fails("claim_task", {"task_id": 1}, who=OTHER)
    call("claim_task", {"task_id": 6})
    assert "You already hold 2 FORGE tasks" in fails("claim_task", {"task_id": 3})


def test_release_task(env: BridgeEnv) -> None:
    assert "isn't claimed by anyone" in fails("release_task", {"task_id": 1})
    call("claim_task", {"task_id": 1})
    assert "claimed by someone else" in fails("release_task", {"task_id": 1}, who=OTHER)
    released = call("release_task", {"task_id": 1})
    assert released.structured == {"taskId": 1, "released": True}
    assert "Anyone can claim it now" in released.text


def test_report_progress_is_stored_as_plain_text(
    env: BridgeEnv, client: TestClient, user_headers: dict[str, str]
) -> None:
    call("claim_task", {"task_id": 1})
    noisy = "Started\x00 work‮ on it\n\tnow " + "x" * 600
    long_message = fails("report_progress", {"task_id": 1, "stage": "started", "message": noisy})
    assert "at most 500 characters" in long_message
    output = call(
        "report_progress",
        {"task_id": 1, "stage": "started", "message": "Started\x00 work‮ on it\n\tnow"},
    )
    assert output.structured is not None
    assert output.structured["stage"] == "agent_working"
    assert "Noted (started)" in output.text
    # The agent's text goes to the holder only (user_headers is USER, who claimed it).
    anonymous = client.get("/api/bridge/status/1").json()["events"]
    assert [event["source"] for event in anonymous] == ["forge"]
    event = client.get("/api/bridge/status/1", headers=user_headers).json()["events"][-1]
    assert event == {
        "at": "2026-08-10T09:00:00Z",
        "kind": "progress",
        "source": "agent",
        "message": "Started work on it now",
        "stage": "started",
    }
    done = call("report_progress", {"task_id": 1, "stage": "done", "message": "All done"})
    assert done.structured is not None and done.structured["stage"] == "ready_to_submit"
    assert "submit_task" in done.text


def test_report_progress_checks_its_arguments(env: BridgeEnv) -> None:
    call("claim_task", {"task_id": 1})
    base = {"task_id": 1, "stage": "working", "message": "ok"}
    assert fails("report_progress", {**base, "stage": "finished"}).startswith(
        "stage must be one of"
    )
    assert (
        fails("report_progress", {**base, "message": "   "})
        == "message must be a non-empty string."
    )
    assert fails("report_progress", {**base, "message": 5}) == "message must be a non-empty string."
    assert "pr_url must be a pull request link" in fails(
        "report_progress", {**base, "pr_url": "https://github.com/evil/forge-app/pull/1"}
    )
    assert fails("report_progress", {**base, "extra": 1}).startswith("Unknown argument 'extra'")
    assert "claimed by someone else" in fails("report_progress", base, who=OTHER)


def test_a_reported_pull_request_moves_the_task_to_checks(env: BridgeEnv) -> None:
    call("claim_task", {"task_id": 1})
    env.github.add_pull(12, USER.login, "agent-branch", sha="9" * 40, body="Closes #1")
    output = call(
        "report_progress",
        {"task_id": 1, "stage": "pr_opened", "message": "Opened it", "pr_url": PR_12},
    )
    assert output.structured is not None
    assert output.structured["stage"] == "in_checks"
    assert output.structured["prUrl"] == PR_12


def test_get_check_results(env: BridgeEnv) -> None:
    assert fails("get_check_results", {"task_id": 1}).startswith("Task #1 isn't claimed")
    call("claim_task", {"task_id": 1})
    none = call("get_check_results", {"task_id": 1})
    assert none.structured is not None and none.structured["state"] == "no_pr"
    assert none.text.startswith("No pull request yet.")
    sha = "8" * 40
    env.github.add_pull(12, USER.login, CSV_BRANCH, sha=sha)
    env.github.set_checks(sha, ("test", "completed", "failure"), ("lint", "completed", "success"))
    env.clock.advance(61)
    failed = call("get_check_results", {"task_id": 1})
    assert failed.structured is not None and failed.structured["state"] == "failed"
    assert failed.text.startswith("Some checks failed.\nThese checks failed on pull request #12")
    assert "- test: failure" in failed.text


def test_submit_task(env: BridgeEnv, client: TestClient, user_headers: dict[str, str]) -> None:
    call("claim_task", {"task_id": 1})
    assert "isn't a pull request link" in fails(
        "submit_task", {"task_id": 1, "pr_url": "https://example.com/pull/1"}
    )
    assert "doesn't exist" in fails("submit_task", {"task_id": 1, "pr_url": PR_12})
    env.github.add_pull(12, "someone-else", "x")
    env.clock.advance(61)  # GitHub's "no such pull request" is cached for a minute
    assert f"doesn't come from your fork ({USER.login}/forge-app)" in fails(
        "submit_task", {"task_id": 1, "pr_url": PR_12}
    )
    env.github.add_pull(13, USER.login, CSV_BRANCH, sha="7" * 40)
    env.clock.advance(61)
    handed = call(
        "submit_task", {"task_id": 1, "pr_url": "https://github.com/verastd/forge-app/pull/13"}
    )
    assert handed.structured is not None and handed.structured["stage"] == "in_checks"
    assert "get_check_results" in handed.text
    event = client.get("/api/bridge/status/1", headers=user_headers).json()["events"][-1]
    assert (event["kind"], event["source"]) == ("submitted", "agent")
    anonymous = client.get("/api/bridge/status/1").json()["events"]
    assert all(event["source"] == "forge" for event in anonymous)  # the holder's only
    env.github.fail = 500
    assert (
        fails(
            "submit_task", {"task_id": 1, "pr_url": "https://github.com/verastd/forge-app/pull/14"}
        )
        == "GitHub can't be reached right now. Try again in a minute."
    )


@pytest.mark.parametrize("bad", [None, True, 0, -3, "abc", 1.5, 10**12])
def test_task_id_must_be_a_task_number(env: BridgeEnv, bad: Any) -> None:
    args = {} if bad is None else {"task_id": bad}
    assert fails("get_task", args) == "task_id must be a FORGE task number, like 12."


def test_a_task_id_written_as_digits_is_accepted(env: BridgeEnv) -> None:
    assert call("get_task", {"task_id": "1"}).structured["taskId"] == 1  # type: ignore[index]


def test_unknown_arguments_are_refused(env: BridgeEnv) -> None:
    assert fails("whoami", {"x": 1}) == "Unknown argument 'x'. This tool takes: no arguments."


def test_an_unexpected_bridge_error_is_a_plain_sentence(env: BridgeEnv) -> None:
    from forge_api.services.errors import ApiError

    error = bridge_mcp._explain(ApiError(418, {"error": "teapot"}), 1, USER.login)
    assert str(error) == "FORGE couldn't do that just now. Try again."


@pytest.mark.parametrize(
    ("payload", "says"),
    [
        ({"error": "tier_too_low", "tierFloor": "T2"}, "needs contributor tier T2"),
        ({"error": "claim_cooldown", "retryAfter": 7200}, "again yet (it can in about 2 hours)"),
        ({"error": "claim_cooldown", "retryAfter": 60}, "(it can in under an hour)"),
        ({"error": "claim_rate_limit", "limit": 20}, "claimed 20 FORGE tasks"),
        ({"error": "submit_limit", "limit": 10}, "handed in 10 pull requests"),
        ({"error": "pr_not_for_task", "prNumber": 51}, '"Closes #4" in its description'),
        ({"error": "progress_limit", "limit": 30}, "30 progress reports in the last hour"),
    ],
)
def test_the_new_refusals_are_plain_sentences(payload: dict[str, Any], says: str) -> None:
    """The contract's new error codes, as the connector tells an agent about them."""
    from forge_api.services.errors import ApiError

    message = str(bridge_mcp._explain(ApiError(400, payload), 4, USER.login))
    assert says in message
    assert message.endswith(".") and len(message) < 400
    assert "FORGE couldn't do that" not in message


# --- the prompt -----------------------------------------------------------------------------


def test_the_forge_task_prompt(env: BridgeEnv) -> None:
    (prompt,) = PROMPTS
    assert prompt.name == "forge_task"
    assert prompt.arguments == [
        {"name": "task_id", "description": "The FORGE task number, e.g. 12.", "required": True}
    ]
    ctx = ToolContext(identity=USER, db=get_state_db())
    (message,) = prompt.render(ctx, {"task_id": "#1"})
    task = FixtureTaskSource(TEST_TASKS).get_task(1)
    assert task is not None
    assert message["role"] == "user"
    assert message["content"]["type"] == "text"
    text = message["content"]["text"]
    assert text.startswith("Start FORGE task #1.")
    assert text.endswith(compile_brief(task, task.acceptanceCriteria, USER.login))
    with pytest.raises(ToolError):
        prompt.render(ctx, {"task_id": "one"})
    with pytest.raises(ToolError) as caught:
        prompt.render(ctx, {"task_id": "999"})
    assert "no FORGE task #999" in str(caught.value)


def test_the_mcp_server_accepts_these_exports(env: BridgeEnv) -> None:
    server = pytest.importorskip("forge_api.services.mcp_server")
    registry = server.registry_from(bridge_mcp)
    assert [item.name for item in registry.tools] == [item.name for item in TOOLS]
    assert registry.instructions == SERVER_INSTRUCTIONS
    for definition in TOOLS:
        described = server.tool_description(definition)
        assert described["inputSchema"] == definition.input_schema
        assert described["outputSchema"] == definition.output_schema
    assert server.argument_problem(tool("get_task").input_schema, {"task_id": 1}) is None
    assert server.argument_problem(tool("get_task").input_schema, {}) is not None


def test_the_bridge_kill_switch_closes_the_tools_too(env: BridgeEnv) -> None:
    env.flags(contribute_bridge=False)
    for name, args in (
        ("whoami", {}),
        ("claim_task", {"task_id": 1}),
        ("get_task", {"task_id": 1}),
    ):
        assert fails(name, args) == bridge_mcp.BRIDGE_OFF
    with pytest.raises(ToolError):
        PROMPTS[0].render(ToolContext(identity=USER, db=get_state_db()), {"task_id": "1"})
