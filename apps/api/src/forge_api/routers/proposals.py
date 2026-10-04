"""The Propose floor (Phase 5 contract §3): thin — parse, call services.proposals, return
the model.

Every route 404s `{"error": "proposals-disabled"}` while the `proposals` flag is off.
The list, a proposal's detail and the pages of its comments are public; a detail read with
an identity adds `you` (and the draft task for an admin). Every other route needs the web
tier's assertion (`require_identity`, 401 without one), and the settings and `/admin/*`
routes an allowlisted GitHub id (`require_admin`, 403 admin_only). Every identity-bearing
route records its caller as a member first (routers/members.py).

Bodies are read by routers/members.json_body, so a bad one is `400 invalid_request` with
`fields`. A proposal number that isn't one is 404 proposal_not_found, like a missing one;
a paging cursor that isn't one (`?decidedBefore=`, `?before=`) is 400 invalid_request.
response_model_exclude_none everywhere: zod's `.optional()` rejects an explicit null.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from forge_api.models import (
    CommentRequest,
    ConsentRequest,
    DraftTaskRequest,
    NewProposal,
    ProposalCommentPage,
    ProposalDetail,
    ProposalList,
    ProposalMe,
    ProposalSettings,
    SecondRequest,
    VoteRequest,
)
from forge_api.routers.members import (
    AdminMember,
    Db,
    MaybeMember,
    Member,
    Now,
    body_doc,
    json_body,
)
from forge_api.services import flags as flags_service
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError
from forge_api.services.proposals import Proposals


def _require_proposals_enabled(now: Now) -> None:
    """The kill switch: every /api/proposals* route 404s while the flag is off. A request
    refused here also records that the floor is closed, if the ticker hasn't yet, so its
    deadlines wait from then."""
    if not flags_service.is_enabled(proposals_service.FLAG):
        proposals_service.note_floor_closed(now)
        raise ApiError(404, {"error": "proposals-disabled"})


def get_floor(db: Db, now: Now) -> Proposals:
    return Proposals(db, now)


Floor = Annotated[Proposals, Depends(get_floor)]

router = APIRouter(
    prefix="/api/proposals",
    tags=["proposals"],
    dependencies=[Depends(_require_proposals_enabled)],
)


@router.get("", response_model=ProposalList, response_model_exclude_none=True)
def list_proposals(
    floor: Floor,
    state: str | None = None,
    decided_before: Annotated[str | None, Query(alias="decidedBefore")] = None,
) -> ProposalList:
    """The floor, newest first: every active proposal and the newest 100 decided ones;
    `?decidedBefore=<id>` pages the older decided ones, and `?state=` keeps one state."""
    return floor.list_proposals(
        proposals_service.parse_state(state),
        proposals_service.parse_cursor(decided_before, "decidedBefore"),
    )


@router.get("/me", response_model=ProposalMe, response_model_exclude_none=True)
def me(floor: Floor, user: Member) -> ProposalMe:
    return floor.me(user)


@router.put(
    "/settings",
    response_model=ProposalSettings,
    response_model_exclude_none=True,
    openapi_extra=body_doc(ProposalSettings),
)
def settings(
    floor: Floor,
    admin: AdminMember,
    request: Annotated[ProposalSettings, Depends(json_body(ProposalSettings))],
) -> ProposalSettings:
    return floor.set_test_timers(admin, request.testTimers)


@router.post(
    "",
    status_code=201,
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(NewProposal),
)
def move(
    floor: Floor,
    user: Member,
    request: Annotated[NewProposal, Depends(json_body(NewProposal))],
) -> ProposalDetail:
    return floor.move(user, request)


@router.get("/{proposal_id}", response_model=ProposalDetail, response_model_exclude_none=True)
def detail(proposal_id: str, floor: Floor, user: MaybeMember) -> ProposalDetail:
    return floor.detail(proposals_service.parse_id(proposal_id), user)


@router.patch(
    "/{proposal_id}",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(NewProposal),
)
def edit(
    proposal_id: str,
    floor: Floor,
    user: Member,
    request: Annotated[NewProposal, Depends(json_body(NewProposal))],
) -> ProposalDetail:
    return floor.edit(user, proposals_service.parse_id(proposal_id), request)


@router.post(
    "/{proposal_id}/withdraw", response_model=ProposalDetail, response_model_exclude_none=True
)
def withdraw(proposal_id: str, floor: Floor, user: Member) -> ProposalDetail:
    return floor.withdraw(user, proposals_service.parse_id(proposal_id))


@router.post(
    "/{proposal_id}/second",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(SecondRequest),
)
def second(
    proposal_id: str,
    floor: Floor,
    user: Member,
    request: Annotated[SecondRequest, Depends(json_body(SecondRequest))],
) -> ProposalDetail:
    """Second the revision of the text the caller read (409 proposal_changed otherwise)."""
    return floor.second(user, proposals_service.parse_id(proposal_id), request.revision)


@router.post(
    "/{proposal_id}/consent",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(ConsentRequest),
)
def consent(
    proposal_id: str,
    floor: Floor,
    user: Member,
    request: Annotated[ConsentRequest, Depends(json_body(ConsentRequest))],
) -> ProposalDetail:
    return floor.consent(user, proposals_service.parse_id(proposal_id), request)


@router.get(
    "/{proposal_id}/comments",
    response_model=ProposalCommentPage,
    response_model_exclude_none=True,
)
def comments(proposal_id: str, floor: Floor, before: str | None = None) -> ProposalCommentPage:
    """Public: up to 100 comments older than comment `?before=` (the newest 100 without
    it), oldest first, and whether older ones exist."""
    return floor.comments(
        proposals_service.parse_id(proposal_id),
        proposals_service.parse_cursor(before, "before"),
    )


@router.post(
    "/{proposal_id}/comments",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(CommentRequest),
)
def comment(
    proposal_id: str,
    floor: Floor,
    user: Member,
    request: Annotated[CommentRequest, Depends(json_body(CommentRequest))],
) -> ProposalDetail:
    return floor.comment(user, proposals_service.parse_id(proposal_id), request)


@router.post(
    "/{proposal_id}/vote",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(VoteRequest),
)
def vote(
    proposal_id: str,
    floor: Floor,
    user: Member,
    request: Annotated[VoteRequest, Depends(json_body(VoteRequest))],
) -> ProposalDetail:
    return floor.vote(user, proposals_service.parse_id(proposal_id), request)


@router.post(
    "/{proposal_id}/admin/end-debate",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
)
def end_debate(proposal_id: str, floor: Floor, admin: AdminMember) -> ProposalDetail:
    return floor.end_debate(admin, proposals_service.parse_id(proposal_id))


@router.post(
    "/{proposal_id}/admin/close-vote",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
)
def close_vote(proposal_id: str, floor: Floor, admin: AdminMember) -> ProposalDetail:
    return floor.close_vote(admin, proposals_service.parse_id(proposal_id))


@router.put(
    "/{proposal_id}/admin/draft-task",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
    openapi_extra=body_doc(DraftTaskRequest),
)
def draft_task(
    proposal_id: str,
    floor: Floor,
    admin: AdminMember,
    request: Annotated[DraftTaskRequest, Depends(json_body(DraftTaskRequest))],
) -> ProposalDetail:
    return floor.put_draft(admin, proposals_service.parse_id(proposal_id), request)


@router.post(
    "/{proposal_id}/admin/publish-task",
    response_model=ProposalDetail,
    response_model_exclude_none=True,
)
def publish_task(proposal_id: str, floor: Floor, admin: AdminMember) -> ProposalDetail:
    return floor.publish(admin, proposals_service.parse_id(proposal_id))
