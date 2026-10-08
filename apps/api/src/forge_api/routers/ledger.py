"""The Upland Ledger gateway, `/api/ledger/{path}` (services/ledger). Thin: gate, read the
request, call services/ledger/gateway, return the ledger's status and JSON body."""

from collections.abc import AsyncIterator
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError
from forge_api.services.identity import require_identity
from forge_api.services.ledger import gateway

FLAG = "upland_ledger"


def require_ledger_enabled() -> None:
    """Router-wide gate: every /api/ledger/* route 404s while `upland_ledger` is off."""
    if not flags_service.is_enabled(FLAG):
        raise ApiError(404, {"error": "ledger-disabled"})


async def get_ledger_client() -> AsyncIterator[httpx.AsyncClient]:
    """Per-request client for the ledger, closed afterwards. Tests override this."""
    client = gateway.make_client()
    try:
        yield client
    finally:
        await client.aclose()


LedgerClient = Annotated[httpx.AsyncClient, Depends(get_ledger_client)]

router = APIRouter(
    prefix="/api/ledger",
    tags=["ledger"],
    # In this order: 404 while `upland_ledger` is off, then 401 without a valid assertion.
    dependencies=[Depends(require_ledger_enabled), Depends(require_identity)],
)

#: Every method lands here, so anything off the allowlist is the same 404, never a 405.
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]


@router.api_route("/{path:path}", methods=METHODS, include_in_schema=False)
async def forward(path: str, request: Request, client: LedgerClient) -> Response:
    # The path as sent, before percent-decoding: an encoded slash or dot must not pass as
    # a plain one. Anything encoded is refused by the allowlist.
    raw = request.scope.get("raw_path", b"").decode("latin-1")
    raw_path = raw.removeprefix(router.prefix + "/") if raw.startswith(router.prefix + "/") else ""
    if raw_path != path:
        raise gateway.not_found()
    # Off the allowlist is 404 before anything else is read: the body, the query's limit.
    gateway.require_allowed(request.method, path)
    query = gateway.check_query(request.scope.get("query_string", b""))
    body = None
    if request.method == "POST":
        body = await gateway.read_body(request.stream(), request.headers.get("content-type"))
    answer = await gateway.forward(
        client,
        method=request.method,
        path=path,
        query=query,
        body=body,
    )
    return Response(
        content=answer.body,
        status_code=answer.status,
        media_type="application/json" if answer.body else None,
        headers=dict(gateway.NO_STORE),
    )
