"""An admin's pitch: the operator's exception of 2026-10-10.

An admin (FORGE_ADMIN_IDS) may write a pitch of up to 50,000 characters, bringing a
proposal or editing it before it is seconded; everyone else stays at 4,000, refused exactly
as before (400 invalid_request naming `pitch`). Characters are counted as before (code
points, before cleaning) and the invisible-text rule is the same for both. The body caps
follow: 640 KB for an admin's proposal, 64 KB for everyone else's, as before. And what
reads a long pitch keeps it whole: the draft task's summary, and the house model's fence.
"""

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.models import PITCH_LIMIT_CONTEXT, PROPOSAL_LIMITS, NewProposal
from forge_api.routers.members import ADMIN_PROPOSAL_BODY, MAX_BODY
from forge_api.services import house
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError
from forge_api.services.house import FileList, ProposalText
from forge_api.services.identity import ADMIN_IDS_ENV, Identity

from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import ADMIN, ALICE, BOB, CAROL, DRAFT, TITLE, Floor, make_floor

MEMBER_MOST = PROPOSAL_LIMITS["pitch"]
ADMIN_MOST = PROPOSAL_LIMITS["adminPitch"]
ASTRAL = "\U0001f3db"
#: Today's refusal of a pitch over its limit, word for word.
OVER_LIMIT = {
    "error": "invalid_request",
    "message": "Check pitch and try again.",
    "fields": ["pitch"],
}


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    return make_floor(client, clock, auth_headers, monkeypatch)


def send(
    floor: Floor, method: str, path: str, who: Identity, body: bytes | dict[str, Any]
) -> httpx.Response:
    """A JSON body sent as these bytes; a dict is encoded with every non-ASCII character
    escaped, the largest a JSON encoder makes it (12 bytes an astral character)."""
    content = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {**floor.headers(who), "Content-Type": "application/json"}
    response: httpx.Response = floor.client.request(method, path, content=content, headers=headers)
    return response


def research_pitch(length: int) -> str:
    """A long pitch in paragraphs, exactly `length` characters, that the cleaners keep as it
    is (no space at either end of a line, one blank line between paragraphs)."""
    paragraph = "Why this research matters to FORGE." + " It says so plainly, in full." * 30
    text = "\n\n".join([paragraph] * (length // len(paragraph) + 1))[: length - 1].rstrip()
    return text + "." * (length - len(text))


# --- bringing a proposal ---------------------------------------------------------------


@pytest.mark.parametrize("char", ["y", ASTRAL])
def test_a_member_is_held_to_4000_characters_as_before(floor: Floor, char: str) -> None:
    response = floor.move(ALICE, TITLE, char * (MEMBER_MOST + 1))
    assert response.status_code == 400
    assert response.json() == OVER_LIMIT
    assert floor.get("/api/proposals").json()["proposals"] == []
    assert floor.move(ALICE, TITLE, char * MEMBER_MOST).status_code == 201


def test_a_members_long_pitch_is_named_beside_a_bad_title_as_before(floor: Floor) -> None:
    response = floor.move(ALICE, "t" * 101, "y" * (MEMBER_MOST + 1))
    assert response.status_code == 400
    assert response.json() == {
        "error": "invalid_request",
        "message": "Check pitch, title and try again.",
        "fields": ["pitch", "title"],
    }


@pytest.mark.parametrize("char", ["y", ASTRAL])
def test_an_admin_brings_a_pitch_of_50000_characters_whole(floor: Floor, char: str) -> None:
    pitch = char * ADMIN_MOST
    response = send(floor, "POST", "/api/proposals", ADMIN, {"title": TITLE, "pitch": pitch})
    assert response.status_code == 201, response.text
    proposal_id = response.json()["proposal"]["id"]
    assert response.json()["pitch"] == pitch
    assert floor.detail(proposal_id)["pitch"] == pitch  # the public record, whole


def test_an_admins_research_pitch_keeps_its_paragraphs(floor: Floor) -> None:
    pitch = research_pitch(34_990)
    assert len(pitch) == 34_990 and "\n\n" in pitch
    proposal_id = floor.moved(ADMIN, TITLE, pitch)
    assert floor.detail(proposal_id)["pitch"] == pitch


@pytest.mark.parametrize("char", ["y", ASTRAL])
def test_an_admin_is_held_to_50000_characters(floor: Floor, char: str) -> None:
    body = {"title": TITLE, "pitch": char * (ADMIN_MOST + 1)}
    response = send(floor, "POST", "/api/proposals", ADMIN, body)
    assert response.status_code == 400
    assert response.json() == OVER_LIMIT
    assert floor.get("/api/proposals").json()["proposals"] == []


def test_an_admins_pitch_still_has_to_show_something(floor: Floor) -> None:
    response = floor.move(ADMIN, TITLE, "​" * ADMIN_MOST)
    assert response.status_code == 400
    assert response.json() == {
        "error": "invalid_request",
        "message": "Write some text in pitch.",
        "fields": ["pitch"],
    }


def test_an_admins_pitch_is_counted_before_it_is_cleaned(floor: Floor) -> None:
    """As a member's always was: invisible characters count, then go."""
    response = floor.move(ADMIN, TITLE, "A pitch." + "​" * (ADMIN_MOST - 7))
    assert response.status_code == 400 and response.json() == OVER_LIMIT
    kept = floor.move(ADMIN, TITLE, "A pitch." + "​" * (ADMIN_MOST - 8))
    assert kept.status_code == 201, kept.text


# --- editing it before it is seconded --------------------------------------------------


def test_a_member_editing_is_held_to_4000_characters_as_before(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    response = floor.edit(proposal_id, ALICE, TITLE, "y" * (MEMBER_MOST + 1))
    assert response.status_code == 400 and response.json() == OVER_LIMIT
    assert floor.revision(proposal_id) == 1
    assert floor.edit(proposal_id, ALICE, TITLE, "y" * MEMBER_MOST).status_code == 200


def test_an_admin_edits_up_to_50000_characters_and_no_more(floor: Floor) -> None:
    proposal_id = floor.moved(ADMIN)
    path = f"/api/proposals/{proposal_id}"
    pitch = ASTRAL * ADMIN_MOST
    response = send(floor, "PATCH", path, ADMIN, {"title": TITLE, "pitch": pitch})
    assert response.status_code == 200, response.text
    assert response.json()["pitch"] == pitch and response.json()["revision"] == 2
    longer = send(floor, "PATCH", path, ADMIN, {"title": TITLE, "pitch": pitch + ASTRAL})
    assert longer.status_code == 400 and longer.json() == OVER_LIMIT
    assert floor.detail(proposal_id)["pitch"] == pitch
    assert floor.revision(proposal_id) == 2


def test_the_limit_is_the_callers_at_the_time(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off the admin list, an admin's own long proposal can only be edited down to 4,000."""
    proposal_id = floor.moved(ADMIN, TITLE, "y" * ADMIN_MOST)
    monkeypatch.setenv(ADMIN_IDS_ENV, "")
    response = floor.edit(proposal_id, ADMIN, TITLE, "z" * (MEMBER_MOST + 1))
    assert response.status_code == 400 and response.json() == OVER_LIMIT
    assert floor.edit(proposal_id, ADMIN, TITLE, "z" * MEMBER_MOST).status_code == 200


def test_the_service_holds_a_pitch_to_its_callers_limit_whatever_it_was_read_for(
    floor: Floor,
) -> None:
    """A request validated for an admin and handed to the service as someone else's is
    still refused: the service decides by who is asking."""
    request = NewProposal.model_validate(
        {"title": TITLE, "pitch": "y" * (MEMBER_MOST + 1)},
        context={PITCH_LIMIT_CONTEXT: ADMIN_MOST},
    )
    for act in (
        lambda: floor.floor().move(ALICE, request),
        lambda: floor.floor().edit(ALICE, floor.moved(ALICE), request),
    ):
        with pytest.raises(ApiError) as caught:
            act()
        assert (caught.value.status_code, caught.value.payload) == (400, OVER_LIMIT)
    assert proposals_service.pitch_limit(ALICE) == MEMBER_MOST
    assert proposals_service.pitch_limit(ADMIN) == ADMIN_MOST


# --- the body caps -----------------------------------------------------------------------


def test_an_admins_proposal_may_be_640_kb_and_no_more(floor: Floor) -> None:
    most = {"title": ASTRAL * PROPOSAL_LIMITS["title"], "pitch": ASTRAL * ADMIN_MOST}
    body = json.dumps(most).encode()  # 12 bytes a character: the most it can take
    assert MAX_BODY < len(body) <= ADMIN_PROPOSAL_BODY
    # From a member, the same body is refused at their cap, as before.
    member = send(floor, "POST", "/api/proposals", ALICE, body)
    assert member.status_code == 413
    assert member.json() == {"error": "body_too_large", "limit": MAX_BODY}
    response = send(floor, "POST", "/api/proposals", ADMIN, body)
    assert response.status_code == 201, response.text
    proposal_id = response.json()["proposal"]["id"]

    huge = b'{"title": "x", "pitch": "' + b"y" * ADMIN_PROPOSAL_BODY + b'"}'
    for method, path in (("POST", "/api/proposals"), ("PATCH", f"/api/proposals/{proposal_id}")):
        response = send(floor, method, path, ADMIN, huge)
        assert response.status_code == 413, method
        assert response.json() == {"error": "body_too_large", "limit": ADMIN_PROPOSAL_BODY}
    edit = send(floor, "PATCH", f"/api/proposals/{proposal_id}", ALICE, huge)
    assert edit.json() == {"error": "body_too_large", "limit": MAX_BODY}
    assert floor.detail(proposal_id)["pitch"] == most["pitch"]


def test_every_other_body_keeps_the_64_kb_cap_even_from_an_admin(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    big = b'{"text": "' + b"y" * (MAX_BODY + 1) + b'"}'
    response = send(floor, "POST", f"/api/proposals/{proposal_id}/comments", ADMIN, big)
    assert response.status_code == 413
    assert response.json() == {"error": "body_too_large", "limit": MAX_BODY}


def test_no_identity_is_401_before_any_body_is_read(floor: Floor) -> None:
    huge = b'{"title": "x", "pitch": "' + b"y" * ADMIN_PROPOSAL_BODY + b'"}'
    response = floor.client.post(
        "/api/proposals", content=huge, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 401
    assert response.json() == {"error": "unauthenticated"}


# --- what reads a long pitch -------------------------------------------------------------


def test_a_passed_admin_pitch_is_its_draft_summary_whole_until_an_admin_cuts_it(
    floor: Floor,
) -> None:
    """The draft task starts as the whole pitch on one line, never cut short; publishing
    refuses it until an admin has written a summary of 500 characters or fewer."""
    floor.hello(ADMIN, BOB, CAROL)
    pitch = research_pitch(34_990)
    proposal_id = floor.moved(ADMIN, TITLE, pitch)
    assert floor.second(proposal_id, BOB).status_code == 200
    floor.testing()
    assert floor.end_debate(proposal_id).status_code == 200
    assert floor.state(proposal_id) == "passed"

    summary = floor.detail(proposal_id, ADMIN)["draft"]["civilianSummary"]
    assert "\n" not in summary
    assert summary.split() == pitch.split()  # every word kept
    refused = floor.publish(proposal_id)
    assert refused.status_code == 400
    assert refused.json()["fields"] == ["acceptanceCriteria", "civilianSummary"]
    assert floor.state(proposal_id) == "passed"

    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    assert floor.publish(proposal_id).status_code == 200
    assert floor.state(proposal_id) == "building"


def test_the_house_fences_an_admins_whole_pitch_with_a_full_debate() -> None:
    """The most the floor can hand the house: a 50,000-character pitch of four-byte
    characters and 50 comments of 2,000 from logins of GitHub's longest (39), all inside
    one fence, with nothing cut and no too_large. ADR-007's amendment of 2026-10-10 gives
    this block's size, 604,032 bytes with a real fence's name, under the 640 KB cap."""
    pitch = ASTRAL * ADMIN_MOST
    comments = tuple(
        (f"member-{index % 10}".ljust(39, "x"), ASTRAL * PROPOSAL_LIMITS["comment"])
        for index in range(50)
    )
    proposal = ProposalText(
        title=ASTRAL * PROPOSAL_LIMITS["title"],
        pitch=pitch,
        comments=comments,
        comment_count=50,
    )
    fence = "proposal-" + "0" * 16  # as long as house.new_boundary()'s
    assert len(fence) == len(house.new_boundary())
    block = house.proposal_block(proposal, fence)
    assert len(block.encode()) == 604_032 < house.CONTEXT_CAP_BYTES == 640 * 1024
    lines = block.split("\n")
    assert lines[2:4] == [
        f"<{fence}>",
        json.dumps({"title": proposal.title}, ensure_ascii=False),
    ]
    assert json.loads(lines[4]) == {"pitch": pitch}
    assert lines[-1] == f"</{fence}>"
    assert len(lines) == 2 + 1 + 2 + 50 + 1
    message, _ = house.pick_message(block, FileList(("apps/web/src/app/page.tsx",), 1))
    assert block in message
    assert block in house.spec_message(block, ("# AGENTS.md", False), [])
