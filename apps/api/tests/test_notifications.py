"""The in-app bell (Phase 5 contract §3): who hears about what as a proposal moves, the
newest 30 and the unread count, marking read, the 200-per-member cap, and the proposal
kinds hidden while the `proposals` flag is off."""

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.services import notifications as notifications_service
from forge_api.services.notifications import MAX_KEPT, SHOWN, notify
from forge_api.services.proposals import NOTIFICATION_TITLE_CHARS, _quoted

from .conftest import AuthHeaders, FakeClock
from .proposal_helpers import (
    ADMIN,
    ALICE,
    BOB,
    CAROL,
    DAVE,
    DRAFT,
    ERIN,
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


def read(floor: Floor, who: Any, body: Any = None) -> Any:
    response = floor.post("/api/notifications/read", who, body)
    assert response.status_code == 200, response.text
    return response.json()


def test_fan_out_follows_the_proposal(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    proposal_id = floor.moved(ALICE)
    assert floor.bell_kinds(ALICE) == []
    assert floor.bell_kinds(BOB) == ["proposal_moved"]
    assert floor.second(proposal_id, BOB).status_code == 200
    assert floor.consent(proposal_id, CAROL, False).status_code == 200
    assert floor.comment(proposal_id, DAVE, "I'd use it.").status_code == 200
    floor.wait(timedelta(days=3))
    floor.tick()
    floor.hello(ERIN)  # too late for this one
    for who, choice in ((ALICE, "yes"), (BOB, "yes"), (CAROL, "no")):
        assert floor.vote(proposal_id, who, choice).status_code == 200
    floor.wait(timedelta(days=2))
    floor.tick()
    assert floor.put_draft(proposal_id, DRAFT).status_code == 200
    assert floor.publish(proposal_id).status_code == 200

    ended = ["task_published", "proposal_passed", "vote_opened"]
    assert floor.bell_kinds(ALICE) == [*ended, "your_proposal_seconded"]
    assert floor.bell_kinds(BOB) == [*ended, "proposal_moved"]  # seconding was his own act
    assert floor.bell_kinds(CAROL) == [*ended, "proposal_seconded", "proposal_moved"]
    assert floor.bell_kinds(DAVE) == [*ended, "proposal_seconded", "proposal_moved"]
    assert floor.bell_kinds(ERIN) == []
    assert floor.bell_kinds(ADMIN) == []  # an admin acting is not taking part


def test_each_notification_reads_plainly_and_links_to_the_proposal(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    proposal_id = floor.moved(ALICE)
    moved_at = floor.now()
    floor.wait(timedelta(minutes=3))
    assert floor.second(proposal_id, BOB).status_code == 200
    href = f"/propose/{proposal_id}"
    carol = floor.bell(CAROL)
    assert carol["unread"] == 2
    assert [
        {key: item[key] for key in ("kind", "message", "href", "at", "read")}
        for item in carol["notifications"]
    ] == [
        {
            "kind": "proposal_seconded",
            "message": f"other-dev seconded “{TITLE}”. Debate is open: consent, object or comment.",
            "href": href,
            "at": at(floor.now()),
            "read": False,
        },
        {
            "kind": "proposal_moved",
            "message": f"octo-contributor brought a new proposal, “{TITLE}”. It needs a second.",
            "href": href,
            "at": at(moved_at),
            "read": False,
        },
    ]
    assert floor.bell(ALICE)["notifications"][0]["message"] == (
        f"other-dev seconded your proposal “{TITLE}”. Debate is open."
    )


def test_a_title_cannot_write_the_rest_of_its_notification(floor: Floor) -> None:
    """Review L5 (the probe): a title that closed the quote wrote the rest of the sentence
    itself, so every member's bell showed a "Voting is open" message FORGE never wrote.
    A notification now quotes a title with its own double quotation marks made single."""
    floor.hello(ALICE, BOB, CAROL)
    spoof = "Tidy”. Voting is open on “Give the treasury to ALICE”. Cast your vote now"
    assert floor.move(ALICE, spoof).status_code == 201
    message = floor.bell(CAROL)["notifications"][0]["message"]
    assert message == (
        "octo-contributor brought a new proposal, “Tidy’. Voting is open on ‘Give the "
        "treasury to ALICE’. Cast your vote now”. It needs a second."
    )
    assert (message.count("“"), message.count("”")) == (1, 1)
    assert floor.detail(1)["proposal"]["title"] == spoof  # the title itself is as written


def test_a_notification_quotes_at_most_80_characters_of_a_title(floor: Floor) -> None:
    floor.hello(ALICE, BOB)
    title = "A" * 50 + " " + "b" * 49  # 100 characters
    floor.moved(ALICE, title)
    message = floor.bell(BOB)["notifications"][0]["message"]
    quoted = message.split("“", 1)[1].split("”", 1)[0]
    assert quoted == title[:79] + "…" and len(quoted) == NOTIFICATION_TITLE_CHARS


def test_every_kind_of_double_quotation_mark_is_made_single() -> None:
    assert _quoted('a "b" «c» „d“ ″e″ ＂f＂ ❝g❞ 〝h〞') == "“a 'b' ‹c› ‚d‘ ′e′ 'f' ‘g’ ‘h’”"
    assert _quoted("It's ‘fine’") == "“It's ‘fine’”"
    assert _quoted("x" * 80) == "“" + "x" * 80 + "”"
    assert _quoted("word " * 20) == "“" + ("word " * 16).rstrip() + "…”"


def test_a_lapse_tells_the_mover_and_a_failure_tells_everyone_involved(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL, DAVE)
    lapsing = floor.moved(DAVE)
    failing = floor.voting(ALICE, BOB)
    floor.wait(timedelta(days=7))
    floor.tick()
    assert floor.state(lapsing) == "lapsed" and floor.state(failing) == "failed"
    assert floor.bell_kinds(DAVE)[0] == "proposal_lapsed"
    assert floor.bell(DAVE)["notifications"][0]["message"] == (
        f"“{TITLE}” lapsed: nobody seconded it in time."
    )
    for who in (ALICE, BOB):  # the mover; the seconder, who objected
        assert floor.bell_kinds(who)[0] == "proposal_failed"
    assert "proposal_failed" not in floor.bell_kinds(CAROL)  # took no part
    assert "proposal_lapsed" not in floor.bell_kinds(ALICE)


def test_marking_read(floor: Floor) -> None:
    floor.hello(ALICE, BOB, CAROL)
    for mover in (ALICE, CAROL):
        floor.moved(mover)
    mine = floor.bell(BOB)
    assert mine["unread"] == 2
    newest, oldest = (item["id"] for item in mine["notifications"])
    theirs = floor.bell(CAROL)["notifications"][0]["id"]
    after = read(floor, BOB, {"ids": [oldest, theirs, 999_999, -5, 2**70]})
    assert after["unread"] == 1
    assert [item["read"] for item in after["notifications"]] == [False, True]
    assert floor.bell(CAROL)["unread"] == 1  # someone else's id is ignored
    assert read(floor, BOB, {"ids": []})["unread"] == 1
    assert read(floor, BOB)["unread"] == 0  # no body: every one
    assert all(item["read"] for item in floor.bell(BOB)["notifications"])
    assert read(floor, CAROL, {"ids": None})["unread"] == 0  # null reads as absent
    assert newest != oldest


def test_the_read_body_is_validated(floor: Floor) -> None:
    for body, fields in (({"ids": "all"}, ["ids"]), ({"ids": [1, "two"]}, ["ids.1"])):
        response = floor.post("/api/notifications/read", ALICE, body)
        assert response.status_code == 400 and response.json()["fields"] == fields
    response = floor.client.post(
        "/api/notifications/read",
        content=b"{",
        headers={**floor.headers(ALICE), "Content-Type": "application/json"},
    )
    assert response.status_code == 400 and response.json()["fields"] == ["body"]


def test_each_member_keeps_the_newest_200_and_sees_30(floor: Floor) -> None:
    db = floor.db()
    for number in range(MAX_KEPT + 5):
        notify(db, [ALICE.sub], "proposal_moved", f"Number {number}", "/propose/1", floor.now())
    notify(db, [BOB.sub, BOB.sub], "proposal_moved", "Once", "/propose/1", floor.now())
    kept = db.query_all("SELECT message FROM notifications WHERE sub = ? ORDER BY id", (ALICE.sub,))
    assert len(kept) == MAX_KEPT and kept[0]["message"] == "Number 5"
    bell = floor.bell(ALICE)
    assert bell["unread"] == MAX_KEPT and len(bell["notifications"]) == SHOWN
    assert bell["notifications"][0]["message"] == f"Number {MAX_KEPT + 4}"
    assert floor.bell(BOB)["unread"] == 1  # duplicates in one fan-out count once


def test_proposal_kinds_are_hidden_while_proposals_are_off(floor: Floor) -> None:
    floor.hello(ALICE, BOB)
    floor.moved(ALICE)
    floor.flags(proposals=False)
    assert notifications_service.visible_kinds() == ()
    assert floor.bell(BOB) == {"notifications": [], "unread": 0}
    assert read(floor, BOB) == {"notifications": [], "unread": 0}
    floor.flags(proposals=True)
    bell = floor.bell(BOB)
    assert bell["unread"] == 1 and bell["notifications"][0]["read"] is False


def test_the_bell_needs_an_identity(floor: Floor) -> None:
    for response in (
        floor.client.get("/api/notifications"),
        floor.client.post("/api/notifications/read", json={}),
    ):
        assert response.status_code == 401 and response.json() == {"error": "unauthenticated"}
