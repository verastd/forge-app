"""Shared helpers for the house model's tests (Phase 6): a fake Anthropic client that
streams back the SDK's own message and error objects, built offline (no test reaches the
network), specs as the model writes them, a small git repository for the house to read,
and the house switched on. Kept out of conftest.py, as proposal_helpers.py is; test
modules import what they need."""

import json
import subprocess
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from types import SimpleNamespace, TracebackType
from typing import Any

import anthropic
import httpx2
import pytest
from anthropic.types.beta import BetaMessage

from forge_api.services import house

#: What a test sets ANTHROPIC_API_KEY to: the house only checks that it is set.
KEY = "set"
#: The model the house asks for in these tests (FORGE_HOUSE_MODEL).
MODEL = "house-test-model"
#: The fence every request uses while `fixed_fence` is on.
FENCE = "proposal-0123456789abcdef"

PAGE = "apps/web/src/app/data/page.tsx"

#: The first call's answer.
PICK: dict[str, Any] = {"paths": [PAGE], "reason": "The page the task changes."}

#: A spec as the model writes it, already as clean as the cleaner would make it.
WRITTEN: dict[str, Any] = {
    "title": "Add a dark mode to the Data app",
    "civilianSummary": "People can switch the Data app to dark colors, easier on tired eyes.",
    "acceptanceCriteria": [
        "A switch on /apps/data turns dark mode on and off",
        "The choice is kept after a reload",
    ],
    "size": "XS",
    "tierFloor": "T1",
    "scopeIn": ["apps/web/src/app/data/**"],
    "scopeOut": ["apps/api"],
    "risks": ["Charts may need their own dark colors."],
    "questions": ["Should it follow the device's setting?"],
    "verdict": "ready",
    "verdictReason": "Small, testable, and all of it in apps/web.",
}

#: The repository the house reads in these tests.
REPO_FILES: dict[str, str] = {
    "AGENTS.md": "# AGENTS.md\n\nRun `make test` before you push.\n",
    "README.md": "# FORGE\n",
    ".github/forge-protocol.json": json.dumps(
        {"protectedPaths": [".github/", "CODEOWNERS", "packages/auth/", "apps/web/src/app/auth/"]}
    ),
    PAGE: "export default function DataPage() {}\n",
    "apps/api/src/forge_api/main.py": "app = None\n",
    "docs/guide.md": "# Guide\n",
}


def git(root: Path, *args: str) -> None:
    """Run git in `root`, quietly; any failure fails the test."""
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def track(root: Path) -> Path:
    """Make `root` a git repository tracking every file in it (nothing is committed: the
    house reads what git tracks), and return it."""
    if not (root / ".git").exists():
        git(root, "init", "-q")
    git(root, "add", "-A")
    return root


def write(root: Path, relative: str, text: str = "x") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def make_repo(root: Path, files: dict[str, str] | None = None) -> Path:
    """Write `files` (REPO_FILES by default) under `root`, track them with git, and return
    it."""
    root.mkdir(parents=True, exist_ok=True)
    for relative, text in (REPO_FILES if files is None else files).items():
        write(root, relative, text)
    return track(root)


def message(
    payload: Any = None,
    *,
    text: str | None = None,
    stop: str = "end_turn",
    model: str = MODEL,
    input_tokens: int = 1000,
    output_tokens: int = 200,
    cache_read: int | None = 800,
    cache_write: int | None = None,
    request_id: str | None = "req_test",
    blocks: Iterable[dict[str, Any]] = (),
    stop_details: dict[str, Any] | None = None,
    iterations: list[dict[str, Any]] | None = None,
) -> BetaMessage:
    """A response as the SDK returns it: `payload` as JSON in one text block (or `text` as
    it is, or no text block when both are None), after any `blocks`."""
    content = list(blocks)
    if text is None and payload is not None:
        text = json.dumps(payload)
    if text is not None:
        content.append({"type": "text", "text": text})
    usage: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
    }
    if iterations is not None:
        usage["iterations"] = iterations
    response = BetaMessage.model_validate(
        {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": stop,
            "stop_details": stop_details,
            "usage": usage,
        }
    )
    if request_id is not None:
        response._request_id = request_id
    return response


def drafted(title: str = WRITTEN["title"], **changes: Any) -> list[BetaMessage]:
    """Both calls of a draft that works: the pick, then the spec (WRITTEN with `changes`)."""
    return [
        message(PICK, request_id="req_pick"),
        message({**WRITTEN, "title": title, **changes}, request_id="req_spec"),
    ]


#: A request as the SDK would build it: never sent anywhere.
_REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
#: Only to map a status to the SDK's own error class: it never sends anything.
_SDK = anthropic.Anthropic(api_key=KEY, max_retries=0)


def status_error(status: int, error_type: str | None = None) -> anthropic.APIStatusError:
    """The error the SDK raises for an HTTP `status` (200: an error event in a stream that
    had begun, of `error_type`), with a request id."""
    response = httpx2.Response(status, request=_REQUEST, headers={"request-id": f"req_{status}"})
    body = None if error_type is None else {"type": "error", "error": {"type": error_type}}
    return _SDK._make_status_error(f"HTTP {status}", body=body, response=response)


def connection_error() -> anthropic.APIConnectionError:
    return anthropic.APIConnectionError(request=_REQUEST)


def timeout_error() -> anthropic.APITimeoutError:
    return anthropic.APITimeoutError(request=_REQUEST)


class MidStream:
    """A reply that fails after its stream began: `error` is raised while the events are
    read, as the SDK (an error event) or its HTTP client (a timeout, a dropped
    connection) raise it there."""

    def __init__(self, error: BaseException) -> None:
        self.error = error


Reply = BetaMessage | BaseException | MidStream | Callable[[dict[str, Any]], Any]


class FakeStream:
    """What `client.beta.messages.stream(...)` hands out: a context manager whose stream
    yields `events` events, then holds the final message (or raises a mid-stream error).
    `each_event` is called for every event, as time passes in a real stream."""

    def __init__(
        self,
        reply: BetaMessage | MidStream,
        events: int,
        each_event: Callable[[], None] | None = None,
    ) -> None:
        self.reply = reply
        self.events = events
        self.each_event = each_event

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        return None

    def __iter__(self) -> Iterator[object]:
        for number in range(self.events):
            if self.each_event is not None:
                self.each_event()
            yield SimpleNamespace(type="ping", number=number)
        if isinstance(self.reply, MidStream):
            raise self.reply.error

    def get_final_message(self) -> BetaMessage:
        assert isinstance(self.reply, BetaMessage)
        return self.reply

    @property
    def request_id(self) -> str | None:
        return getattr(self.reply, "_request_id", None)


class FakeMessages:
    """`client.beta.messages`: each stream() takes the next reply, and keeps what it was
    asked. A callable reply is called with the request's arguments first (and its result
    used); an exception is raised as the request is sent; a MidStream is raised by the
    stream's events."""

    def __init__(self, replies: Iterable[Reply], events: int = 3) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []
        self.events = events
        self.each_event: Callable[[], None] | None = None

    def stream(self, **kwargs: Any) -> FakeStream:
        self.calls.append(kwargs)
        if not self.replies:
            raise AssertionError("the fake client has no reply left")
        reply = self.replies.pop(0)
        if callable(reply) and not isinstance(reply, BaseException | MidStream):
            reply = reply(kwargs)
        if isinstance(reply, BaseException):
            raise reply
        assert isinstance(reply, BetaMessage | MidStream)
        return FakeStream(reply, self.events, self.each_event)


class FakeClient:
    """Stands in for `anthropic.Anthropic`: `beta.messages.stream`, as the house uses it,
    and `with_options`, as the eval does."""

    def __init__(self, replies: Iterable[Reply] = ()) -> None:
        self.messages = FakeMessages(replies)
        self.beta = SimpleNamespace(messages=self.messages)
        self.options: list[dict[str, Any]] = []

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self.messages.calls

    def add(self, *replies: Reply) -> None:
        self.messages.replies.extend(replies)

    def with_options(self, **options: Any) -> "FakeClient":
        self.options.append(options)
        return self


def install(monkeypatch: pytest.MonkeyPatch, *replies: Reply) -> FakeClient:
    """A fake client as the house's client factory: every job gets it."""
    fake = FakeClient(replies)
    monkeypatch.setattr(house, "client_factory", lambda: fake)
    return fake


def fixed_fence(monkeypatch: pytest.MonkeyPatch, fence: str = FENCE) -> str:
    """Every request's fence is `fence`, so a test can write the message it expects."""
    monkeypatch.setattr(house, "boundary_factory", lambda: fence)
    return fence


def house_on(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    """The house on (both flags are on in config/flags.json): a key, the test model, and
    `root` as the repository it reads."""
    monkeypatch.setenv(house.KEY_ENV, KEY)
    monkeypatch.setenv(house.MODEL_ENV, MODEL)
    monkeypatch.setenv(house.ROOT_ENV, str(root))
