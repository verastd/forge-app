"""Machines in the Apps lobby (behind `apps_lobby`; every route 404s `lobby-disabled`
while it is off). The logic is services/lobby_machines.py.

- Public: `GET /api/lobby/machines?since=<rev>` (every machine, or what changed),
  `GET /api/lobby/machines/blueprints` (the mechanic's library) and
  `GET /api/lobby/machines/assets/{sha256}/{n}` (a blueprint's file, a chunk at a time,
  cacheable forever).
- Signed in (`Member`): `GET /api/lobby/machines/me` and, for admins,
  `PUT /api/lobby/machines/me/stand-in` ("Be the mechanic", for testing).
- The mechanic only (checked on every call): `POST /api/lobby/machines` (build one),
  `DELETE /api/lobby/machines/{id}` (take one down), and the library's uploads:
  `POST /api/lobby/machines/blueprints` (start), `PUT .../blueprints/{id}/chunks/{n}`,
  `POST .../blueprints/{id}/finish`, `DELETE .../blueprints/{id}`.
"""

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from starlette.responses import Response

from forge_api.models import (
    MACHINE_CHUNK_BYTES,
    MACHINE_ID,
    MachineBlueprint,
    MachineBlueprintList,
    MachineBuild,
    MachineChange,
    MachineChunk,
    MachineList,
    MachineMe,
    MachineStandIn,
    MachineUpload,
    MachineUploadStart,
)
from forge_api.routers.members import Db, Member, Now, body_doc, json_body, read_capped
from forge_api.services import flags as flags_service
from forge_api.services import lobby_machines as machines_service
from forge_api.services import proposals as proposals_service
from forge_api.services.errors import ApiError

_SHA256 = r"^[0-9a-f]{64}$"


def _require_enabled() -> None:
    if not flags_service.is_enabled(machines_service.FLAG):
        raise ApiError(404, {"error": "lobby-disabled"})


def _machine_id(machineId: str) -> str:
    if re.fullmatch(MACHINE_ID, machineId) is None:
        raise ApiError(404, {"error": "machine_not_found"})
    return machineId


def _blueprint_id(blueprintId: str) -> str:
    if re.fullmatch(MACHINE_ID, blueprintId) is None:
        raise ApiError(404, {"error": "blueprint_not_found"})
    return blueprintId


MachineId = Annotated[str, Depends(_machine_id)]
BlueprintId = Annotated[str, Depends(_blueprint_id)]

#: A chunk's base64, and the JSON around it.
CHUNK_BODY_MAX = 4 * ((MACHINE_CHUNK_BYTES + 2) // 3) + 1024


async def _chunk_body(request: Request) -> MachineChunk:
    return proposals_service.parse_request(await read_capped(request, CHUNK_BODY_MAX), MachineChunk)


router = APIRouter(
    prefix="/api/lobby/machines", tags=["lobby"], dependencies=[Depends(_require_enabled)]
)


@router.get("", response_model=MachineList)
def list_machines(
    db: Db, now: Now, since: Annotated[int | None, Query(ge=0)] = None
) -> MachineList:
    return machines_service.list_machines(db, since, now)


@router.get("/me", response_model=MachineMe)
def my_machines(user: Member, db: Db) -> MachineMe:
    return machines_service.me(db, user)


@router.put("/me/stand-in", response_model=MachineMe, openapi_extra=body_doc(MachineStandIn))
def put_stand_in(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[MachineStandIn, Depends(json_body(MachineStandIn))],
) -> MachineMe:
    """An admin takes over the mechanic's powers to test them, or gives them back."""
    return machines_service.stand_in(db, user, body.on, now)


@router.get("/blueprints", response_model=MachineBlueprintList)
def list_blueprints(db: Db) -> MachineBlueprintList:
    return machines_service.list_blueprints(db)


@router.post(
    "/blueprints", response_model=MachineUpload, openapi_extra=body_doc(MachineUploadStart)
)
def start_upload(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[MachineUploadStart, Depends(json_body(MachineUploadStart))],
) -> MachineUpload:
    return machines_service.start_upload(db, user, body, now)


@router.put(
    "/blueprints/{blueprintId}/chunks/{n}",
    status_code=204,
    response_class=Response,
    openapi_extra=body_doc(MachineChunk),
)
def put_chunk(
    user: Member,
    db: Db,
    blueprint_id: BlueprintId,
    n: Annotated[int, Path(ge=0, le=64)],
    body: Annotated[MachineChunk, Depends(_chunk_body)],
) -> Response:
    machines_service.put_chunk(db, user, blueprint_id, n, body.data)
    return Response(status_code=204)


@router.post("/blueprints/{blueprintId}/finish", response_model=MachineBlueprint)
def finish_upload(user: Member, db: Db, now: Now, blueprint_id: BlueprintId) -> MachineBlueprint:
    return machines_service.finish_upload(db, user, blueprint_id, now)


@router.delete("/blueprints/{blueprintId}", status_code=204, response_class=Response)
def delete_blueprint(user: Member, db: Db, blueprint_id: BlueprintId) -> Response:
    machines_service.delete_blueprint(db, user, blueprint_id)
    return Response(status_code=204)


@router.get("/assets/{sha256}/{n}", response_class=Response)
def get_asset_chunk(sha256: str, n: Annotated[int, Path(ge=0, le=64)], db: Db) -> Response:
    """A blueprint's file, MACHINE_CHUNK_BYTES at a time (a response carries a few
    megabytes at most on the way through the web's BFF). Cacheable forever."""
    if re.fullmatch(_SHA256, sha256) is None:
        raise ApiError(404, {"error": "asset_not_found"})
    return Response(
        content=machines_service.asset_chunk(db, sha256, n),
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{sha256}-{n}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "",
    response_model=MachineChange,
    response_model_exclude_none=True,
    openapi_extra=body_doc(MachineBuild),
)
def build_machine(
    user: Member,
    db: Db,
    now: Now,
    body: Annotated[MachineBuild, Depends(json_body(MachineBuild))],
) -> MachineChange:
    return machines_service.build(db, user, body, now)


@router.delete("/{machineId}", response_model=MachineChange, response_model_exclude_none=True)
def take_down(user: Member, db: Db, now: Now, machine_id: MachineId) -> MachineChange:
    return machines_service.take_down(db, user, machine_id, now)
