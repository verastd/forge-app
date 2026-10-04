"""The house model's wire models (Phase 6 contract §2): HouseSpec, HouseDraft,
ProposalDetail.house and the `house_drafted` timeline line.

test_wire_models.py holds each model here to its zod mirror field for field, limits
included (tests/fixtures/wire-golden.json); this file pins the vocabularies and what each
model takes, with the contract's numbers written out, so a wrong limit fails here on its
own. packages/shared/src/house.test.ts runs the same cases against zod.
"""

import json
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from forge_api.models import (
    HOUSE_FAILURE_REASONS,
    HOUSE_OFF_REASONS,
    HOUSE_REASONS,
    HOUSE_SPEC_LIMITS,
    HOUSE_STATUSES,
    HOUSE_VERDICTS,
    PROPOSAL_EVENT_KINDS,
    DraftTaskRequest,
    HouseDraft,
    HouseSpec,
    ProposalDetail,
    ProposalEvent,
)

#: One character that is two UTF-16 units.
ASTRAL = "\U0001f3db"

SPEC: dict[str, Any] = {
    "title": "A map of every app on the wall",
    "civilianSummary": "One page that lists every app on the wall, with a link to each.",
    "acceptanceCriteria": [
        "/apps/map lists every lit panel by name",
        "Each entry links to its app",
    ],
    "size": "S",
    "tierFloor": "T0",
    "scopeIn": ["apps/web/src/app/apps/map/**", "tests/e2e/map.spec.ts"],
    "scopeOut": ["apps/api/"],
    "risks": ["The panel list is written by hand in the lobby for now."],
    "questions": ["Should panels that are switched off be listed too?"],
    "verdict": "ready",
    "verdictReason": "Small, testable, and all of it in apps/web.",
}

#: What describes a spec that succeeded.
SAVED: dict[str, Any] = {"model": "house-test-model", "draftedAt": "2026-10-04T12:00:00Z"}

DONE: dict[str, Any] = {"status": "done", "spec": SPEC, **SAVED, "appliedToDraft": True}

DETAIL: dict[str, Any] = {
    "proposal": {
        "id": 12,
        "title": "A map of every app on the wall",
        "state": "passed",
        "mover": "maya",
        "movedAt": "2026-10-01T09:00:00Z",
        "seconder": "sam",
        "commentCount": 0,
        "objectionCount": 0,
    },
    "pitch": "Show every app on one page.",
    "comments": [],
    "events": [{"at": "2026-10-04T09:00:00Z", "kind": "passed", "message": "It passed."}],
    "revision": 1,
}

DRAFT: dict[str, Any] = {
    "title": SPEC["title"],
    "civilianSummary": SPEC["civilianSummary"],
    "acceptanceCriteria": SPEC["acceptanceCriteria"],
    "size": SPEC["size"],
    "tierFloor": "T0",
    "rewardClass": "R1",
}

#: Leave the field out.
ABSENT = object()


def takes(model: type[BaseModel], base: dict[str, Any], field: str, value: Any) -> bool:
    """Whether `model` takes `base` with `field` set to `value` (ABSENT: left out)."""
    payload = {key: item for key, item in base.items() if key != field}
    if value is not ABSENT:
        payload[field] = value
    try:
        model.model_validate(payload)
    except ValidationError:
        return False
    return True


def entries(count: int, text: str = "It works") -> list[str]:
    return [text] * count


def nulls(value: Any, path: str = "") -> list[str]:
    """Every place in a serialized payload that holds null."""
    if value is None:
        return [path]
    if isinstance(value, dict):
        return [found for key, item in value.items() for found in nulls(item, f"{path}.{key}")]
    if isinstance(value, list):
        return [found for at, item in enumerate(value) for found in nulls(item, f"{path}.{at}")]
    return []


# --- vocabularies -----------------------------------------------------------------------


def test_the_verdicts_statuses_and_reasons_in_order() -> None:
    assert HOUSE_VERDICTS == ("ready", "needs_clarification", "not_feasible")
    assert HOUSE_STATUSES == ("off", "queued", "running", "done", "failed")
    assert HOUSE_OFF_REASONS == ("not_configured", "switched_off")
    assert HOUSE_FAILURE_REASONS == (
        "refused",
        "invalid_output",
        "unavailable",
        "too_large",
        "bad_request",
        "daily_limit",
    )
    assert HOUSE_REASONS == HOUSE_OFF_REASONS + HOUSE_FAILURE_REASONS


def test_every_reason_is_either_an_off_reason_or_a_failure_reason() -> None:
    assert not set(HOUSE_OFF_REASONS) & set(HOUSE_FAILURE_REASONS)
    assert len(set(HOUSE_REASONS)) == 8


@pytest.mark.parametrize(
    ("model", "base", "field", "value"),
    [
        (HouseSpec, SPEC, "verdict", "maybe"),
        (HouseSpec, SPEC, "verdict", "Ready"),
        (HouseSpec, SPEC, "verdict", "needs clarification"),
        (HouseDraft, DONE, "status", "cancelled"),
        (HouseDraft, DONE, "status", ""),
        (HouseDraft, DONE, "reason", "timeout"),
        (HouseDraft, DONE, "reason", "DAILY_LIMIT"),
    ],
)
def test_values_outside_the_vocabularies_are_rejected(
    model: type[BaseModel], base: dict[str, Any], field: str, value: str
) -> None:
    assert not takes(model, base, field, value)


@pytest.mark.parametrize("verdict", HOUSE_VERDICTS)
def test_a_spec_takes_every_verdict(verdict: str) -> None:
    assert HouseSpec.model_validate({**SPEC, "verdict": verdict}).verdict == verdict


def test_house_drafted_is_the_last_timeline_kind_and_a_public_line_takes_it() -> None:
    assert PROPOSAL_EVENT_KINDS[-1] == "house_drafted"
    assert PROPOSAL_EVENT_KINDS.count("house_drafted") == 1
    line = {
        "at": "2026-10-04T12:00:00Z",
        "kind": "house_drafted",
        "message": "FORGE's house model drafted the task from this proposal.",
    }
    assert ProposalEvent.model_validate(line).model_dump(exclude_none=True) == line


def test_the_limits_are_the_contract_numbers_and_cannot_change() -> None:
    assert dict(HOUSE_SPEC_LIMITS) == {
        "title": 100,
        "summary": 500,
        "criteria": 10,
        "criterion": 300,
        "scope": 20,
        "path": 200,
        "risks": 10,
        "risk": 300,
        "questions": 10,
        "question": 300,
        "verdictReason": 500,
    }
    with pytest.raises(TypeError):
        HOUSE_SPEC_LIMITS["title"] = 1000  # type: ignore[index]


def test_a_spec_at_every_limit_still_fits_the_draft_task_it_fills() -> None:
    longest = HouseSpec.model_validate(
        {
            **SPEC,
            "title": ASTRAL * HOUSE_SPEC_LIMITS["title"],
            "civilianSummary": ASTRAL * HOUSE_SPEC_LIMITS["summary"],
            "acceptanceCriteria": entries(
                HOUSE_SPEC_LIMITS["criteria"], ASTRAL * HOUSE_SPEC_LIMITS["criterion"]
            ),
        }
    )
    DraftTaskRequest.model_validate(
        {
            "title": longest.title,
            "civilianSummary": longest.civilianSummary,
            "acceptanceCriteria": longest.acceptanceCriteria,
            "size": longest.size,
            "tierFloor": "T0",
            "rewardClass": "R1",
        }
    )


# --- HouseSpec ------------------------------------------------------------------------


def test_a_spec_round_trips_unchanged_as_a_dict_and_as_json() -> None:
    spec = HouseSpec.model_validate(SPEC)
    assert spec.model_dump() == SPEC
    assert json.loads(spec.model_dump_json()) == SPEC
    assert HouseSpec.model_validate_json(json.dumps(SPEC)) == spec


def test_a_spec_takes_empty_scope_risks_and_questions() -> None:
    bare = {**SPEC, "scopeIn": [], "scopeOut": [], "risks": [], "questions": []}
    assert HouseSpec.model_validate(bare).model_dump() == bare


def test_a_spec_drops_a_key_it_does_not_know_as_zod_does() -> None:
    assert HouseSpec.model_validate({**SPEC, "rewardClass": "R4"}).model_dump() == SPEC


@pytest.mark.parametrize("field", list(SPEC))
def test_every_spec_field_is_required_and_never_null(field: str) -> None:
    assert not takes(HouseSpec, SPEC, field, ABSENT)
    assert not takes(HouseSpec, SPEC, field, None)
    with pytest.raises(ValidationError):
        HouseSpec.model_validate_json(json.dumps({**SPEC, field: None}))


@pytest.mark.parametrize(
    ("field", "good", "bad"),
    [
        ("size", ("XS", "S", "M"), "L"),
        ("tierFloor", ("T0", "T1", "T2"), "T3"),
    ],
)
def test_size_and_tier_floor_are_the_task_board_enums(
    field: str, good: tuple[str, ...], bad: str
) -> None:
    for value in good:
        assert takes(HouseSpec, SPEC, field, value)
    assert not takes(HouseSpec, SPEC, field, bad)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", 42),
        ("title", b"A map"),  # lax pydantic would decode bytes; zod refuses them
        ("civilianSummary", ["One page."]),
        ("acceptanceCriteria", "It works"),
        ("acceptanceCriteria", ("It works",)),  # lax pydantic would take a tuple
        ("scopeIn", {"apps/web/"}),  # or a set
        ("risks", [1]),
        ("size", b"S"),
    ],
)
def test_a_spec_is_strict_as_zod_is_a_wrong_type_is_refused_not_coerced(
    field: str, value: object
) -> None:
    assert not takes(HouseSpec, SPEC, field, value)


TEXTS = [("title", 100), ("civilianSummary", 500), ("verdictReason", 500)]


@pytest.mark.parametrize(("field", "most"), TEXTS)
@pytest.mark.parametrize("char", ["a", ASTRAL])
def test_a_spec_text_takes_one_to_its_limit_in_characters(field: str, most: int, char: str) -> None:
    assert not takes(HouseSpec, SPEC, field, "")
    assert takes(HouseSpec, SPEC, field, char)
    assert takes(HouseSpec, SPEC, field, char * most)
    assert not takes(HouseSpec, SPEC, field, char * (most + 1))


LISTS = [
    ("acceptanceCriteria", 1, 10, 300),
    ("scopeIn", 0, 20, 200),
    ("scopeOut", 0, 20, 200),
    ("risks", 0, 10, 300),
    ("questions", 0, 10, 300),
]


@pytest.mark.parametrize(("field", "fewest", "most", "longest"), LISTS)
@pytest.mark.parametrize("char", ["a", ASTRAL])
def test_a_spec_list_holds_its_entries_of_one_to_its_limit_in_characters(
    field: str, fewest: int, most: int, longest: int, char: str
) -> None:
    if fewest:
        assert not takes(HouseSpec, SPEC, field, entries(fewest - 1))
    assert takes(HouseSpec, SPEC, field, entries(fewest))
    assert takes(HouseSpec, SPEC, field, entries(most))
    assert not takes(HouseSpec, SPEC, field, entries(most + 1))
    assert takes(HouseSpec, SPEC, field, [char * longest])
    assert not takes(HouseSpec, SPEC, field, [char * (longest + 1)])
    assert not takes(HouseSpec, SPEC, field, ["Fine", ""])
    assert not takes(HouseSpec, SPEC, field, ["Fine", None])


def test_model_output_validates_from_json_and_names_every_problem() -> None:
    output = json.dumps({**SPEC, "title": "t" * 101, "scopeIn": [""], "verdict": "unsure"})
    with pytest.raises(ValidationError) as caught:
        HouseSpec.model_validate_json(output)
    assert [(error["loc"], error["type"]) for error in caught.value.errors()] == [
        (("title",), "string_too_long"),
        (("scopeIn", 0), "string_too_short"),
        (("verdict",), "literal_error"),
    ]


# --- HouseDraft -------------------------------------------------------------------------

DRAFTS: list[dict[str, Any]] = [
    {"status": "off", "reason": "not_configured"},
    {"status": "off", "reason": "switched_off"},
    {"status": "queued"},
    {"status": "running"},
    # A new draft on its way keeps showing the latest one that succeeded.
    {"status": "queued", "spec": SPEC, **SAVED, "appliedToDraft": False},
    {"status": "running", "spec": SPEC, **SAVED, "appliedToDraft": True},
    DONE,
    {"status": "done", "spec": SPEC, **SAVED, "appliedToDraft": False},
    {"status": "failed", "reason": "daily_limit"},
    {"status": "failed", "reason": "refused", "spec": SPEC, **SAVED, "appliedToDraft": True},
]


@pytest.mark.parametrize("payload", DRAFTS)
def test_a_draft_round_trips_at_every_status_without_nulls(payload: dict[str, Any]) -> None:
    draft = HouseDraft.model_validate(payload)
    assert draft.model_dump(exclude_none=True) == payload
    assert json.loads(draft.model_dump_json(exclude_none=True)) == payload
    assert HouseDraft.model_validate_json(json.dumps(payload)) == draft


def test_a_draft_needs_only_its_status() -> None:
    queued = HouseDraft.model_validate({"status": "queued"})
    assert queued.model_dump(exclude_none=True) == {"status": "queued"}
    assert (queued.reason, queued.spec, queued.model, queued.draftedAt) == (None, None, None, None)
    assert queued.appliedToDraft is None
    assert not takes(HouseDraft, DONE, "status", ABSENT)
    assert not takes(HouseDraft, DONE, "status", None)
    assert [name for name, field in HouseDraft.model_fields.items() if field.is_required()] == [
        "status"
    ]


@pytest.mark.parametrize("field", ["reason", "spec", "model", "draftedAt", "appliedToDraft"])
def test_an_optional_draft_field_is_left_out_never_serialized_as_null(field: str) -> None:
    full = {**DONE, "reason": "refused"}
    assert takes(HouseDraft, full, field, ABSENT)
    # The API builds a draft with None for what it doesn't have; None never reaches the wire.
    built = HouseDraft.model_validate({**full, field: None})
    assert built.model_dump(exclude_none=True) == {
        key: value for key, value in full.items() if key != field
    }
    assert nulls(built.model_dump(exclude_none=True)) == []


@pytest.mark.parametrize("status", HOUSE_STATUSES)
def test_a_draft_takes_every_status(status: str) -> None:
    assert HouseDraft.model_validate({"status": status}).status == status


@pytest.mark.parametrize("reason", HOUSE_REASONS)
def test_a_draft_takes_every_reason(reason: str) -> None:
    assert HouseDraft.model_validate({"status": "failed", "reason": reason}).reason == reason


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("appliedToDraft", 1),
        ("appliedToDraft", 0),
        ("appliedToDraft", "true"),
        ("appliedToDraft", "false"),
        ("model", 5),
        ("draftedAt", 1759579200000),
    ],
)
def test_a_draft_is_strict_as_zod_is(field: str, value: object) -> None:
    # Lax pydantic would read 1 or "true" as True: build it with a real boolean.
    assert not takes(HouseDraft, DONE, field, value)


@pytest.mark.parametrize(
    "spec",
    [
        {**SPEC, "acceptanceCriteria": []},
        {**SPEC, "title": "t" * 101},
        {**SPEC, "verdict": "unsure"},
        {key: value for key, value in SPEC.items() if key != "risks"},
    ],
)
def test_the_spec_in_a_draft_is_held_to_the_spec_limits(spec: dict[str, Any]) -> None:
    assert not takes(HouseDraft, DONE, "spec", spec)


def test_a_draft_takes_a_spec_already_built() -> None:
    draft = HouseDraft(status="done", spec=HouseSpec.model_validate(SPEC), appliedToDraft=False)
    assert draft.model_dump(exclude_none=True) == {
        "status": "done",
        "spec": SPEC,
        "appliedToDraft": False,
    }


# --- ProposalDetail.house -----------------------------------------------------------------


def test_house_is_optional_and_a_detail_without_it_reads_as_before() -> None:
    field = ProposalDetail.model_fields["house"]
    assert not field.is_required() and field.default is None
    detail = ProposalDetail.model_validate(DETAIL)
    assert detail.house is None
    assert detail.model_dump(exclude_none=True) == DETAIL


def test_an_admins_detail_carries_the_house_next_to_the_draft_and_round_trips() -> None:
    admin = {
        **DETAIL,
        "events": [
            *DETAIL["events"],
            {"at": "2026-10-04T12:00:00Z", "kind": "house_drafted", "message": "Drafted."},
        ],
        "draft": DRAFT,
        "house": DONE,
    }
    detail = ProposalDetail.model_validate(admin)
    assert isinstance(detail.house, HouseDraft)
    dumped = detail.model_dump(exclude_none=True)
    assert dumped == admin
    assert nulls(dumped) == []
    assert ProposalDetail.model_validate_json(json.dumps(admin)) == detail
    fields = list(ProposalDetail.model_fields)
    assert fields.index("house") == fields.index("draft") + 1


@pytest.mark.parametrize(
    "house",
    [DONE, {"status": "off", "reason": "switched_off"}, {"status": "running"}],
)
@pytest.mark.parametrize("state", ["passed", "building", "shipped"])
def test_the_house_shows_from_the_pass_on(state: str, house: dict[str, Any]) -> None:
    later = {**DETAIL, "proposal": {**DETAIL["proposal"], "state": state}, "house": house}
    assert ProposalDetail.model_validate(later).model_dump(exclude_none=True) == later


def test_a_house_built_with_nones_inside_a_detail_never_reaches_the_wire_as_null() -> None:
    detail = ProposalDetail.model_validate(
        {**DETAIL, "house": HouseDraft(status="queued", reason=None, spec=None)}
    )
    dumped = detail.model_dump(exclude_none=True)
    assert dumped["house"] == {"status": "queued"}
    assert nulls(dumped) == []


@pytest.mark.parametrize(
    "house", [{}, {"reason": "refused"}, {"status": "done", "spec": {**SPEC, "title": ""}}]
)
def test_a_house_without_its_status_or_with_a_bad_spec_is_refused(house: dict[str, Any]) -> None:
    assert not takes(ProposalDetail, DETAIL, "house", house)
