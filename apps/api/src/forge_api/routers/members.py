"""Members (Phase 5 contract §3): `POST /api/members/hello`, and what the members,
proposals and notifications routers share.

`hello` is what the web's sign-in callback calls once after a GitHub sign-in, server-side
and best effort, with the usual API assertion: it records the caller as a member, so they
count in the eligible set of any proposal seconded from then on. 204, no body.

The dependencies below make every identity-bearing Phase 5 route record its caller as a
member first (`touch_member`), and read JSON bodies themselves: a bad one is
`400 invalid_request` naming the fields, never FastAPI's 422 (which echoes the input),
and one over MAX_BODY is `413 body_too_large`.
"""

from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel

from forge_api.services import members as members_service
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity, require_admin, require_identity
from forge_api.services.state import StateDB, get_state_db

#: The largest body read: a 4000-character pitch, every character escaped, fits easily.
MAX_BODY = 64 * 1024

Db = Annotated[StateDB, Depends(get_state_db)]
Now = Annotated[datetime, Depends(members_service.current_time)]


def member(identity: Annotated[Identity, Depends(require_identity)], db: Db, now: Now) -> Identity:
    """The verified caller (401 without one), recorded as a member."""
    members_service.touch_member(db, identity, now)
    return identity


def maybe_member(
    db: Db, now: Now, authorization: Annotated[str | None, Header()] = None
) -> Identity | None:
    """The verified caller recorded as a member, or None when the request carries no
    Authorization header at all. A header that is present but wrong is still 401."""
    if authorization is None:
        return None
    return member(require_identity(authorization), db, now)


def admin_member(
    identity: Annotated[Identity, Depends(require_admin)], db: Db, now: Now
) -> Identity:
    """An allowlisted admin (403 admin_only otherwise), recorded as a member."""
    members_service.touch_member(db, identity, now)
    return identity


Member = Annotated[Identity, Depends(member)]
MaybeMember = Annotated[Identity | None, Depends(maybe_member)]
AdminMember = Annotated[Identity, Depends(admin_member)]


async def read_capped(request: Request, limit: int = MAX_BODY) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiError(413, {"error": "body_too_large", "limit": limit})
        chunks.append(chunk)
    return b"".join(chunks)


def json_body[ModelT: BaseModel](model: type[ModelT]) -> Callable[[Request], Awaitable[ModelT]]:
    """A dependency that reads the request body as `model` (proposals.parse_request)."""

    async def read(request: Request) -> ModelT:
        return proposals_service.parse_request(await read_capped(request), model)

    return read


def body_doc(model: type[BaseModel], *, required: bool = True) -> dict[str, Any]:
    """OpenAPI for a body read by `json_body`, which FastAPI can't see by itself."""
    return {
        "requestBody": {
            "required": required,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


router = APIRouter(prefix="/api/members", tags=["members"])


@router.post("/hello", status_code=204, response_class=Response)
def hello(user: Member) -> Response:
    """Record the caller as a member (`member` already did). Not behind any flag."""
    return Response(status_code=204)
