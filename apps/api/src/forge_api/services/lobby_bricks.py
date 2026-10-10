"""Building bricks in the Apps lobby (behind `apps_lobby`): the cave's shared, permanent
build.

Only the brick maker (the robot wearing a back model that makes bricks: services/avatars.py
`is_brick_maker`, or an admin who switched on "Be the Lego bot" to test) makes bricks and
takes them away. Anyone signed in may pick up a loose brick and place it; a brick something
is fastened to is part of a build, frozen for everyone but the maker. Where a brick may go
is services/brick_rules.py.

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

from forge_api.models import (
    Brick,
    BrickBuild,
    BrickBuilt,
    BrickChange,
    BrickList,
    BrickMake,
    BrickMe,
    BrickPlace,
    BrickTakenDown,
)
from forge_api.services import avatars as avatars_service
from forge_api.services import brick_rules as rules
from forge_api.services import lobby_machines as _machines  # noqa: F401  (its stand-ins table)
from forge_api.services import members as members_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity, is_admin
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
        # Admins testing as the brick maker ("Be the Lego bot"). A row: switched on. It only
        # counts while they're still an admin (is_admin, every call).
        """CREATE TABLE IF NOT EXISTS lobby_bricks_stand_ins (
            member_id TEXT PRIMARY KEY,
            since TEXT NOT NULL
        )""",
        # The cave's revision (`rev`), and the oldest revision a delta can start from
        # (`floor`: tombstones before it are gone).
        """CREATE TABLE IF NOT EXISTS lobby_bricks_meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        )""",
        # Which blueprint build a brick came from (a row per brick of a build, kept while
        # the brick is: it goes with its tombstone), so the whole build comes down at once.
        """CREATE TABLE IF NOT EXISTS lobby_bricks_builds (
            brick_id TEXT PRIMARY KEY,
            build_id TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS lobby_bricks_builds_build ON lobby_bricks_builds (build_id)",
    ],
)

#: Every brick with the build it came from (b_build: NULL for a brick made by hand).
_BRICK_SELECT: Final = (
    "SELECT k.*, b.build_id AS b_build FROM lobby_bricks k "
    "LEFT JOIN lobby_bricks_builds b ON b.brick_id = k.id"
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
        build=row.get("b_build"),
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
    db.execute(
        "DELETE FROM lobby_bricks_builds WHERE brick_id NOT IN (SELECT id FROM lobby_bricks)"
    )
    _set_meta(db, "floor", max(_meta(db, "floor"), int(old["rev"])))


def list_bricks(db: StateDB, since: int | None, now: datetime) -> BrickList:
    """Every brick, or only what changed after revision `since` (when it can say)."""
    with db.transaction():
        _lapse(db, now)
        _purge(db, now)
        _tag_old_builds(db)
        rev = _meta(db, "rev")
        if since is None or since < _meta(db, "floor") or since > rev:
            rows = db.query_all(f"{_BRICK_SELECT} WHERE k.gone = 0 ORDER BY k.rev")
            return BrickList(rev=rev, full=True, bricks=[_brick(r) for r in rows], gone=[])
        rows = db.query_all(f"{_BRICK_SELECT} WHERE k.rev > ? ORDER BY k.rev", (since,))
    return BrickList(
        rev=rev,
        full=False,
        bricks=[_brick(r) for r in rows if not r["gone"]],
        gone=[r["id"] for r in rows if r["gone"]],
    )


def _member(user: Identity) -> str:
    return f"gh:{user.sub}"


def _standing_in(db: StateDB, user: Identity) -> bool:
    row = db.query_one("SELECT 1 FROM lobby_bricks_stand_ins WHERE member_id = ?", (_member(user),))
    return row is not None


def _is_maker(db: StateDB, user: Identity) -> bool:
    """The brick maker: wearing the brick-making backpack, or an admin testing as it."""
    if avatars_service.is_brick_maker(db, _member(user)):
        return True
    return is_admin(user) and _standing_in(db, user)


def me(db: StateDB, user: Identity) -> BrickMe:
    """Who the caller is to the bricks, and whether they make them (the browser's keys and
    panel follow it; every maker-only call still checks)."""
    admin = is_admin(user)
    return BrickMe(
        memberId=_member(user),
        maker=_is_maker(db, user),
        canStandIn=admin,
        standIn=admin and _standing_in(db, user),
    )


def stand_in(db: StateDB, user: Identity, on: bool, now: datetime) -> BrickMe:
    """An admin takes over the brick maker's powers to test them, or gives them back.
    403 admin_only."""
    if not is_admin(user):
        raise ApiError(403, {"error": "admin_only"})
    with db.transaction():
        if on:
            db.execute(
                "INSERT INTO lobby_bricks_stand_ins (member_id, since) VALUES (?, ?) "
                "ON CONFLICT (member_id) DO NOTHING",
                (_member(user), members_service.to_db(now)),
            )
            # One role at a time: being the Lego bot stops being the mechanic.
            db.execute("DELETE FROM lobby_machines_stand_ins WHERE member_id = ?", (_member(user),))
        else:
            db.execute("DELETE FROM lobby_bricks_stand_ins WHERE member_id = ?", (_member(user),))
        return me(db, user)


def _require_maker(db: StateDB, user: Identity) -> None:
    if not _is_maker(db, user):
        raise ApiError(403, {"error": "not_the_maker"})


def _hands_free(db: StateDB, member_id: str, but: str | None = None) -> None:
    held = db.query_one(
        "SELECT id FROM lobby_bricks WHERE gone = 0 AND holder = ? AND id IS NOT ?",
        (member_id, but),
    )
    if held is not None:
        raise ApiError(409, {"error": "hands_full", "brick": held["id"]})


def _change(db: StateDB, rev: int, brick_id: str) -> BrickChange:
    row = db.query_one(f"{_BRICK_SELECT} WHERE k.id = ? AND k.gone = 0", (brick_id,))
    return BrickChange(rev=rev, brick=_brick(row) if row else None)


def make(db: StateDB, user: Identity, body: BrickMake, now: datetime) -> BrickChange:
    """A new brick: dropped loose on the floor at `body.at` (out of the backpack's ramp), or
    into the maker's hand. 403 not_the_maker; 409 hands_full (into the hand), brick_limit,
    wont_fit (where it drops)."""
    member_id = _member(user)
    with db.transaction():
        _lapse(db, now)
        _require_maker(db, user)
        if body.at is None:
            _hands_free(db, member_id)
        count = db.query_one("SELECT COUNT(*) AS n FROM lobby_bricks WHERE gone = 0")
        if count is not None and count["n"] >= rules.LIMIT:
            raise ApiError(409, {"error": "brick_limit", "limit": rules.LIMIT})
        at = body.at
        if at is not None:
            spot = rules.At(body.shape, at.x, at.y, at.z, at.rot)
            problem = rules.problem(spot, _placed(db))
            if problem is not None:
                raise ApiError(409, {"error": "wont_fit", "problem": problem})
        brick_id = secrets.token_hex(6)
        rev = _bump(db)
        stamp = members_service.to_db(now)
        if at is None:
            db.execute(
                "INSERT INTO lobby_bricks (id, shape, color, x, y, z, rot, holder, held_at, "
                "has_home, gone, rev, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, ?, ?)",
                (brick_id, body.shape, body.color, member_id, stamp, rev, stamp),
            )
        else:
            db.execute(
                "INSERT INTO lobby_bricks (id, shape, color, x, y, z, rot, holder, held_at, "
                "has_home, gone, rev, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, 0, ?, ?)",
                (brick_id, body.shape, body.color, at.x, at.y, at.z, at.rot, rev, stamp),
            )
        return _change(db, rev, brick_id)


def build(db: StateDB, user: Identity, body: BrickBuild, now: datetime) -> BrickBuilt:
    """A blueprint built where it's placed, every brick new and placed, all at once: all of
    it fits or none of it is built. 403 not_the_maker; 409 brick_limit (with the room
    left), wont_fit (the first brick that doesn't, and why)."""
    with db.transaction():
        _lapse(db, now)
        _require_maker(db, user)
        count = db.query_one("SELECT COUNT(*) AS n FROM lobby_bricks WHERE gone = 0")
        room = rules.LIMIT - (count["n"] if count is not None else 0)
        if len(body.bricks) > room:
            raise ApiError(
                409, {"error": "brick_limit", "limit": rules.LIMIT, "room": max(0, room)}
            )
        pieces = [rules.At(p.shape, p.x, p.y, p.z, p.rot) for p in body.bricks]
        problems = rules.blueprint_problems(pieces, _placed(db))
        for index, problem in enumerate(problems):
            if problem is not None:
                raise ApiError(409, {"error": "wont_fit", "problem": problem, "index": index})
        rev = _bump(db)
        stamp = members_service.to_db(now)
        build_id = secrets.token_hex(6)
        ids = [secrets.token_hex(6) for _ in body.bricks]
        db.executemany(
            "INSERT INTO lobby_bricks (id, shape, color, x, y, z, rot, holder, held_at, "
            "has_home, gone, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, 0, ?, ?)",
            [
                (brick_id, p.shape, p.color, p.x, p.y, p.z, p.rot, rev, stamp)
                for brick_id, p in zip(ids, body.bricks, strict=True)
            ],
        )
        db.executemany(
            "INSERT INTO lobby_bricks_builds (brick_id, build_id) VALUES (?, ?)",
            [(brick_id, build_id) for brick_id in ids],
        )
        return BrickBuilt(rev=rev, built=len(body.bricks), build=build_id)


def pick(db: StateDB, user: Identity, brick_id: str, now: datetime) -> BrickChange:
    """Into the caller's hand: a loose brick for anyone, any brick for the maker.
    404 brick_not_found; 409 taken (someone has it), frozen (part of a build), hands_full."""
    member_id = _member(user)
    with db.transaction():
        _lapse(db, now)
        row = _row(db, brick_id)
        if row["holder"] == member_id:
            return _change(db, _meta(db, "rev"), brick_id)
        if row["holder"] is not None:
            raise ApiError(409, {"error": "taken"})
        _hands_free(db, member_id)
        if not _is_maker(db, user):
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


def remove(db: StateDB, user: Identity, brick_id: str, now: datetime) -> BrickChange:
    """Takes a brick out of the cave (the maker only). 403 not_the_maker, 404."""
    with db.transaction():
        _require_maker(db, user)
        _row(db, brick_id)
        rev = _take_away(db, brick_id, now)
        return BrickChange(rev=rev)


def _tag_old_builds(db: StateDB) -> None:
    """Once: tags the builds made before builds were tagged. A build wrote all its bricks
    under one revision, and nothing else writes two bricks under one, so the bricks still
    sharing a revision are a build (one moved since has its own revision: it's left out)."""
    if _meta(db, "builds_tagged"):
        return
    db.execute(
        "INSERT OR IGNORE INTO lobby_bricks_builds (brick_id, build_id) "
        "SELECT id, printf('%012x', rev) FROM lobby_bricks WHERE gone = 0 AND rev IN "
        "(SELECT rev FROM lobby_bricks WHERE gone = 0 GROUP BY rev HAVING COUNT(*) > 1)"
    )
    _set_meta(db, "builds_tagged", 1)


def take_down(db: StateDB, user: Identity, build_id: str, now: datetime) -> BrickTakenDown:
    """Takes a whole blueprint build out of the cave, every brick of it (placed, moved or
    in someone's hand), under one revision (the maker only). 403 not_the_maker;
    404 build_not_found (none of it is left)."""
    with db.transaction():
        _require_maker(db, user)
        _tag_old_builds(db)
        rows = db.query_all(
            "SELECT k.id FROM lobby_bricks k JOIN lobby_bricks_builds b ON b.brick_id = k.id "
            "WHERE b.build_id = ? AND k.gone = 0",
            (build_id,),
        )
        if not rows:
            raise ApiError(404, {"error": "build_not_found"})
        rev = _bump(db)
        stamp = members_service.to_db(now)
        db.executemany(
            "UPDATE lobby_bricks SET gone = 1, holder = NULL, held_at = NULL, rev = ?, "
            "updated_at = ? WHERE id = ?",
            [(rev, stamp, row["id"]) for row in rows],
        )
        return BrickTakenDown(rev=rev, removed=len(rows))
