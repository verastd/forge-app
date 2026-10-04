"""The start-rail adapters (services/rail_adapters/): the exact request each vendor gets,
how its answers map, and that a credential never leaks into an error, a log line or a
redirect. Every vendor is a stand-in on httpx.MockTransport; nothing reaches a network
(the one test that needs a real socket uses a Unix socket in a temporary folder)."""

import base64
import json
import logging
import shutil
import socket
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.models import StartRail
from forge_api.services.bridge import FixtureTaskSource
from forge_api.services.brief import branch_name, compile_brief
from forge_api.services.rail_adapters import ADAPTERS, adapter_for
from forge_api.services.rail_adapters import base as base_module
from forge_api.services.rail_adapters.base import (
    MAX_JSON_DEPTH,
    MAX_RESPONSE_BYTES,
    AdapterError,
    AdapterRequest,
    AdapterResult,
    JSONTooDeep,
    OutboundCall,
    RailCredential,
    TransportFailure,
    VendorResponse,
    bounded_send,
    https_url,
    json_body,
    log_failure,
    make_client,
    parse_json,
    scrub,
    secret_forms,
    session_ref,
    strip_controls,
    vendor_message,
)
from forge_api.services.state import get_state_db

from .bridge_helpers import (
    CURSOR_KEY,
    DEVIN_KEY,
    DEVIN_ORG,
    GITHUB_USER_KEY,
    JULES_KEY,
    OPENHANDS_KEY,
    ROUTINE_TOKEN,
    ROUTINE_URL,
    BridgeEnv,
    FakeVendor,
    install_bridge,
    json_response,
    vendor_ok,
)
from .conftest import FakeClock

LOGIN = "octo-contributor"
FORK_URL = f"https://github.com/{LOGIN}/forge-app"

CREDENTIALS: dict[StartRail, RailCredential] = {
    "copilot": RailCredential(key=GITHUB_USER_KEY),
    "jules": RailCredential(key=JULES_KEY),
    "cursor": RailCredential(key=CURSOR_KEY),
    "devin": RailCredential(key=DEVIN_KEY, org_id=DEVIN_ORG),
    "openhands": RailCredential(key=OPENHANDS_KEY),
    "claude-routine": RailCredential(key=ROUTINE_TOKEN, routine_url=ROUTINE_URL),
}
#: The call that starts the session (Jules lists its sources first).
START_CALL: dict[StartRail, tuple[str, str]] = {
    "copilot": ("POST", f"https://api.github.com/agents/repos/{LOGIN}/forge-app/tasks"),
    "jules": ("POST", "https://jules.googleapis.com/v1alpha/sessions"),
    "cursor": ("POST", "https://api.cursor.com/v1/agents"),
    "devin": ("POST", f"https://api.devin.ai/v3/organizations/{DEVIN_ORG}/sessions"),
    "openhands": ("POST", "https://app.all-hands.dev/api/v1/app-conversations"),
    "claude-routine": ("POST", ROUTINE_URL),
}
SESSIONS: dict[StartRail, AdapterResult] = {
    "copilot": AdapterResult(f"{FORK_URL}/agents/task-123", "task-123"),
    "jules": AdapterResult("https://jules.google.com/session/31415", "sessions/31415"),
    "cursor": AdapterResult("https://cursor.com/agents/bc-1234", "bc-1234"),
    "devin": AdapterResult("https://app.devin.ai/sessions/devin-77", "devin-77"),
    "openhands": AdapterResult("https://app.all-hands.dev/conversations/conv-9", "conv-9"),
    "claude-routine": AdapterResult("https://claude.ai/code/session_01Test", "session_01Test"),
}
AUTH_HEADER: dict[StartRail, tuple[str, str]] = {
    "copilot": ("authorization", f"Bearer {GITHUB_USER_KEY}"),
    "jules": ("x-goog-api-key", JULES_KEY),
    "cursor": ("authorization", f"Bearer {CURSOR_KEY}"),
    "devin": ("authorization", f"Bearer {DEVIN_KEY}"),
    "openhands": ("authorization", f"Bearer {OPENHANDS_KEY}"),
    "claude-routine": ("authorization", f"Bearer {ROUTINE_TOKEN}"),
}
RAILS: list[StartRail] = list(CREDENTIALS)


def request_for(rail: StartRail, credential: RailCredential | None = None) -> AdapterRequest:
    task = FixtureTaskSource().get_task(1)
    assert task is not None
    return AdapterRequest(
        task_id=task.id,
        title=task.title,
        brief=compile_brief(task, task.acceptanceCriteria, LOGIN),
        branch=branch_name(task.id, task.title),
        login=LOGIN,
        credential=credential or CREDENTIALS[rail],
    )


def is_start(rail: StartRail, request: httpx.Request) -> bool:
    method, url = START_CALL[rail]
    return request.method == method and str(request.url).split("?")[0] == url


def on_start(rail: StartRail, answer: Callable[[httpx.Request], httpx.Response]) -> FakeVendor:
    """A vendor that answers the start call with `answer` and everything else with OK."""
    return FakeVendor(
        respond=lambda request: answer(request) if is_start(rail, request) else vendor_ok(request)
    )


def start(rail: StartRail, vendor: FakeVendor, credential: RailCredential | None = None) -> Any:
    adapter = adapter_for(rail, vendor.client())
    try:
        return adapter.start(request_for(rail, credential))
    except AdapterError as exc:
        return exc


# --- the request each vendor gets -------------------------------------------------------


@pytest.mark.parametrize("rail", RAILS)
def test_the_start_request_has_the_documented_shape(rail: StartRail) -> None:
    vendor = FakeVendor(respond=vendor_ok)
    result = start(rail, vendor)
    assert result == SESSIONS[rail]
    request = vendor.requests[-1]
    assert is_start(rail, request)
    header, value = AUTH_HEADER[rail]
    assert request.headers[header] == value
    body = json.loads(request.content)
    brief = request_for(rail).brief
    branch = request_for(rail).branch
    title = f"FORGE task #1: {request_for(rail).title}"
    expected: dict[StartRail, dict[str, Any]] = {
        "copilot": {"prompt": brief, "base_ref": "main", "create_pull_request": True},
        "jules": {
            "prompt": brief,
            "title": title,
            "sourceContext": {
                "source": f"sources/github/{LOGIN}/forge-app",
                "githubRepoContext": {"startingBranch": "main"},
                "workingBranch": branch,
            },
            "automationMode": "AUTO_CREATE_PR",
            "requirePlanApproval": False,
        },
        "cursor": {
            "prompt": {"text": brief},
            "name": title,
            "repos": [{"url": FORK_URL, "startingRef": "main"}],
            "autoCreatePR": True,
        },
        "devin": {"prompt": brief, "title": title, "repos": [f"{LOGIN}/forge-app"]},
        "openhands": {
            "initial_message": {"content": [{"type": "text", "text": brief}]},
            "selected_repository": f"{LOGIN}/forge-app",
            "selected_branch": "main",
            "title": title,
        },
        "claude-routine": {"text": brief},
    }
    assert body == expected[rail]
    assert vendor.requests[-1].extensions.get("follow_redirects") in (None, False)


def test_vendor_specific_headers() -> None:
    copilot = FakeVendor(respond=vendor_ok)
    start("copilot", copilot)
    assert copilot.requests[-1].headers["x-github-api-version"] == "2026-03-10"
    assert copilot.requests[-1].headers["accept"] == "application/vnd.github+json"
    routine = FakeVendor(respond=vendor_ok)
    start("claude-routine", routine)
    assert routine.requests[-1].headers["anthropic-version"] == "2023-06-01"
    assert routine.requests[-1].headers["anthropic-beta"] == "experimental-cc-routine-2026-04-01"
    jules = FakeVendor(respond=vendor_ok)
    start("jules", jules)
    listing = jules.requests[0]
    assert (listing.method, listing.url.path, listing.url.params["pageSize"]) == (
        "GET",
        "/v1alpha/sources",
        "100",
    )


@pytest.mark.parametrize("rail", RAILS)
def test_the_plan_matches_what_start_sends(rail: StartRail) -> None:
    plan = adapter_for(rail, make_client()).plan(request_for(rail))
    assert (plan[-1].method, plan[-1].url) == START_CALL[rail]
    assert plan[-1].purpose
    for call in plan:
        masked = call.masked_headers("<hidden>")
        assert CREDENTIALS[rail].key not in json.dumps(masked)


# --- how answers map ------------------------------------------------------------------


@pytest.mark.parametrize("rail", RAILS)
def test_401_is_a_rejected_credential(rail: StartRail) -> None:
    vendor = FakeVendor(respond=lambda request: json_response(401, {"error": "unauthenticated"}))
    error = start(rail, vendor)
    assert isinstance(error, AdapterError)
    assert (error.code, error.status) == ("credential_rejected", 401)
    assert "didn't accept that key" in error.message


@pytest.mark.parametrize(
    ("rail", "code"),
    [
        ("copilot", "rail_setup_needed"),  # contract §5: Copilot 403 means "not set up"
        ("jules", "credential_rejected"),  # the key fails the first call, the source list
        ("cursor", "credential_rejected"),
        ("devin", "credential_rejected"),
        ("openhands", "credential_rejected"),  # the probe fails too
        ("claude-routine", "credential_rejected"),
    ],
)
def test_403(rail: StartRail, code: str) -> None:
    vendor = FakeVendor(respond=lambda request: json_response(403, {"message": "forbidden"}))
    error = start(rail, vendor)
    assert isinstance(error, AdapterError)
    assert (error.code, error.status) == (code, 403)


SETUP_ANSWERS: list[tuple[StartRail, int, Any]] = [
    ("copilot", 404, {"message": "Not Found"}),
    ("copilot", 403, {"message": "Resource not accessible by integration"}),
    ("jules", 404, {"error": {"code": 404, "status": "NOT_FOUND", "message": "x"}}),
    ("jules", 403, {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "x"}}),
    (
        "jules",
        400,
        {"error": {"code": 400, "status": "FAILED_PRECONDITION", "message": "source not ready"}},
    ),
    ("cursor", 400, {"code": "validation_error", "message": "Repository not accessible"}),
    ("cursor", 403, {"error": "Forbidden", "message": "No access to repo"}),
    ("devin", 404, {"title": "Not Found", "status": 404}),
    ("devin", 422, {"title": "Invalid", "status": 422, "errors": [{"loc": ["repos", 0]}]}),
    ("openhands", 401, {"detail": "you don't have access to that repository"}),
    ("openhands", 422, {"detail": [{"loc": ["selected_repository"], "msg": "bad repo"}]}),
    (
        "claude-routine",
        404,
        {"type": "error", "error": {"type": "not_found_error", "message": "x"}},
    ),
    (
        "claude-routine",
        400,
        {
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "routine is paused"},
        },
    ),
]


@pytest.mark.parametrize(("rail", "status", "body"), SETUP_ANSWERS)
def test_not_connected_is_setup_needed_with_a_plain_sentence(
    rail: StartRail, status: int, body: Any
) -> None:
    vendor = on_start(rail, lambda request: json_response(status, body))
    if rail == "openhands":  # the probe (a plain read) proves the key itself is fine
        vendor = FakeVendor(
            respond=lambda request: (
                json_response(status, body)
                if is_start(rail, request)
                else json_response(200, {"items": []})
            )
        )
    error = start(rail, vendor)
    assert isinstance(error, AdapterError), error
    assert (error.code, error.status) == ("rail_setup_needed", status)
    assert error.message.endswith(".")
    assert "{" not in error.message  # a sentence, not vendor JSON


def test_jules_without_the_fork_among_its_sources_is_setup_needed() -> None:
    other = {
        "name": "sources/github/someone/else",
        "githubRepo": {"owner": "someone", "repo": "else"},
    }
    pages = iter(
        [
            json_response(200, {"sources": [other], "nextPageToken": "p2"}),
            json_response(200, {"sources": []}),
        ]
    )
    vendor = FakeVendor(respond=lambda request: next(pages))
    error = start("jules", vendor)
    assert isinstance(error, AdapterError) and error.code == "rail_setup_needed"
    assert f"{LOGIN}/forge-app" in error.message
    assert vendor.requests[1].url.params["pageToken"] == "p2"
    assert len(vendor.requests) == 2  # never tried to start


def test_jules_finds_its_source_by_name_too() -> None:
    listed = {"sources": [{"name": f"sources/github-{LOGIN}-forge-app"}]}
    vendor = on_start("jules", vendor_ok)
    vendor.respond = lambda request: (
        json_response(200, listed) if request.url.path.endswith("/sources") else vendor_ok(request)
    )
    start("jules", vendor)
    assert json.loads(vendor.requests[-1].content)["sourceContext"]["source"] == (
        f"sources/github-{LOGIN}-forge-app"
    )


def test_a_google_bad_key_400_is_rejected() -> None:
    bad_key = {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}}
    vendor = FakeVendor(respond=lambda request: json_response(400, bad_key))
    error = start("jules", vendor)
    assert isinstance(error, AdapterError) and error.code == "credential_rejected"


def test_openhands_start_task_error_maps() -> None:
    repo = on_start(
        "openhands",
        lambda r: json_response(
            200, {"id": "t", "status": "ERROR", "detail": "Repository not found"}
        ),
    )
    error = start("openhands", repo)
    assert isinstance(error, AdapterError) and error.code == "rail_setup_needed"
    other = on_start("openhands", lambda r: json_response(200, {"id": "t", "status": "ERROR"}))
    error = start("openhands", other)
    assert isinstance(error, AdapterError) and (error.code, error.status) == ("rail_failed", 502)
    starting = on_start(
        "openhands", lambda r: json_response(200, {"id": "task-1", "status": "WORKING"})
    )
    assert start("openhands", starting) == AdapterResult(
        "https://app.all-hands.dev/conversations/task-1", "task-1"
    )


def test_devin_and_routine_refuse_a_bad_credential_before_calling() -> None:
    vendor = FakeVendor(respond=vendor_ok)
    error = start("devin", vendor, RailCredential(key=DEVIN_KEY, org_id="../x"))
    assert isinstance(error, AdapterError) and error.code == "rail_setup_needed"
    error = start(
        "claude-routine",
        vendor,
        RailCredential(key=ROUTINE_TOKEN, routine_url="https://evil.example/fire"),
    )
    assert isinstance(error, AdapterError) and error.code == "rail_setup_needed"
    assert vendor.requests == []


@pytest.mark.parametrize("rail", RAILS)
def test_5xx_is_rail_failed_with_the_status(rail: StartRail) -> None:
    vendor = on_start(rail, lambda request: json_response(503, {"error": "overloaded"}))
    error = start(rail, vendor)
    assert isinstance(error, AdapterError)
    assert (error.code, error.status) == ("rail_failed", 503)
    assert "error 503" in error.message


@pytest.mark.parametrize("rail", RAILS)
def test_a_timeout_is_rail_failed_504(rail: StartRail) -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connect timed out", request=request)

    error = start(rail, on_start(rail, hang))
    assert isinstance(error, AdapterError)
    assert (error.code, error.status) == ("rail_failed", 504)


@pytest.mark.parametrize("rail", RAILS)
def test_an_oversized_answer_is_rail_failed(rail: StartRail) -> None:
    huge = b'{"x": "' + b"y" * MAX_RESPONSE_BYTES + b'"}'
    error = start(rail, on_start(rail, lambda request: httpx.Response(200, content=huge)))
    assert isinstance(error, AdapterError)
    assert (error.code, error.status) == ("rail_failed", 502)


@pytest.mark.parametrize("rail", RAILS)
def test_a_redirect_is_never_followed(rail: StartRail) -> None:
    vendor = on_start(
        rail, lambda request: httpx.Response(302, headers={"location": "https://evil.example/"})
    )
    error = start(rail, vendor)
    assert isinstance(error, AdapterError) and (error.code, error.status) == ("rail_failed", 302)
    assert all(request.url.host != "evil.example" for request in vendor.requests)


#: 2xx bodies that carry no JSON object FORGE can read (CR-6). The deep one is the
#: review's probe: 100,000 nested arrays made the parser raise RecursionError, a 500.
UNREADABLE_SUCCESSES = {
    "html": b"<html>",
    "nested 100,000 deep": b"[" * 100_000 + b"]" * 100_000,
    "nested 33 deep": b'{"agent": ' * 33 + b"{}" + b"}" * 33,
    "not an object": b'["https://cursor.com/agents/bc-1"]',
    "not UTF-8": b'{"url": "\xff"}',
}


@pytest.mark.parametrize("body", UNREADABLE_SUCCESSES.values(), ids=list(UNREADABLE_SUCCESSES))
@pytest.mark.parametrize("rail", RAILS)
def test_a_success_without_readable_json_is_started_without_a_link(
    rail: StartRail, body: bytes
) -> None:
    """The vendor said 2xx, so the session started: calling it a failure would have the
    contributor start a second one. It just has no link (CR-6)."""
    vendor = on_start(rail, lambda request: httpx.Response(201, content=body))
    assert start(rail, vendor) == AdapterResult(None, None)


def test_json_deeper_than_the_limit_is_refused_before_it_is_parsed() -> None:
    nested: Any = parse_json("[" * MAX_JSON_DEPTH + "]" * MAX_JSON_DEPTH)
    for _ in range(MAX_JSON_DEPTH - 1):
        nested = nested[0]
    assert nested == []
    with pytest.raises(JSONTooDeep):
        parse_json("[" * (MAX_JSON_DEPTH + 1) + "]" * (MAX_JSON_DEPTH + 1))
    # Brackets inside strings, escaped quotes included, aren't nesting.
    assert parse_json(b'{"a": "[[[[\\"{{{{", "b": [1]}') == {"a": '[[[["{{{{', "b": [1]}
    deep = VendorResponse(200, UNREADABLE_SUCCESSES["nested 100,000 deep"])
    with pytest.raises(ValueError):
        deep.json()
    assert deep.json_object() == {}
    with pytest.raises(AdapterError) as caught:
        json_body(deep, vendor="Cursor")
    assert (caught.value.code, caught.value.status) == ("rail_failed", 502)
    error = VendorResponse(400, b'{"errors": ' + b"[" * 50_000 + b"]" * 50_000 + b"}")
    assert vendor_message(error).startswith('{"errors": [[[')  # the raw text, no crash


def test_counting_the_depth_stays_linear_on_hostile_text() -> None:
    # An unterminated string full of escaped quotes: each quote would start a fresh scan
    # to the end if the pattern needed a closing quote, which is quadratic.
    hostile = '"' + '\\"' * 300_000
    started = time.monotonic()
    with pytest.raises(ValueError):
        parse_json(hostile)
    assert time.monotonic() - started < 2.0


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


def test_through_the_bridge_an_unreadable_success_is_a_start_without_a_link(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    """The review's probe P5 (CR-6): a 201 of 100,000 nested arrays was a 500 after the
    vendor had started the session; the dispatch stayed `pending` (counting toward the
    hourly limit), no event was written, and the key the person asked to keep wasn't."""
    env.vault_on()
    env.start_rails("cursor")
    deep = UNREADABLE_SUCCESSES["nested 100,000 deep"]
    env.vendor.respond = lambda request: httpx.Response(
        201, content=deep, headers={"content-type": "application/json"}
    )
    claimed = client.post("/api/bridge/claim", json={"taskId": 1}, headers=user_headers)
    assert claimed.status_code == 200, claimed.text
    started = client.post(
        "/api/bridge/dispatch",
        json={
            "taskId": 1,
            "rail": "cursor",
            "credential": {"key": CURSOR_KEY},
            "saveCredential": True,
        },
        headers=user_headers,
    )
    assert started.status_code == 200, started.text
    assert "sessionUrl" not in started.json() and started.json()["credentialSaved"] is True
    rows = get_state_db().query_all("SELECT rail, mode, outcome FROM bridge_dispatches")
    assert rows == [{"rail": "cursor", "mode": "start", "outcome": "started"}]
    status = client.get("/api/bridge/status/1", headers=user_headers).json()
    assert status["stage"] == "agent_working" and "sessionUrl" not in status


@pytest.mark.parametrize("rail", RAILS)
def test_the_credential_never_reaches_an_error_or_a_log(
    rail: StartRail, caplog: pytest.LogCaptureFixture
) -> None:
    key = CREDENTIALS[rail].key
    echo = f"bad credential {key} (also {quote(key, safe='')})\n‮more"
    vendor = on_start(rail, lambda request: json_response(418, {"message": echo, "detail": echo}))
    error = start(rail, vendor)
    assert isinstance(error, AdapterError)
    with caplog.at_level(logging.DEBUG):
        log_failure(rail, "start", error)
    for text in (error.message, error.detail, str(error), caplog.text):
        assert key not in text
    assert "[redacted]" in error.detail
    assert len(error.detail) <= 200
    assert "‮" not in error.detail and "\n" not in error.detail
    assert repr(CREDENTIALS[rail]).count(key) == 0  # dataclass repr hides the key


@pytest.mark.parametrize("rail", RAILS)
def test_an_outbound_calls_repr_never_shows_its_credential(rail: StartRail) -> None:
    """A log line, traceback or error report that shows a call shows no key (CR-11)."""
    key = CREDENTIALS[rail].key
    for planned in adapter_for(rail, make_client()).plan(request_for(rail)):
        shown = repr(planned)
        assert key not in shown
        assert "<credential>" in shown and planned.url in shown


def test_scrub_removes_every_spelling_of_a_key() -> None:
    """A key may hold a quote, a backslash or a slash (any printable ASCII is accepted),
    and a vendor may echo it re-encoded: JSON-escaped and base64 too (CR-11)."""
    key = 'test-only-quote"back\\slash/0123456789'
    escaped = json.dumps(key)[1:-1]
    forms = {
        "as sent": key,
        "URL-encoded": quote(key, safe=""),
        "JSON-escaped": escaped,
        "JSON-escaped, slash too": escaped.replace("/", "\\/"),
        "base64": base64.b64encode(key.encode()).decode(),
        "base64 without padding": base64.b64encode(key.encode()).decode().rstrip("="),
        "URL-safe base64": base64.urlsafe_b64encode(key.encode()).decode(),
        "HTTP Basic user name": base64.b64encode(f"{key}:".encode()).decode(),
    }
    for name, form in forms.items():
        assert scrub(f"refused {form} here", [key]) == "refused [redacted] here", name
    assert set(forms.values()) <= secret_forms(key)


def test_a_key_echoed_in_a_vendor_error_list_is_redacted(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The review's probe P1b (CR-11): vendor_message re-encodes an `errors` list with
    json.dumps, so a key holding a quote or a backslash came out JSON-escaped, a form
    scrub() didn't look for, and was logged."""
    key = 'test-only-quote"in\\key-0123456789'
    body = {"errors": [{"field": "key", "value": key}]}
    vendor = FakeVendor(respond=lambda request: json_response(400, body))
    error = start("jules", vendor, RailCredential(key=key))
    assert isinstance(error, AdapterError)
    with caplog.at_level(logging.DEBUG):
        log_failure("jules", "start", error)
    for text in (error.detail, caplog.text):
        assert json.dumps(key)[1:-1] not in text and key not in text
    assert "[redacted]" in error.detail


def test_a_key_is_redacted_whole_wherever_it_sits_in_a_long_vendor_error() -> None:
    """vendor_message used to cut a re-encoded list at 400 characters before scrub() ran:
    a key across the cut was left half there, and the whitespace folded in front of it
    pulled that half into the 200 characters that get logged."""
    key = "test-only-cut-across-the-old-limit-0123456789"
    body = {"detail": [{"msg": " " * 360, "input": key}]}
    vendor = on_start("cursor", lambda request: json_response(422, body))
    error = start("cursor", vendor, RailCredential(key=key))
    assert isinstance(error, AdapterError) and error.code == "rail_failed"
    pieces = {key[index : index + 8] for index in range(len(key) - 7)}
    assert not any(piece in error.detail for piece in pieces), error.detail
    assert "[redacted]" in error.detail


# --- follow-up notes ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rail", "ref", "url", "body"),
    [
        (
            "jules",
            "sessions/31415",
            "https://jules.googleapis.com/v1alpha/sessions/31415:sendMessage",
            {"prompt": "fix it"},
        ),
        (
            "cursor",
            "bc-1234",
            "https://api.cursor.com/v1/agents/bc-1234/runs",
            {"prompt": {"text": "fix it"}},
        ),
        (
            "devin",
            "devin-77",
            f"https://api.devin.ai/v3/organizations/{DEVIN_ORG}/sessions/devin-77/messages",
            {"message": "fix it"},
        ),
    ],
)
def test_notes_go_to_the_running_session(rail: StartRail, ref: str, url: str, body: Any) -> None:
    vendor = FakeVendor(respond=vendor_ok)
    adapter = adapter_for(rail, vendor.client())
    assert adapter.supports_notes is True
    adapter.send_notes(CREDENTIALS[rail], ref, "fix it")
    sent = vendor.requests[-1]
    assert (sent.method, str(sent.url)) == ("POST", url)
    assert json.loads(sent.content) == body
    header, value = AUTH_HEADER[rail]
    assert sent.headers[header] == value


@pytest.mark.parametrize("rail", ["jules", "cursor", "devin"])
def test_notes_refuse_a_reference_that_isnt_a_session(rail: StartRail) -> None:
    vendor = FakeVendor(respond=vendor_ok)
    with pytest.raises(AdapterError):
        adapter_for(rail, vendor.client()).send_notes(CREDENTIALS[rail], "../../admin", "x")
    assert vendor.requests == []


def test_a_busy_cursor_agent_refuses_notes() -> None:
    vendor = FakeVendor(respond=lambda request: json_response(409, {"code": "agent_busy"}))
    with pytest.raises(AdapterError) as caught:
        adapter_for("cursor", vendor.client()).send_notes(CREDENTIALS["cursor"], "bc-1", "x")
    assert (caught.value.code, caught.value.status) == ("rail_failed", 409)


@pytest.mark.parametrize("rail", ["copilot", "openhands", "claude-routine"])
def test_rails_without_follow_ups_say_so(rail: StartRail) -> None:
    adapter = adapter_for(rail, make_client())
    assert adapter.supports_notes is False
    with pytest.raises(AdapterError) as caught:
        adapter.send_notes(CREDENTIALS[rail], "ref", "x")
    assert caught.value.code == "rail_failed"


# --- --check: the cheapest signed-in read ------------------------------------------------


def test_checks_prove_the_key_and_the_fork_where_they_can() -> None:
    def check(rail: StartRail, respond: Callable[[httpx.Request], httpx.Response]) -> Any:
        vendor = FakeVendor(respond=respond)
        return adapter_for(rail, vendor.client()).check(request_for(rail)), vendor

    result, vendor = check("jules", vendor_ok)
    assert result.ok and "sources/github/octo-contributor/forge-app" in result.summary
    assert [r.method for r in vendor.requests] == ["GET"]

    result, vendor = check("copilot", lambda r: json_response(200, {"tasks": []}))
    assert result.ok
    assert (vendor.requests[0].method, vendor.requests[0].url.params["per_page"]) == ("GET", "1")

    listed = {"items": [{"url": FORK_URL + ".git"}]}
    result, vendor = check(
        "cursor",
        lambda r: json_response(
            200, listed if r.url.path.endswith("repositories") else {"apiKeyName": "k"}
        ),
    )
    assert result.ok and [r.url.path for r in vendor.requests] == ["/v1/me", "/v1/repositories"]
    result, _ = check(
        "cursor",
        lambda r: json_response(200, {"items": []} if r.url.path.endswith("repositories") else {}),
    )
    assert not result.ok
    result, _ = check(
        "cursor",
        lambda r: (
            json_response(429, {})
            if r.url.path.endswith("repositories")
            else json_response(200, {})
        ),
    )
    assert result.ok and "unproven" in result.summary

    result, vendor = check(
        "devin", lambda r: json_response(200, {"principal_type": "pat_user", "org_id": DEVIN_ORG})
    )
    assert result.ok and vendor.requests[0].url.path == "/v3/self"
    result, _ = check("devin", lambda r: json_response(200, {"org_id": "org-other"}))
    assert not result.ok

    result, vendor = check("openhands", lambda r: json_response(200, {"items": []}))
    assert result.ok and vendor.requests[0].url.path == "/api/v1/app-conversations/search"

    result, vendor = check("claude-routine", vendor_ok)
    assert result.ok and vendor.requests == []  # a routine has no read-only call
    assert ROUTINE_TOKEN not in result.summary


def test_a_check_with_a_bad_key_raises() -> None:
    vendor = FakeVendor(respond=lambda request: json_response(401, {}))
    for rail in ("jules", "copilot", "cursor", "devin", "openhands"):
        with pytest.raises(AdapterError) as caught:
            adapter_for(rail, vendor.client()).check(request_for(rail))  # type: ignore[arg-type]
        assert caught.value.code == "credential_rejected"


# --- the shared outbound rules ------------------------------------------------------------


def call(url: str = "https://vendor.example/x") -> OutboundCall:
    return OutboundCall(method="GET", url=url, headers={"Authorization": "Bearer test-only-k"})


def test_bounded_send_reads_a_streamed_body_up_to_the_limit() -> None:
    chunks = [b"a" * 600_000, b"b" * 600_000]
    client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, content=iter(chunks)))
    )
    with pytest.raises(TransportFailure) as caught:
        bounded_send(client, call())
    assert (caught.value.status, caught.value.reason) == (502, "response too large")
    small = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, content=iter([b"{}"])))
    )
    assert bounded_send(small, call()).body == b"{}"


def test_bounded_send_gives_up_after_the_total_deadline() -> None:
    ticks = iter([0.0, 5.0, 25.0, 30.0])
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, content=iter([b"a", b"b", b"c"]))
        )
    )
    with pytest.raises(TransportFailure) as caught:
        bounded_send(client, call(), clock=lambda: next(ticks))
    assert caught.value.status == 504


def test_bounded_send_maps_transport_errors() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = httpx.Client(transport=httpx.MockTransport(broken))
    with pytest.raises(TransportFailure) as caught:
        bounded_send(client, call())
    assert (caught.value.status, caught.value.reason) == (502, "ConnectError")


def test_bounded_send_never_follows_redirects_even_if_the_client_would() -> None:
    hops: list[str] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        return httpx.Response(307, headers={"location": "https://elsewhere.example/"})

    client = httpx.Client(transport=httpx.MockTransport(redirect), follow_redirects=True)
    assert bounded_send(client, call()).status == 307
    assert hops == ["https://vendor.example/x"]


def test_make_client_settings() -> None:
    client = make_client()
    assert client.follow_redirects is False
    assert client.timeout.connect == 5.0
    assert client.timeout.read == 20.0


def test_bounded_send_asks_for_an_uncompressed_answer_and_refuses_a_compressed_one() -> None:
    """A gzip answer under the 1 MB cap could inflate to about 1 GB before the cap was
    checked (CR-7): FORGE asks for identity, and refuses anything else unread."""
    sent: list[httpx.Request] = []

    def answering(encoding: str) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            headers = {"content-encoding": encoding} if encoding else {}
            return httpx.Response(200, content=iter([b"{}"]), headers=headers)

        return httpx.Client(transport=httpx.MockTransport(handler))

    asks_gzip = OutboundCall(
        method="GET", url="https://vendor.example/x", headers={"accept-encoding": "gzip, br"}
    )
    with pytest.raises(TransportFailure) as caught:
        bounded_send(answering("gzip"), asks_gzip)
    assert (caught.value.status, caught.value.reason) == (502, "compressed response refused")
    assert sent[-1].headers.get_list("accept-encoding") == ["identity"]
    assert bounded_send(answering("identity"), call()).body == b"{}"
    assert bounded_send(answering(""), call()).body == b"{}"
    assert sent[-1].headers.get_list("accept-encoding") == ["identity"]


@pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="needs Unix sockets")
def test_the_budget_covers_a_status_line_and_headers_sent_slowly() -> None:
    """The review's slow-headers probe (CR-7), through httpx's own transport and a real
    socket: a server sending its status line and headers a byte at a time beats every
    per-read timeout, so only a deadline over the whole exchange stops it."""
    folder = tempfile.mkdtemp()  # short: a Unix socket's path is limited to ~100 bytes
    path = str(Path(folder) / "v.sock")
    head = (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Pad: "
        + b"a" * 60
        + b"\r\nContent-Length: 2\r\n\r\n{}"
    )
    stop = threading.Event()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)

    def dribble() -> None:
        try:
            connection, _ = server.accept()
        except OSError:
            return
        with connection:
            connection.recv(65_536)
            for byte in head:  # about 25 s in all
                if stop.wait(0.2):
                    return
                try:
                    connection.sendall(bytes([byte]))
                except OSError:
                    return

    thread = threading.Thread(target=dribble, daemon=True)
    thread.start()
    client = httpx.Client(transport=httpx.HTTPTransport(uds=path))
    started = time.monotonic()
    try:
        with pytest.raises(TransportFailure) as caught:
            bounded_send(client, call("http://vendor.test/"), total_timeout=1.0)
        elapsed = time.monotonic() - started
    finally:
        stop.set()
        client.close()
        server.close()
        thread.join(5)
        shutil.rmtree(folder, ignore_errors=True)
    assert (caught.value.status, caught.value.reason) == (504, "timed out")
    assert elapsed < 3.0


class _FakeStream:
    def __init__(self, waits: list[tuple[str, float | None]]) -> None:
        self.waits = waits

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        self.waits.append(("read", timeout))
        return b"x"

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self.waits.append(("write", timeout))

    def close(self) -> None:
        self.waits.append(("close", None))

    def start_tls(
        self, ssl_context: Any, server_hostname: str | None = None, timeout: float | None = None
    ) -> "_FakeStream":
        self.waits.append(("tls", timeout))
        return self

    def get_extra_info(self, info: str) -> str:
        return f"info:{info}"


class _FakeBackend:
    def __init__(self) -> None:
        self.waits: list[tuple[str, float | None]] = []
        self.slept: list[float] = []

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> _FakeStream:
        self.waits.append(("tcp", timeout))
        return _FakeStream(self.waits)

    def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Any = None
    ) -> _FakeStream:
        self.waits.append(("unix", timeout))
        return _FakeStream(self.waits)

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)


def test_every_socket_wait_is_cut_to_what_is_left_of_the_budget() -> None:
    fake = _FakeBackend()
    backend = base_module._DeadlineBackend(fake)
    backend.connect_tcp("vendor.example", 443, timeout=5.0).read(10, timeout=20.0)
    assert fake.waits == [("tcp", 5.0), ("read", 20.0)]  # outside a call: untouched
    fake.waits.clear()
    budget = base_module._call_deadline.set(time.monotonic() + 0.5)
    try:
        stream = backend.connect_tcp("vendor.example", 443, timeout=5.0)
        tls = stream.start_tls(None, "vendor.example", timeout=5.0)
        tls.write(b"GET / HTTP/1.1", timeout=20.0)
        assert tls.read(10, timeout=None) == b"x"
        backend.connect_unix_socket("/run/v.sock", timeout=5.0).close()
        assert tls.get_extra_info("socket") == "info:socket"
        backend.sleep(0.25)
    finally:
        base_module._call_deadline.reset(budget)
    timed = [timeout for kind, timeout in fake.waits if kind != "close"]
    assert len(timed) == 5 and all(t is not None and 0 < t <= 0.5 for t in timed)
    assert fake.slept == [0.25]
    budget = base_module._call_deadline.set(time.monotonic() - 1)  # already spent
    try:
        stream.read(10, timeout=20.0)
    finally:
        base_module._call_deadline.reset(budget)
    assert fake.waits[-1] == ("read", 0.001)


def test_bounded_send_arms_any_client_once_proxies_included() -> None:
    client = httpx.Client(proxy="http://127.0.0.1:3128")  # never contacted
    transports: list[Any] = [client._transport, *client._mounts.values()]
    pools = [transport._pool for transport in transports]
    assert len(pools) == 2  # the direct pool and the proxy's
    base_module._deadline_bound(client)
    base_module._deadline_bound(client)
    for pool in pools:
        assert isinstance(pool._network_backend, base_module._DeadlineBackend)
        assert not isinstance(pool._network_backend._backend, base_module._DeadlineBackend)
    mocked = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    base_module._deadline_bound(mocked)  # nothing to arm, nothing breaks
    assert bounded_send(mocked, call()).status == 200


def test_scrub_and_vendor_messages() -> None:
    secret = "test-only-s3cret/+value"
    text = f"a {secret} b {quote(secret, safe='')} c {quote(secret)}\x00​"
    cleaned = scrub(text, [secret, "abc"])
    assert secret not in cleaned and quote(secret, safe="") not in cleaned
    assert cleaned == "a [redacted] b [redacted] c [redacted]"
    assert len(scrub("x" * 500, [])) == 200
    assert strip_controls("a\tb\r\nc‮d") == "a b cd"
    google = VendorResponse(400, b'{"error": {"code": 400, "status": "INVALID", "message": "m"}}')
    assert vendor_message(google) == "INVALID m"
    anthropic = VendorResponse(
        404, b'{"type":"error","error":{"type":"not_found_error","message":"m"}}'
    )
    assert vendor_message(anthropic) == "not_found_error m"
    assert vendor_message(VendorResponse(500, b"plain text")) == "plain text"
    problem = VendorResponse(422, b'{"title": "t", "detail": [{"loc": ["repos"]}], "errors": [1]}')
    assert "repos" in vendor_message(problem) and "[1]" in vendor_message(problem)
    assert vendor_message(VendorResponse(500, b'{"error": "flat"}')) == "flat"
    assert VendorResponse(200, b"\xff").json_object() == {}


def test_session_links_and_refs_are_checked() -> None:
    hosts = ("cursor.com",)
    assert https_url("https://cursor.com/agents/1", host_suffixes=hosts)
    assert https_url("https://www.cursor.com/agents/1", host_suffixes=hosts)
    for bad in (
        "http://cursor.com/a",
        "https://cursor.com.evil.example/",
        "javascript:alert(1)",
        7,
        "https://" + "a" * 2000,
        "https://[::1",
    ):
        assert https_url(bad, host_suffixes=hosts) is None
    assert session_ref("sessions/123") == "sessions/123"
    assert session_ref(42) == "42"
    for bad in ("../x", "a/../b", "", " x", True, None, "x" * 300):
        assert session_ref(bad) is None


@pytest.mark.parametrize(
    "link",
    [
        "https://evil.example\\@cursor.com/agents/1",  # a browser reads "\" as "/"
        "https://evil.example\\.cursor.com/agents/1",
        "https://cursor.com\\@evil.example/agents/1",
        "https://evil.example\t.cursor.com/agents/1",  # a browser drops tabs and newlines
        "https://cursor.com/agents/\n1",
        "https://cursor.com/agents/1 x",
        "https://cursor.com/agents/\x7f",
        "https://cursor.com/agents/ä",
        "https://cürsor.com/agents/1",
        "https://user@cursor.com/agents/1",
        "https://user:pass@cursor.com/agents/1",
        "https://cursor.com@evil.example/agents/1",
        "https://cursor.com:8443/agents/1",
        "https://cursor.com:0443/agents/1",
        "https://cursor.com./agents/1",
        "https://cursor%2Ecom/agents/1",
        "https:cursor.com/agents/1",
        "https:///cursor.com/agents/1",
        "https://evil.example#.cursor.com",
        "https://evil.example?.cursor.com",
    ],
)
def test_a_session_link_is_checked_as_the_browser_will_read_it(link: str) -> None:
    """CR-2: the host the check sees must be the host the browser opens."""
    assert https_url(link, host_suffixes=("cursor.com",)) is None


def test_plain_vendor_session_links_still_pass() -> None:
    hosts = ("cursor.com",)
    for good in (
        "https://cursor.com",
        "https://cursor.com/agents/bc-1?tab=log#@note",
        "https://www.cursor.com:443/agents/1",
        "https://CURSOR.com/agents/1",
    ):
        assert https_url(good, host_suffixes=hosts) == good


@pytest.mark.parametrize(
    ("rail", "field_path", "link"),
    [
        ("jules", ("url",), "https://evil.example\\@jules.google.com/session/1"),
        ("cursor", ("agent", "url"), "https://evil.example\\.cursor.com/agents/bc-1"),
        ("copilot", ("html_url",), "https://evil.example\\@github.com/o/forge-app/agents/1"),
        ("devin", ("url",), "https://evil.example\\@app.devin.ai/sessions/devin-77"),
        (
            "claude-routine",
            ("claude_code_session_url",),
            "https://evil.example\\@claude.ai/code/session_01Test",
        ),
    ],
)
def test_a_vendor_link_that_would_open_another_site_is_never_kept(
    rail: StartRail, field_path: tuple[str, ...], link: str
) -> None:
    """The review's probe P10 (CR-2): the vendor's answer carried the backslash link and
    FORGE stored it as the session link behind "Watch it work"."""

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(vendor_ok(request).content)
        target = body
        for name in field_path[:-1]:
            target = target[name]
        target[field_path[-1]] = link
        return json_response(201, body)

    result = start(rail, on_start(rail, answer))
    assert isinstance(result, AdapterResult)
    assert result.session_url is None or result.session_url == SESSIONS[rail].session_url


def test_masked_headers_keep_the_scheme() -> None:
    masked = OutboundCall(
        method="GET",
        url="https://x.example",
        headers={"Authorization": "Bearer test-only-k", "X-Key": "test-only-k", "Accept": "a"},
        secret_headers=frozenset({"authorization", "x-key"}),
    ).masked_headers("<K>")
    assert masked == {"Authorization": "Bearer <K>", "X-Key": "<K>", "Accept": "a"}


def test_every_start_rail_has_an_adapter() -> None:
    assert set(ADAPTERS) == set(RAILS)
    for rail, adapter in ADAPTERS.items():
        assert adapter.rail == rail and adapter.vendor


def test_the_base_adapter_is_abstract() -> None:
    from forge_api.services.rail_adapters.base import RailAdapter

    base = RailAdapter(make_client())
    for method in (base.plan, base.start, base.check):
        with pytest.raises(NotImplementedError):
            method(request_for("jules"))


def test_jules_tolerates_odd_listings_and_sparse_sessions() -> None:
    listed = {
        "sources": [
            "junk",
            {
                "name": f"sources/github/{LOGIN}/forge-app",
                "githubRepo": {"owner": LOGIN, "repo": "forge-app"},
            },
        ]
    }
    vendor = FakeVendor(
        respond=lambda r: (
            json_response(200, listed)
            if r.url.path.endswith("/sources")
            else json_response(200, {"id": "99", "state": "QUEUED"})
        )
    )
    assert start("jules", vendor) == AdapterResult(
        "https://jules.google.com/session/99", "sessions/99"
    )


def test_openhands_counts_an_unreachable_probe_as_a_bad_key() -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/search"):
            raise httpx.ConnectTimeout("down", request=request)
        return json_response(401, {"detail": "nope"})

    error = start("openhands", FakeVendor(respond=answer))
    assert isinstance(error, AdapterError) and error.code == "credential_rejected"


def test_openhands_drops_an_id_that_isnt_a_plain_id() -> None:
    vendor = on_start("openhands", lambda r: json_response(200, {"id": "x/y", "status": "WORKING"}))
    assert start("openhands", vendor) == AdapterResult(None, None)
