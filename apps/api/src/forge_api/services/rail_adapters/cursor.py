"""Cursor cloud agent: launch an agent on the contributor's fork, with their API key.

Coded against, read 2026-10-01:
- https://cursor.com/docs/cloud-agent/api/endpoints (Cloud Agents API v1, public beta;
  v0 is legacy)
- https://cursor.com/docs/api (authentication, common error responses)

Calls (base https://api.cursor.com, `Authorization: Bearer <key>`, which the docs say
behaves exactly like Basic auth with the key as the user name):
- POST /v1/agents {prompt: {text}, name, repos: [{url, startingRef}], autoCreatePR}
  -> {agent: {id: "bc-...", name, status, url: "https://cursor.com/agents/bc-...", ...},
  run: {id, agentId, status}}
- POST /v1/agents/{id}/runs {prompt: {text}} -> {run} (follow-up; 409 `agent_busy`
  while a run is active)
- GET /v1/me (who the key belongs to) and GET /v1/repositories ({items: [{url}]},
  limited to 1 a minute and 30 an hour) for `--check`
Errors: 400 `validation_error`, 401 bad key, 403 not allowed, 404, 409, 429; bodies look
like {"error", "message"} or {"code", "message"}.

Not proven live (docs/live-tests.md, test 6):
- How Cursor reports a repository its GitHub connection can't reach (undocumented):
  a 400/403/404/422 whose text mentions the repository or GitHub is read as "connect
  your fork". A 403 is treated as a rejected key only when the text doesn't say so.
- Which branch the agent pushes to (the brief names one; `workOnCurrentBranch` is left
  false because the branch may not exist yet) and where autoCreatePR opens the pull
  request when the repository is a fork.
"""

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
    send,
    session_ref,
    started_body,
)

BASE_URL = "https://api.cursor.com"
STARTING_REF = "main"
_REPO_WORDS = ("repo", "github", "installation", "access to")


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {credential.key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _connect_sentence(fork: str) -> str:
    return (
        f"Cursor can't reach your copy. In Cursor, connect GitHub and give it access to "
        f"{fork}, then try again."
    )


class CursorAdapter(RailAdapter):
    rail = "cursor"
    vendor = "Cursor"
    supports_notes = True

    def _launch_call(self, request: AdapterRequest) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=f"{BASE_URL}/v1/agents",
            headers=_headers(request.credential),
            body={
                "prompt": {"text": request.brief},
                "name": request.session_title[:100],
                "repos": [{"url": request.fork_url, "startingRef": STARTING_REF}],
                "autoCreatePR": True,
            },
            secret_headers=frozenset({"Authorization"}),
            purpose="Launch the Cursor cloud agent on the fork.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        return [self._launch_call(request)]

    def start(self, request: AdapterRequest) -> AdapterResult:
        def setup_needed(response: VendorResponse, text: str) -> str | None:
            if response.status in (400, 403, 404, 422) and any(
                word in text for word in _REPO_WORDS
            ):
                return _connect_sentence(request.fork)
            return None

        def rejected(response: VendorResponse, text: str) -> bool:
            return response.status == 403 and not any(word in text for word in _REPO_WORDS)

        response = self.call(
            self._launch_call(request),
            request.credential,
            setup_needed=setup_needed,
            rejected_statuses=frozenset({401}),
            rejected=rejected,
        )
        body = started_body(response)
        agent = body.get("agent")
        agent = agent if isinstance(agent, dict) else {}
        return AdapterResult(
            session_url=https_url(agent.get("url"), host_suffixes=("cursor.com",)),
            session_ref=session_ref(agent.get("id")),
        )

    def check(self, request: AdapterRequest) -> CheckResult:
        self.call(
            OutboundCall(
                method="GET",
                url=f"{BASE_URL}/v1/me",
                headers=_headers(request.credential),
                secret_headers=frozenset({"Authorization"}),
                purpose="Ask Cursor who this key belongs to.",
            ),
            request.credential,
        )
        # Rate limited to 1 a minute: a 429 here still leaves the key proven.
        listing = send(
            self.client,
            OutboundCall(
                method="GET",
                url=f"{BASE_URL}/v1/repositories",
                headers=_headers(request.credential),
                secret_headers=frozenset({"Authorization"}),
                purpose="List the GitHub repositories Cursor can reach.",
            ),
            vendor=self.vendor,
            secrets=request.credential.secrets(),
        )
        if not listing.ok:
            return CheckResult(
                ok=True,
                summary=(
                    "Cursor accepted the key; its repository list didn't answer "
                    f"(HTTP {listing.status}), so the fork connection is unproven."
                ),
            )
        items = json_body(listing, vendor=self.vendor).get("items")
        wanted = request.fork_url.lower().rstrip("/")
        found = any(
            isinstance(item, dict)
            and isinstance(item.get("url"), str)
            and item["url"].lower().rstrip("/").removesuffix(".git") == wanted
            for item in (items if isinstance(items, list) else [])
        )
        if found:
            return CheckResult(
                ok=True, summary=f"Cursor accepted the key and can reach {request.fork}."
            )
        return CheckResult(ok=False, summary=_connect_sentence(request.fork))

    def send_notes(self, credential: RailCredential, ref: str, text: str) -> None:
        if session_ref(ref) is None or "/" in ref:
            raise AdapterError("rail_failed", 400, "FORGE has no Cursor agent to write to.")
        self.call(
            OutboundCall(
                method="POST",
                url=f"{BASE_URL}/v1/agents/{ref}/runs",
                headers=_headers(credential),
                body={"prompt": {"text": text}},
                secret_headers=frozenset({"Authorization"}),
                purpose="Send the check notes to the Cursor agent as a follow-up.",
            ),
            credential,
        )
