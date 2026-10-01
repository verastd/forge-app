"""OpenHands Cloud: start a conversation on the contributor's fork, with their API key.

Coded against, read 2026-10-01:
- https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md (Cloud API overview, V1)
- https://docs.openhands.dev/openhands/usage/cloud/api-reference/conversations/start-app-conversation
  (AppConversationStartRequest / AppConversationStartTask)

Calls (base https://app.all-hands.dev, `Authorization: Bearer <key>` as the overview's
examples show; the generated reference names an `X-Access-Token` header instead):
- POST /api/v1/app-conversations {initial_message: {content: [{type: "text", text}]},
  selected_repository: "<owner>/<repo>", selected_branch, title}
  -> start task {id, status: WORKING|WAITING_FOR_SANDBOX|PREPARING_REPOSITORY|
  SETTING_UP_SKILLS|READY|ERROR, detail?, app_conversation_id (when READY), ...}
- GET /api/v1/app-conversations/search?limit=1 (a signed-in read, for `--check` and to
  tell a bad key from an unreachable repository)
The conversation page is https://app.all-hands.dev/conversations/<app_conversation_id>;
the docs' own example falls back to the start task's `id` while the conversation is
still being prepared, and so does FORGE. The V0 API (/api/conversations) was removed.

The docs say a wrong repository name or a repository you can't access also comes back
as an authentication error, so a 401/403 on the start call is checked with the search
read: if the key works there, the contributor is told to connect the fork instead of
having a good key deleted.

Not proven live (docs/live-tests.md, test 8):
- Bearer auth (vs. X-Access-Token) for user API keys on the V1 endpoints.
- That the `id` fallback opens the conversation while it is still starting.
- Which branch the agent pushes to and where it opens the pull request.
OpenHands documents no follow-up message call for V1 conversations, so check notes are
not relayed.
"""

from forge_api.services.rail_adapters.base import (
    STATUS_BAD_GATEWAY,
    AdapterError,
    AdapterRequest,
    AdapterResult,
    CheckResult,
    OutboundCall,
    RailAdapter,
    RailCredential,
    VendorResponse,
    json_body,
    send,
    session_ref,
)

BASE_URL = "https://app.all-hands.dev"
CONVERSATION_PAGE = f"{BASE_URL}/conversations/"
SELECTED_BRANCH = "main"


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {credential.key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _connect_sentence(fork: str) -> str:
    return (
        f"OpenHands can't open your fork. At app.all-hands.dev, connect GitHub and give "
        f"OpenHands access to {fork}, then try again."
    )


class OpenHandsAdapter(RailAdapter):
    rail = "openhands"
    vendor = "OpenHands"

    def _start_call(self, request: AdapterRequest) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=f"{BASE_URL}/api/v1/app-conversations",
            headers=_headers(request.credential),
            body={
                "initial_message": {"content": [{"type": "text", "text": request.brief}]},
                "selected_repository": request.fork,
                "selected_branch": SELECTED_BRANCH,
                "title": request.session_title,
            },
            secret_headers=frozenset({"Authorization"}),
            purpose="Start the OpenHands conversation on the fork.",
        )

    def _probe_call(self, credential: RailCredential) -> OutboundCall:
        return OutboundCall(
            method="GET",
            url=f"{BASE_URL}/api/v1/app-conversations/search",
            headers=_headers(credential),
            params={"limit": "1"},
            secret_headers=frozenset({"Authorization"}),
            purpose="A signed-in read that proves the key.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        return [self._start_call(request)]

    def _key_works(self, credential: RailCredential) -> bool:
        try:
            probe = send(
                self.client,
                self._probe_call(credential),
                vendor=self.vendor,
                secrets=credential.secrets(),
            )
        except AdapterError:
            return False
        return probe.ok

    def start(self, request: AdapterRequest) -> AdapterResult:
        def setup_needed(response: VendorResponse, text: str) -> str | None:
            if response.status in (401, 403, 404) or (
                response.status in (400, 422) and "repo" in text
            ):
                return _connect_sentence(request.fork)
            return None

        def rejected(response: VendorResponse, text: str) -> bool:
            # A 401/403 means a bad key only when the key fails a plain read too.
            return response.status in (401, 403) and not self._key_works(request.credential)

        response = self.call(
            self._start_call(request),
            request.credential,
            setup_needed=setup_needed,
            rejected_statuses=frozenset(),
            rejected=rejected,
        )
        body = json_body(response, vendor=self.vendor)
        status = body.get("status")
        if status == "ERROR":
            detail = body.get("detail")
            text = detail.lower() if isinstance(detail, str) else ""
            if "repo" in text or "github" in text:
                raise AdapterError("rail_setup_needed", 400, _connect_sentence(request.fork))
            raise AdapterError(
                "rail_failed",
                STATUS_BAD_GATEWAY,
                f"{self.vendor} didn't answer properly (error {STATUS_BAD_GATEWAY}).",
                "the start task reported ERROR",
            )
        ref = session_ref(body.get("app_conversation_id")) or session_ref(body.get("id"))
        if ref is not None and "/" in ref:
            ref = None
        return AdapterResult(
            session_url=CONVERSATION_PAGE + ref if ref is not None else None,
            session_ref=ref,
        )

    def check(self, request: AdapterRequest) -> CheckResult:
        self.call(self._probe_call(request.credential), request.credential)
        return CheckResult(
            ok=True,
            summary=(
                "OpenHands accepted the key. OpenHands has no read that proves the fork "
                "connection; --go does."
            ),
        )
