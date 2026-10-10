"""Building bricks in the Apps lobby (behind `apps_lobby`; every route 404s
`lobby-disabled` while it is off). The logic is services/lobby_bricks.py.

- `GET /api/lobby/bricks?since=<rev>`: every brick, or what changed since `rev`. Public:
  everyone in the cave sees the build.
- Signed in (`Member`): `GET /api/lobby/bricks/me` (who you are, and whether you make
  bricks), `PUT /api/lobby/bricks/me/stand-in` (admins only: "Be the Lego bot", for
  testing), `PUT /api/lobby/bricks/{id}/pick` and `.../{id}/place`.
- The brick maker only (checked on every call): `POST /api/lobby/bricks` (make one),
  `POST /api/lobby/bricks/build` (a blueprint, all at once) and
  `DELETE /api/lobby/bricks/{id}` (take one away).
"""

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from forge_api.models import (
    BRICK_ID,
    BrickBuild,
    BrickBuilt,
    BrickChange,
    BrickList,
    BrickMake,
    BrickMe,
    BrickPlace,
    BrickStandIn,
)
from forge_api.routers.members import Db, Member, Now, body_doc, json_body, read_capped
from forge_api.services import flags as flags_service
from forge_api.services import lobby_bricks as bricks_service
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import Identity


def _require_enabled() -> None:
    if not flags_service.is_enabled(bricks_service.FLAG):
        raise ApiError(404, {"error": "lobby-disabled"})


def _brick_id(brickId: str) -> str:
    if re.fullmatch(BRICK_ID, brickId) is None:
        raise ApiError(404, {"error": "brick_not_found"})
    return brickId


BrickId = Annotated[str, Depends(_brick_id)]


def _member_id(user: Identity) -> str:
    return f"gh:{user.sub}"


router = APIRouter(
    prefix="/api/lobby/bricks", tags=["lobby"], dependencies=[Depends(_require_enabled)]
)


@router.get("", response_model=BrickList, response_model_exclude_none=True)
def list_bricks(db: Db, now: Now, since: Annotated[int | None, Query(ge=0)] = None) -> BrickList:
    return bricks_service.list_bricks(db, since, now)


@router.get("/me", response_model=BrickMe)
def my_bricks(user: Member, db: Db) -> BrickMe:
    return bricks_service.me(db, user)


#: Room for a whole blueprint: about 80 bytes a brick, and the JSON around them.
BUILD_BODY_MAX = 192 * 1024


async def _build_body(request: Request) -> BrickBuild:
    return proposals_service.parse_request(await read_capped(request, BUILD_BODY_MAX), BrickBuild)


@router.post(
    "/build",
    response_model=BrickBuilt,
    openapi_extra=body_doc(BrickBuild),
)
def build_bricks(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[BrickBuild, Depends(_build_body)],
) -> BrickBuilt:
    """The brick maker builds a blueprint where it's placed, all at once."""
    return bricks_service.build(db, user, body, now)


@router.put("/me/stand-in", response_model=BrickMe, openapi_extra=body_doc(BrickStandIn))
def put_stand_in(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[BrickStandIn, Depends(json_body(BrickStandIn))],
) -> BrickMe:
    """An admin takes over the brick maker's powers to test them, or gives them back."""
    return bricks_service.stand_in(db, user, body.on, now)


@router.post(
    "",
    response_model=BrickChange,
    response_model_exclude_none=True,
    openapi_extra=body_doc(BrickMake),
)
def make_brick(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[BrickMake, Depends(json_body(BrickMake))],
) -> BrickChange:
    return bricks_service.make(db, user, body, now)


@router.put("/{brickId}/pick", response_model=BrickChange, response_model_exclude_none=True)
def pick_brick(user: Member, db: Db, now: Now, brick_id: BrickId) -> BrickChange:
    return bricks_service.pick(db, user, brick_id, now)


@router.put(
    "/{brickId}/place",
    response_model=BrickChange,
    response_model_exclude_none=True,
    openapi_extra=body_doc(BrickPlace),
)
def place_brick(
    user: Member,
    db: Db,
    now: Now,
    brick_id: BrickId,
    body: Annotated[BrickPlace, Depends(json_body(BrickPlace))],
) -> BrickChange:
    return bricks_service.place(db, _member_id(user), brick_id, body, now)


@router.delete("/{brickId}", response_model=BrickChange, response_model_exclude_none=True)
def delete_brick(user: Member, db: Db, now: Now, brick_id: BrickId) -> BrickChange:
    return bricks_service.remove(db, user, brick_id, now)
