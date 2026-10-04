"""The house's calls through Anthropic's real SDK (anthropic 1.11), answered in process by
an httpx2 MockTransport: no socket is opened and nothing reaches the network, and no key
is set anywhere (the client is given a dummy one). This pins what the fake client of the
other tests assumes: how `client.beta.messages.stream` sends the house's parameters, and
how a streamed answer comes back (a fallback's blocks, stop_details, usage.iterations, an
error event, a cut-off stream, a retried request)."""

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import anthropic
import httpx2
import pytest

from forge_api.services import house
from forge_api.services.house import ProposalText

from .house_helpers import KEY, PAGE, PICK, WRITTEN, make_repo

PROPOSAL = ProposalText(title="Dark mode for the Data app", pitch="Night owls want it.")


def sse(*events: dict[str, Any]) -> bytes:
    return b"".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode() for event in events
    )


def start(model: str = "house-model", input_tokens: int = 100) -> dict[str, Any]:
    return {
        "type": "message_start",
        "message": {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": 1,
                "cache_read_input_tokens": 50,
                "cache_creation_input_tokens": 7,
            },
        },
    }


def text_block(index: int, text: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "content_block_start",
            "index": index,
            "content_block": {"type": "text", "text": ""},
        },
        {
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "text_delta", "text": text},
        },
        {"type": "content_block_stop", "index": index},
    ]


def stop(
    reason: str = "end_turn", details: dict[str, Any] | None = None, **usage: Any
) -> list[dict[str, Any]]:
    return [
        {
            "type": "message_delta",
            "delta": {"stop_reason": reason, "stop_sequence": None, "stop_details": details},
            "usage": {"output_tokens": 30, **usage},
        },
        {"type": "message_stop"},
    ]


def answer(payload: Any, request_id: str = "req_sdk") -> httpx2.Response:
    events = [start(), *text_block(0, json.dumps(payload)), *stop()]
    return httpx2.Response(
        200,
        headers={"content-type": "text/event-stream", "request-id": request_id},
        content=sse(*events),
    )


Handler = Callable[[httpx2.Request], httpx2.Response]


class Server:
    """What the transport saw, and what it answers with: one handler per request."""

    def __init__(self, *handlers: Handler | httpx2.Response) -> None:
        self.handlers = list(handlers)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        handler = self.handlers.pop(0)
        return handler(request) if callable(handler) else handler

    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests]


def client(server: Server, retries: int = house.SDK_RETRIES) -> anthropic.Anthropic:
    return anthropic.Anthropic(
        api_key=KEY,
        http_client=httpx2.Client(transport=httpx2.MockTransport(server)),
        max_retries=retries,
        timeout=anthropic.Timeout(house.TIMEOUT_SECONDS, connect=house.CONNECT_SECONDS),
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path / "repo")


def draft(sdk: anthropic.Anthropic, root: Path, usage: house.Usage | None = None) -> house.Drafted:
    return house.draft(
        sdk, PROPOSAL, root, model="house-model", effort="high", usage=usage or house.Usage()
    )


def test_a_draft_streams_both_calls_with_the_houses_parameters(repo: Path) -> None:
    """M2: `beta.messages.stream` takes betas (as the anthropic-beta header), fallbacks and
    output_config (effort and format) as they are, and streams."""
    server = Server(answer(PICK, "req_pick"), answer(WRITTEN, "req_spec"))
    usage = house.Usage()
    drafted = draft(client(server), repo, usage)
    assert drafted.picked == (PAGE,)
    first, second = server.bodies()
    for request in server.requests:
        assert request.url.path == "/v1/messages"
        assert request.headers["anthropic-beta"] == "server-side-fallback-2026-07-01"
    assert first["stream"] is True and first["fallbacks"] == "default"
    assert first["max_tokens"] == 16000 and first["model"] == "house-model"
    assert first["output_config"] == {
        "effort": "high",
        "format": {"type": "json_schema", "schema": house.PICK_SCHEMA},
    }
    assert second["output_config"]["format"]["schema"] == house.SPEC_SCHEMA
    assert first["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "thinking" not in first
    assert usage.request_ids == ["req_pick", "req_spec"]  # from the stream's header
    assert [(call.input_tokens, call.cache_creation_input_tokens) for call in usage.calls] == [
        (100, 7),
        (100, 7),
    ]


def test_a_fallback_mid_stream_continues_the_declined_text(repo: Path) -> None:
    """M2: the stream keeps the declined model's partial text, marks the switch with a
    fallback block, and the fallback model continues; usage.iterations bills both."""
    pick = json.dumps(PICK)
    half = len(pick) // 2
    fallback = {
        "type": "content_block_start",
        "index": 1,
        "content_block": {
            "type": "fallback",
            "from": {"model": "house-model"},
            "to": {"model": "fallback-model"},
            "trigger": {"type": "refusal", "category": "cyber"},
        },
    }
    iterations = [
        {
            "type": "message",
            "model": "house-model",
            "input_tokens": 100,
            "output_tokens": 5,
            "cache_read_input_tokens": 50,
            "cache_creation_input_tokens": 7,
        },
        {
            "type": "fallback_message",
            "model": "fallback-model",
            "input_tokens": 120,
            "output_tokens": 30,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
    ]
    events = [
        start(),
        *text_block(0, pick[:half]),
        fallback,
        {"type": "content_block_stop", "index": 1},
        *text_block(2, pick[half:]),
        *stop(input_tokens=120, iterations=iterations),
    ]
    streamed = httpx2.Response(
        200,
        headers={"content-type": "text/event-stream", "request-id": "req_fb"},
        content=sse(*events),
    )
    server = Server(streamed, answer(WRITTEN))
    usage = house.Usage()
    assert draft(client(server), repo, usage).picked == (PAGE,)
    pick_call = usage.calls[0]
    assert pick_call.served_by == "fallback-model"
    assert (pick_call.iterations_input_tokens, pick_call.iterations_output_tokens) == (220, 35)
    assert [hop.model for hop in pick_call.hops] == ["house-model", "fallback-model"]


def test_a_refusal_whose_fallback_couldnt_run_names_a_model(repo: Path) -> None:
    """L9: the field is `stop_details.recommended_model` (BetaRefusalStopDetails)."""
    details = {
        "type": "refusal",
        "category": "cyber",
        "explanation": None,
        "recommended_model": "fallback-model",
    }
    refused = httpx2.Response(
        200,
        headers={"content-type": "text/event-stream", "request-id": "req_busy"},
        content=sse(start(), *stop("refusal", details)),
    )
    with pytest.raises(house.HouseUnavailable):
        draft(client(Server(refused)), repo)


def test_an_error_event_after_the_stream_began_is_transient(repo: Path) -> None:
    """M2: the SDK raises it as a plain APIStatusError with the stream's status (200) and
    the event's type: not 5xx, so the house reads the type."""
    error = {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
    body = sse(start(), error)
    overloaded = httpx2.Response(
        200, headers={"content-type": "text/event-stream", "request-id": "req_err"}, content=body
    )
    usage = house.Usage()
    with pytest.raises(house.HouseUnavailable):
        draft(client(Server(overloaded)), repo, usage)
    assert (usage.calls[0].outcome, usage.calls[0].request_id) == ("unavailable", "req_err")


def test_a_stream_cut_off_by_its_timeout_is_transient(repo: Path) -> None:
    """M2: the SDK doesn't wrap what httpx2 raises while a stream is read."""

    class CutOff(httpx2.SyncByteStream):
        def __iter__(self) -> Iterator[bytes]:
            yield sse(start())
            raise httpx2.ReadTimeout("no event for 600 seconds")

    def cut_off(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=CutOff())

    with pytest.raises(house.HouseUnavailable):
        draft(client(Server(cut_off)), repo)


def test_the_sdk_retries_a_failed_request_once(repo: Path) -> None:
    """M2: SDK_RETRIES is 1, so an overloaded API is asked twice per call; the job's own
    retries do the rest."""
    overloaded = httpx2.Response(
        529,
        headers={"request-id": "req_529", "retry-after-ms": "1"},
        json={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
    )
    server = Server(overloaded, overloaded)
    usage = house.Usage()
    with pytest.raises(house.HouseUnavailable):
        draft(client(server), repo, usage)
    assert [request.headers["x-stainless-retry-count"] for request in server.requests] == ["0", "1"]
    assert [(call.outcome, call.request_id) for call in usage.calls] == [("unavailable", "req_529")]


def test_a_bad_request_fails_at_once_with_no_retry(repo: Path) -> None:
    rejected = httpx2.Response(
        400,
        headers={"request-id": "req_400"},
        json={"type": "error", "error": {"type": "invalid_request_error", "message": "no"}},
    )
    server = Server(rejected)
    with pytest.raises(house.HouseFailure) as caught:
        draft(client(server), repo)
    assert caught.value.reason == "bad_request"
    assert len(server.requests) == 1
