"""The Proposals and notifications wire models (Phase 5 contract §2).

test_wire_models.py holds every model here to its zod mirror field for field, limits
included (tests/fixtures/wire-golden.json); this file pins the vocabularies and what each
model takes. packages/shared/src/proposals.test.ts runs the same cases against zod.
"""

from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from forge_api.models import (
    ACTIVE_PROPOSAL_STATES,
    CONSENT_CHOICES,
    ELIGIBLE_ACTIVITY_DAYS,
    NOTIFICATION_KINDS,
    PROPOSAL_EVENT_KINDS,
    PROPOSAL_LIMITS,
    PROPOSAL_STATES,
    VOTE_CHOICES,
    CommentRequest,
    ConsentRequest,
    DraftTask,
    DraftTaskRequest,
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
    SecondRequest,
    VoteRequest,
)

#: One character that is two UTF-16 units.
ASTRAL = "\U0001f3db"

CARD: dict[str, Any] = {
    "id": 12,
    "title": "A map of every app on the wall",
    "state": "debate",
    "mover": "maya",
    "movedAt": "2026-10-04T09:00:00Z",
    "seconder": "sam",
    "deadline": "2026-10-07T09:05:00Z",
    "commentCount": 1,
    "objectionCount": 0,
}

YOU: dict[str, Any] = {
    "canEdit": False,
    "canWithdraw": True,
    "canSecond": False,
    "canConsent": False,
    "consent": "consented",
    "canComment": True,
    "canVote": False,
    "isAdmin": False,
}

DETAIL: dict[str, Any] = {
    "proposal": CARD,
    "pitch": "Show every app on one page.\nEach with a link.",
    "eligibleCount": 6,
    "consentCount": 4,
    "comments": [{"id": 1, "author": "sam", "text": "Yes please.", "at": "2026-10-04T10:00:00Z"}],
    "events": [
        {
            "at": "2026-10-04T09:00:00Z",
            "kind": "moved",
            "actor": "maya",
            "message": "maya moved this proposal.",
        },
        {
            "at": "2026-10-04T09:05:00Z",
            "kind": "seconded",
            "actor": "sam",
            "message": "sam seconded it. Debate is open.",
        },
    ],
    "you": YOU,
    "revision": 1,
}

DRAFT_REQUEST: dict[str, Any] = {
    "title": "A map of every app on the wall",
    "civilianSummary": "One page that lists every app, with a link to each.",
    "acceptanceCriteria": ["Every lit panel is listed", "Each entry links to its app"],
    "size": "S",
    "tierFloor": "T0",
    "rewardClass": "R1",
}

NEW: dict[str, Any] = {"title": "A title", "pitch": "A pitch."}


def takes(model: type[BaseModel], base: dict[str, Any], field: str, value: Any) -> bool:
    """Whether `model` takes `base` with `field` set to `value`."""
    try:
        model.model_validate({**base, field: value})
    except ValidationError:
        return False
    return True


def without(payload: dict[str, Any], *fields: str) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key not in fields}


# --- vocabularies --------------------------------------------------------------------


def test_the_stored_states_leave_out_the_momentary_second() -> None:
    assert PROPOSAL_STATES == (
        "submitted",
        "debate",
        "voting",
        "passed",
        "failed",
        "building",
        "shipped",
        "lapsed",
        "withdrawn",
    )
    assert not takes(ProposalCard, CARD, "state", "seconded")


def test_the_active_states_are_the_three_before_a_decision() -> None:
    assert ACTIVE_PROPOSAL_STATES == ("submitted", "debate", "voting")
    assert set(ACTIVE_PROPOSAL_STATES) <= set(PROPOSAL_STATES)


def test_every_timeline_kind_in_order() -> None:
    assert PROPOSAL_EVENT_KINDS == (
        "moved",
        "edited",
        "seconded",
        "consented",
        "objected",
        "commented",
        "debate_ended",
        "vote_opened",
        "voted",
        "vote_closed",
        "passed",
        "failed",
        "lapsed",
        "withdrawn",
        "task_drafted",
        "task_published",
        "shipped",
        "admin_ended_debate",
        "admin_closed_vote",
        "test_timers_on",
        "test_timers_off",
        "floor_paused",
        "floor_resumed",
    )


def test_votes_consents_and_notification_kinds() -> None:
    assert VOTE_CHOICES == ("yes", "no", "abstain")
    assert CONSENT_CHOICES == ("consented", "objected")
    assert NOTIFICATION_KINDS == (
        "proposal_moved",
        "proposal_seconded",
        "your_proposal_seconded",
        "proposal_passed",
        "proposal_failed",
        "proposal_lapsed",
        "vote_opened",
        "task_published",
    )


@pytest.mark.parametrize(
    ("model", "base", "field", "value"),
    [
        (ProposalEvent, {"at": "t", "kind": "moved", "message": "m"}, "kind", "deleted"),
        (VoteRequest, {}, "choice", "maybe"),
        (ProposalYou, YOU, "consent", "abstained"),
        (
            Notification,
            {"id": 1, "kind": "vote_opened", "message": "m", "href": "/", "at": "t", "read": False},
            "kind",
            "proposal_shipped",
        ),
    ],
)
def test_values_outside_the_vocabularies_are_rejected(
    model: type[BaseModel], base: dict[str, Any], field: str, value: str
) -> None:
    assert takes(model, base, field, base.get(field, "yes"))
    assert not takes(model, base, field, value)


def test_the_limits_are_the_contract_numbers_and_cannot_change() -> None:
    assert dict(PROPOSAL_LIMITS) == {
        "title": 100,
        "pitch": 4000,
        "comment": 2000,
        "summary": 500,
        "criteria": 10,
        "criterion": 300,
    }
    with pytest.raises(TypeError):
        PROPOSAL_LIMITS["title"] = 1000  # type: ignore[index]


# --- cards, the list and the detail ----------------------------------------------------


def test_a_card_before_and_after_the_second() -> None:
    ProposalCard.model_validate(CARD)
    fresh = ProposalCard.model_validate(
        {**without(CARD, "seconder", "deadline"), "state": "submitted"}
    )
    assert "seconder" not in fresh.model_dump(exclude_none=True)
    assert not takes(ProposalCard, CARD, "id", 1.5)


def test_a_list_carries_the_cards_and_the_test_timers_switch() -> None:
    ProposalList.model_validate({"proposals": [CARD], "testTimers": True})
    with pytest.raises(ValidationError):
        ProposalList.model_validate({"proposals": []})


def test_a_list_may_say_older_decided_ones_exist_and_the_floor_is_paused() -> None:
    paged = {"proposals": [CARD], "testTimers": False, "moreDecided": True, "floorPaused": True}
    assert ProposalList.model_validate(paged).model_dump(exclude_none=True) == paged
    plain = ProposalList.model_validate({"proposals": [], "testTimers": False})
    assert plain.model_dump(exclude_none=True) == {"proposals": [], "testTimers": False}
    assert not takes(ProposalList, paged, "moreDecided", "maybe")


def test_a_detail_for_an_identified_caller_round_trips_without_nulls() -> None:
    detail = ProposalDetail.model_validate(DETAIL)
    assert detail.you is not None and detail.you.consent == "consented"
    assert detail.model_dump(exclude_none=True) == DETAIL


def test_a_decided_detail_as_an_admin_sees_it_once_published() -> None:
    decided = {
        **DETAIL,
        "proposal": {**CARD, "state": "building", "objectionCount": 1},
        "tally": {"yes": 4, "no": 1, "abstain": 1, "eligible": 6, "quorumMet": True},
        "you": {**YOU, "consent": "objected", "vote": "no", "isAdmin": True},
        "draft": {**DRAFT_REQUEST, "taskId": 10001},
        "taskId": 10001,
    }
    assert ProposalDetail.model_validate(decided).model_dump(exclude_none=True) == decided


def test_a_detail_carries_its_revision_and_whether_more_comments_exist() -> None:
    current = {**DETAIL, "revision": 3, "moreComments": True, "floorPaused": True}
    assert ProposalDetail.model_validate(current).model_dump(exclude_none=True) == current
    assert not takes(ProposalDetail, DETAIL, "revision", 1.5)
    assert not takes(ProposalDetail, DETAIL, "moreComments", "maybe")


def test_a_page_of_comments_says_whether_older_ones_exist() -> None:
    page = {"comments": DETAIL["comments"], "moreComments": False}
    assert ProposalCommentPage.model_validate(page).model_dump() == page
    with pytest.raises(ValidationError):
        ProposalCommentPage.model_validate({"comments": []})


def test_a_signed_out_detail_has_no_you_and_no_counts() -> None:
    anonymous = without(DETAIL, "you", "eligibleCount", "consentCount")
    assert ProposalDetail.model_validate(anonymous).model_dump(exclude_none=True) == anonymous


@pytest.mark.parametrize("field", ["comments", "events", "pitch", "proposal", "revision"])
def test_a_detail_needs_its_thread_timeline_pitch_card_and_revision(field: str) -> None:
    with pytest.raises(ValidationError):
        ProposalDetail.model_validate(without(DETAIL, field))


def test_a_timeline_line_may_have_no_actor_but_a_comment_needs_its_author() -> None:
    line = ProposalEvent.model_validate({"at": "t", "kind": "lapsed", "message": "Nobody."})
    assert line.model_dump(exclude_none=True) == {"at": "t", "kind": "lapsed", "message": "Nobody."}
    with pytest.raises(ValidationError):
        ProposalComment.model_validate({"id": 1, "text": "x", "at": "t"})


def test_a_tally_has_every_count_and_you_takes_only_known_votes() -> None:
    with pytest.raises(ValidationError):
        ProposalTally.model_validate({"yes": 1, "no": 1, "abstain": 0, "eligible": 3})
    assert not takes(ProposalYou, YOU, "vote", "maybe")
    assert ProposalYou.model_validate(without(YOU, "consent")).consent is None


# --- the draft task ---------------------------------------------------------------------


def test_a_draft_starts_as_the_whole_pitch_and_no_criteria() -> None:
    fresh = {
        **DRAFT_REQUEST,
        "civilianSummary": "p" * PROPOSAL_LIMITS["pitch"],
        "acceptanceCriteria": [],
    }
    DraftTask.model_validate(fresh)


@pytest.mark.parametrize(
    ("field", "value"),
    [("size", "L"), ("tierFloor", "T3"), ("rewardClass", "R9"), ("taskId", 10001.5)],
)
def test_a_draft_reuses_the_task_board_enums(field: str, value: object) -> None:
    assert not takes(DraftTask, DRAFT_REQUEST, field, value)


def test_a_draft_request_is_the_draft_without_its_task_id() -> None:
    assert list(DraftTaskRequest.model_fields) == [
        field for field in DraftTask.model_fields if field != "taskId"
    ]
    request = DraftTaskRequest.model_validate({**DRAFT_REQUEST, "taskId": 7})
    assert request.model_dump() == DRAFT_REQUEST


# --- the limits on what members send ------------------------------------------------------

LIMITED = [
    (NewProposal, NEW, "title", PROPOSAL_LIMITS["title"]),
    (NewProposal, NEW, "pitch", PROPOSAL_LIMITS["pitch"]),
    (CommentRequest, {"text": "x"}, "text", PROPOSAL_LIMITS["comment"]),
    (DraftTaskRequest, DRAFT_REQUEST, "title", PROPOSAL_LIMITS["title"]),
    (DraftTaskRequest, DRAFT_REQUEST, "civilianSummary", PROPOSAL_LIMITS["summary"]),
]


@pytest.mark.parametrize(("model", "base", "field", "most"), LIMITED)
@pytest.mark.parametrize("char", ["a", ASTRAL])
def test_a_text_takes_one_to_its_limit_in_characters(
    model: type[BaseModel], base: dict[str, Any], field: str, most: int, char: str
) -> None:
    assert not takes(model, base, field, "")
    assert takes(model, base, field, char)
    assert takes(model, base, field, char * most)
    assert not takes(model, base, field, char * (most + 1))
    with pytest.raises(ValidationError):
        model.model_validate(without(base, field))


@pytest.mark.parametrize("char", ["a", ASTRAL])
def test_a_draft_lists_one_to_ten_criteria_of_one_to_300_characters(char: str) -> None:
    field = "acceptanceCriteria"
    most, longest = PROPOSAL_LIMITS["criteria"], PROPOSAL_LIMITS["criterion"]
    assert not takes(DraftTaskRequest, DRAFT_REQUEST, field, [])
    assert takes(DraftTaskRequest, DRAFT_REQUEST, field, ["It works"])
    assert takes(DraftTaskRequest, DRAFT_REQUEST, field, ["It works"] * most)
    assert not takes(DraftTaskRequest, DRAFT_REQUEST, field, ["It works"] * (most + 1))
    assert takes(DraftTaskRequest, DRAFT_REQUEST, field, [char * longest])
    assert not takes(DraftTaskRequest, DRAFT_REQUEST, field, [char * (longest + 1)])
    assert not takes(DraftTaskRequest, DRAFT_REQUEST, field, ["Fine", ""])


def test_a_too_long_title_and_an_empty_pitch_are_both_named() -> None:
    with pytest.raises(ValidationError) as caught:
        NewProposal.model_validate({"title": "t" * 101, "pitch": ""})
    assert [(error["loc"], error["type"]) for error in caught.value.errors()] == [
        (("title",), "string_too_long"),
        (("pitch",), "string_too_short"),
    ]


# --- the other requests and the caller ----------------------------------------------------


@pytest.mark.parametrize("consent", [True, False])
def test_consent_takes_a_real_boolean(consent: bool) -> None:
    assert ConsentRequest.model_validate({"consent": consent}).consent is consent


@pytest.mark.parametrize("value", ["false", "true", 0, 1, None])
def test_consent_refuses_anything_but_a_boolean_as_zod_does(value: object) -> None:
    # Lax pydantic would read "false" or 0 as an objection, which is final.
    assert not takes(ConsentRequest, {}, "consent", value)
    with pytest.raises(ValidationError):
        ConsentRequest.model_validate({})


def test_a_second_names_a_revision_as_a_positive_integer() -> None:
    assert SecondRequest.model_validate({"revision": 2}).revision == 2
    for value in ("2", 2.0, True, 0, -1, None):
        assert not takes(SecondRequest, {}, "revision", value)
    with pytest.raises(ValidationError):
        SecondRequest.model_validate({})


def test_the_eligible_set_counts_the_last_30_days() -> None:
    assert ELIGIBLE_ACTIVITY_DAYS == 30


def test_a_vote_is_one_of_the_three_choices() -> None:
    for choice in VOTE_CHOICES:
        assert VoteRequest.model_validate({"choice": choice}).choice == choice
    assert not takes(VoteRequest, {}, "choice", "YES")


def test_settings_and_the_caller() -> None:
    assert ProposalSettings.model_validate({"testTimers": True}).testTimers is True
    assert not takes(ProposalSettings, {}, "testTimers", "true")
    me = ProposalMe.model_validate({"isAdmin": False, "testTimers": False})
    assert me.model_dump(exclude_none=True) == {"isAdmin": False, "testTimers": False}
    assert ProposalMe(isAdmin=True, activeProposalId=12, testTimers=True).activeProposalId == 12


# --- notifications --------------------------------------------------------------------------

ITEM: dict[str, Any] = {
    "id": 3,
    "kind": "proposal_seconded",
    "message": 'sam seconded "A map of every app on the wall". Debate is open.',
    "href": "/propose/12",
    "at": "2026-10-04T09:05:00Z",
    "read": False,
}


def test_a_notification_list_is_the_items_and_the_unread_count() -> None:
    payload = {"notifications": [ITEM, {**ITEM, "id": 2, "read": True}], "unread": 1}
    assert NotificationList.model_validate(payload).model_dump() == payload
    with pytest.raises(ValidationError):
        NotificationList.model_validate({"notifications": []})


def test_marking_read_names_the_ids_or_none_for_all_of_them() -> None:
    assert NotificationReadRequest.model_validate({}).ids is None
    assert NotificationReadRequest.model_validate({"ids": [1, 2]}).ids == [1, 2]
    for ids in (["one"], [1.5]):
        assert not takes(NotificationReadRequest, {}, "ids", ids)
