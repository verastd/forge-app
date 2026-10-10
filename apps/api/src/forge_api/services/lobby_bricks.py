"""Building bricks in the Apps lobby (behind `apps_lobby`): the cave's shared, permanent
build.

Only the brick maker (the robot wearing a back model that makes bricks: services/avatars.py
`is_brick_maker`) makes bricks and takes them away. Anyone signed in may pick up a loose
brick and place it; a brick something is fastened to is part of a build, frozen for
everyone but the maker. Where a brick may go is services/brick_rules.py.

A brick is held (in someone's hand: x, y, z, rot is where it was taken from) or placed. A
hold left longer than HOLD_LAPSE (they left, or their tab died) lapses: the brick goes back
where it was if it still fits, else to the nearest free floor spot, and a brick that was
never placed is taken away.

Every change bumps the cave's revision and stamps it on the row, so a browser asks only
for what changed since the revision it has. A brick taken away leaves a tombstone for a
day so those deltas can say so; a browser further behind than that gets everything.
"""

import secrets
from datetime import datetime, timedelta
from typing import Any, Final

from forge_api.models import Brick, BrickChange, BrickList, BrickMake, BrickMe, BrickPlace
from forge_api.services import avatars as avatars_service
from forge_api.services import brick_rules as rules
from forge_api.services import members as members_service
from forge_api.services.errors import ApiError
from forge_api.services.state import StateDB, register_schema

FLAG: Final = "apps_lobby"
#: How long a brick may stay in a hand before it goes back.
HOLD_LAPSE: Final = timedelta(minutes=5)
#: How long a taken-away brick's tombstone is kept for deltas.
TOMBSTONE_KEEP: Final = timedelta(days=1)

register_schema(
    "lobby_bricks",
    [
        """CREATE TABLE IF NOT EXISTS lobby_bricks (
            id TEXT PRIMARY KEY,
            shape TEXT NOT NULL,
            color TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            z INTEGER NOT NULL,
            rot INTEGER NOT NULL,
            holder TEXT,
            held_at TEXT,
            has_home INTEGER NOT NULL,
            gone INTEGER NOT NULL,
            rev INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS lobby_bricks_rev ON lobby_bricks (rev)",
        # The cave's revision (`rev`), and the oldest revision a delta can start from
        # (`floor`: tombstones before it are gone).
        """CREATE TABLE IF NOT EXISTS lobby_bricks_meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        )""",
    ],
)


def _meta(db: StateDB, key: str) -> int:
    row = db.query_one("SELECT value FROM lobby_bricks_meta WHERE key = ?", (key,))
    return int(row["value"]) if row else 0


def _set_meta(db: StateDB, key: str, value: int) -> None:
    db.execute(
        "INSERT INTO lobby_bricks_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _bump(db: StateDB) -> int:
    rev = _meta(db, "rev") + 1
    _set_meta(db, "rev", rev)
    return rev


def _brick(row: dict[str, Any]) -> Brick:
    return Brick(
        id=row["id"],
        shape=row["shape"],
        color=row["color"],
        x=row["x"],
        y=row["y"],
        z=row["z"],
        rot=row["rot"],
        holder=row["holder"],
        updatedAt=members_service.from_db(row["updated_at"]).isoformat(),
    )


def _at(row: dict[str, Any]) -> rules.At:
    return rules.At(row["shape"], row["x"], row["y"], row["z"], row["rot"])


def _placed(db: StateDB, but: str | None = None) -> list[rules.At]:
    rows = db.query_all(
        "SELECT * FROM lobby_bricks WHERE gone = 0 AND holder IS NULL AND id IS NOT ?", (but,)
    )
    return [_at(row) for row in rows]


def _row(db: StateDB, brick_id: str) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM lobby_bricks WHERE id = ? AND gone = 0", (brick_id,))
    if row is None:
        raise ApiError(404, {"error": "brick_not_found"})
    return row


def _take_away(db: StateDB, brick_id: str, now: datetime) -> int:
    rev = _bump(db)
    db.execute(
        "UPDATE lobby_bricks SET gone = 1, holder = NULL, held_at = NULL, rev = ?, "
        "updated_at = ? WHERE id = ?",
        (rev, members_service.to_db(now), brick_id),
    )
    return rev


def _move(db: StateDB, brick_id: str, at: rules.At, holder: str | None, now: datetime) -> int:
    rev = _bump(db)
    stamp = members_service.to_db(now)
    db.execute(
        "UPDATE lobby_bricks SET x = ?, y = ?, z = ?, rot = ?, holder = ?, held_at = ?, "
        "has_home = 1, rev = ?, updated_at = ? WHERE id = ?",
        (at.x, at.y, at.z, at.rot, holder, stamp if holder else None, rev, stamp, brick_id),
    )
    return rev


def _lapse(db: StateDB, now: datetime) -> None:
    """Puts back every brick held too long (or takes it away, if it was never placed)."""
    cutoff = members_service.to_db(now - HOLD_LAPSE)
    stale = db.query_all(
        "SELECT * FROM lobby_bricks WHERE gone = 0 AND holder IS NOT NULL AND held_at < ? "
        "ORDER BY held_at",
        (cutoff,),
    )
    for row in stale:
        home = _at(row)
        placed = _placed(db)
        spot: rules.At | None = None
        if row["has_home"]:
            spot = (
                home
                if rules.problem(home, placed) is None
                else rules.floor_spot(home.shape, home.rot, home.x, home.z, placed)
            )
        if spot is None:
            _take_away(db, row["id"], now)
        else:
            _move(db, row["id"], spot, None, now)


def _purge(db: StateDB, now: datetime) -> None:
    """Forgets tombstones older than TOMBSTONE_KEEP; deltas from before them get everything."""
    cutoff = members_service.to_db(now - TOMBSTONE_KEEP)
    old = db.query_one(
        "SELECT MAX(rev) AS rev FROM lobby_bricks WHERE gone = 1 AND updated_at < ?", (cutoff,)
    )
    if old is None or old["rev"] is None:
        return
    db.execute("DELETE FROM lobby_bricks WHERE gone = 1 AND updated_at < ?", (cutoff,))
    _set_meta(db, "floor", max(_meta(db, "floor"), int(old["rev"])))


def list_bricks(db: StateDB, since: int | None, now: datetime) -> BrickList:
    """Every brick, or only what changed after revision `since` (when it can say)."""
    with db.transaction():
        _lapse(db, now)
        _purge(db, now)
        rev = _meta(db, "rev")
        if since is None or since < _meta(db, "floor") or since > rev:
            rows = db.query_all("SELECT * FROM lobby_bricks WHERE gone = 0 ORDER BY rev")
            return BrickList(rev=rev, full=True, bricks=[_brick(r) for r in rows], gone=[])
        rows = db.query_all("SELECT * FROM lobby_bricks WHERE rev > ? ORDER BY rev", (since,))
    return BrickList(
        rev=rev,
        full=False,
        bricks=[_brick(r) for r in rows if not r["gone"]],
        gone=[r["id"] for r in rows if r["gone"]],
    )


def me(db: StateDB, member_id: str) -> BrickMe:
    """Who the caller is to the bricks, and whether they make them (the browser's keys and
    panel follow it; every maker-only call still checks)."""
    return BrickMe(memberId=member_id, maker=avatars_service.is_brick_maker(db, member_id))


def _require_maker(db: StateDB, member_id: str) -> None:
    if not avatars_service.is_brick_maker(db, member_id):
        raise ApiError(403, {"error": "not_the_maker"})


def _hands_free(db: StateDB, member_id: str, but: str | None = None) -> None:
    held = db.query_one(
        "SELECT id FROM lobby_bricks WHERE gone = 0 AND holder = ? AND id IS NOT ?",
        (member_id, but),
    )
    if held is not None:
        raise ApiError(409, {"error": "hands_full", "brick": held["id"]})


def _change(db: StateDB, rev: int, brick_id: str) -> BrickChange:
    row = db.query_one("SELECT * FROM lobby_bricks WHERE id = ? AND gone = 0", (brick_id,))
    return BrickChange(rev=rev, brick=_brick(row) if row else None)


def make(db: StateDB, member_id: str, body: BrickMake, now: datetime) -> BrickChange:
    """A new brick in the maker's hand. 403 not_the_maker, 409 hands_full / brick_limit."""
    with db.transaction():
        _lapse(db, now)
        _require_maker(db, member_id)
        _hands_free(db, member_id)
        count = db.query_one("SELECT COUNT(*) AS n FROM lobby_bricks WHERE gone = 0")
        if count is not None and count["n"] >= rules.LIMIT:
            raise ApiError(409, {"error": "brick_limit", "limit": rules.LIMIT})
        brick_id = secrets.token_hex(6)
        rev = _bump(db)
        stamp = members_service.to_db(now)
        db.execute(
            "INSERT INTO lobby_bricks (id, shape, color, x, y, z, rot, holder, held_at, "
            "has_home, gone, rev, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, ?, ?)",
            (brick_id, body.shape, body.color, member_id, stamp, rev, stamp),
        )
        return _change(db, rev, brick_id)


def pick(db: StateDB, member_id: str, brick_id: str, now: datetime) -> BrickChange:
    """Into the caller's hand: a loose brick for anyone, any brick for the maker.
    404 brick_not_found; 409 taken (someone has it), frozen (part of a build), hands_full."""
    with db.transaction():
        _lapse(db, now)
        row = _row(db, brick_id)
        if row["holder"] == member_id:
            return _change(db, _meta(db, "rev"), brick_id)
        if row["holder"] is not None:
            raise ApiError(409, {"error": "taken"})
        _hands_free(db, member_id)
        if not avatars_service.is_brick_maker(db, member_id):
            here = _at(row)
            if rules.frozen(here, _placed(db, but=brick_id)):
                raise ApiError(409, {"error": "frozen"})
        rev = _move(db, brick_id, _at(row), member_id, now)
        return _change(db, rev, brick_id)


def place(
    db: StateDB, member_id: str, brick_id: str, body: BrickPlace, now: datetime
) -> BrickChange:
    """Puts the caller's brick down where `body` says, if it fits there.
    404 brick_not_found; 409 not_holding, wont_fit (with the rule's `problem`)."""
    with db.transaction():
        _lapse(db, now)
        row = _row(db, brick_id)
        if row["holder"] != member_id:
            raise ApiError(409, {"error": "not_holding"})
        at = rules.At(row["shape"], body.x, body.y, body.z, body.rot)
        problem = rules.problem(at, _placed(db, but=brick_id))
        if problem is not None:
            raise ApiError(409, {"error": "wont_fit", "problem": problem})
        rev = _move(db, brick_id, at, None, now)
        return _change(db, rev, brick_id)


def remove(db: StateDB, member_id: str, brick_id: str, now: datetime) -> BrickChange:
    """Takes a brick out of the cave (the maker only). 403 not_the_maker, 404."""
    with db.transaction():
        _require_maker(db, member_id)
        _row(db, brick_id)
        rev = _take_away(db, brick_id, now)
        return BrickChange(rev=rev)
