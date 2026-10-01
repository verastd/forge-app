"""Claude Code routine: fire the contributor's own routine with the brief.

Coded against, read 2026-10-01:
- https://code.claude.com/docs/en/routines.md ("Add an API trigger", "Trigger a routine")
- https://platform.claude.com/docs/en/api/claude-code/routines-fire (headers, limits,
  errors)

Call: POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire with
`Authorization: Bearer <routine token>`, `anthropic-version: 2023-06-01` (required),
`anthropic-beta: experimental-cc-routine-2026-04-01` (contract §2; still accepted) and a
JSON body {"text": <brief>} (at most 65,536 characters). 200 -> {type: "routine_fire",
claude_code_session_id, claude_code_session_url}. Errors use the Anthropic envelope
{"type": "error", "error": {"type", "message"}}: 400 invalid_request_error (also a paused
routine), 401 authentication_error (token doesn't match this routine), 403
permission_error (no access to the endpoint), 404 not_found_error (no such routine), 429
rate_limit_error (30 fires an hour per routine, 100 per account), 500, 503.

The contributor pastes the fire URL the routine's API trigger shows. FORGE accepts only
that exact shape and rebuilds the URL from the trigger id, so a pasted URL can never send
the brief (and the token) anywhere but api.anthropic.com. The text arrives in a
<routine-fire-payload> block marked untrusted; the routine's prompt (ROUTINE_PROMPT in
services/rails.py) is what opts in to acting on a FORGE brief.

A routine has no read-only call: `--check` only proves the URL and token are well
formed. Each fire starts a new session, so check notes are never relayed (there is no
follow-up on a running session).

Not proven live (docs/live-tests.md, test 9): the whole round trip, including that the
routine pushes to the brief's branch rather than a `claude/` one.
"""

import re

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
)

API_URL = "https://api.anthropic.com/v1/claude_code/routines"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_BETA = "experimental-cc-routine-2026-04-01"
MAX_TEXT = 65_536
#: The fire URL the routine's API trigger shows, and nothing else.
FIRE_URL = re.compile(
    r"https://api\.anthropic\.com/v1/claude_code/routines/(trig_[A-Za-z0-9]{1,64})/fire"
)


def trigger_id(routine_url: object) -> str | None:
    """The `trig_...` id in a well-formed fire URL, else None."""
    if not isinstance(routine_url, str):
        return None
    match = FIRE_URL.fullmatch(routine_url.strip())
    return match.group(1) if match else None


def _fire_url(credential: RailCredential) -> str:
    trig = trigger_id(credential.routine_url)
    if trig is None:
        raise AdapterError(
            "rail_setup_needed",
            400,
            "That isn't a routine fire URL. Copy the URL from the routine's API trigger at "
            "claude.ai/code/routines.",
        )
    return f"{API_URL}/{trig}/fire"


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {credential.key}",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
        "Content-Type": "application/json",
    }


def _setup_needed(response: VendorResponse, text: str) -> str | None:
    if response.status == 404:
        return (
            "Claude Code couldn't find that routine. Copy the URL from its API trigger at "
            "claude.ai/code/routines."
        )
    if response.status == 400 and "paused" in text:
        return "Your routine is paused. Turn it back on at claude.ai/code/routines and try again."
    return None


class ClaudeRoutineAdapter(RailAdapter):
    rail = "claude-routine"
    vendor = "Claude Code"

    def _fire_call(self, request: AdapterRequest) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=_fire_url(request.credential),
            headers=_headers(request.credential),
            body={"text": request.brief[:MAX_TEXT]},
            secret_headers=frozenset({"Authorization"}),
            purpose="Fire the routine with the brief.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        return [self._fire_call(request)]

    def start(self, request: AdapterRequest) -> AdapterResult:
        response = self.call(
            self._fire_call(request), request.credential, setup_needed=_setup_needed
        )
        body = json_body(response, vendor=self.vendor)
        return AdapterResult(
            session_url=https_url(
                body.get("claude_code_session_url"), host_suffixes=("claude.ai",)
            ),
            session_ref=session_ref(body.get("claude_code_session_id")),
        )

    def check(self, request: AdapterRequest) -> CheckResult:
        url = _fire_url(request.credential)
        trig = url.removeprefix(API_URL + "/").removesuffix("/fire")
        return CheckResult(
            ok=True,
            summary=(
                f"The routine URL is well formed (trigger {trig}) and a token is set. A "
                "routine has no read-only call, so only --go proves the token."
            ),
        )
