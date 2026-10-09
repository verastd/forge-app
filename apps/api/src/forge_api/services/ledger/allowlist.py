"""The Upland Ledger gateway's allowlist: every upstream route the browser may reach.

A request is forwarded only when its method and path match one entry here exactly, segment
by segment; anything else is `404 not_found` and the ledger is never contacted. A literal
segment must match as written; a parameter segment must match its pattern in full. The
ledger's own `/health` and `/metrics` are not `/v1/*` routes and are not here.

Checked against the ledger's source (/srv/upland-ledger/apps/api/src: routes.ts,
entities/routes.ts, analytics/routes.ts, market/routes.ts). Paths are relative to `/v1/`.
"""

import re
from dataclasses import dataclass
from typing import Final, Literal

Method = Literal["GET", "POST"]

#: Path parameters, by name. Each is matched in full (`fullmatch`).
PARAMS: Final[dict[str, re.Pattern[str]]] = {
    # An Antelope account or contract name, the ledger's own rule: up to 12
    # characters of [a-z1-5.], or exactly 12 plus a 13th of [a-j1-5].
    "account": re.compile(r"[a-z1-5.]{1,12}|[a-z1-5.]{12}[a-j1-5]"),
    "contract": re.compile(r"[a-z1-5.]{1,12}|[a-z1-5.]{12}[a-j1-5]"),
    # UInt64s: digits only, at most 20 of them.
    "globalSequence": re.compile(r"[0-9]{1,20}"),
    "propertyId": re.compile(r"[0-9]{1,20}"),
    # A transaction id: 64 hex digits.
    "trxId": re.compile(r"[0-9a-fA-F]{64}"),
}


@dataclass(frozen=True)
class Route:
    method: Method
    #: Segments: a literal, or `{name}` for a parameter in PARAMS.
    segments: tuple[str, ...]


def _route(method: Method, template: str) -> Route:
    segments = tuple(template.split("/"))
    for segment in segments:
        if segment.startswith("{") and segment[1:-1] not in PARAMS:
            raise ValueError(f"unknown path parameter in {template!r}")  # pragma: no cover
    return Route(method, segments)


_GET_TEMPLATES: Final = (
    "accounts",
    "accounts/{account}",
    "accounts/{account}/actions",
    "actions",
    "actions/{globalSequence}",
    "analytics/accounts/top",
    "analytics/calendar",
    "analytics/flows",
    "analytics/keys",
    "analytics/overview",
    "analytics/sales",
    "analytics/timeseries",
    "chains",
    "collections",
    "contracts",
    "contracts/{contract}/actions",
    "ingest/windows",
    "listings",
    "market/cities",
    "market/fiat",
    "market/upx-usd",
    "neighborhoods",
    "offers",
    "properties",
    "properties/{propertyId}",
    "properties/{propertyId}/history",
    "rates",
    "sales",
    "search",
    "signals",
    "stats/actions",
    "status",
    "transactions/{trxId}",
    "transfers",
    "treasures",
)

#: Every route the gateway forwards. POST is the analytics query alone.
ROUTES: Final[tuple[Route, ...]] = (
    *(_route("GET", template) for template in _GET_TEMPLATES),
    _route("POST", "analytics/query"),
)


def _segment_matches(pattern: str, segment: str) -> bool:
    if pattern.startswith("{"):
        return PARAMS[pattern[1:-1]].fullmatch(segment) is not None
    return pattern == segment


def match(method: str, path: str) -> Route | None:
    """The allowlisted route `method path` is, or None. `path` is relative to /v1/ and must
    be plain: no empty, `.` or `..` segment, nothing percent-encoded, no backslash."""
    if not path or len(path) > 256 or "%" in path or "\\" in path:
        return None
    segments = path.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return None
    for route in ROUTES:
        if route.method != method or len(route.segments) != len(segments):
            continue
        if all(_segment_matches(p, s) for p, s in zip(route.segments, segments, strict=True)):
            return route
    return None
