"""Error envelope shared by every endpoint.

FastAPI's HTTPException nests its body under "detail"; the frozen client contract
wants the error fields at the top level (e.g. {"error": "already_claimed",
"claimedBy": "you"}), so services raise ApiError and main.py renders it verbatim.
"""

from typing import Any


class ApiError(Exception):
    """An error with an HTTP status and a flat JSON body."""

    def __init__(
        self,
        status_code: int,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(payload.get("error", "error"))
        self.status_code = status_code
        self.payload = payload
        # Response headers the status needs, e.g. a 401's `WWW-Authenticate` challenge.
        self.headers = headers
