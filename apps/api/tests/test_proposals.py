"""The Propose floor over HTTP (Phase 5 contract §1, §3), as members use it: move, edit,
withdraw, second, consent or object, comment and vote; every refusal with its error code;
what `you` says in each state; public reads and their pages; the plain-text rules; the
limits; and the kill switch."""

from datetime import timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.models import ELIGIBLE_ACTIVITY_DAYS
from forge_api.services.identity import Identity
from forge_api.services.members import to_db
from forge_api.services.proposals import (
    EDIT_LIMIT,
    MAX_EDITS,
    clean_line,
    clean_paragraphs,
    has_visible_text,
)
from forge_api.services.state import Params, StateDB, WriteResult

from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import (
    ADMIN,
    ALICE,
    BOB,
    CAROL,
    DAVE,
    DRAFT,
    ERIN,
    PITCH,
    SECOND,
    TITLE,
    Floor,
    at,
    make_floor,
)


@pytest.fixture
def floor(
    client: TestClient,
    clock: FakeClock,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
) -> Floor:
    return make_floor(client, clock, auth_headers, monkeypatch)


def refused(response: httpx.Response, status: int, error: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    assert body["error"] == error, body
    assert isinstance(body.get("message"), str) and body["message"], body
    return body


# --- move -----------------------------------------------------------------------------


def test_a_member_moves_a_proposal(floor: Floor) -> None:
    response = floor.move(ALICE)
    assert response.status_code == 201, response.text
    detail = response.json()
    assert detail["proposal"] == {
        "id": 1,
        "title": TITLE,
        "state": "submitted",
        "mover": "octo-contributor",
        "movedAt": at(floor.now()),
        "deadline": at(floor.now() + timedelta(days=7)),
        "commentCount": 0,
        "objectionCount": 0,
    }
    assert detail["pitch"] == PITCH
    assert detail["comments"] == []
    assert detail["events"] == [
        {
            "at": at(floor.now()),
            "kind": "moved",
            "actor": "octo-contributor",
            "message": "octo-contributor brought this proposal. It needs a second from "
            "another member.",
        }
    ]
    assert detail["you"] == {
        "canEdit": True,
        "canWithdraw": True,
        "canSecond": False,
        "canConsent": False,
        "canComment": False,
        "canVote": False,
        "isAdmin": False,
    }
    assert not {"eligibleCount", "consentCount", "turnout", "tally", "draft", "taskId"} & set(
        detail
    )


def test_public_reads_need_no_identity_and_say_nothing_about_you(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    listing = floor.get("/api/proposals")
    assert listing.status_code == 200
    assert [card["id"] for card in listing.json()["proposals"]] == [proposal_id]
    detail = floor.detail(proposal_id)
    assert "you" not in detail and "draft" not in detail
    assert floor.detail(proposal_id, BOB)["you"]["canSecond"] is True


def test_a_bad_authorization_header_is_still_401_on_a_public_read(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    response = floor.client.get(
        f"/api/proposals/{proposal_id}", headers={"Authorization": "Bearer nope"}
    )
    assert response.status_code == 401
    assert response.json() == {"error": "unauthenticated"}


def test_the_list_is_newest_first_and_filters_by_state(floor: Floor) -> None:
    first = floor.moved(ALICE)
    second = floor.moved(BOB)
    assert floor.withdraw(first, ALICE).status_code == 200
    third = floor.moved(CAROL)
    listing = floor.get("/api/proposals").json()
    assert [card["id"] for card in listing["proposals"]] == [third, second, first]
    assert listing["testTimers"] is False
    submitted = floor.get("/api/proposals?state=submitted").json()["proposals"]
    assert [card["id"] for card in submitted] == [third, second]
    withdrawn = floor.get("/api/proposals?state=withdrawn").json()["proposals"]
    assert [card["id"] for card in withdrawn] == [first]
    body = refused(floor.get("/api/proposals?state=seconded"), 400, "invalid_request")
    assert body["fields"] == ["state"]


def test_one_active_proposal_per_member(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    body = refused(floor.move(ALICE, "Another idea", "Another pitch"), 409, "one_active_proposal")
    assert body["proposalId"] == proposal_id
    assert floor.get("/api/proposals/me", ALICE).json()["activeProposalId"] == proposal_id
    assert floor.withdraw(proposal_id, ALICE).status_code == 200
    assert floor.move(ALICE, "Another idea", "Another pitch").status_code == 201


def test_a_proposal_that_lapsed_frees_its_mover(floor: Floor) -> None:
    floor.moved(ALICE)
    floor.wait(timedelta(days=7))
    # The deadline is applied before the one-active rule is checked.
    assert floor.move(ALICE, "Second try", "A better pitch").status_code == 201


def test_three_proposals_a_day(floor: Floor) -> None:
    for number in range(3):
        proposal_id = floor.moved(ALICE, f"Idea {number}", "Pitch")
        assert floor.withdraw(proposal_id, ALICE).status_code == 200
        floor.wait(timedelta(hours=1))
    response = floor.move(ALICE, "Idea 4", "Pitch")
    body = refused(response, 429, "rate_limited")
    # The first of the three was moved 3 hours ago: 21 hours to go.
    assert response.headers["retry-after"] == str(21 * 3600)
    assert body["retryAfter"] == 21 * 3600 and body["limit"] == 3
    floor.wait(timedelta(hours=21) - SECOND)
    refused(floor.move(ALICE, "Idea 4", "Pitch"), 429, "rate_limited")
    floor.wait(SECOND)
    assert floor.move(ALICE, "Idea 4", "Pitch").status_code == 201
    assert floor.move(BOB, "Bob's idea", "Pitch").status_code == 201  # per member


def seed_decided(floor: Floor, count: int) -> list[int]:
    """`count` withdrawn proposals by other accounts, written straight to the table. Their
    numbers, oldest first."""
    db, stamp = floor.db(), to_db(floor.now())
    with db.transaction():
        for number in range(count):
            db.execute(
                "INSERT INTO proposal_motions (title, pitch, state, mover_sub, mover_login, "
                "moved_at, updated_at, decided_at) VALUES (?, 'p', 'withdrawn', ?, ?, ?, ?, ?)",
                (f"Filler {number}", str(7000 + number), f"filler-{number}", stamp, stamp, stamp),
            )
    rows = db.query_all("SELECT id FROM proposal_motions WHERE state = 'withdrawn' ORDER BY id")
    return [int(row["id"]) for row in rows]


def test_the_floor_lists_every_active_proposal_and_pages_the_decided_ones(floor: Floor) -> None:
    """Review L8 (the probe): the list was the newest 500 proposals of every state, so newer
    decided ones pushed an older proposal still waiting for a second off the floor. Now
    every active proposal is listed, with the newest 100 decided ones, and
    `?decidedBefore=` pages back through the rest."""
    waiting = floor.moved(ALICE)
    decided = seed_decided(floor, 250)
    in_debate = floor.seconded(BOB, CAROL)
    listing = floor.get("/api/proposals").json()
    assert [card["id"] for card in listing["proposals"]] == [
        in_debate,
        *reversed(decided[-100:]),
        waiting,
    ]
    assert listing["moreDecided"] is True
    second_page = floor.get(f"/api/proposals?decidedBefore={decided[-100]}").json()
    assert [card["id"] for card in second_page["proposals"]] == list(reversed(decided[-200:-100]))
    assert second_page["moreDecided"] is True
    last_page = floor.get(f"/api/proposals?decidedBefore={decided[-200]}").json()
    assert [card["id"] for card in last_page["proposals"]] == list(reversed(decided[:-200]))
    assert "moreDecided" not in last_page
    withdrawn = floor.get("/api/proposals?state=withdrawn").json()
    assert len(withdrawn["proposals"]) == 100 and withdrawn["moreDecided"] is True
    submitted = floor.get("/api/proposals?state=submitted").json()
    assert [card["id"] for card in submitted["proposals"]] == [waiting]
    assert "moreDecided" not in submitted
    # A page of decided proposals never repeats the active ones.
    later = floor.get(f"/api/proposals?state=debate&decidedBefore={decided[-1]}").json()
    assert later["proposals"] == []
    for raw in ("abc", "0", "-1", "1.5", "9" * 20):
        response = floor.get(f"/api/proposals?decidedBefore={raw}")
        assert refused(response, 400, "invalid_request")["fields"] == ["decidedBefore"]


# --- edit and withdraw ----------------------------------------------------------------


def test_the_mover_edits_until_the_second(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(minutes=1))
    response = floor.edit(proposal_id, ALICE, "Dark mode, please", "Shorter pitch.")
    assert response.status_code == 200, response.text
    detail = response.json()
    assert (detail["proposal"]["title"], detail["pitch"]) == ("Dark mode, please", "Shorter pitch.")
    assert detail["events"][-1]["kind"] == "edited"
    # The deadline stays where it was.
    moved_at = floor.now() - timedelta(minutes=1)
    assert detail["proposal"]["deadline"] == at(moved_at + timedelta(days=7))
    # The same text again changes nothing and adds no line.
    assert floor.edit(proposal_id, ALICE, "Dark mode, please", "Shorter pitch.").status_code == 200
    assert floor.kinds(proposal_id) == ["moved", "edited"]
    refused(floor.edit(proposal_id, BOB, "Hijacked", "Mine now"), 403, "not_mover")
    assert floor.second(proposal_id, BOB).status_code == 200
    body = refused(floor.edit(proposal_id, ALICE, "Too late", "Too late"), 409, "wrong_state")
    assert body["state"] == "debate"
    assert body["message"] == "That can't be done now: this proposal is in debate."


def test_edits_are_limited_to_ten_an_hour(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    for number in range(10):
        assert floor.edit(proposal_id, ALICE, f"Title {number}", PITCH).status_code == 200
    refused(floor.edit(proposal_id, ALICE, "Title 10", PITCH), 429, "rate_limited")
    floor.wait(timedelta(hours=1))
    assert floor.edit(proposal_id, ALICE, "Title 10", PITCH).status_code == 200


def test_a_proposal_takes_at_most_20_edits(floor: Floor) -> None:
    """Review L7: every edit is a line in the public timeline, and only the hourly limit
    bounded them, for the whole week before a second. A proposal now takes MAX_EDITS
    edits in all (409 edit_limit); each one adds 1 to its revision."""
    proposal_id = floor.moved(ALICE)
    assert floor.detail(proposal_id)["revision"] == 1
    for number in range(MAX_EDITS):
        if number and number % EDIT_LIMIT == 0:
            floor.wait(timedelta(hours=1))
        assert floor.edit(proposal_id, ALICE, f"Title {number}", PITCH).status_code == 200
    floor.wait(timedelta(hours=1))
    body = refused(floor.edit(proposal_id, ALICE, "One more", PITCH), 409, "edit_limit")
    assert body == {
        "error": "edit_limit",
        "message": "A proposal can be edited at most 20 times. Withdraw it and bring a new one "
        "if it needs more.",
        "limit": 20,
    }
    detail = floor.detail(proposal_id)
    assert (detail["proposal"]["title"], detail["revision"]) == ("Title 19", 21)
    assert floor.kinds(proposal_id).count("edited") == MAX_EDITS
    # The same text again is no edit: it is still answered, and the revision stays.
    assert floor.edit(proposal_id, ALICE, "Title 19", PITCH).json()["revision"] == 21


def test_withdraw_until_a_decision(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    submitted = floor.moved(ALICE)
    refused(floor.withdraw(submitted, BOB), 403, "not_mover")
    detail = floor.withdraw(submitted, ALICE).json()
    assert detail["proposal"]["state"] == "withdrawn" and "deadline" not in detail["proposal"]
    assert detail["you"]["canWithdraw"] is False
    assert detail["events"][-1] == {
        "at": at(floor.now()),
        "kind": "withdrawn",
        "actor": "octo-contributor",
        "message": "octo-contributor withdrew it.",
    }
    refused(floor.withdraw(submitted, ALICE), 409, "wrong_state")
    in_debate = floor.seconded(BOB, CAROL)
    assert floor.withdraw(in_debate, BOB).json()["proposal"]["state"] == "withdrawn"
    in_vote = floor.voting(CAROL, DAVE)
    assert floor.withdraw(in_vote, CAROL).json()["proposal"]["state"] == "withdrawn"
    decided = floor.passed(DAVE, ALICE)
    body = refused(floor.withdraw(decided, DAVE), 409, "wrong_state")
    assert body["state"] == "passed"


# --- second ---------------------------------------------------------------------------


def test_a_second_opens_debate_and_freezes_the_eligible_set(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE)
    floor.wait(timedelta(hours=2))
    response = floor.second(proposal_id, BOB)
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["proposal"]["state"] == "debate"
    assert detail["proposal"]["seconder"] == "other-dev"
    assert detail["proposal"]["deadline"] == at(floor.now() + timedelta(days=3))
    assert (detail["eligibleCount"], detail["consentCount"]) == (3, 1)  # the mover consents
    assert [event["kind"] for event in detail["events"]] == ["moved", "seconded", "consented"]
    assert detail["events"][1]["actor"] == "other-dev"
    assert detail["events"][2]["actor"] == "octo-contributor"
    assert detail["you"]["canConsent"] is True and detail["you"]["canSecond"] is False
    # Someone who turns up after the second can talk but not decide.
    floor.hello(DAVE)
    refused(floor.consent(proposal_id, DAVE), 409, "not_eligible")
    assert floor.comment(proposal_id, DAVE, "Late, but I like it.").status_code == 200
    late = floor.detail(proposal_id, DAVE)["you"]
    assert (late["canConsent"], late["canComment"], late["canVote"]) == (False, True, False)
    assert floor.detail(proposal_id)["eligibleCount"] == 3


def test_the_mover_and_seconder_are_always_eligible(floor: Floor) -> None:
    # Nobody said hello beforehand; moving and seconding record them anyway.
    proposal_id = floor.moved(ALICE)
    floor.db().execute("DELETE FROM members")
    assert floor.second(proposal_id, BOB).json()["eligibleCount"] == 2
    assert floor.detail_eligible(proposal_id) == [ALICE.sub, BOB.sub]


def test_the_mover_cannot_second(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    body = refused(floor.second(proposal_id, ALICE), 403, "own_proposal")
    assert body["message"] == "You can't second your own proposal: another member has to."


def test_a_second_is_tied_to_the_text_the_seconder_read(floor: Floor) -> None:
    """Review L3 (the probe): Bob opened "Add a dark mode", the mover rewrote it, and Bob's
    second landed on text he never saw. A second now names the revision it read, and an
    older one is 409 proposal_changed with the current revision."""
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE, "Add a dark mode", "Easier on the eyes at night.")
    seen = floor.detail(proposal_id, BOB)
    assert seen["revision"] == 1
    rewritten = floor.edit(
        proposal_id, ALICE, "Give admins a veto over every vote", "Admins can overrule any vote."
    )
    assert rewritten.json()["revision"] == 2
    response = floor.second(proposal_id, BOB, revision=seen["revision"])
    assert response.status_code == 409
    assert response.json() == {
        "error": "proposal_changed",
        "message": "The proposal changed since you opened it. Read it again, then second it.",
        "revision": 2,
    }
    assert floor.state(proposal_id) == "submitted"
    assert floor.kinds(proposal_id) == ["moved", "edited"]
    refused(floor.second(proposal_id, BOB, revision=3), 409, "proposal_changed")
    # Having read it again, Bob seconds what he read.
    assert floor.second(proposal_id, BOB, revision=2).json()["proposal"]["state"] == "debate"


@pytest.mark.parametrize(
    "body",
    [
        None,
        {},
        {"revision": "1"},
        {"revision": 1.0},
        {"revision": True},
        {"revision": 0},
        {"revision": -1},
        {"revision": None},
    ],
)
def test_a_second_names_the_revision_it_read(floor: Floor, body: Any) -> None:
    proposal_id = floor.moved(ALICE)
    response = floor.post(f"/api/proposals/{proposal_id}/second", BOB, body)
    assert refused(response, 400, "invalid_request")["fields"] == ["revision"]
    assert floor.state(proposal_id) == "submitted"


def test_the_eligible_set_is_the_members_active_in_the_last_30_days(floor: Floor) -> None:
    """Review M3 (the probe): everyone who ever signed in counted toward quorum forever, so
    11 accounts that looked once made one objection a veto: all 10 active members voted
    yes and it failed without quorum. The eligible set is now the members seen in the
    last ELIGIBLE_ACTIVITY_DAYS days, plus the mover and the seconder."""
    active = [Identity(str(2000 + number), f"active-{number}") for number in range(10)]
    dormant = [Identity(str(3000 + number), f"looked-once-{number}") for number in range(11)]
    floor.hello(*dormant)
    floor.wait(timedelta(days=ELIGIBLE_ACTIVITY_DAYS))
    floor.hello(*active)
    mover, seconder, objector = active[:3]
    proposal_id = floor.moved(mover)
    assert floor.second(proposal_id, seconder).json()["eligibleCount"] == 10
    assert floor.consent(proposal_id, objector, False).status_code == 200
    floor.wait(timedelta(days=3))
    refused(floor.vote(proposal_id, dormant[0], "no"), 409, "not_eligible")
    for who in active:
        assert floor.vote(proposal_id, who, "yes").status_code == 200
    floor.wait(timedelta(days=2))
    detail = floor.detail(proposal_id)
    assert detail["eligibleCount"] == 10
    assert detail["tally"] == {"yes": 10, "no": 0, "abstain": 0, "eligible": 10, "quorumMet": True}
    assert detail["proposal"]["state"] == "passed"


def test_the_activity_window_is_30_days_from_when_a_member_was_last_seen(floor: Floor) -> None:
    floor.hello(CAROL)
    floor.wait(timedelta(days=ELIGIBLE_ACTIVITY_DAYS) - SECOND)
    inside = floor.seconded(ALICE, BOB)
    assert floor.detail_eligible(inside) == [ALICE.sub, BOB.sub, CAROL.sub]
    seconded = floor.detail(inside)["events"][1]["message"]
    assert seconded == (
        "other-dev seconded it, so debate is open. The 3 members of the eligible set (those "
        "active in the last 30 days) can consent or object, and vote if it comes to that."
    )
    floor.wait(SECOND)  # Carol was last seen 30 days ago: out
    outside = floor.seconded(DAVE, ERIN)
    assert floor.detail_eligible(outside) == [ALICE.sub, BOB.sub, DAVE.sub, ERIN.sub]
    floor.hello(CAROL)  # back again: in again
    again = floor.seconded(ADMIN, ERIN)
    assert CAROL.sub in floor.detail_eligible(again)


def test_a_proposal_is_seconded_once(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    refused(floor.second(proposal_id, CAROL), 409, "already_seconded")
    lapsed = floor.moved(CAROL)
    floor.wait(timedelta(days=7))
    body = refused(floor.second(lapsed, DAVE), 409, "wrong_state")
    assert body["state"] == "lapsed"


# --- consent and objection ------------------------------------------------------------


def test_unanimous_consent_passes_at_once(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    detail = floor.consent(proposal_id, BOB).json()
    assert detail["proposal"]["state"] == "debate" and detail["consentCount"] == 2
    assert detail["you"]["consent"] == "consented" and detail["you"]["canConsent"] is False
    floor.wait(timedelta(hours=1))
    detail = floor.consent(proposal_id, CAROL).json()
    assert detail["proposal"]["state"] == "passed"
    assert detail["consentCount"] == 3 and "deadline" not in detail["proposal"]
    assert [event["kind"] for event in detail["events"]][-4:] == [
        "consented",
        "consented",
        "passed",
        "task_drafted",
    ]
    passed = detail["events"][-2]
    assert passed["at"] == at(floor.now())
    assert passed["message"] == (
        "Everyone in the eligible set consented, so it passed without a vote."
    )
    assert "tally" not in detail and "turnout" not in detail


def test_consent_by_silence(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.seconded(ALICE, BOB)
    assert floor.consent(proposal_id, CAROL).status_code == 200
    floor.wait(timedelta(days=3))
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "passed"
    assert detail["consentCount"] == 2 and detail["eligibleCount"] == 4
    assert "passed without a vote" in detail["events"][-2]["message"]


def test_an_objection_is_final(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    detail = floor.consent(proposal_id, CAROL, False).json()
    assert detail["proposal"]["objectionCount"] == 1
    assert detail["you"]["consent"] == "objected"
    assert detail["events"][-1]["message"] == (
        "carol-dev objected, so it goes to a vote when debate ends."
    )
    body = refused(floor.consent(proposal_id, CAROL, True), 409, "already_decided_consent")
    assert body["message"] == "You've already consented or objected, and that can't be changed."
    refused(floor.consent(proposal_id, CAROL, False), 409, "already_decided_consent")
    mover = refused(floor.consent(proposal_id, ALICE, False), 409, "already_decided_consent")
    assert mover["message"] == "You brought this proposal, so you already count as consenting."
    # Everyone else consenting no longer passes it: it goes to a vote at the deadline.
    assert floor.consent(proposal_id, BOB).json()["proposal"]["state"] == "debate"
    floor.wait(timedelta(days=3))
    assert floor.state(proposal_id) == "voting"


def test_consent_only_during_debate(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    submitted = floor.moved(ALICE)
    assert refused(floor.consent(submitted, BOB), 409, "wrong_state")["state"] == "submitted"
    voting = floor.voting(BOB, CAROL)
    assert refused(floor.consent(voting, ALICE), 409, "wrong_state")["state"] == "voting"


def test_consent_must_be_a_real_boolean(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.seconded(ALICE, BOB)
    for value in ("false", 0, None, "no"):
        body = refused(floor.consent(proposal_id, CAROL, value), 400, "invalid_request")
        assert body["fields"] == ["consent"], value
    assert floor.detail(proposal_id)["proposal"]["objectionCount"] == 0


# --- comments -------------------------------------------------------------------------


def test_comments_run_from_the_second_until_the_vote_closes(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE)
    assert refused(floor.comment(proposal_id, BOB, "Hi"), 409, "wrong_state")["state"] == (
        "submitted"
    )
    assert floor.second(proposal_id, BOB).status_code == 200
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    response = floor.comment(proposal_id, CAROL, "It's too much work.\r\n\r\n\r\nLet's vote.")
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["comments"] == [
        {
            "id": 1,
            "author": "carol-dev",
            "text": "It's too much work.\n\nLet's vote.",
            "at": at(floor.now()),
        }
    ]
    assert detail["proposal"]["commentCount"] == 1
    assert detail["events"][-1] == {
        "at": at(floor.now()),
        "kind": "commented",
        "actor": "carol-dev",
        "message": "carol-dev commented.",
    }
    floor.wait(timedelta(days=3))
    assert floor.comment(proposal_id, ERIN, "Anyone signed in can comment.").status_code == 200
    floor.wait(timedelta(days=2))
    assert floor.state(proposal_id) == "failed"
    refused(floor.comment(proposal_id, ALICE, "Too late"), 409, "wrong_state")
    texts = [comment["text"] for comment in floor.detail(proposal_id)["comments"]]
    assert texts == ["It's too much work.\n\nLet's vote.", "Anyone signed in can comment."]


def test_ten_comments_an_hour_per_member_per_proposal(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    for number in range(10):
        floor.wait(timedelta(minutes=1))
        assert floor.comment(proposal_id, BOB, f"Point {number}").status_code == 200
    response = floor.comment(proposal_id, BOB, "Point 10")
    body = refused(response, 429, "rate_limited")
    # The first of the ten was 9 minutes ago.
    assert response.headers["retry-after"] == str(51 * 60) and body["limit"] == 10
    assert floor.comment(proposal_id, ALICE, "Others still can.").status_code == 200
    floor.wait(timedelta(minutes=51))
    assert floor.comment(proposal_id, BOB, "Point 10").status_code == 200


def test_the_whole_debate_thread_stays_readable(floor: Floor) -> None:
    """Review M2 (the probe): a detail showed the newest 500 comments and nothing reached
    older ones, so one member posting inside the limit buried Carol's objection reason.
    The detail now shows the newest 100 and says there are more, and
    GET /api/proposals/{id}/comments?before= pages back to the first comment."""
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.seconded(ALICE, BOB)
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    reason = "I object: this would expose members' email addresses."
    assert floor.comment(proposal_id, CAROL, reason).status_code == 200
    db, stamp = floor.db(), to_db(floor.now())
    with db.transaction():  # Dave's flood, written straight to the table
        for number in range(250):
            db.execute(
                "INSERT INTO proposal_comments (proposal_id, author_sub, author_login, text, at) "
                "VALUES (?, ?, ?, ?, ?)",
                (proposal_id, DAVE.sub, DAVE.login, f"spam {number}", stamp),
            )
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["commentCount"] == 251
    assert len(detail["comments"]) == 100 and detail["moreComments"] is True
    assert detail["comments"][-1]["text"] == "spam 249"
    thread: list[dict[str, Any]] = detail["comments"]
    more = True
    while more:
        response = floor.comments_page(proposal_id, thread[0]["id"])
        assert response.status_code == 200, response.text
        page = response.json()
        assert 0 < len(page["comments"]) <= 100
        thread = page["comments"] + thread
        more = page["moreComments"]
    assert [comment["text"] for comment in thread] == [
        reason,
        *(f"spam {number}" for number in range(250)),
    ]
    assert thread[0]["author"] == "carol-dev"


def test_a_page_of_comments(floor: Floor) -> None:
    floor.hello(ALICE, BOB)
    proposal_id = floor.seconded(ALICE, BOB)
    assert floor.comments_page(proposal_id).json() == {"comments": [], "moreComments": False}
    for number in range(3):
        assert floor.comment(proposal_id, BOB, f"Point {number}").status_code == 200
    detail = floor.detail(proposal_id)
    assert "moreComments" not in detail
    newest = floor.comments_page(proposal_id).json()  # no cursor: the newest, as the detail
    assert newest == {"comments": detail["comments"], "moreComments": False}
    older = floor.comments_page(proposal_id, newest["comments"][-1]["id"]).json()
    assert [comment["text"] for comment in older["comments"]] == ["Point 0", "Point 1"]
    assert older["moreComments"] is False
    for raw in ("abc", "0", "-3", "1.5", "9" * 20):
        response = floor.get(f"/api/proposals/{proposal_id}/comments?before={raw}")
        assert refused(response, 400, "invalid_request")["fields"] == ["before"]
    refused(floor.comments_page(999), 404, "proposal_not_found")
    refused(floor.get("/api/proposals/abc/comments"), 404, "proposal_not_found")
    floor.flags(proposals=False)
    assert floor.comments_page(proposal_id).json() == {"error": "proposals-disabled"}


# --- the vote -------------------------------------------------------------------------


def test_votes_are_hidden_until_the_close_and_can_change(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.voting(ALICE, BOB)
    opened = floor.now()
    detail = floor.vote(proposal_id, ALICE, "yes").json()
    assert detail["turnout"] == 1 and "tally" not in detail
    assert detail["you"]["vote"] == "yes" and detail["you"]["canVote"] is True
    floor.wait(timedelta(hours=1))
    assert floor.vote(proposal_id, BOB, "no").status_code == 200
    floor.wait(timedelta(hours=1))
    detail = floor.vote(proposal_id, BOB, "yes").json()  # changed
    assert detail["turnout"] == 2 and detail["you"]["vote"] == "yes"
    assert floor.vote(proposal_id, CAROL, "abstain").status_code == 200
    public = floor.detail(proposal_id)
    assert public["turnout"] == 3 and "tally" not in public
    assert "voted" not in [event["kind"] for event in public["events"]]
    assert floor.detail(proposal_id, CAROL)["you"]["vote"] == "abstain"
    floor.wait(timedelta(days=2) - timedelta(hours=2))
    closed = floor.detail(proposal_id)
    assert closed["proposal"]["state"] == "passed"
    assert closed["tally"] == {"yes": 2, "no": 0, "abstain": 1, "eligible": 3, "quorumMet": True}
    assert "turnout" not in closed
    ballots = [event for event in closed["events"] if event["kind"] == "voted"]
    assert [(event["actor"], event["message"], event["at"]) for event in ballots] == [
        ("octo-contributor", "octo-contributor voted yes.", at(opened)),
        ("other-dev", "other-dev voted yes.", at(opened + timedelta(hours=2))),  # changed
        ("carol-dev", "carol-dev voted abstain.", at(opened + timedelta(hours=2))),
    ]
    kinds = [event["kind"] for event in closed["events"]]
    assert kinds[-6:] == ["voted", "voted", "voted", "vote_closed", "passed", "task_drafted"]
    assert closed["events"][-3]["message"] == (
        "The vote closed: 2 yes, 0 no, 1 abstain. 3 of 3 voted, so the quorum was met."
    )
    refused(floor.vote(proposal_id, ALICE, "no"), 409, "wrong_state")
    assert floor.detail(proposal_id, BOB)["you"]["vote"] == "yes"


def test_a_tie_fails(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.voting(ALICE, BOB)
    for who, choice in ((ALICE, "yes"), (BOB, "no"), (CAROL, "yes"), (DAVE, "no")):
        assert floor.vote(proposal_id, who, choice).status_code == 200
    floor.wait(timedelta(days=2))
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "failed"
    assert detail["tally"] == {"yes": 2, "no": 2, "abstain": 0, "eligible": 4, "quorumMet": True}
    assert detail["events"][-1]["message"] == "It failed: it needed more yes votes than no."


def test_quorum_missed_fails(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE, ERIN)
    proposal_id = floor.voting(ALICE, BOB)
    for who in (ALICE, CAROL):
        assert floor.vote(proposal_id, who, "yes").status_code == 200
    floor.wait(timedelta(days=2))
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "failed"
    assert detail["tally"] == {"yes": 2, "no": 0, "abstain": 0, "eligible": 5, "quorumMet": False}
    assert "no quorum" in detail["events"][-1]["message"]


def test_quorum_met_with_abstentions(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE, ERIN)
    proposal_id = floor.voting(ALICE, BOB)
    for who, choice in ((ALICE, "yes"), (CAROL, "abstain"), (DAVE, "abstain")):
        assert floor.vote(proposal_id, who, choice).status_code == 200
    floor.wait(timedelta(days=2))
    detail = floor.detail(proposal_id)
    assert detail["proposal"]["state"] == "passed"
    assert detail["tally"]["quorumMet"] is True


def test_only_the_eligible_set_votes(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.voting(ALICE, BOB)
    floor.hello(DAVE)
    refused(floor.vote(proposal_id, DAVE, "yes"), 409, "not_eligible")
    body = refused(floor.vote(proposal_id, CAROL, "maybe"), 400, "invalid_request")
    assert body["fields"] == ["choice"]
    in_debate = floor.seconded(CAROL, ALICE)
    assert refused(floor.vote(in_debate, BOB, "yes"), 409, "wrong_state")["state"] == "debate"


# --- write limits and the fan-out ------------------------------------------------------


def test_writes_are_limited_to_60_an_hour_across_the_floor(floor: Floor) -> None:
    """Review L9: changing a vote had no limit at all. Seconding, consenting or objecting,
    voting, editing and withdrawing now count toward WRITE_LIMIT an hour per member, across
    every proposal (429 rate_limited with Retry-After)."""
    floor.hello(ALICE, BOB, CAROL, DAVE)
    vote_on = floor.voting(ALICE, CAROL)
    own = floor.moved(BOB)
    for number in range(56):
        assert floor.vote(vote_on, BOB, ("yes", "no")[number % 2]).status_code == 200
    assert floor.edit(own, BOB, "A new title", PITCH).status_code == 200
    assert floor.withdraw(own, BOB).status_code == 200
    theirs = floor.moved(CAROL)
    assert floor.second(theirs, BOB).status_code == 200
    assert floor.consent(theirs, BOB).status_code == 200  # the 60th
    response = floor.vote(vote_on, BOB, "abstain")
    body = refused(response, 429, "rate_limited")
    assert body["limit"] == 60 and body["retryAfter"] == 3600
    assert response.headers["retry-after"] == "3600"
    assert body["message"] == (
        "You can second, consent, object, vote, edit or withdraw at most 60 times an hour. "
        "Try again later."
    )
    assert floor.detail(vote_on, BOB)["you"]["vote"] == "no"
    refused(floor.consent(floor.seconded(DAVE, ALICE), BOB, False), 429, "rate_limited")
    assert floor.vote(vote_on, ALICE, "yes").status_code == 200  # others aren't held back
    floor.wait(timedelta(hours=1))
    assert floor.vote(vote_on, BOB, "abstain").status_code == 200
    stale = floor.db().query_one(
        "SELECT COUNT(*) AS n FROM proposal_writes WHERE sub = ?", (BOB.sub,)
    )
    assert stale == {"n": 1}  # older writes are forgotten as new ones come


def test_a_fan_out_is_one_batch_not_statements_per_member(
    floor: Floor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review L9: a move wrote two statements per member (a notification and a trim), and
    a second one more (its eligible row), all under the process-wide database lock. Each
    is now one executemany."""
    db, stamp = floor.db(), to_db(floor.now())
    with db.transaction():
        db.executemany(
            "INSERT INTO members (sub, login, first_seen, last_seen) VALUES (?, ?, ?, ?)",
            [(str(5_000_000 + number), f"member-{number}", stamp, stamp) for number in range(1000)],
        )
    statements = {"execute": 0, "executemany": 0}
    execute, executemany = StateDB.execute, StateDB.executemany

    def counted_execute(self: StateDB, sql: str, params: Params = ()) -> WriteResult:
        statements["execute"] += 1
        return execute(self, sql, params)

    def counted_executemany(self: StateDB, sql: str, rows: Any) -> WriteResult:
        statements["executemany"] += 1
        return executemany(self, sql, rows)

    monkeypatch.setattr(StateDB, "execute", counted_execute)
    monkeypatch.setattr(StateDB, "executemany", counted_executemany)
    proposal_id = floor.moved(ALICE)
    assert statements["execute"] < 20 and statements["executemany"] == 2
    statements.update(execute=0, executemany=0)
    assert floor.second(proposal_id, BOB).status_code == 200
    assert statements["execute"] < 30 and statements["executemany"] == 5
    assert floor.detail(proposal_id)["eligibleCount"] == 1002
    # Everyone but Bob, who seconded it himself, heard about it.
    notified = db.query_one("SELECT COUNT(DISTINCT sub) AS n FROM notifications")
    assert notified == {"n": 1001}


# --- what `you` says, and /me ---------------------------------------------------------


def test_you_follows_the_state(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE)

    keys = ("canEdit", "canWithdraw", "canSecond", "canConsent", "canComment", "canVote")

    def you(who: Any) -> tuple[bool, ...]:
        mine = floor.detail(proposal_id, who)["you"]
        return tuple(mine[key] for key in keys)

    assert you(ALICE) == (True, True, False, False, False, False)
    assert you(BOB) == (False, False, True, False, False, False)
    assert floor.second(proposal_id, BOB).status_code == 200
    assert you(ALICE) == (False, True, False, False, True, False)
    assert you(CAROL) == (False, False, False, True, True, False)
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    assert you(BOB) == (False, False, False, True, True, False)
    floor.wait(timedelta(days=3))
    assert you(ALICE) == (False, True, False, False, True, True)
    assert you(BOB) == (False, False, False, False, True, True)
    floor.wait(timedelta(days=2))
    assert you(ALICE) == (False, False, False, False, False, False)
    assert floor.detail(proposal_id, ALICE)["you"]["consent"] == "consented"
    assert floor.detail(proposal_id, ADMIN)["you"]["isAdmin"] is True


def test_me(floor: Floor) -> None:
    me = floor.get("/api/proposals/me", ALICE).json()
    assert me == {"isAdmin": False, "testTimers": False}
    proposal_id = floor.moved(ALICE)
    assert floor.get("/api/proposals/me", ALICE).json()["activeProposalId"] == proposal_id
    assert floor.get("/api/proposals/me", ADMIN).json() == {"isAdmin": True, "testTimers": False}
    floor.wait(timedelta(days=7))
    assert "activeProposalId" not in floor.get("/api/proposals/me", ALICE).json()
    assert floor.test_timers(True).status_code == 200
    assert floor.get("/api/proposals/me", ALICE).json()["testTimers"] is True


# --- plain text -----------------------------------------------------------------------


def test_titles_and_pitches_are_stored_as_plain_text(floor: Floor) -> None:
    title = "  Dark‮ mode\nfor​ the️ Data apṕ́́́  "
    pitch = "\r\n\nLine one Line two\x00\x1b[31m\n\n\n\n  Line three  \t\n\n"
    detail = floor.move(ALICE, title, pitch).json()
    assert detail["proposal"]["title"] == "Dark mode for the Data apṕ́"
    assert detail["pitch"] == "Line one\nLine two[31m\n\nLine three"


def test_text_blank_once_sanitized_is_refused(floor: Floor) -> None:
    body = refused(floor.move(ALICE, "​‮  ", "\n\t\n"), 400, "invalid_request")
    assert body["fields"] == ["pitch", "title"]
    assert body["message"] == "Write some text in pitch, title."
    proposal_id = floor.seconded(ALICE, BOB)
    assert refused(floor.comment(proposal_id, BOB, "⁦⁩"), 400, "invalid_request")["fields"] == [
        "text"
    ]
    refused(floor.edit(proposal_id, ALICE, " ", "x"), 400, "invalid_request")


@pytest.mark.parametrize(
    "blank",
    [
        "\u3164",  # HANGUL FILLER
        "\u2800\u2800",  # BRAILLE PATTERN BLANK
        "\u115f\u1160",  # HANGUL CHOSEONG and JUNGSEONG FILLER
        "\uffa0",  # HALFWIDTH HANGUL FILLER
        "\u3164 \u3164",
        "\u200b\u3164\u2060",  # zero-width characters around a filler
        "\u17b4\u17b5",  # KHMER VOWEL INHERENT AQ and AA
        "\u0301\u0302",  # combining marks with nothing to sit on
        "\ufe0f\u3000\u3164",  # a variation selector, an ideographic space and a filler
    ],
)
def test_text_that_shows_nothing_is_refused(floor: Floor, blank: str) -> None:
    """Review L6 (the probe): a title and pitch of Hangul fillers or blank Braille patterns
    were accepted (201), listing an invisible proposal under the mover's name. Text with
    no visible character is now refused, as blank text always was."""
    body = refused(floor.move(ALICE, blank, blank), 400, "invalid_request")
    assert body["fields"] == ["pitch", "title"]
    assert floor.get("/api/proposals").json()["proposals"] == []


def test_invisible_text_is_refused_wherever_members_write(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE)
    response = floor.edit(proposal_id, ALICE, "\u3164", PITCH)
    assert refused(response, 400, "invalid_request")["fields"] == ["title"]
    assert floor.second(proposal_id, BOB).status_code == 200
    response = floor.comment(proposal_id, BOB, "\u2800\n\u3164")
    assert refused(response, 400, "invalid_request")["fields"] == ["text"]
    passed = floor.passed(CAROL, BOB)
    draft = {**DRAFT, "civilianSummary": "\uffa0", "acceptanceCriteria": ["Works", "\u115f"]}
    body = refused(floor.put_draft(passed, draft), 400, "invalid_request")
    assert body["fields"] == ["acceptanceCriteria.1", "civilianSummary"]
    # One visible character is enough; the text is kept as written.
    kept = floor.move(DAVE, "\u3164Dark mode", "\u2800A pitch.").json()
    assert (kept["proposal"]["title"], kept["pitch"]) == ("\u3164Dark mode", "\u2800A pitch.")


def test_what_shows_and_what_does_not() -> None:
    for text in ("a", "\u3164a", "e\u0301", "\u0915", "\U0001f600", "\u2801", "1"):
        assert has_visible_text(text), ascii(text)
    for text in (
        "",
        " \t\n",
        "\u00a0\u2007\u3000",  # spaces
        "\u200b\u200c\u200d\u2060\ufeff\u180e",  # zero-width
        "\u202e\u2066",  # bidi controls
        "\ue000",  # private use
        "\U000e0041",  # a tag character
        "\u0378",  # unassigned
    ):
        assert not has_visible_text(text), ascii(text)


def test_the_cleaners_keep_lines_only_where_they_belong() -> None:
    assert clean_line("a\nb\r\nc", 100) == "a b c"
    assert clean_line("x" * 120, 100) == "x" * 100
    assert clean_paragraphs("a\n\n\n\nb\n", 100) == "a\n\nb"
    assert clean_paragraphs("  a  \n  b", 100) == "a\nb"
    assert clean_paragraphs("abc\ndef", 5) == "abc\nd"
    assert clean_paragraphs("abc\n\ndef", 4) == "abc"
    assert clean_paragraphs("", 10) == ""


# --- bodies, ids and identity ---------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({}, ["pitch", "title"]),
        ({"title": "x"}, ["pitch"]),
        ({"title": "", "pitch": "y"}, ["title"]),
        ({"title": "x" * 101, "pitch": "y"}, ["title"]),
        ({"title": "\U0001f3db" * 100, "pitch": "y" * 4001}, ["pitch"]),
        ({"title": 5, "pitch": "y"}, ["title"]),
        ({"title": None, "pitch": None}, ["pitch", "title"]),
    ],
)
def test_invalid_bodies_name_their_fields(
    floor: Floor, body: dict[str, Any], fields: list[str]
) -> None:
    response = floor.post("/api/proposals", ALICE, body)
    assert refused(response, 400, "invalid_request")["fields"] == fields
    assert "input" not in response.text


def test_bodies_that_are_not_json_objects(floor: Floor) -> None:
    headers = {**floor.headers(ALICE), "Content-Type": "application/json"}
    for raw in (b"not json", b"[1, 2]", b'"title"', b"\xff\xfe", b"[" * 40 + b"]" * 40):
        response = floor.client.post("/api/proposals", content=raw, headers=headers)
        assert refused(response, 400, "invalid_request")["fields"] == ["body"], raw
    huge = b'{"title": "x", "pitch": "' + b"y" * (70 * 1024) + b'"}'
    response = floor.client.post("/api/proposals", content=huge, headers=headers)
    assert response.status_code == 413
    assert response.json() == {"error": "body_too_large", "limit": 64 * 1024}
    assert floor.get("/api/proposals").json()["proposals"] == []


@pytest.mark.parametrize("raw", ["abc", "0", "-1", "1e3", "007", "99", "9" * 20, "1.5"])
def test_a_proposal_number_that_is_not_one_is_not_found(floor: Floor, raw: str) -> None:
    floor.moved(ALICE)
    for response in (
        floor.get(f"/api/proposals/{raw}"),
        floor.second(raw, BOB),  # type: ignore[arg-type]
    ):
        refused(response, 404, "proposal_not_found")


def test_every_write_needs_an_identity(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    writes = [
        floor.client.get("/api/proposals/me"),
        floor.client.post("/api/proposals", json={"title": "x", "pitch": "y"}),
        floor.client.patch(f"/api/proposals/{proposal_id}", json={"title": "x", "pitch": "y"}),
        floor.client.post(f"/api/proposals/{proposal_id}/withdraw"),
        floor.client.post(f"/api/proposals/{proposal_id}/second"),
        floor.client.post(f"/api/proposals/{proposal_id}/consent", json={"consent": True}),
        floor.client.post(f"/api/proposals/{proposal_id}/comments", json={"text": "x"}),
        floor.client.post(f"/api/proposals/{proposal_id}/vote", json={"choice": "yes"}),
    ]
    for response in writes:
        assert response.status_code == 401, response.request.url
        assert response.json() == {"error": "unauthenticated"}


def test_signin_off_means_nobody_can_act(floor: Floor) -> None:
    proposal_id = floor.moved(ALICE)
    floor.flags(github_signin=False, proposals=True)
    assert floor.second(proposal_id, BOB).status_code == 401
    assert floor.get(f"/api/proposals/{proposal_id}").status_code == 200


# --- the kill switch ------------------------------------------------------------------


def test_the_flag_off_answers_404_everywhere(floor: Floor) -> None:
    proposal_id = floor.seconded(ALICE, BOB)
    floor.flags(proposals=False)
    disabled = {"error": "proposals-disabled"}
    base = f"/api/proposals/{proposal_id}"
    responses = [
        floor.get("/api/proposals"),
        floor.get("/api/proposals/me", ALICE),
        floor.get(base),
        floor.get(base, ALICE),
        floor.move(CAROL),
        floor.edit(proposal_id, ALICE, "x", "y"),
        floor.withdraw(proposal_id, ALICE),
        floor.second(proposal_id, CAROL),
        floor.consent(proposal_id, CAROL),
        floor.comment(proposal_id, CAROL, "x"),
        floor.vote(proposal_id, CAROL, "yes"),
        floor.client.post(f"{base}/second"),  # no identity: still 404, not 401
        floor.test_timers(True),
        floor.end_debate(proposal_id),
        floor.close_vote(proposal_id),
        floor.put_draft(proposal_id, {}),
        floor.publish(proposal_id),
    ]
    for response in responses:
        assert response.status_code == 404, (response.request.url, response.text)
        assert response.json() == disabled
    floor.flags(proposals=True)
    assert floor.state(proposal_id) == "debate"
