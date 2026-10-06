"""Lobby avatars (behind `lobby_avatars`; every route 404s `avatars-disabled` while it is
off). The logic is services/avatars.py.

- `GET /api/avatars`: every dressed robot and the head library. Public: the lobby draws
  everyone's robot, and nothing here is private.
- `GET /api/avatars/assets/{sha256}`: a chest image or a head, cacheable forever.
- `GET /api/avatars/me`: whether the signed-in caller may edit (is an admin), for the web's
  account menu.
- Admins only (`AdminMember`): `GET /api/avatars/members` (whom to dress),
  `PUT|DELETE /api/avatars/members/{memberId}`, `PUT|DELETE .../{memberId}/chest`, and
  `PUT|DELETE /api/avatars/heads/{headId}`.

Uploads are JSON with the file in base64, read with a cap sized to the file's own limit.
"""

import re
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from forge_api.models import (
    AVATAR_CHEST_MAX_BYTES,
    AVATAR_HEAD_ID,
    AVATAR_HEAD_MAX_BYTES,
    AVATAR_MEMBER_ID,
    AVATAR_SHA256,
    Avatar,
    AvatarAccess,
    AvatarChestUpload,
    AvatarHead,
    AvatarHeadOwner,
    AvatarHeadRefit,
    AvatarHeadUpload,
    AvatarList,
    AvatarMemberList,
    AvatarUpdate,
)
from forge_api.routers.members import (
    AdminMember,
    Db,
    Member,
    Now,
    body_doc,
    json_body,
    read_capped,
)
from forge_api.services import avatars as avatars_service
from forge_api.services import flags as flags_service
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError

#: Room for the JSON around a base64 file: the field names and a 40-character name.
_ENVELOPE = 4096


def _base64_cap(limit: int) -> int:
    return 4 * ((limit + 2) // 3) + _ENVELOPE


def _require_enabled() -> None:
    if not flags_service.is_enabled(avatars_service.FLAG):
        raise ApiError(404, {"error": "avatars-disabled"})


def _member_id(memberId: str) -> str:
    if re.fullmatch(AVATAR_MEMBER_ID, memberId) is None:
        raise ApiError(404, {"error": "member_not_found"})
    return memberId


def _head_id(headId: str) -> str:
    if re.fullmatch(AVATAR_HEAD_ID, headId) is None:
        raise ApiError(404, {"error": "head_not_found"})
    return headId


MemberId = Annotated[str, Depends(_member_id)]
HeadId = Annotated[str, Depends(_head_id)]


def _upload[ModelT: BaseModel](
    model: type[ModelT], limit: int
) -> Callable[[Request], Awaitable[ModelT]]:
    """`json_body`, with a cap that fits a base64 file of up to `limit` bytes."""

    async def read(request: Request) -> ModelT:
        return proposals_service.parse_request(
            await read_capped(request, _base64_cap(limit)), model
        )

    return read


router = APIRouter(
    prefix="/api/avatars", tags=["avatars"], dependencies=[Depends(_require_enabled)]
)


@router.get("", response_model=AvatarList, response_model_exclude_none=True)
def list_avatars(db: Db) -> AvatarList:
    return avatars_service.list_all(db)


@router.get("/assets/{sha256}", response_class=Response)
def get_asset(sha256: str, db: Db) -> Response:
    if re.fullmatch(AVATAR_SHA256, sha256) is None:
        raise ApiError(404, {"error": "asset_not_found"})
    content_type, data = avatars_service.asset(db, sha256)
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{sha256}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/me", response_model=AvatarAccess)
def my_access(user: Member) -> AvatarAccess:
    """Whether the caller may use the avatar editor: the web's account menu asks, to link
    admins to it. The editor's own routes still check, every time."""
    return avatars_service.access(user)


@router.get("/members", response_model=AvatarMemberList)
def list_members(admin: AdminMember, db: Db) -> AvatarMemberList:
    return avatars_service.list_members(db)


@router.put(
    "/members/{memberId}",
    response_model=Avatar,
    response_model_exclude_none=True,
    openapi_extra=body_doc(AvatarUpdate),
)
def put_avatar(
    admin: AdminMember,
    db: Db,
    now: Now,
    member_id: MemberId,
    update: Annotated[AvatarUpdate, Depends(json_body(AvatarUpdate))],
) -> Avatar:
    return avatars_service.set_avatar(db, member_id, update, now)


@router.delete("/members/{memberId}", status_code=204, response_class=Response)
def delete_avatar(admin: AdminMember, db: Db, member_id: MemberId) -> Response:
    avatars_service.reset_avatar(db, member_id)
    return Response(status_code=204)


@router.put(
    "/members/{memberId}/chest",
    response_model=Avatar,
    response_model_exclude_none=True,
    openapi_extra=body_doc(AvatarChestUpload),
)
def put_chest(
    admin: AdminMember,
    db: Db,
    now: Now,
    member_id: MemberId,
    upload: Annotated[
        AvatarChestUpload, Depends(_upload(AvatarChestUpload, AVATAR_CHEST_MAX_BYTES))
    ],
) -> Avatar:
    return avatars_service.set_chest(db, member_id, upload, now)


@router.delete("/members/{memberId}/chest", response_model=Avatar, response_model_exclude_none=True)
def delete_chest(admin: AdminMember, db: Db, now: Now, member_id: MemberId) -> Avatar:
    return avatars_service.clear_chest(db, member_id, now)


@router.put(
    "/heads/{headId}",
    response_model=AvatarHead,
    response_model_exclude_none=True,
    openapi_extra=body_doc(AvatarHeadUpload),
)
def put_head(
    admin: AdminMember,
    db: Db,
    now: Now,
    head_id: HeadId,
    upload: Annotated[AvatarHeadUpload, Depends(_upload(AvatarHeadUpload, AVATAR_HEAD_MAX_BYTES))],
) -> AvatarHead:
    return avatars_service.put_head(db, head_id, upload, now)


@router.put(
    "/heads/{headId}/placement",
    response_model=AvatarHead,
    response_model_exclude_none=True,
    openapi_extra=body_doc(AvatarHeadRefit),
)
def put_head_placement(
    admin: AdminMember,
    db: Db,
    now: Now,
    head_id: HeadId,
    refit: Annotated[AvatarHeadRefit, Depends(json_body(AvatarHeadRefit))],
) -> AvatarHead:
    """Changes how a head is worn (the editor's fitting), keeping its file."""
    return avatars_service.refit_head(db, head_id, refit.placement, now)


@router.put(
    "/heads/{headId}/owner",
    response_model=AvatarHead,
    response_model_exclude_none=True,
    openapi_extra=body_doc(AvatarHeadOwner),
)
def put_head_owner(
    admin: AdminMember,
    db: Db,
    now: Now,
    head_id: HeadId,
    body: Annotated[AvatarHeadOwner, Depends(json_body(AvatarHeadOwner))],
) -> AvatarHead:
    """Gives a head to the member it is for (only they can wear it), or to nobody."""
    return avatars_service.set_head_owner(db, head_id, body.owner, now)


@router.delete("/heads/{headId}", status_code=204, response_class=Response)
def delete_head(admin: AdminMember, db: Db, head_id: HeadId) -> Response:
    avatars_service.delete_head(db, head_id)
    return Response(status_code=204)
