"""The in-app bell (Phase 5 contract §3): `GET /api/notifications` (the newest 30 and the
unread count) and `POST /api/notifications/read` (`{ids?: int[]}`: those, or every one
when absent), which answers the bell as it is afterwards.

Identity required, and the caller is recorded as a member (routers/members.py). Behind no
flag of its own: the proposal kinds are hidden while `proposals` is off
(services/notifications.py), so the bell is empty then rather than 404.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from forge_api.models import NotificationList, NotificationReadRequest
from forge_api.routers.members import Db, Member, Now, body_doc, json_body
from forge_api.services import notifications as notifications_service

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=NotificationList, response_model_exclude_none=True)
def list_notifications(user: Member, db: Db) -> NotificationList:
    return notifications_service.list_notifications(db, user.sub)


@router.post(
    "/read",
    response_model=NotificationList,
    response_model_exclude_none=True,
    openapi_extra=body_doc(NotificationReadRequest, required=False),
)
def mark_read(
    user: Member,
    db: Db,
    now: Now,
    request: Annotated[NotificationReadRequest, Depends(json_body(NotificationReadRequest))],
) -> NotificationList:
    return notifications_service.mark_read(db, user.sub, request.ids, now)
