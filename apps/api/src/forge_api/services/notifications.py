"""Notifications: the in-app bell (Phase 5 contract §3).

One row per member per notification in `notifications`. The proposals service fans them
out as a proposal moves (who gets which kind is decided there); this module stores them,
keeps each member's newest MAX_KEPT, lists the newest SHOWN with the unread count, and
marks them read. A notification's `message` is plain text built from a sanitized title
and GitHub logins, and its `href` a path on this site (`/propose/<id>`).

The routes need an identity and sit behind no flag of their own. Every kind today is a
proposal kind, and those are hidden (neither listed, counted nor marked) while the
`proposals` flag is off, so switching proposals off empties the bell without deleting
anything.
"""

from collections.abc import Iterable, Sequence
from datetime import datetime

from forge_api.models import (
    NOTIFICATION_KINDS,
    Notification,
    NotificationKind,
    NotificationList,
)
from forge_api.services import flags as flags_service
from forge_api.services.members import from_db, to_db
from forge_api.services.state import StateDB, register_schema

#: The newest notifications each member keeps; older ones are deleted.
MAX_KEPT = 200
#: How many GET /api/notifications lists.
SHOWN = 30
PROPOSALS_FLAG = "proposals"
#: Kinds that belong to proposals, shown only while the `proposals` flag is on.
PROPOSAL_KINDS: frozenset[NotificationKind] = frozenset(NOTIFICATION_KINDS)

register_schema(
    "notifications",
    [
        """CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sub TEXT NOT NULL,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            href TEXT NOT NULL,
            at TEXT NOT NULL,
            read_at TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS notifications_sub ON notifications (sub, id)",
    ],
)


def _iso(value: str) -> str:
    return from_db(value).isoformat().replace("+00:00", "Z")


def notify(
    db: StateDB,
    subs: Iterable[str],
    kind: NotificationKind,
    message: str,
    href: str,
    at: datetime,
) -> int:
    """Give each member in `subs` (duplicates once) one notification, and trim each of them
    to their newest MAX_KEPT. One `executemany` writes them all and one more trims, inside
    the caller's transaction, so a fan-out to every member holds the database briefly.
    Returns how many were written."""
    targets = list(dict.fromkeys(subs))
    if not targets:
        return 0
    stamp = to_db(at)
    with db.transaction():
        db.executemany(
            "INSERT INTO notifications (sub, kind, message, href, at) VALUES (?, ?, ?, ?, ?)",
            [(sub, kind, message, href, stamp) for sub in targets],
        )
        db.executemany(
            "DELETE FROM notifications WHERE sub = ? AND id <= ("
            "SELECT id FROM notifications WHERE sub = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
            [(sub, sub, MAX_KEPT) for sub in targets],
        )
    return len(targets)


def visible_kinds() -> tuple[NotificationKind, ...]:
    """The kinds the bell shows right now: the proposal kinds only while `proposals` is on."""
    proposals_on = flags_service.is_enabled(PROPOSALS_FLAG)
    return tuple(kind for kind in NOTIFICATION_KINDS if proposals_on or kind not in PROPOSAL_KINDS)


def _kind_filter(kinds: Sequence[str]) -> tuple[str, list[str]]:
    """`kind IN (?, ...)` for `kinds`; a filter nothing matches when there are none."""
    if not kinds:
        return "0", []
    return f"kind IN ({', '.join('?' for _ in kinds)})", list(kinds)


def list_notifications(db: StateDB, sub: str) -> NotificationList:
    """The member's newest SHOWN notifications, newest first, and how many of all their
    notifications are unread."""
    where, kinds = _kind_filter(visible_kinds())
    rows = db.query_all(
        f"SELECT * FROM notifications WHERE sub = ? AND {where} ORDER BY id DESC LIMIT ?",
        (sub, *kinds, SHOWN),
    )
    unread = db.query_one(
        f"SELECT COUNT(*) AS n FROM notifications WHERE sub = ? AND {where} AND read_at IS NULL",
        (sub, *kinds),
    )
    return NotificationList(
        notifications=[
            Notification(
                id=row["id"],
                kind=row["kind"],
                message=row["message"],
                href=row["href"],
                at=_iso(row["at"]),
                read=row["read_at"] is not None,
            )
            for row in rows
        ],
        unread=int(unread["n"]) if unread else 0,
    )


def mark_read(db: StateDB, sub: str, ids: Sequence[int] | None, now: datetime) -> NotificationList:
    """Mark the member's notifications in `ids` read, or every one of theirs when `ids` is
    None. Ids that aren't theirs (or don't exist) are ignored. Returns the bell afterwards."""
    where, kinds = _kind_filter(visible_kinds())
    with db.transaction():
        if ids is None:
            db.execute(
                f"UPDATE notifications SET read_at = ? WHERE sub = ? AND {where} "
                "AND read_at IS NULL",
                (to_db(now), sub, *kinds),
            )
        else:
            # An id SQLite can't hold matches nothing anyway.
            wanted = sorted({item for item in ids if 0 < item < 2**63})
            for start in range(0, len(wanted), 500):
                chunk = wanted[start : start + 500]
                db.execute(
                    f"UPDATE notifications SET read_at = ? WHERE sub = ? AND {where} "
                    f"AND read_at IS NULL AND id IN ({', '.join('?' for _ in chunk)})",
                    (to_db(now), sub, *kinds, *chunk),
                )
    return list_notifications(db, sub)
