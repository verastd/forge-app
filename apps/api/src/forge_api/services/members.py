"""Members: every GitHub account FORGE has seen signed in (Phase 5 contract §3).

`touch_member` records the caller, and refreshes their login and last-seen time, on every
identity-bearing proposals and notifications route and on `POST /api/members/hello`, which
the web's sign-in callback calls once after a GitHub sign-in. The bell's poll refreshes it
while a member has FORGE open. A proposal's eligible set is the members seen in the last
ELIGIBLE_ACTIVITY_DAYS days at the moment it is seconded (`recent_members`), plus the mover
and the seconder (services/proposals.py), so accounts that signed in once and left don't
count toward quorum forever.

The table starts empty and is never backfilled: accounts FORGE knew before Phase 5 (Bridge
lease holders, connector users) become members when they next sign in or use a Phase 5
route.

The table is `members`: one row per GitHub user id (`sub`), never per login, because a
login can be renamed and then registered by someone else.

This module also holds the two things every Phase 5 route shares: the state database's
time format, and `current_time`, the clock a request acts at (tests override it).
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from forge_api.services.identity import Identity
from forge_api.services.state import StateDB, register_schema

#: Fixed width (always microseconds), so stored times sort as text: the Bridge's format.
DB_TIME = "%Y-%m-%dT%H:%M:%S.%fZ"

register_schema(
    "members",
    [
        """CREATE TABLE IF NOT EXISTS members (
            sub TEXT PRIMARY KEY,
            login TEXT NOT NULL,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )""",
    ],
)


def to_db(moment: datetime) -> str:
    """A time as the state database keeps it (UTC, fixed width)."""
    return moment.astimezone(UTC).strftime(DB_TIME)


def from_db(value: str) -> datetime:
    return datetime.strptime(value, DB_TIME).replace(tzinfo=UTC)


def current_time() -> datetime:
    """FastAPI dependency: the time a request acts at. Tests override it with a fake
    clock, so every deadline on the floor can be crossed without waiting."""
    return datetime.now(UTC)


@dataclass(frozen=True)
class Member:
    sub: str
    login: str


def touch_member(db: StateDB, identity: Identity, now: datetime) -> None:
    """Record `identity` as a member: added the first time, and its login and last-seen
    time refreshed after that (last_seen never moves backwards)."""
    stamp = to_db(now)
    db.execute(
        "INSERT INTO members (sub, login, first_seen, last_seen) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (sub) DO UPDATE SET login = excluded.login, "
        "last_seen = MAX(members.last_seen, excluded.last_seen)",
        (identity.sub, identity.login, stamp, stamp),
    )


def all_members(db: StateDB) -> list[Member]:
    """Every member, oldest first."""
    rows = db.query_all("SELECT sub, login FROM members ORDER BY first_seen, sub")
    return [Member(sub=row["sub"], login=row["login"]) for row in rows]


def member_subs(db: StateDB) -> list[str]:
    return [member.sub for member in all_members(db)]


def recent_members(db: StateDB, since: datetime) -> list[Member]:
    """Every member seen after `since` (last_seen later than it), oldest first."""
    rows = db.query_all(
        "SELECT sub, login FROM members WHERE last_seen > ? ORDER BY first_seen, sub",
        (to_db(since),),
    )
    return [Member(sub=row["sub"], login=row["login"]) for row in rows]
