"""Devin: start a Devin session on the contributor's fork, with their key and organization.

Coded against, read 2026-10-01:
- https://docs.devin.ai/api-reference/overview.md (v3 is current; v1 and v2 deprecated)
- https://docs.devin.ai/api-reference/authentication.md (`Authorization: Bearer cog_...`;
  the organization ID is on Settings > Devin API)
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md
- https://docs.devin.ai/v3-openapi.json (SessionCreateRequest, SessionResponse,
  SessionMessageCreateRequest, ProblemDetail, GET /v3/self)

Calls (base https://api.devin.ai/v3):
- POST /organizations/{org_id}/sessions {prompt, title, repos: ["<owner>/<repo>"]}
  -> SessionResponse {session_id, url, status, ...}; needs `UseDevinSessions`
- POST /organizations/{org_id}/sessions/{session_id}/messages {message} (follow-up)
- GET /self -> {principal_type, org_id?, ...} for `--check`
Errors are RFC 9457 problem details {type, title, status, detail, errors?}: 401 bad or
expired key, 403 missing permission, 404 organization or resource not found, 409, 422
field errors, 429.

Not proven live (docs/live-tests.md, test 7):
- The `repos` entry format: the schema says only "array of strings"; FORGE sends
  `<login>/forge-app`, the owner/name form Devin's code-scan schema documents.
- That a 404 or a 422 about `repos` means "connect GitHub in Devin" (or a wrong
  organization ID), which is what the contributor is told.
- Which branch Devin pushes to and where it opens the pull request.
"""

import re
from urllib.parse import quote

from forge_api.services.rail_adapters.base import (
    AdapterError,
    AdapterRequest,
    AdapterResult,
    CheckResult,
    OutboundCall,
    RailAdapter,
    RailCredential,
    VendorResponse,
    https_url,
    json_body,
    session_ref,
    started_body,
)

BASE_URL = "https://api.devin.ai/v3"
#: Devin organization ids go into a URL path: letters, digits and a few separators.
ORG_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}")


def valid_org_id(value: object) -> bool:
    return isinstance(value, str) and ORG_ID.fullmatch(value) is not None and ".." not in value


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {credential.key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _org_path(credential: RailCredential) -> str:
    org = credential.org_id
    if org is None or not valid_org_id(org):
        raise AdapterError(
            "rail_setup_needed",
            400,
            "Devin needs your organization ID too. Copy it from Settings > Devin API at "
            "app.devin.ai.",
        )
    return f"{BASE_URL}/organizations/{quote(org, safe='')}"


def _connect_sentence(fork: str) -> str:
    return (
        f"Devin couldn't start on your copy. Check the organization ID at app.devin.ai "
        f"(Settings > Devin API), and connect GitHub in Devin with access to {fork}."
    )


class DevinAdapter(RailAdapter):
    rail = "devin"
    vendor = "Devin"
    supports_notes = True

    def _session_call(self, request: AdapterRequest) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=f"{_org_path(request.credential)}/sessions",
            headers=_headers(request.credential),
            body={
                "prompt": request.brief,
                "title": request.session_title,
                "repos": [request.fork],
            },
            secret_headers=frozenset({"Authorization"}),
            purpose="Start the Devin session.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        return [self._session_call(request)]

    def start(self, request: AdapterRequest) -> AdapterResult:
        def setup_needed(response: VendorResponse, text: str) -> str | None:
            if response.status == 404 or (
                response.status == 422 and any(word in text for word in ("repo", "github"))
            ):
                return _connect_sentence(request.fork)
            return None

        response = self.call(
            self._session_call(request), request.credential, setup_needed=setup_needed
        )
        body = started_body(response)
        return AdapterResult(
            session_url=https_url(body.get("url"), host_suffixes=("devin.ai",)),
            session_ref=session_ref(body.get("session_id")),
        )

    def check(self, request: AdapterRequest) -> CheckResult:
        _org_path(request.credential)  # refuses a missing or malformed id before any call
        response = self.call(
            OutboundCall(
                method="GET",
                url=f"{BASE_URL}/self",
                headers=_headers(request.credential),
                secret_headers=frozenset({"Authorization"}),
                purpose="Ask Devin who this key belongs to.",
            ),
            request.credential,
        )
        body = json_body(response, vendor=self.vendor)
        org = body.get("org_id")
        if isinstance(org, str) and org != request.credential.org_id:
            return CheckResult(
                ok=False,
                summary="Devin accepted the key, but it belongs to another organization ID.",
            )
        return CheckResult(
            ok=True,
            summary=(
                "Devin accepted the key. Devin has no read that proves the fork connection; "
                "--go does."
            ),
        )

    def send_notes(self, credential: RailCredential, ref: str, text: str) -> None:
        if session_ref(ref) is None or "/" in ref:
            raise AdapterError("rail_failed", 400, "FORGE has no Devin session to write to.")
        self.call(
            OutboundCall(
                method="POST",
                url=f"{_org_path(credential)}/sessions/{quote(ref, safe='')}/messages",
                headers=_headers(credential),
                body={"message": text},
                secret_headers=frozenset({"Authorization"}),
                purpose="Send the check notes to the running Devin session.",
            ),
            credential,
        )
