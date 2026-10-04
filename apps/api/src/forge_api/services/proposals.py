"""Proposals: the Propose floor (Phase 5 contract §1, §3), behind the `proposals` flag.

A member moves a proposal (a title and a plain-English pitch). Another member seconds the
revision they read, which opens debate and freezes the eligible set: every member FORGE has
seen in the last ELIGIBLE_ACTIVITY_DAYS days (services/members.py), the mover and the
seconder always among them. Debate passes it by unanimous consent (the mover counts as
consenting), or by silence when its deadline comes with no objection; one objection sends
it to a vote of the eligible set instead. A passed proposal becomes a draft task, which an
admin finishes and publishes to the Contribute board; when the Bridge records that task's
pull request as merged, it has shipped.

    submitted --second--> debate --everyone consents-------------------> passed
        |                   |----deadline, no objection----------------> passed
        |                   '----deadline, an objection--> voting --close--> passed / failed
        |--nobody seconds in time--> lapsed
        '--the mover withdraws (submitted, debate or voting)--> withdrawn
    passed --an admin publishes the draft task--> building --its pull request merges--> shipped

At the close, quorum is a majority of the eligible set casting a ballot (Abstain counts);
with quorum it passes if Yes > No, and otherwise, or without quorum, it fails.

`advance(proposal, now)` is the pure part: from a snapshot it works out every transition
due at `now` (each deadline that has passed, and the unanimous-consent pass). It runs on
every read and write of a proposal and in the API's 60-second ticker (`advance_all`, from
main.py's lifespan). Each result is persisted in one transaction that re-reads the
proposal and compare-and-sets its state and version, so concurrent readers never apply a
transition twice. Deadlines are fixed when their period starts, from the pilot timers or,
while an admin has Test timers on, the short ones; a transition applied late is dated at
its deadline, so the record never depends on when somebody looked.

Ballots stay private until the vote closes: the timeline gets each final ballot (a
`voted` event, dated when it was cast) only at the close, and until then only turnout is
shown. Titles, pitches, comments and draft fields are stored as plain text through the
Bridge's sanitizer (`bridge.clean_text`); pitches and comments keep their line breaks, and
text that shows nothing (`has_visible_text`) is refused.

The floor pauses while members can't act: while the `proposals` or `github_signin` flag is
off (a flag configuration that fails closed turns both off), no transition applies and the
moment it closed is kept (`proposal_floor`). When it opens again, before anything else,
every deadline still running when it closed moves later by the time it was closed, and the
timeline says so (`floor_paused`, `floor_resumed`).

Tables (all new, prefixed proposal_): proposal_motions (one row per proposal),
proposal_eligible, proposal_consents, proposal_votes, proposal_comments, proposal_events
(the public timeline), proposal_drafts, proposal_tasks (the link from a proposal to the
Contribute task it was published as), proposal_settings (the Test timers switch),
proposal_floor (when the floor closed, while it is paused) and proposal_writes (each
member's recent writes, for the hourly write limit).
"""

import asyncio
import json
import logging
import math
import os
import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any, Literal, cast

from pydantic import BaseModel, ValidationError

from forge_api.models import (
    ACTIVE_PROPOSAL_STATES,
    ELIGIBLE_ACTIVITY_DAYS,
    PROPOSAL_LIMITS,
    PROPOSAL_STATES,
    CommentRequest,
    ConsentChoice,
    ConsentRequest,
    DraftTask,
    DraftTaskRequest,
    NewProposal,
    NotificationKind,
    ProposalCard,
    ProposalComment,
    ProposalCommentPage,
    ProposalDetail,
    ProposalEvent,
    ProposalEventKind,
    ProposalList,
    ProposalMe,
    ProposalSettings,
    ProposalState,
    ProposalTally,
    ProposalYou,
    RewardClass,
    Size,
    TierFloor,
    VoteChoice,
    VoteRequest,
)
from forge_api.services import bridge as bridge_service
from forge_api.services import flags as flags_service
from forge_api.services.bridge import clean_text, iso
from forge_api.services.brief import slugify
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity, admin_ids
from forge_api.services.members import current_time, from_db, member_subs, recent_members, to_db
from forge_api.services.notifications import notify
from forge_api.services.oauth import ORIGIN_ENV, public_origin
from forge_api.services.rail_adapters.base import parse_json
from forge_api.services.state import StateDB, get_state_db, register_schema

logger = logging.getLogger(__name__)

FLAG = "proposals"
#: Without GitHub sign-in nobody can act on the floor either, so it pauses then too.
SIGNIN_FLAG = "github_signin"


@dataclass(frozen=True)
class Timers:
    """How long each period lasts. A period's deadline is fixed when it starts."""

    lapse: timedelta  # submitted: nobody seconded in time
    debate: timedelta
    vote: timedelta


#: The pilot's numbers (contract §1).
PILOT_TIMERS = Timers(lapse=timedelta(days=7), debate=timedelta(days=3), vote=timedelta(days=2))
#: While an admin has Test timers on: minutes, not days.
TEST_TIMERS = Timers(
    lapse=timedelta(minutes=10), debate=timedelta(minutes=5), vote=timedelta(minutes=5)
)

#: Proposals one member may move per MOVE_WINDOW.
MOVE_LIMIT = 3
MOVE_WINDOW = timedelta(hours=24)
#: Comments one member may post on one proposal per COMMENT_WINDOW.
COMMENT_LIMIT = 10
COMMENT_WINDOW = timedelta(hours=1)
#: Edits a proposal takes per EDIT_WINDOW (each one is a line in the public timeline).
EDIT_LIMIT = 10
EDIT_WINDOW = timedelta(hours=1)
#: Edits a proposal takes in all (409 edit_limit after that).
MAX_EDITS = 20
#: Writes (second, consent, vote, withdraw, edit) one member may make per WRITE_WINDOW,
#: across the whole floor (429 rate_limited after that).
WRITE_LIMIT = 60
WRITE_WINDOW = timedelta(hours=1)
#: The decided proposals GET /api/proposals lists per page (every active one is always
#: listed), and the comments a detail or a page of GET /api/proposals/{id}/comments shows.
DECIDED_PAGE = 100
COMMENTS_PAGE = 100
#: The eligible set frozen at a second: members seen less than this long before it.
ELIGIBLE_ACTIVITY = timedelta(days=ELIGIBLE_ACTIVITY_DAYS)
#: How often the lifespan ticker runs advance_all.
TICK_SECONDS = 60.0
#: What a draft task starts as, besides the proposal's title and pitch.
DRAFT_SIZE: Size = "S"
DRAFT_TIER_FLOOR: TierFloor = "T0"
DRAFT_REWARD_CLASS: RewardClass = "none"
#: The tier floors a task may be published with while every contributor is T0
#: (bridge.caller_tier, until Foreman's ledger): a T1 or T2 task could never be claimed.
OPEN_TIER_FLOORS: tuple[TierFloor, ...] = ("T0",)
#: The label every task published from a proposal carries (contract §3).
FROM_PROPOSAL_LABEL = "from-proposal"
#: The most characters of a title a notification quotes.
NOTIFICATION_TITLE_CHARS = 80
_TEST_TIMERS_SETTING = "test_timers"

#: How each state reads after "this proposal" in a wrong_state message.
STATE_WORDS: Mapping[ProposalState, str] = {
    "submitted": "is waiting for a second",
    "debate": "is in debate",
    "voting": "is in a vote",
    "passed": "has passed",
    "failed": "has failed",
    "building": "is being built",
    "shipped": "has shipped",
    "lapsed": "has lapsed",
    "withdrawn": "was withdrawn",
}

register_schema(
    "proposals",
    [
        """CREATE TABLE IF NOT EXISTS proposal_motions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            pitch TEXT NOT NULL,
            state TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0,
            mover_sub TEXT NOT NULL,
            mover_login TEXT NOT NULL,
            moved_at TEXT NOT NULL,
            seconder_sub TEXT,
            seconder_login TEXT,
            seconded_at TEXT,
            deadline TEXT,
            debate_ended_at TEXT,
            vote_opened_at TEXT,
            vote_closed_at TEXT,
            decided_at TEXT,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS proposal_motions_due ON proposal_motions (state, deadline)",
        "CREATE INDEX IF NOT EXISTS proposal_motions_mover "
        "ON proposal_motions (mover_sub, moved_at)",
        """CREATE TABLE IF NOT EXISTS proposal_eligible (
            proposal_id INTEGER NOT NULL REFERENCES proposal_motions (id) ON DELETE CASCADE,
            sub TEXT NOT NULL,
            login TEXT NOT NULL,
            PRIMARY KEY (proposal_id, sub)
        )""",
        """CREATE TABLE IF NOT EXISTS proposal_consents (
            proposal_id INTEGER NOT NULL REFERENCES proposal_motions (id) ON DELETE CASCADE,
            sub TEXT NOT NULL,
            login TEXT NOT NULL,
            choice TEXT NOT NULL CHECK (choice IN ('consented', 'objected')),
            at TEXT NOT NULL,
            PRIMARY KEY (proposal_id, sub)
        )""",
        """CREATE TABLE IF NOT EXISTS proposal_votes (
            proposal_id INTEGER NOT NULL REFERENCES proposal_motions (id) ON DELETE CASCADE,
            sub TEXT NOT NULL,
            login TEXT NOT NULL,
            choice TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
            at TEXT NOT NULL,
            PRIMARY KEY (proposal_id, sub)
        )""",
        """CREATE TABLE IF NOT EXISTS proposal_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id INTEGER NOT NULL REFERENCES proposal_motions (id) ON DELETE CASCADE,
            author_sub TEXT NOT NULL,
            author_login TEXT NOT NULL,
            text TEXT NOT NULL,
            at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS proposal_comments_by "
        "ON proposal_comments (proposal_id, author_sub, at)",
        """CREATE TABLE IF NOT EXISTS proposal_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id INTEGER NOT NULL REFERENCES proposal_motions (id) ON DELETE CASCADE,
            at TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor TEXT,
            message TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS proposal_events_of ON proposal_events (proposal_id, at, id)",
        """CREATE TABLE IF NOT EXISTS proposal_drafts (
            proposal_id INTEGER PRIMARY KEY REFERENCES proposal_motions (id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            civilian_summary TEXT NOT NULL,
            acceptance_criteria TEXT NOT NULL,
            size TEXT NOT NULL,
            tier_floor TEXT NOT NULL,
            reward_class TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS proposal_tasks (
            proposal_id INTEGER PRIMARY KEY REFERENCES proposal_motions (id) ON DELETE CASCADE,
            task_id INTEGER NOT NULL UNIQUE,
            published_at TEXT NOT NULL,
            published_by TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS proposal_settings (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL
        )""",
        # One row: while the floor is paused, when it closed (NULL while it is open).
        """CREATE TABLE IF NOT EXISTS proposal_floor (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            closed_since TEXT,
            updated_at TEXT NOT NULL
        )""",
        # Each member's writes in the last WRITE_WINDOW (older ones are deleted as they go).
        """CREATE TABLE IF NOT EXISTS proposal_writes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sub TEXT NOT NULL,
            kind TEXT NOT NULL,
            at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS proposal_writes_by ON proposal_writes (sub, at)",
    ],
)

# --- plain text -----------------------------------------------------------------------


def clean_line(text: str, limit: int) -> str:
    """One-line text (a title, a summary, a criterion) as FORGE stores it: the Bridge's
    sanitizer for agent text, which drops control and format characters and variation
    selectors, caps combining-mark stacks and folds every line break into a space."""
    return clean_text(text, limit).strip()


def clean_paragraphs(text: str, limit: int) -> str:
    """Multi-line text (a pitch, a comment) as FORGE stores it: the same sanitizer, line by
    line, so its line breaks survive as "\\n". At most one blank line in a row, none at
    either end."""
    kept: list[str] = []
    for line in text.splitlines():
        cleaned = clean_text(line, limit)
        if cleaned or (kept and kept[-1]):
            kept.append(cleaned)
    while kept and not kept[-1]:
        kept.pop()
    return "\n".join(kept)[:limit].rstrip()


#: Categories that show nothing by themselves: what the Bridge's sanitizer drops (control,
#: format, surrogate and private-use characters, which include the zero-width ones and the
#: bidi controls), unassigned code points, combining marks with no character to sit on (the
#: variation selectors among them) and separators (spaces, line and paragraph breaks).
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Mn", "Me", "Zs", "Zl", "Zp"})
#: Characters that show nothing although their category says otherwise, or that the
#: sanitizer keeps: the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the blank Braille
#: pattern (U+2800), the Khmer inherent vowels (U+17B4, U+17B5) and the zero-width
#: characters (U+180E, U+200B to U+200D, U+2060, U+FEFF).
_BLANK_CHARACTERS = frozenset(
    "\u115f\u1160\u3164\uffa0\u2800\u17b4\u17b5\u180e\u200b\u200c\u200d\u2060\ufeff"
)


def is_visible(char: str) -> bool:
    """Whether one character shows on its own: not whitespace, nothing the Bridge's
    sanitizer drops, no bare combining mark, and no filler or zero-width character."""
    return (
        not char.isspace()
        and char not in _BLANK_CHARACTERS
        and unicodedata.category(char) not in _INVISIBLE_CATEGORIES
    )


def has_visible_text(text: str) -> bool:
    """Whether `text` shows anything at all: one visible character is enough."""
    return any(is_visible(char) for char in text)


# --- errors ---------------------------------------------------------------------------


def _refuse(
    status: int, code: str, message: str, *, headers: dict[str, str] | None = None, **extra: Any
) -> ApiError:
    return ApiError(status, {"error": code, "message": message, **extra}, headers=headers)


def not_found() -> ApiError:
    return _refuse(404, "proposal_not_found", "There's no proposal with that number.")


def wrong_state(state: ProposalState) -> ApiError:
    return _refuse(
        409,
        "wrong_state",
        f"That can't be done now: this proposal {STATE_WORDS[state]}.",
        state=state,
    )


def invalid_request(fields: Iterable[str], message: str | None = None) -> ApiError:
    named = sorted(set(fields))
    return _refuse(
        400,
        "invalid_request",
        message or f"Check {', '.join(named)} and try again.",
        fields=named,
    )


def _not_mover() -> ApiError:
    return _refuse(403, "not_mover", "Only the member who brought this proposal can do that.")


def _not_eligible() -> ApiError:
    return _refuse(
        409,
        "not_eligible",
        "Only the members who were here when this proposal was seconded can consent, "
        "object or vote on it.",
    )


def _tier_not_open() -> ApiError:
    return _refuse(400, "tier_not_open", "Tiers above T0 aren't open yet, so publish it as T0.")


# --- requests -------------------------------------------------------------------------

_ID = re.compile(r"[1-9][0-9]{0,18}")
_SQLITE_MAX_INT = 2**63 - 1


def error_fields(exc: ValidationError) -> list[str]:
    """The fields a validation error names ("title", "acceptanceCriteria.2"), never the
    input itself."""
    return sorted(
        {
            ".".join(str(part) for part in error["loc"]) or "body"
            for error in exc.errors(include_url=False, include_input=False)
        }
    )


def parse_request[ModelT: BaseModel](raw: bytes, model: type[ModelT]) -> ModelT:
    """A JSON request body as `model`, or 400 invalid_request naming the fields at fault
    ("body" when it isn't a JSON object). An empty body is `{}`. Read here, not by FastAPI,
    whose 422 would echo the input back."""
    try:
        data: Any = parse_json(raw) if raw.strip() else {}
    except ValueError:  # not JSON, not UTF-8 (UnicodeDecodeError), or nested too deep
        raise invalid_request(["body"]) from None
    if not isinstance(data, dict):
        raise invalid_request(["body"])
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise invalid_request(error_fields(exc)) from None


def parse_id(raw: str) -> int:
    """A proposal number from the path: anything that isn't one is 404 proposal_not_found."""
    if _ID.fullmatch(raw) is None or int(raw) > _SQLITE_MAX_INT:
        raise not_found()
    return int(raw)


def parse_state(raw: str | None) -> ProposalState | None:
    """The `?state=` filter: one of PROPOSAL_STATES, or 400 invalid_request."""
    if raw is None:
        return None
    if raw not in PROPOSAL_STATES:
        raise invalid_request(["state"])
    return raw


def _cleaned(values: Mapping[str, str]) -> None:
    """400 invalid_request naming every field that shows nothing once sanitized: empty,
    only spaces, or only characters that are invisible (`has_visible_text`)."""
    blank = sorted(field for field, value in values.items() if not has_visible_text(value))
    if blank:
        raise invalid_request(blank, f"Write some text in {', '.join(blank)}.")


def parse_cursor(raw: str | None, field: str) -> int | None:
    """A paging cursor from the query string (`before`, `decidedBefore`): a proposal or
    comment number, or 400 invalid_request naming `field`."""
    if raw is None:
        return None
    if _ID.fullmatch(raw) is None or int(raw) > _SQLITE_MAX_INT:
        raise invalid_request([field])
    return int(raw)


def duration_words(delta: timedelta) -> str:
    """A span as a person reads it: "2 h 10 min", "3 d 5 s", "under a second"."""
    seconds = max(0, int(delta.total_seconds()))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, rest = divmod(rest, 60)
    parts = [
        f"{amount} {unit}"
        for amount, unit in ((days, "d"), (hours, "h"), (minutes, "min"), (rest, "s"))
        if amount
    ]
    return " ".join(parts) or "under a second"


def members_can_act() -> bool:
    """Whether members can act on the floor: the `proposals` and `github_signin` flags both
    on. A flag configuration that fails closed turns every flag off, so it reads as no."""
    flags = flags_service.get_flags()
    return flags.proposals and flags.github_signin


def task_url(proposal_id: int, env: Mapping[str, str] | None = None) -> str:
    """A published task's link: the proposal's page on FORGE_PUBLIC_ORIGIN, or a path on
    this site while that is unset or not a usable origin (local development)."""
    origin = public_origin((env if env is not None else os.environ).get(ORIGIN_ENV, ""))
    return f"{origin or ''}/propose/{proposal_id}"


# --- the rules, as a pure function ----------------------------------------------------


@dataclass(frozen=True)
class ProposalFacts:
    """A snapshot of one proposal: everything `advance` reads."""

    id: int
    state: ProposalState
    version: int
    deadline: datetime | None
    eligible: int = 0  # the frozen eligible set's size (0 before the second)
    consents: int = 0  # consented so far, the mover included
    objections: int = 0
    yes: int = 0
    no: int = 0
    abstain: int = 0

    @property
    def ballots(self) -> int:
        return self.yes + self.no + self.abstain


StepKind = Literal["lapsed", "debate_ended", "vote_opened", "vote_closed", "passed", "failed"]


@dataclass(frozen=True)
class Step:
    """One transition: its timeline kind, when it happened, and the timeline's words."""

    kind: StepKind
    at: datetime
    message: str


@dataclass(frozen=True)
class Advance:
    """Where a proposal stands after `advance`, and the steps that got it there (none when
    nothing was due)."""

    state: ProposalState
    deadline: datetime | None
    steps: tuple[Step, ...] = ()


def quorum_met(ballots: int, eligible: int) -> bool:
    """A majority of the eligible set cast a ballot (Abstain counts)."""
    return ballots * 2 > eligible


def advance(proposal: ProposalFacts, now: datetime, timers: Timers = PILOT_TIMERS) -> Advance:
    """Every transition `proposal` has due at `now`, worked out without touching anything.

    - submitted, its deadline passed: lapsed (dated at the deadline).
    - debate, its deadline passed: debate ends then; with no objection it passes by
      silence, otherwise voting opens and runs `timers.vote` from that moment.
    - debate, everyone in the eligible set consented and nobody objected: passed now.
    - voting, its deadline passed: the vote closes then; passed with quorum and more Yes
      than No, failed otherwise (ties fail).

    Chains: a debate whose vote deadline has passed as well ends, opens and closes its
    vote in one go. `timers` sets the deadline of a vote opened here.
    """
    state, deadline = proposal.state, proposal.deadline
    steps: list[Step] = []
    if state == "submitted" and deadline is not None and deadline <= now:
        message = "Nobody seconded it in time, so it lapsed."
        return Advance("lapsed", None, (Step("lapsed", deadline, message),))
    if state == "debate":
        if deadline is not None and deadline <= now:
            ended = deadline
            steps.append(Step("debate_ended", ended, "Debate ended."))
            if proposal.objections == 0:
                message = "Debate ended with no objection, so it passed without a vote."
                steps.append(Step("passed", ended, message))
                return Advance("passed", None, tuple(steps))
            state, deadline = "voting", ended + timers.vote
            message = (
                f"Someone objected, so it goes to a vote. The {proposal.eligible} members of "
                "the eligible set can vote Yes, No or Abstain until the vote closes."
            )
            steps.append(Step("vote_opened", ended, message))
        elif proposal.objections == 0 and 0 < proposal.eligible <= proposal.consents:
            message = "Everyone in the eligible set consented, so it passed without a vote."
            return Advance("passed", None, (Step("passed", now, message),))
    if state == "voting" and deadline is not None and deadline <= now:
        quorum = quorum_met(proposal.ballots, proposal.eligible)
        carried = quorum and proposal.yes > proposal.no
        steps.append(
            Step(
                "vote_closed",
                deadline,
                f"The vote closed: {proposal.yes} yes, {proposal.no} no, {proposal.abstain} "
                f"abstain. {proposal.ballots} of {proposal.eligible} voted, so the quorum was "
                f"{'met' if quorum else 'not met'}.",
            )
        )
        if carried:
            steps.append(Step("passed", deadline, "It passed: more members voted yes than no."))
            return Advance("passed", None, tuple(steps))
        message = (
            "It failed: it needed more yes votes than no."
            if quorum
            else "It failed: fewer than half of the eligible set voted, so there was no quorum."
        )
        steps.append(Step("failed", deadline, message))
        return Advance("failed", None, tuple(steps))
    return Advance(state, deadline, tuple(steps))


# --- the floor, persisted -------------------------------------------------------------

Row = dict[str, Any]

_ACTIVE_SQL = ", ".join(f"'{state}'" for state in ACTIVE_PROPOSAL_STATES)


def _marks(values: Sequence[object]) -> str:
    """One `?` per value, for `IN (...)`."""
    return ", ".join("?" for _ in values)


_MOTION_SQL = """
    SELECT m.*,
        (SELECT COUNT(*) FROM proposal_eligible e WHERE e.proposal_id = m.id)
            AS eligible_count,
        (SELECT COUNT(*) FROM proposal_consents c
            WHERE c.proposal_id = m.id AND c.choice = 'consented') AS consent_count,
        (SELECT COUNT(*) FROM proposal_consents c
            WHERE c.proposal_id = m.id AND c.choice = 'objected') AS objection_count,
        (SELECT COUNT(*) FROM proposal_votes v WHERE v.proposal_id = m.id AND v.choice = 'yes')
            AS yes_count,
        (SELECT COUNT(*) FROM proposal_votes v WHERE v.proposal_id = m.id AND v.choice = 'no')
            AS no_count,
        (SELECT COUNT(*) FROM proposal_votes v
            WHERE v.proposal_id = m.id AND v.choice = 'abstain') AS abstain_count,
        (SELECT COUNT(*) FROM proposal_comments k WHERE k.proposal_id = m.id) AS comment_count
    FROM proposal_motions m
"""
#: The column each step stamps with its time.
_STEP_STAMPS: Mapping[StepKind, str] = {
    "lapsed": "decided_at",
    "debate_ended": "debate_ended_at",
    "vote_opened": "vote_opened_at",
    "vote_closed": "vote_closed_at",
    "passed": "decided_at",
    "failed": "decided_at",
}


def _iso(value: str) -> str:
    return iso(from_db(value))


def _facts(row: Row) -> ProposalFacts:
    return ProposalFacts(
        id=row["id"],
        state=row["state"],
        version=row["version"],
        deadline=from_db(row["deadline"]) if row["deadline"] else None,
        eligible=row["eligible_count"],
        consents=row["consent_count"],
        objections=row["objection_count"],
        yes=row["yes_count"],
        no=row["no_count"],
        abstain=row["abstain_count"],
    )


def _card(row: Row) -> ProposalCard:
    return ProposalCard(
        id=row["id"],
        title=row["title"],
        state=row["state"],
        mover=row["mover_login"],
        movedAt=_iso(row["moved_at"]),
        seconder=row["seconder_login"],
        deadline=_iso(row["deadline"]) if row["deadline"] else None,
        commentCount=row["comment_count"],
        objectionCount=row["objection_count"],
    )


#: A title's own double quotation marks, and the single marks that stand for them inside a
#: notification's quotes (English nests quotes that way), so no title can close the quote
#: early and write the rest of the sentence itself.
_INNER_QUOTES = str.maketrans(
    {
        "“": "‘",
        "‟": "‛",
        "〝": "‘",
        "❝": "‘",
        "”": "’",
        "〞": "’",
        "〟": "’",
        "❞": "’",
        "„": "‚",
        "⹂": "‚",
        '"': "'",
        "＂": "'",
        "″": "′",
        "‶": "‵",
        "«": "‹",
        "»": "›",
    }
)


def _quoted(title: str) -> str:
    """A title as a notification quotes it: inside “ ”, its own double quotation marks made
    single, and at most NOTIFICATION_TITLE_CHARS characters ("…" marks a cut)."""
    text = title.translate(_INNER_QUOTES)
    if len(text) > NOTIFICATION_TITLE_CHARS:
        text = text[: NOTIFICATION_TITLE_CHARS - 1].rstrip() + "…"
    return f"“{text}”"


class Proposals:
    """The floor as of `now`, over the state database. Every route, the ticker and the
    Bridge's shipped hook go through these methods.

    Each write runs in one transaction that first applies every transition due, so an
    action always meets the proposal as it stands at `now`; reads apply them too.
    """

    def __init__(self, db: StateDB, now: datetime) -> None:
        self.db = db
        self.now = now
        self._open: bool | None = None  # floor_open(), once worked out

    # the pause: no transition applies while members can't act

    def floor_open(self) -> bool:
        """Whether transitions may apply now. The first call brings the pause up to date:
        it records that the floor closed, or ends the pause it was in (moving every running
        deadline later by the time it was closed) before anything else happens. Later calls
        on this object give the same answer."""
        if self._open is None:
            self._open = self._sync_floor()
        return self._open

    def _closed_since(self) -> datetime | None:
        row = self.db.query_one("SELECT closed_since FROM proposal_floor WHERE id = 1")
        return from_db(row["closed_since"]) if row and row["closed_since"] else None

    def _sync_floor(self) -> bool:
        can_act = members_can_act()
        if can_act == (self._closed_since() is None):  # open as recorded, or paused already
            return can_act
        with self.db.transaction():
            closed = self._closed_since()  # again, under the write lock
            if not can_act:
                if closed is None:
                    self._pause()
                return False
            if closed is not None:
                self._resume(closed)
            return True

    def _active_rows(self) -> list[Row]:
        return self.db.query_all(
            "SELECT id, state, version, deadline FROM proposal_motions "
            f"WHERE state IN ({_ACTIVE_SQL}) ORDER BY id"
        )

    def _pause(self) -> None:
        """The floor just closed: keep when, and say so on every active proposal."""
        self.db.execute(
            "INSERT INTO proposal_floor (id, closed_since, updated_at) VALUES (1, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET closed_since = excluded.closed_since, "
            "updated_at = excluded.updated_at",
            (to_db(self.now), to_db(self.now)),
        )
        for row in self._active_rows():
            self._event(
                row["id"],
                "floor_paused",
                "The floor closed, so nobody can act on it for now. Its deadlines wait until "
                "it opens again.",
            )

    def _resume(self, closed: datetime) -> None:
        """The floor opened again: every deadline still running when it closed moves later
        by the time it was closed, and every active proposal says so. A deadline that had
        passed before it closed stays where it was and is applied next, dated at itself."""
        closed_for = max(self.now - closed, timedelta(0))
        words = duration_words(closed_for)
        for row in self._active_rows():
            deadline = from_db(row["deadline"]) if row["deadline"] else None
            if deadline is not None and deadline > closed:
                self._update(row, "deadline = ?", (to_db(deadline + closed_for),))
                message = f"The floor was closed for {words}; deadlines moved by that."
            else:
                message = f"The floor was closed for {words}."
            self._event(row["id"], "floor_resumed", message)
        self.db.execute(
            "UPDATE proposal_floor SET closed_since = NULL, updated_at = ? WHERE id = 1",
            (to_db(self.now),),
        )

    # settings

    def test_timers(self) -> bool:
        row = self.db.query_one(
            "SELECT value FROM proposal_settings WHERE name = ?", (_TEST_TIMERS_SETTING,)
        )
        return row is not None and row["value"] == "on"

    def timers(self) -> Timers:
        """The timers a deadline set now gets."""
        return TEST_TIMERS if self.test_timers() else PILOT_TIMERS

    # reading

    def _load(self, proposal_id: int) -> Row | None:
        return self.db.query_one(_MOTION_SQL + " WHERE m.id = ?", (proposal_id,))

    def _current(self, proposal_id: int) -> Row:
        """The proposal with every due transition applied, or 404."""
        self.advance_one(proposal_id)
        row = self._load(proposal_id)
        if row is None:
            raise not_found()
        return row

    def _is_eligible(self, proposal_id: int, sub: str) -> bool:
        row = self.db.query_one(
            "SELECT 1 AS hit FROM proposal_eligible WHERE proposal_id = ? AND sub = ?",
            (proposal_id, sub),
        )
        return row is not None

    def _consent_of(self, proposal_id: int, sub: str) -> ConsentChoice | None:
        row = self.db.query_one(
            "SELECT choice FROM proposal_consents WHERE proposal_id = ? AND sub = ?",
            (proposal_id, sub),
        )
        return cast(ConsentChoice, row["choice"]) if row else None

    def _vote_of(self, proposal_id: int, sub: str) -> VoteChoice | None:
        row = self.db.query_one(
            "SELECT choice FROM proposal_votes WHERE proposal_id = ? AND sub = ?",
            (proposal_id, sub),
        )
        return cast(VoteChoice, row["choice"]) if row else None

    def _eligible_subs(self, proposal_id: int) -> list[str]:
        rows = self.db.query_all(
            "SELECT sub FROM proposal_eligible WHERE proposal_id = ? ORDER BY sub", (proposal_id,)
        )
        return [row["sub"] for row in rows]

    def _involved(self, proposal_id: int) -> list[str]:
        """The mover, the seconder and everyone who consented, objected, voted or
        commented: who hears how it ended."""
        rows = self.db.query_all(
            "SELECT mover_sub AS sub FROM proposal_motions WHERE id = :id "
            "UNION SELECT seconder_sub FROM proposal_motions "
            "WHERE id = :id AND seconder_sub IS NOT NULL "
            "UNION SELECT sub FROM proposal_consents WHERE proposal_id = :id "
            "UNION SELECT sub FROM proposal_votes WHERE proposal_id = :id "
            "UNION SELECT author_sub FROM proposal_comments WHERE proposal_id = :id",
            {"id": proposal_id},
        )
        return sorted(row["sub"] for row in rows)

    def _task_id(self, proposal_id: int) -> int | None:
        row = self.db.query_one(
            "SELECT task_id FROM proposal_tasks WHERE proposal_id = ?", (proposal_id,)
        )
        return int(row["task_id"]) if row else None

    def _active_of(self, sub: str) -> int | None:
        """The member's own proposal still in an active state at `now`, if any."""
        sql = f"SELECT id FROM proposal_motions WHERE mover_sub = ? AND state IN ({_ACTIVE_SQL})"
        for candidate in self.db.query_all(sql, (sub,)):
            self.advance_one(candidate["id"])
        row = self.db.query_one(sql + " ORDER BY id DESC LIMIT 1", (sub,))
        return int(row["id"]) if row else None

    # writing

    def _event(
        self,
        proposal_id: int,
        kind: ProposalEventKind,
        message: str,
        *,
        actor: str | None = None,
        at: datetime | None = None,
    ) -> None:
        self.db.execute(
            "INSERT INTO proposal_events (proposal_id, at, kind, actor, message) "
            "VALUES (?, ?, ?, ?, ?)",
            (proposal_id, to_db(at or self.now), kind, actor, message),
        )

    def _notify(
        self,
        subs: Iterable[str],
        kind: NotificationKind,
        message: str,
        proposal_id: int,
        at: datetime | None = None,
    ) -> None:
        notify(self.db, subs, kind, message, f"/propose/{proposal_id}", at or self.now)

    def _update(self, row: Row, assignments: str, params: Sequence[Any] = ()) -> None:
        """Change the proposal read as `row`, compare-and-set on its state and version: a
        proposal changed underneath since is 409 wrong_state, and nothing is written."""
        written = self.db.execute(
            f"UPDATE proposal_motions SET {assignments}, version = version + 1, updated_at = ? "
            "WHERE id = ? AND state = ? AND version = ?",
            (*params, to_db(self.now), row["id"], row["state"], row["version"]),
        )
        if written.rowcount != 1:
            fresh = self._load(row["id"])
            raise wrong_state(fresh["state"] if fresh else row["state"])

    def _limit(
        self, sql: str, params: Sequence[Any], limit: int, window: timedelta, message: str
    ) -> None:
        """429 rate_limited (with Retry-After) when `sql` finds `limit` times (column
        `at`, oldest first) inside the window."""
        rows = self.db.query_all(sql, params)
        if len(rows) >= limit:
            oldest = from_db(rows[len(rows) - limit]["at"])
            retry = max(1, math.ceil((oldest + window - self.now).total_seconds()))
            raise _refuse(
                429,
                "rate_limited",
                message,
                headers={"Retry-After": str(retry)},
                retryAfter=retry,
                limit=limit,
            )

    def _count_write(self, identity: Identity, kind: str) -> None:
        """A member's write (a second, consent, vote, withdrawal or edit): 429 rate_limited
        past WRITE_LIMIT in WRITE_WINDOW across the floor; otherwise it is counted, and
        that member's writes older than the window are forgotten."""
        since = to_db(self.now - WRITE_WINDOW)
        self._limit(
            "SELECT at FROM proposal_writes WHERE sub = ? AND at > ? ORDER BY at",
            (identity.sub, since),
            WRITE_LIMIT,
            WRITE_WINDOW,
            f"You can second, consent, object, vote, edit or withdraw at most {WRITE_LIMIT} "
            "times an hour. Try again later.",
        )
        self.db.execute(
            "DELETE FROM proposal_writes WHERE sub = ? AND at <= ?", (identity.sub, since)
        )
        self.db.execute(
            "INSERT INTO proposal_writes (sub, kind, at) VALUES (?, ?, ?)",
            (identity.sub, kind, to_db(self.now)),
        )

    def _revision(self, proposal_id: int) -> int:
        """The text's revision: 1, plus 1 for every edit (each is an `edited` line)."""
        row = self.db.query_one(
            "SELECT COUNT(*) AS n FROM proposal_events WHERE proposal_id = ? AND kind = 'edited'",
            (proposal_id,),
        )
        return 1 + (int(row["n"]) if row else 0)

    # transitions

    def advance_one(self, proposal_id: int) -> int:
        """Apply every transition due for this proposal at `now`; returns how many steps
        were applied (none while the floor is paused). Checks first without the write lock,
        so a read with nothing due writes nothing; then re-reads inside one transaction
        before applying."""
        if not self.floor_open():
            return 0
        row = self._load(proposal_id)
        if row is None or not advance(_facts(row), self.now, self.timers()).steps:
            return 0
        with self.db.transaction():
            row = self._load(proposal_id)
            if row is None:  # deleted since the check: nothing left to apply
                return 0
            return self._apply(row, advance(_facts(row), self.now, self.timers()))

    def advance_all(self) -> int:
        """Apply every transition due at `now` on the whole floor (the ticker's beat), and
        catch up any shipped task whose hook didn't run. Returns how many steps: none while
        the floor is paused."""
        if not self.floor_open():
            return 0
        due = self.db.query_all(
            f"SELECT id FROM proposal_motions WHERE state IN ({_ACTIVE_SQL}) AND deadline <= ? "
            "ORDER BY id",
            (to_db(self.now),),
        )
        applied = sum(self.advance_one(row["id"]) for row in due)
        building = self.db.query_all(
            "SELECT t.task_id FROM proposal_tasks t JOIN proposal_motions m "
            "ON m.id = t.proposal_id WHERE m.state = 'building' ORDER BY t.task_id"
        )
        for row in building:
            if bridge_service.task_merged(self.db, row["task_id"]) and self.ship(row["task_id"]):
                applied += 1
        return applied

    def _apply(self, row: Row, result: Advance) -> int:
        """Persist `result` for the proposal read as `row`, inside the caller's transaction:
        compare-and-set its state and version, then each step's timeline line, draft task
        and notifications. Returns the steps applied: none when it changed underneath."""
        if not result.steps:
            return 0
        stamps = {_STEP_STAMPS[step.kind]: to_db(step.at) for step in result.steps}
        written = self.db.execute(
            "UPDATE proposal_motions SET state = ?, deadline = ?, version = version + 1, "
            f"updated_at = ?{''.join(f', {column} = ?' for column in stamps)} "
            "WHERE id = ? AND state = ? AND version = ?",
            (
                result.state,
                to_db(result.deadline) if result.deadline is not None else None,
                to_db(self.now),
                *stamps.values(),
                row["id"],
                row["state"],
                row["version"],
            ),
        )
        if written.rowcount != 1:  # changed underneath: whoever changed it applied it
            return 0
        for step in result.steps:
            self._on_step(row, step)
        return len(result.steps)

    def _on_step(self, row: Row, step: Step) -> None:
        proposal_id, title = row["id"], _quoted(row["title"])
        if step.kind == "vote_closed":
            # Ballots are public once the vote is over: each member's final one, dated
            # when they cast it.
            ballots = self.db.query_all(
                "SELECT login, choice, at FROM proposal_votes WHERE proposal_id = ? "
                "ORDER BY at, sub",
                (proposal_id,),
            )
            for ballot in ballots:
                self._event(
                    proposal_id,
                    "voted",
                    f"{ballot['login']} voted {ballot['choice']}.",
                    actor=ballot["login"],
                    at=from_db(ballot["at"]),
                )
        self._event(proposal_id, step.kind, step.message, at=step.at)
        if step.kind == "vote_opened":
            self._notify(
                self._eligible_subs(proposal_id),
                "vote_opened",
                f"Voting is open on {title}. Cast your vote before it closes.",
                proposal_id,
                step.at,
            )
        elif step.kind == "passed":
            self._draft_task(row, step.at)
            self._notify(
                self._involved(proposal_id),
                "proposal_passed",
                f"{title} passed.",
                proposal_id,
                step.at,
            )
        elif step.kind == "failed":
            self._notify(
                self._involved(proposal_id),
                "proposal_failed",
                f"{title} failed.",
                proposal_id,
                step.at,
            )
        elif step.kind == "lapsed":
            self._notify(
                self._involved(proposal_id),
                "proposal_lapsed",
                f"{title} lapsed: nobody seconded it in time.",
                proposal_id,
                step.at,
            )

    def _draft_task(self, row: Row, at: datetime) -> None:
        """A passed proposal's draft task: its title, the pitch (on one line) as the
        summary, no criteria yet, and the plainest size, tier floor and reward."""
        self.db.execute(
            "INSERT OR IGNORE INTO proposal_drafts (proposal_id, title, civilian_summary, "
            "acceptance_criteria, size, tier_floor, reward_class, updated_at) "
            "VALUES (?, ?, ?, '[]', ?, ?, ?, ?)",
            (
                row["id"],
                row["title"],
                clean_line(row["pitch"], PROPOSAL_LIMITS["pitch"]),
                DRAFT_SIZE,
                DRAFT_TIER_FLOOR,
                DRAFT_REWARD_CLASS,
                to_db(at),
            ),
        )
        self._event(
            row["id"],
            "task_drafted",
            "A draft task was made from it. An admin will say what done means and publish "
            "it to the Contribute board.",
            at=at,
        )

    # reads

    def list_proposals(
        self, state: ProposalState | None = None, decided_before: int | None = None
    ) -> ProposalList:
        """The floor, newest first, optionally in one state: every active proposal, and the
        newest DECIDED_PAGE decided ones (`moreDecided` when there are older ones). With
        `decided_before`, only the decided proposals numbered below it: the next page."""
        self.advance_all()
        wanted = [candidate for candidate in PROPOSAL_STATES if state in (None, candidate)]
        active = [one for one in wanted if one in ACTIVE_PROPOSAL_STATES]
        decided = [one for one in wanted if one not in ACTIVE_PROPOSAL_STATES]
        rows: list[Row] = []
        if active and decided_before is None:
            rows += self.db.query_all(
                _MOTION_SQL + f" WHERE m.state IN ({_marks(active)}) ORDER BY m.id DESC",
                active,
            )
        more = False
        if decided:
            below = "" if decided_before is None else " AND m.id < ?"
            page = self.db.query_all(
                _MOTION_SQL + f" WHERE m.state IN ({_marks(decided)}){below} "
                "ORDER BY m.id DESC LIMIT ?",
                (*decided, *([] if decided_before is None else [decided_before]), DECIDED_PAGE + 1),
            )
            more = len(page) > DECIDED_PAGE
            rows += page[:DECIDED_PAGE]
        rows.sort(key=lambda row: int(row["id"]), reverse=True)
        return ProposalList(
            proposals=[_card(row) for row in rows],
            testTimers=self.test_timers(),
            moreDecided=more or None,
            floorPaused=self._paused(),
        )

    def _paused(self) -> bool | None:
        """`floorPaused` on the wire: true while the floor is paused, absent otherwise."""
        return None if self.floor_open() else True

    def detail(self, proposal_id: int, viewer: Identity | None = None) -> ProposalDetail:
        """Everything public about one proposal; `you` for an identified viewer, and the
        draft task for an admin."""
        row = self._current(proposal_id)
        seconded = row["seconded_at"] is not None
        task_id = self._task_id(proposal_id)
        is_admin = viewer is not None and viewer.sub in admin_ids()
        ballots = row["yes_count"] + row["no_count"] + row["abstain_count"]
        tally = None
        if row["vote_closed_at"] is not None:
            tally = ProposalTally(
                yes=row["yes_count"],
                no=row["no_count"],
                abstain=row["abstain_count"],
                eligible=row["eligible_count"],
                quorumMet=quorum_met(ballots, row["eligible_count"]),
            )
        comments, more_comments = self._comment_page(proposal_id)
        return ProposalDetail(
            proposal=_card(row),
            pitch=row["pitch"],
            eligibleCount=row["eligible_count"] if seconded else None,
            consentCount=row["consent_count"] if seconded else None,
            turnout=ballots if row["state"] == "voting" else None,
            tally=tally,
            comments=comments,
            events=self._events(proposal_id),
            you=self._you(row, viewer, is_admin) if viewer is not None else None,
            draft=self._draft(proposal_id, task_id) if is_admin else None,
            taskId=task_id,
            revision=self._revision(proposal_id),
            moreComments=more_comments or None,
            floorPaused=self._paused(),
        )

    def comments(self, proposal_id: int, before: int | None = None) -> ProposalCommentPage:
        """GET /api/proposals/{id}/comments: the COMMENTS_PAGE comments before comment
        number `before` (the newest ones without it), so the whole thread stays readable
        however long it gets."""
        self._current(proposal_id)
        comments, more = self._comment_page(proposal_id, before)
        return ProposalCommentPage(comments=comments, moreComments=more)

    def _comment_page(
        self, proposal_id: int, before: int | None = None
    ) -> tuple[list[ProposalComment], bool]:
        """Up to COMMENTS_PAGE comments numbered below `before` (any, without it), oldest
        first, and whether older ones exist."""
        below = "" if before is None else " AND id < ?"
        rows = self.db.query_all(
            f"SELECT * FROM proposal_comments WHERE proposal_id = ?{below} "
            "ORDER BY id DESC LIMIT ?",
            (proposal_id, *([] if before is None else [before]), COMMENTS_PAGE + 1),
        )
        comments = [
            ProposalComment(
                id=row["id"], author=row["author_login"], text=row["text"], at=_iso(row["at"])
            )
            for row in reversed(rows[:COMMENTS_PAGE])
        ]
        return comments, len(rows) > COMMENTS_PAGE

    def _events(self, proposal_id: int) -> list[ProposalEvent]:
        rows = self.db.query_all(
            "SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY at, id", (proposal_id,)
        )
        return [
            ProposalEvent(
                at=_iso(row["at"]), kind=row["kind"], actor=row["actor"], message=row["message"]
            )
            for row in rows
        ]

    def _draft(self, proposal_id: int, task_id: int | None) -> DraftTask | None:
        row = self.db.query_one(
            "SELECT * FROM proposal_drafts WHERE proposal_id = ?", (proposal_id,)
        )
        if row is None:
            return None
        return DraftTask(
            title=row["title"],
            civilianSummary=row["civilian_summary"],
            acceptanceCriteria=list(json.loads(row["acceptance_criteria"])),
            size=row["size"],
            tierFloor=row["tier_floor"],
            rewardClass=row["reward_class"],
            taskId=task_id,
        )

    def _you(self, row: Row, viewer: Identity, is_admin: bool) -> ProposalYou:
        state: ProposalState = row["state"]
        proposal_id = row["id"]
        is_mover = row["mover_sub"] == viewer.sub
        eligible = self._is_eligible(proposal_id, viewer.sub)
        consent = self._consent_of(proposal_id, viewer.sub)
        return ProposalYou(
            canEdit=is_mover and state == "submitted",
            canWithdraw=is_mover and state in ACTIVE_PROPOSAL_STATES,
            canSecond=not is_mover and state == "submitted",
            canConsent=state == "debate" and eligible and consent is None,
            consent=consent,
            canComment=state in ("debate", "voting"),
            canVote=state == "voting" and eligible,
            vote=self._vote_of(proposal_id, viewer.sub),
            isAdmin=is_admin,
        )

    def me(self, identity: Identity) -> ProposalMe:
        return ProposalMe(
            isAdmin=identity.sub in admin_ids(),
            activeProposalId=self._active_of(identity.sub),
            testTimers=self.test_timers(),
        )

    # a member's actions

    def move(self, identity: Identity, request: NewProposal) -> ProposalDetail:
        """Bring a proposal: one active proposal per member, MOVE_LIMIT a day."""
        title = clean_line(request.title, PROPOSAL_LIMITS["title"])
        pitch = clean_paragraphs(request.pitch, PROPOSAL_LIMITS["pitch"])
        _cleaned({"title": title, "pitch": pitch})
        with self.db.transaction():
            active = self._active_of(identity.sub)
            if active is not None:
                raise _refuse(
                    409,
                    "one_active_proposal",
                    "You already have a proposal on the floor. You can bring another once "
                    "it's decided.",
                    proposalId=active,
                )
            self._limit(
                "SELECT moved_at AS at FROM proposal_motions WHERE mover_sub = ? "
                "AND moved_at > ? ORDER BY moved_at",
                (identity.sub, to_db(self.now - MOVE_WINDOW)),
                MOVE_LIMIT,
                MOVE_WINDOW,
                f"You can bring at most {MOVE_LIMIT} proposals in 24 hours. Try again later.",
            )
            written = self.db.execute(
                "INSERT INTO proposal_motions (title, pitch, state, mover_sub, mover_login, "
                "moved_at, deadline, updated_at) VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?)",
                (
                    title,
                    pitch,
                    identity.sub,
                    identity.login,
                    to_db(self.now),
                    to_db(self.now + self.timers().lapse),
                    to_db(self.now),
                ),
            )
            proposal_id = int(written.lastrowid or 0)
            self._event(
                proposal_id,
                "moved",
                f"{identity.login} brought this proposal. It needs a second from another member.",
                actor=identity.login,
            )
            self._notify(
                (sub for sub in member_subs(self.db) if sub != identity.sub),
                "proposal_moved",
                f"{identity.login} brought a new proposal, {_quoted(title)}. It needs a second.",
                proposal_id,
            )
        return self.detail(proposal_id, identity)

    def edit(self, identity: Identity, proposal_id: int, request: NewProposal) -> ProposalDetail:
        """The mover changes the title and pitch, until someone seconds it: MAX_EDITS times
        in all (409 edit_limit), EDIT_LIMIT an hour. Each edit adds 1 to the revision."""
        title = clean_line(request.title, PROPOSAL_LIMITS["title"])
        pitch = clean_paragraphs(request.pitch, PROPOSAL_LIMITS["pitch"])
        _cleaned({"title": title, "pitch": pitch})
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["mover_sub"] != identity.sub:
                raise _not_mover()
            if row["state"] != "submitted":
                raise wrong_state(row["state"])
            if (title, pitch) != (row["title"], row["pitch"]):
                if self._revision(proposal_id) > MAX_EDITS:
                    raise _refuse(
                        409,
                        "edit_limit",
                        f"A proposal can be edited at most {MAX_EDITS} times. Withdraw it "
                        "and bring a new one if it needs more.",
                        limit=MAX_EDITS,
                    )
                self._limit(
                    "SELECT at FROM proposal_events WHERE proposal_id = ? AND kind = 'edited' "
                    "AND at > ? ORDER BY at",
                    (proposal_id, to_db(self.now - EDIT_WINDOW)),
                    EDIT_LIMIT,
                    EDIT_WINDOW,
                    f"A proposal can be edited at most {EDIT_LIMIT} times an hour. Try again "
                    "later.",
                )
                self._count_write(identity, "edit")
                self._update(row, "title = ?, pitch = ?", (title, pitch))
                self._event(
                    proposal_id,
                    "edited",
                    f"{identity.login} edited the title or the pitch.",
                    actor=identity.login,
                )
        return self.detail(proposal_id, identity)

    def withdraw(self, identity: Identity, proposal_id: int) -> ProposalDetail:
        """The mover takes it back, any time before it's decided."""
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["mover_sub"] != identity.sub:
                raise _not_mover()
            if row["state"] not in ACTIVE_PROPOSAL_STATES:
                raise wrong_state(row["state"])
            self._count_write(identity, "withdraw")
            self._update(
                row, "state = 'withdrawn', deadline = NULL, decided_at = ?", (to_db(self.now),)
            )
            self._event(
                proposal_id, "withdrawn", f"{identity.login} withdrew it.", actor=identity.login
            )
        return self.detail(proposal_id, identity)

    def second(self, identity: Identity, proposal_id: int, revision: int) -> ProposalDetail:
        """Another member seconds the revision of the text they read (409 proposal_changed
        when it has been edited since): debate opens, its deadline is set, and the eligible
        set is frozen (the members seen in the last ELIGIBLE_ACTIVITY_DAYS days, the mover
        and the seconder always). The mover counts as consenting."""
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["mover_sub"] == identity.sub:
                raise _refuse(
                    403,
                    "own_proposal",
                    "You can't second your own proposal: another member has to.",
                )
            if row["state"] != "submitted":
                if row["seconder_sub"] is not None:
                    raise _refuse(
                        409,
                        "already_seconded",
                        "Another member has already seconded this proposal.",
                    )
                raise wrong_state(row["state"])
            current = self._revision(proposal_id)
            if revision != current:
                raise _refuse(
                    409,
                    "proposal_changed",
                    "The proposal changed since you opened it. Read it again, then second it.",
                    revision=current,
                )
            self._count_write(identity, "second")
            recent = recent_members(self.db, self.now - ELIGIBLE_ACTIVITY)
            eligible = {member.sub: member.login for member in recent}
            eligible.setdefault(row["mover_sub"], row["mover_login"])
            eligible[identity.sub] = identity.login
            self.db.executemany(
                "INSERT INTO proposal_eligible (proposal_id, sub, login) VALUES (?, ?, ?)",
                [(proposal_id, sub, login) for sub, login in eligible.items()],
            )
            self.db.execute(
                "INSERT INTO proposal_consents (proposal_id, sub, login, choice, at) "
                "VALUES (?, ?, ?, 'consented', ?)",
                (proposal_id, row["mover_sub"], row["mover_login"], to_db(self.now)),
            )
            self._update(
                row,
                "state = 'debate', seconder_sub = ?, seconder_login = ?, seconded_at = ?, "
                "deadline = ?",
                (
                    identity.sub,
                    identity.login,
                    to_db(self.now),
                    to_db(self.now + self.timers().debate),
                ),
            )
            self._event(
                proposal_id,
                "seconded",
                f"{identity.login} seconded it, so debate is open. The {len(eligible)} members "
                f"of the eligible set (those active in the last {ELIGIBLE_ACTIVITY_DAYS} days) "
                "can consent or object, and vote if it comes to that.",
                actor=identity.login,
            )
            self._event(
                proposal_id,
                "consented",
                f"{row['mover_login']} brought it, so counts as consenting.",
                actor=row["mover_login"],
            )
            title = _quoted(row["title"])
            self._notify(
                (sub for sub in eligible if sub not in (row["mover_sub"], identity.sub)),
                "proposal_seconded",
                f"{identity.login} seconded {title}. Debate is open: consent, object or comment.",
                proposal_id,
            )
            self._notify(
                [row["mover_sub"]],
                "your_proposal_seconded",
                f"{identity.login} seconded your proposal {title}. Debate is open.",
                proposal_id,
            )
        return self.detail(proposal_id, identity)

    def consent(
        self, identity: Identity, proposal_id: int, request: ConsentRequest
    ) -> ProposalDetail:
        """Consent (true) or object (false) during debate, once: objecting is final, and
        the mover consented already. The last consent passes it at once."""
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["state"] != "debate":
                raise wrong_state(row["state"])
            if not self._is_eligible(proposal_id, identity.sub):
                raise _not_eligible()
            if self._consent_of(proposal_id, identity.sub) is not None:
                raise _refuse(
                    409,
                    "already_decided_consent",
                    "You brought this proposal, so you already count as consenting."
                    if row["mover_sub"] == identity.sub
                    else "You've already consented or objected, and that can't be changed.",
                )
            choice: ConsentChoice = "consented" if request.consent else "objected"
            self._count_write(identity, "consent")
            self.db.execute(
                "INSERT INTO proposal_consents (proposal_id, sub, login, choice, at) "
                "VALUES (?, ?, ?, ?, ?)",
                (proposal_id, identity.sub, identity.login, choice, to_db(self.now)),
            )
            self._event(
                proposal_id,
                choice,
                f"{identity.login} consented."
                if request.consent
                else f"{identity.login} objected, so it goes to a vote when debate ends.",
                actor=identity.login,
            )
            self.advance_one(proposal_id)
        return self.detail(proposal_id, identity)

    def comment(
        self, identity: Identity, proposal_id: int, request: CommentRequest
    ) -> ProposalDetail:
        """Any member, from the second until the vote closes; COMMENT_LIMIT an hour each."""
        text = clean_paragraphs(request.text, PROPOSAL_LIMITS["comment"])
        _cleaned({"text": text})
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["state"] not in ("debate", "voting"):
                raise wrong_state(row["state"])
            self._limit(
                "SELECT at FROM proposal_comments WHERE proposal_id = ? AND author_sub = ? "
                "AND at > ? ORDER BY at",
                (proposal_id, identity.sub, to_db(self.now - COMMENT_WINDOW)),
                COMMENT_LIMIT,
                COMMENT_WINDOW,
                f"You can post at most {COMMENT_LIMIT} comments an hour on one proposal. "
                "Try again later.",
            )
            self.db.execute(
                "INSERT INTO proposal_comments (proposal_id, author_sub, author_login, text, at) "
                "VALUES (?, ?, ?, ?, ?)",
                (proposal_id, identity.sub, identity.login, text, to_db(self.now)),
            )
            self._event(
                proposal_id, "commented", f"{identity.login} commented.", actor=identity.login
            )
        return self.detail(proposal_id, identity)

    def vote(self, identity: Identity, proposal_id: int, request: VoteRequest) -> ProposalDetail:
        """A member of the eligible set votes, or changes their vote, until it closes."""
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["state"] != "voting":
                raise wrong_state(row["state"])
            if not self._is_eligible(proposal_id, identity.sub):
                raise _not_eligible()
            self._count_write(identity, "vote")
            self.db.execute(
                "INSERT INTO proposal_votes (proposal_id, sub, login, choice, at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT (proposal_id, sub) DO UPDATE SET "
                "login = excluded.login, choice = excluded.choice, at = excluded.at",
                (proposal_id, identity.sub, identity.login, request.choice, to_db(self.now)),
            )
        return self.detail(proposal_id, identity)

    # an admin's actions

    def set_test_timers(self, admin: Identity, on: bool) -> ProposalSettings:
        """Switch Test timers. Only deadlines set afterwards change; each proposal still
        active gets a line in its timeline saying so."""
        with self.db.transaction():
            if on != self.test_timers():
                self.advance_all()
                self.db.execute(
                    "INSERT INTO proposal_settings (name, value, updated_at, updated_by) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, "
                    "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                    (_TEST_TIMERS_SETTING, "on" if on else "off", to_db(self.now), admin.login),
                )
                kind: ProposalEventKind = "test_timers_on" if on else "test_timers_off"
                message = (
                    f"{admin.login}, an admin, switched test timers on: deadlines set from now "
                    "on are minutes, not days."
                    if on
                    else f"{admin.login}, an admin, switched test timers off: deadlines set "
                    "from now on are days again."
                )
                active = self.db.query_all(
                    f"SELECT id FROM proposal_motions WHERE state IN ({_ACTIVE_SQL}) ORDER BY id"
                )
                for row in active:
                    self._event(row["id"], kind, message, actor=admin.login)
        return ProposalSettings(testTimers=bool(on))

    def _require_test_timers(self) -> None:
        """The admin buttons are test tools: 409 test_mode_off unless Test timers are on, so
        nobody can cut a real debate or vote short."""
        if not self.test_timers():
            raise _refuse(
                409,
                "test_mode_off",
                "End debate now and Close the vote now work only while Test timers are on.",
            )

    def end_debate(self, admin: Identity, proposal_id: int) -> ProposalDetail:
        """The "End debate now" button, while Test timers are on: as if its deadline had
        passed this moment."""
        with self.db.transaction():
            row = self._current(proposal_id)
            self._require_test_timers()
            if row["state"] != "debate":
                raise wrong_state(row["state"])
            self._event(
                proposal_id,
                "admin_ended_debate",
                f"{admin.login}, an admin, ended debate now.",
                actor=admin.login,
            )
            facts = replace(_facts(row), deadline=self.now)
            self._apply(row, advance(facts, self.now, self.timers()))
        return self.detail(proposal_id, admin)

    def close_vote(self, admin: Identity, proposal_id: int) -> ProposalDetail:
        """The "Close the vote now" button, while Test timers are on: tallied as if its
        deadline had passed now."""
        with self.db.transaction():
            row = self._current(proposal_id)
            self._require_test_timers()
            if row["state"] != "voting":
                raise wrong_state(row["state"])
            self._event(
                proposal_id,
                "admin_closed_vote",
                f"{admin.login}, an admin, closed the vote now.",
                actor=admin.login,
            )
            facts = replace(_facts(row), deadline=self.now)
            self._apply(row, advance(facts, self.now, self.timers()))
        return self.detail(proposal_id, admin)

    def put_draft(
        self, admin: Identity, proposal_id: int, request: DraftTaskRequest
    ) -> ProposalDetail:
        """An admin finishes the draft task of a passed proposal (before it's published).
        Its tier floor must be T0 while no contributor is above it (400 tier_not_open)."""
        if request.tierFloor not in OPEN_TIER_FLOORS:
            raise _tier_not_open()
        criteria = [
            clean_line(item, PROPOSAL_LIMITS["criterion"]) for item in request.acceptanceCriteria
        ]
        title = clean_line(request.title, PROPOSAL_LIMITS["title"])
        summary = clean_line(request.civilianSummary, PROPOSAL_LIMITS["summary"])
        _cleaned(
            {
                "title": title,
                "civilianSummary": summary,
                **{f"acceptanceCriteria.{index}": item for index, item in enumerate(criteria)},
            }
        )
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["state"] != "passed":
                raise wrong_state(row["state"])
            self.db.execute(
                "INSERT INTO proposal_drafts (proposal_id, title, civilian_summary, "
                "acceptance_criteria, size, tier_floor, reward_class, updated_at, updated_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (proposal_id) DO UPDATE SET "
                "title = excluded.title, civilian_summary = excluded.civilian_summary, "
                "acceptance_criteria = excluded.acceptance_criteria, size = excluded.size, "
                "tier_floor = excluded.tier_floor, reward_class = excluded.reward_class, "
                "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                (
                    proposal_id,
                    title,
                    summary,
                    json.dumps(criteria),
                    request.size,
                    request.tierFloor,
                    request.rewardClass,
                    to_db(self.now),
                    admin.login,
                ),
            )
        return self.detail(proposal_id, admin)

    def publish(self, admin: Identity, proposal_id: int) -> ProposalDetail:
        """The "Publish to the board" button: the finished draft becomes a Contribute task
        (id 10001 up) and the proposal moves to building, in one transaction. A draft that isn't
        finished (no criteria yet, or a summary over the limit) is 400 invalid_request; one
        with a tier floor above T0 is 400 tier_not_open, since nobody could claim it; and one
        whose title has no letter or digit to name its branch is 400
        task_title_needs_letters."""
        with self.db.transaction():
            row = self._current(proposal_id)
            if row["state"] != "passed":
                raise wrong_state(row["state"])
            draft = self._draft(proposal_id, None)
            if draft is None:  # every passed proposal gets one; never publish without
                raise invalid_request(["draft"])
            try:
                ready = DraftTaskRequest.model_validate(draft.model_dump(exclude={"taskId"}))
            except ValidationError as exc:
                fields = error_fields(exc)
                raise invalid_request(
                    fields,
                    f"Finish the draft task before publishing it: check {', '.join(fields)}.",
                ) from None
            if ready.tierFloor not in OPEN_TIER_FLOORS:
                raise _tier_not_open()
            if not slugify(ready.title):
                raise _refuse(
                    400,
                    "task_title_needs_letters",
                    "Give the task a title with a letter or a digit from A to Z or 0 to 9: "
                    "its branch is named after it.",
                )
            task = bridge_service.publish_task(
                self.db,
                title=ready.title,
                civilian_summary=ready.civilianSummary,
                acceptance_criteria=list(ready.acceptanceCriteria),
                size=ready.size,
                tier_floor=ready.tierFloor,
                reward_class=ready.rewardClass,
                url=task_url(proposal_id),
                labels=["agent-ready", "status:open", f"size:{ready.size}", FROM_PROPOSAL_LABEL],
                published_by=admin.login,
                now=self.now,
            )
            self.db.execute(
                "INSERT INTO proposal_tasks (proposal_id, task_id, published_at, published_by) "
                "VALUES (?, ?, ?, ?)",
                (proposal_id, task.id, to_db(self.now), admin.login),
            )
            self._update(row, "state = 'building'")
            self._event(
                proposal_id,
                "task_published",
                f"{admin.login}, an admin, published it to the Contribute board as task "
                f"#{task.id}.",
                actor=admin.login,
            )
            self._notify(
                self._involved(proposal_id),
                "task_published",
                f"{_quoted(row['title'])} is on the Contribute board as task #{task.id}.",
                proposal_id,
            )
        return self.detail(proposal_id, admin)

    # the Bridge's word

    def ship(self, task_id: int) -> bool:
        """The task published from a proposal was merged: building -> shipped, once.
        False when the task isn't a proposal's, or the proposal isn't building."""
        link = self.db.query_one(
            "SELECT proposal_id FROM proposal_tasks WHERE task_id = ?", (task_id,)
        )
        if link is None:
            return False
        with self.db.transaction():
            row = self._load(link["proposal_id"])
            if row is None or row["state"] != "building":
                return False
            self._update(row, "state = 'shipped'")
            self._event(
                row["id"],
                "shipped",
                f"The pull request for task #{task_id} was merged, so it has shipped.",
            )
        return True


def advance_all(db: StateDB, now: datetime) -> int:
    """Apply every proposal transition due at `now`: the ticker's beat, and every list
    read's first step. Returns how many steps were applied."""
    return Proposals(db, now).advance_all()


def note_floor_closed(now: datetime) -> None:
    """A request was refused because the `proposals` flag is off: record that the floor
    closed, if nothing has yet, without waiting for the ticker's next beat. Best effort:
    the refusal stands whatever happens here, and a failure is only logged."""
    try:
        Proposals(get_state_db(), now).floor_open()
    except Exception:
        logger.exception("Couldn't record that the floor closed; the ticker's next beat will.")


def _on_task_shipped(db: StateDB, task_id: int, now: datetime) -> None:
    Proposals(db, now).ship(task_id)


bridge_service.on_task_shipped(_on_task_shipped)

# --- the ticker -----------------------------------------------------------------------


def tick(db: StateDB, now: datetime) -> int:
    """One beat: advance_all. While members can't act (`proposals` or `github_signin` off)
    nothing moves and the beat records when the floor closed; the first beat or read after
    it opens again moves every running deadline later by that long, then carries on."""
    return advance_all(db, now)


def _beat(db_fn: Callable[[], StateDB], now_fn: Callable[[], datetime]) -> int:
    return tick(db_fn(), now_fn())


async def run_ticker(
    interval: float = TICK_SECONDS,
    *,
    db_fn: Callable[[], StateDB] = get_state_db,
    now_fn: Callable[[], datetime] = current_time,
) -> None:
    """Every `interval` seconds, apply the proposal deadlines that have passed, in a
    worker thread (the database blocks). A failing beat is logged and the next one tries
    again; cancelling the task stops it."""
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(_beat, db_fn, now_fn)
        except Exception:
            logger.exception("A proposals ticker beat failed; the next one tries again.")
