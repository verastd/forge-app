"""The wire models: Bridge v2 (Phase 4 contract §3), Proposals and notifications (Phase 5
contract §2), the house model (Phase 6 contract §2) and the copy and "Send for review"
(Phase 7 contract §4).

tests/fixtures/wire-golden.json records every model's fields as this file describes
them, length limits included; packages/shared/src/wire.test.ts describes the zod schemas
the same way and compares against the same file, so a field renamed, retyped, made
optional or given another limit on one side only fails a test on both. Update the golden
by hand when both sides change together.
"""

import json
from collections.abc import Iterable
from pathlib import Path
from types import NoneType, UnionType
from typing import Annotated, Any, Literal, Union, get_args, get_origin

import pytest
from pydantic import BaseModel, Field, SecretStr, ValidationError
from pydantic.fields import FieldInfo

from forge_api.models import (
    BRIDGE_EVENT_KINDS,
    OPEN_RAILS,
    PROGRESS_STAGES,
    RAILS,
    REPO_ACTION_ERRORS,
    START_RAILS,
    AuthorizeCheck,
    AuthorizeDecision,
    AuthorizeError,
    AuthorizeParams,
    BridgeEvent,
    BridgeStatus,
    CheckResults,
    CheckRun,
    ClaimRequest,
    CommentRequest,
    ConnectedAgent,
    ConnectedAgentList,
    ConsentRequest,
    CopyResult,
    Credential,
    DispatchRequest,
    DispatchResult,
    DraftTask,
    DraftTaskRequest,
    FeedbackResponse,
    FlagConfig,
    ForkStatus,
    HouseDraft,
    HouseSpec,
    NewProposal,
    Notification,
    NotificationList,
    NotificationReadRequest,
    ProposalCard,
    ProposalComment,
    ProposalCommentPage,
    ProposalDetail,
    ProposalEvent,
    ProposalList,
    ProposalMe,
    ProposalSettings,
    ProposalTally,
    ProposalYou,
    PullRequestRef,
    RailInfo,
    RailList,
    RailMeta,
    RepoActionRequest,
    RepoCopy,
    ReviewResult,
    SavedCredential,
    SavedCredentialList,
    SecondRequest,
    SubmitRequest,
    TaskCard,
    TaskDetail,
    TaskList,
    VoteRequest,
)

GOLDEN = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "wire-golden.json"

#: Every model whose zod mirror is checked field-for-field. (ClaimResponse is not: its
#: leaseHours is an int here and any number in zod, a difference older than this file.)
WIRE_MODELS: list[type[BaseModel]] = [
    FlagConfig,
    TaskCard,
    TaskList,
    ClaimRequest,
    RailMeta,
    RailInfo,
    RailList,
    TaskDetail,
    ForkStatus,
    Credential,
    DispatchRequest,
    DispatchResult,
    BridgeEvent,
    BridgeStatus,
    CheckRun,
    CheckResults,
    FeedbackResponse,
    SubmitRequest,
    SavedCredential,
    SavedCredentialList,
    ConnectedAgent,
    ConnectedAgentList,
    AuthorizeParams,
    AuthorizeCheck,
    AuthorizeError,
    AuthorizeDecision,
    ProposalCard,
    ProposalList,
    ProposalComment,
    ProposalEvent,
    ProposalTally,
    ProposalYou,
    DraftTask,
    ProposalDetail,
    NewProposal,
    ConsentRequest,
    VoteRequest,
    CommentRequest,
    DraftTaskRequest,
    ProposalSettings,
    ProposalMe,
    Notification,
    NotificationList,
    NotificationReadRequest,
    ProposalCommentPage,
    SecondRequest,
    HouseSpec,
    HouseDraft,
    RepoCopy,
    RepoActionRequest,
    CopyResult,
    PullRequestRef,
    ReviewResult,
]

_SIMPLE = {str: "string", SecretStr: "string", bool: "boolean", int: "integer", float: "number"}

SECRET = "test-only-not-a-real-key-0001"


def _limits(constraints: Iterable[Any], *, array: bool) -> dict[str, int]:
    """minLength/maxLength (characters) for a string, minItems/maxItems for a list, read off
    pydantic's constraints. A minimum of 0 is no limit, as the zod side reads it."""
    low_key, high_key = ("minItems", "maxItems") if array else ("minLength", "maxLength")
    found: dict[str, int] = {}
    for constraint in constraints:
        if isinstance(constraint, FieldInfo):
            found.update(_limits(constraint.metadata, array=array))
            continue
        low = getattr(constraint, "min_length", None)
        high = getattr(constraint, "max_length", None)
        if low:
            found[low_key] = low
        if high is not None:
            found[high_key] = high
    return found


def _kind(annotation: Any) -> dict[str, Any]:
    origin = get_origin(annotation)
    if origin is Annotated:
        inner, *constraints = get_args(annotation)
        entry = _kind(inner)
        entry.update(_limits(constraints, array=entry["type"] == "array"))
        return entry
    if origin in (Union, UnionType):
        (inner,) = [arg for arg in get_args(annotation) if arg is not NoneType]
        return _kind(inner)
    if origin is Literal:
        return {"type": "enum", "values": list(get_args(annotation))}
    if origin is list:
        (item,) = get_args(annotation)
        return {"type": "array", "items": _kind(item)}
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return {"type": "object", "ref": annotation.__name__}
    return {"type": _SIMPLE[annotation]}


def describe(model: type[BaseModel]) -> dict[str, Any]:
    """{field: {type, values?, items?, ref?, limits?, optional?}} in declaration order, by
    the name the wire uses (a field's alias, when it has one: TaskDetail.copy_ is `copy`)."""
    described: dict[str, Any] = {}
    for name, field in model.model_fields.items():
        entry = _kind(field.annotation)
        entry.update(_limits(field.metadata, array=entry["type"] == "array"))
        if not field.is_required():
            entry["optional"] = True
        described[field.alias or name] = entry
    return described


def test_the_describer_reads_limits_where_pydantic_keeps_them() -> None:
    class Sample(BaseModel):
        text: Annotated[str, Field(min_length=1, max_length=5)]
        note: str | None = Field(default=None, max_length=9)
        lines: list[Annotated[str, Field(min_length=2, max_length=3)]] = Field(
            min_length=1, max_length=4
        )
        free: str = Field(min_length=0)

    assert describe(Sample) == {
        "text": {"type": "string", "minLength": 1, "maxLength": 5},
        "note": {"type": "string", "maxLength": 9, "optional": True},
        "lines": {
            "type": "array",
            "items": {"type": "string", "minLength": 2, "maxLength": 3},
            "minItems": 1,
            "maxItems": 4,
        },
        "free": {"type": "string"},
    }


def test_every_wire_model_matches_the_golden_the_zod_side_reads() -> None:
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert golden == {"models": {model.__name__: describe(model) for model in WIRE_MODELS}}


def test_the_rail_and_stage_vocabularies() -> None:
    assert RAILS == START_RAILS + OPEN_RAILS and len(set(RAILS)) == 12
    assert PROGRESS_STAGES == ("started", "working", "pushed", "pr_opened", "blocked", "done")
    for retired in ("api", "handoff"):
        with pytest.raises(ValidationError):
            DispatchResult(mode=retired, rail="jules", brief="x", startedAt="t")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        DispatchRequest(taskId=1, rail="gemini-cli")  # type: ignore[arg-type]


def test_a_credential_key_never_prints() -> None:
    request = DispatchRequest.model_validate(
        {"taskId": 1, "rail": "devin", "credential": {"key": SECRET, "orgId": "org-1"}}
    )
    assert request.credential is not None
    assert request.credential.key.get_secret_value() == SECRET
    for rendered in (repr(request), str(request), request.model_dump_json()):
        assert SECRET not in rendered
    assert request.credential.orgId == "org-1"


@pytest.mark.parametrize(
    "credential",
    [
        {"key": ""},
        {"key": "k" * 4097},
        {"key": "k", "orgId": "o" * 201},
        {"key": "k", "routineUrl": "https://example.test/" + "r" * 480},
    ],
)
def test_credential_lengths_are_bounded(credential: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        Credential.model_validate(credential)


def test_credential_bounds_are_inclusive() -> None:
    Credential.model_validate({"key": "k" * 4096, "orgId": "o" * 200, "routineUrl": "u" * 500})


def test_credential_limits_count_characters_as_the_zod_side_does() -> None:
    astral = "\U0001f511"  # one character, two UTF-16 units
    Credential.model_validate({"key": astral * 4096, "orgId": astral * 200})
    for too_long in ({"key": astral * 4097}, {"key": "k", "orgId": astral * 201}):
        with pytest.raises(ValidationError):
            Credential.model_validate(too_long)


def test_optional_fields_leave_the_wire_and_required_lists_stay() -> None:
    status = BridgeStatus(
        taskId=1,
        stage="claimed",
        detail="This task is yours.",
        events=[
            BridgeEvent(at="2026-10-01T00:00:00Z", kind="claimed", source="forge", message="m")
        ],
    )
    assert status.model_dump(exclude_none=True) == {
        "taskId": 1,
        "stage": "claimed",
        "detail": "This task is yours.",
        "events": [
            {"at": "2026-10-01T00:00:00Z", "kind": "claimed", "source": "forge", "message": "m"}
        ],
    }
    with pytest.raises(ValidationError):
        BridgeStatus.model_validate({"taskId": 1, "stage": "claimed", "detail": "x"})


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (BridgeEvent, {"at": "t", "kind": "deleted", "source": "forge", "message": "m"}),
        (BridgeEvent, {"at": "t", "kind": "progress", "source": "user", "message": "m"}),
        (
            BridgeEvent,
            {"at": "t", "kind": "progress", "source": "agent", "message": "m", "stage": "finished"},
        ),
        (CheckRun, {"name": "lint", "status": "done"}),
        (CheckResults, {"taskId": 1, "state": "ok", "checks": [], "notes": ""}),
        (
            RailMeta,
            {
                "id": "copilot",
                "mode": "api",
                "label": "l",
                "vendor": "v",
                "blurb": "b",
                "setup": [],
            },
        ),
        (
            RailMeta,
            {
                "id": "copilot",
                "mode": "start",
                "label": "l",
                "vendor": "v",
                "blurb": "b",
                "setup": [],
                "credential": "password",
            },
        ),
    ],
)
def test_values_outside_the_vocabularies_are_rejected(
    model: type[BaseModel], payload: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_feedback_carries_notes_not_a_prompt() -> None:
    assert set(FeedbackResponse.model_fields) == {"relayed", "notes", "relayedTo"}
    assert FeedbackResponse(relayed=True, notes="n", relayedTo="jules").relayedTo == "jules"


def test_phase_7_vocabularies_match_the_zod_side() -> None:
    """BRIDGE_EVENT_KINDS and REPO_ACTION_ERRORS in packages/shared, in the same order (its
    index.test.ts holds the same lists)."""
    assert BRIDGE_EVENT_KINDS == (
        "claimed",
        "dispatched",
        "opened",
        "progress",
        "submitted",
        "released",
        "relayed",
        "copy_ready",
        "review_sent",
    )
    assert REPO_ACTION_ERRORS == (
        "not_holder",
        "already_shipped",
        "rate_limited",
        "wrong_account",
        "copy_not_ready",
        "copy_mismatch",
        "no_copy",
        "branch_missing",
        "no_changes",
        "too_large",
        "tests_modified",
        "protected_paths",
        "checks_unavailable",
        "head_taken",
        "github_failed",
    )


def test_a_one_time_token_never_prints_and_its_length_is_bounded() -> None:
    request = RepoActionRequest.model_validate({"taskId": 1, "token": SECRET})
    assert request.token.get_secret_value() == SECRET
    for rendered in (repr(request), str(request), request.model_dump_json()):
        assert SECRET not in rendered
    RepoActionRequest.model_validate({"taskId": 1, "token": "t" * 4096})
    for token in ("", "t" * 4097):
        with pytest.raises(ValidationError):
            RepoActionRequest.model_validate({"taskId": 1, "token": token})


def test_task_detail_says_copy_on_the_wire_and_leaves_unknowns_out() -> None:
    card = TaskCard(
        id=1,
        title="t",
        civilianSummary="s",
        size="S",
        rewardClass="none",
        tierFloor="T0",
        status="claimed",
        url="u",
        labels=[],
    )
    detail = TaskDetail(
        task=card,
        acceptanceCriteria=[],
        branch="task/1-t",
        brief="b",
        copy=RepoCopy(fullName="maya/forge-app", syncedAt="2026-10-05T12:00:00Z"),
        canSendForReview=True,
    )
    dumped = detail.model_dump(exclude_none=True)
    assert dumped["copy"] == {"fullName": "maya/forge-app", "syncedAt": "2026-10-05T12:00:00Z"}
    assert dumped["canSendForReview"] is True
    assert detail.copy_ is not None and detail.copy_.fullName == "maya/forge-app"
    bare = TaskDetail(task=card, acceptanceCriteria=[], branch="task/1-t", brief="b")
    assert set(bare.model_dump(exclude_none=True)) == {
        "task",
        "acceptanceCriteria",
        "branch",
        "brief",
    }
    assert TaskDetail.model_validate(dumped).copy_ == detail.copy_
