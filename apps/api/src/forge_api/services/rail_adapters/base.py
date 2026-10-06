"""What every start-rail adapter shares: the request and result shapes, the one error
type, and the outbound HTTP rules (contract §2 and §5 `/dispatch`).

An adapter turns one `AdapterRequest` (the brief, the branch, the contributor's fork and
key) into the vendor's "start a session" call and maps the answer back. The rules every
outbound call follows, here and in services/github_reads.py:

- The `httpx.Client` is injected (tests pass one built on `httpx.MockTransport`), and a
  redirect is never followed: a vendor answering 3xx is a failure, not a hop elsewhere
  with the key attached.
- 5 s to connect and 20 s for the whole exchange, the status line and headers included
  (bounded_send cuts every socket wait to what is left of the budget); at most 1 MB of
  response is read. Answers are asked for uncompressed, and a compressed one is refused
  rather than inflated in memory.
- JSON is parsed only when it nests at most 32 deep. A 2xx answer to a start that
  carries no readable JSON object still means the session started, just without a link.
- A vendor 401/403 is `credential_rejected` (the Bridge deletes a saved credential that
  was rejected); "your repository isn't connected" is `rail_setup_needed` with one plain
  sentence telling the contributor what to connect; anything else is `rail_failed` with
  the HTTP status.
- Vendor error text is only ever logged or printed after `scrub()`: control characters
  removed, every credential value replaced (also URL-encoded, JSON-escaped or base64),
  cut to 200 characters.
"""

import base64
import json
import logging
import re
import time
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import httpx

from forge_api.models import StartRail

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 5.0
TOTAL_TIMEOUT_SECONDS = 20.0
MAX_RESPONSE_BYTES = 1_000_000
MAX_ERROR_TEXT = 200
#: scrub() replaces credentials in the whole text, then cleans only this much of it:
#: what it returns is cut to MAX_ERROR_TEXT anyway.
SCRUB_WINDOW = 4_000
#: The deepest a vendor's (or GitHub's) JSON may nest. Real answers stay under 10; a
#: deeper one is not parsed at all, so it can never exhaust the parser's recursion.
MAX_JSON_DEPTH = 32
USER_AGENT = "forge-api (+https://github.com/verastd/forge-app)"

#: Every fork keeps the upstream's name (contract §4: `<login>/forge-app`).
FORK_REPO_NAME = "forge-app"

AdapterErrorCode = Literal["credential_rejected", "rail_setup_needed", "rail_failed"]

#: The status reported when no HTTP status exists: the vendor timed out, or answered
#: with something unusable (too big, not JSON, a redirect we refuse to follow).
STATUS_TIMEOUT = 504
STATUS_BAD_GATEWAY = 502

#: A session id or reference FORGE stores and later puts back into a vendor URL path.
SESSION_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}")

#: The start of an https link as a browser (WHATWG) and urlsplit both read it alike: a
#: plain ASCII DNS name whose last label starts with a letter (the host rule of the
#: connector's redirect URIs in services/oauth.py), no user info, no port but 443.
_HTTPS_START = re.compile(
    r"https://(?P<host>(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::443)?(?=[/?#]|\Z)",
    re.IGNORECASE,
)

#: One JSON string (its closing quote optional, so an unterminated one is consumed in a
#: single pass) or one bracket; parse_json counts the brackets outside strings.
_JSON_TOKEN = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"?|[\[\]{}]', re.DOTALL)


class JSONTooDeep(ValueError):
    """JSON nested deeper than parse_json allows (a ValueError like any other bad JSON)."""


def parse_json(raw: bytes | str, *, max_depth: int = MAX_JSON_DEPTH) -> Any:
    """`raw` (UTF-8) parsed as JSON. Raises ValueError when it isn't JSON, JSONTooDeep when
    it nests deeper than `max_depth`: the depth is counted before parsing, because the
    parser itself answers a deeply nested body with RecursionError."""
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    depth = 0
    for match in _JSON_TOKEN.finditer(text):
        token = match.group()
        if token in ("[", "{"):
            depth += 1
            if depth > max_depth:
                raise JSONTooDeep(f"JSON nested deeper than {max_depth}")
        elif token in ("]", "}"):
            depth -= 1
    return json.loads(text)


class AdapterError(Exception):
    """A start (or a follow-up) the vendor refused or could not complete.

    `message` is a plain sentence for the contributor and never holds vendor text;
    `detail` is the vendor's own words, already scrubbed, for logs and the live-test
    tool only.
    """

    def __init__(self, code: AdapterErrorCode, status: int, message: str, detail: str = "") -> None:
        super().__init__(f"{code} ({status}): {message}")
        self.code: AdapterErrorCode = code
        self.status = status
        self.message = message
        self.detail = detail


@dataclass(frozen=True)
class RailCredential:
    """What the contributor gave FORGE for one rail. `key` never appears in a repr."""

    key: str = field(repr=False)
    org_id: str | None = None  # devin
    routine_url: str | None = None  # claude-routine

    def secrets(self) -> tuple[str, ...]:
        """The values that must never reach a log line or an error message."""
        return (self.key,)


@dataclass(frozen=True)
class AdapterRequest:
    """One task, ready to hand to a vendor on the contributor's own account."""

    task_id: int
    title: str
    brief: str
    branch: str
    login: str
    credential: RailCredential
    #: The contributor's copy (`owner/name`) once FORGE has set it up (Phase 7), which may
    #: be named otherwise (forge-app-1); None: `<login>/forge-app`, as before.
    repo: str | None = None

    @property
    def fork(self) -> str:
        """The repository the agent works in: the copy, else `<login>/forge-app`."""
        return self.repo if self.repo is not None else f"{self.login}/{FORK_REPO_NAME}"

    @property
    def fork_url(self) -> str:
        return f"https://github.com/{self.fork}"

    @property
    def session_title(self) -> str:
        return f"FORGE task #{self.task_id}: {self.title}"


@dataclass(frozen=True)
class AdapterResult:
    """A started session: where to watch it, and the id a follow-up message needs."""

    session_url: str | None
    session_ref: str | None


@dataclass(frozen=True)
class CheckResult:
    """`--check` in the live-test tool: what the cheapest signed-in read proved."""

    ok: bool
    summary: str


@dataclass(frozen=True)
class OutboundCall:
    """One HTTP request an adapter makes, described so a dry run can print it."""

    method: str
    url: str
    headers: Mapping[str, str]
    body: Mapping[str, Any] | None = None
    params: Mapping[str, str] | None = None
    #: Header names whose values are credentials (masked when printed).
    secret_headers: frozenset[str] = frozenset()
    #: What this call is for, in plain words (dry-run output).
    purpose: str = ""

    def masked_headers(self, mask: str = "<credential>") -> dict[str, str]:
        """The headers with every credential replaced by `mask` (an auth scheme such as
        "Bearer" is kept, so a dry run still shows how the key is sent)."""
        hidden = {name.lower() for name in self.secret_headers}
        masked: dict[str, str] = {}
        for name, value in self.headers.items():
            if name.lower() not in hidden:
                masked[name] = value
                continue
            scheme, _, rest = value.partition(" ")
            masked[name] = f"{scheme} {mask}" if rest and scheme in ("Bearer", "Basic") else mask
        return masked

    def __repr__(self) -> str:
        # Not the dataclass repr, which would print the credential headers in full into
        # any log line, traceback or error report that shows this call.
        return (
            f"OutboundCall(method={self.method!r}, url={self.url!r}, "
            f"headers={self.masked_headers()!r}, body={self.body!r}, params={self.params!r}, "
            f"secret_headers={self.secret_headers!r}, purpose={self.purpose!r})"
        )


@dataclass(frozen=True)
class VendorResponse:
    """A vendor's answer, read in full (it is at most MAX_RESPONSE_BYTES)."""

    status: int
    body: bytes

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        """The parsed body. Raises ValueError when it is not JSON or nests deeper than
        MAX_JSON_DEPTH."""
        return parse_json(self.body)

    def json_object(self) -> dict[str, Any]:
        """The parsed body when it is a JSON object, else {}."""
        try:
            parsed = self.json()
        except (ValueError, UnicodeDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class TransportFailure(Exception):
    """The call never produced a usable answer (timeout, network error, too big)."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


class ResponseTooLarge(TransportFailure):
    """The answer was bigger than the call allows (a TransportFailure like any other, for
    callers that need to tell this one apart)."""

    def __init__(self) -> None:
        super().__init__(STATUS_BAD_GATEWAY, "response too large")


#: When the call this thread is sending must be over (time.monotonic()); bounded_send
#: sets it, and _DeadlineStream reads it before every socket wait.
_call_deadline: ContextVar[float | None] = ContextVar("forge_call_deadline", default=None)


def _within_deadline(timeout: float | None) -> float | None:
    """`timeout`, a socket wait httpx asked for, cut to what is left of the current call's
    budget: at least a millisecond, so a spent budget times the wait out instead of
    making the socket non-blocking."""
    deadline = _call_deadline.get()
    if deadline is None:
        return timeout
    left = max(deadline - time.monotonic(), 0.001)
    return left if timeout is None else min(timeout, left)


class _DeadlineStream:
    """One connection whose every socket wait ends by the call's deadline. httpx's read
    timeout starts again with each byte that arrives, so on its own a server dribbling
    its status line and headers could hold a call, and a worker thread, for hours."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        data: bytes = self._stream.read(max_bytes, _within_deadline(timeout))
        return data

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._stream.write(buffer, _within_deadline(timeout))

    def close(self) -> None:
        self._stream.close()

    def start_tls(
        self, ssl_context: Any, server_hostname: str | None = None, timeout: float | None = None
    ) -> "_DeadlineStream":
        return _DeadlineStream(
            self._stream.start_tls(ssl_context, server_hostname, _within_deadline(timeout))
        )

    def get_extra_info(self, info: str) -> Any:
        return self._stream.get_extra_info(info)


class _DeadlineBackend:
    """httpcore's network backend, handing out _DeadlineStream connections."""

    def __init__(self, backend: Any) -> None:
        self._backend = backend

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> _DeadlineStream:
        return _DeadlineStream(
            self._backend.connect_tcp(
                host, port, _within_deadline(timeout), local_address, socket_options
            )
        )

    def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Any = None
    ) -> _DeadlineStream:
        return _DeadlineStream(
            self._backend.connect_unix_socket(path, _within_deadline(timeout), socket_options)
        )

    def sleep(self, seconds: float) -> None:
        self._backend.sleep(seconds)


def _deadline_bound(client: httpx.Client) -> None:
    """Hold every connection `client` opens from now on (through a proxy from the
    environment too) to the deadline of the bounded_send call using it; outside such a
    call nothing changes. httpx has no public hook for a network backend, so this swaps
    the backend of each connection pool the client built, once (tests prove the effect
    against a real socket). Transports without a pool, such as httpx.MockTransport, are
    left alone."""
    mounts: dict[Any, Any] = getattr(client, "_mounts", {})
    for transport in (getattr(client, "_transport", None), *mounts.values()):
        pool: Any = getattr(transport, "_pool", None)
        backend = getattr(pool, "_network_backend", None)
        if backend is not None and not isinstance(backend, _DeadlineBackend):
            pool._network_backend = _DeadlineBackend(backend)


def make_client() -> httpx.Client:
    """The production client for vendor and GitHub calls."""
    return httpx.Client(
        follow_redirects=False,
        timeout=httpx.Timeout(TOTAL_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        headers={"User-Agent": USER_AGENT},
    )


def bounded_send(
    client: httpx.Client,
    call: OutboundCall,
    *,
    limit: int = MAX_RESPONSE_BYTES,
    total_timeout: float = TOTAL_TIMEOUT_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> VendorResponse:
    """Send `call` and read at most `limit` bytes of the answer within `total_timeout`.

    The budget covers the whole exchange: connecting, sending, the status line and
    headers, and the body (every socket wait on the client's connections is cut to what
    is left of it, and the body is checked here too). Never follows a redirect, whatever
    the client was built with. Asks for an uncompressed answer and refuses a compressed
    one, which could expand far past `limit` in memory before being counted. Raises
    TransportFailure (504 for a timeout, 502 for anything else) instead of returning a
    response that was cut off.
    """
    deadline = clock() + total_timeout
    headers = {
        name: value for name, value in call.headers.items() if name.lower() != "accept-encoding"
    }
    headers["Accept-Encoding"] = "identity"
    _deadline_bound(client)
    budget = _call_deadline.set(time.monotonic() + total_timeout)
    try:
        with client.stream(
            call.method,
            call.url,
            headers=headers,
            json=dict(call.body) if call.body is not None else None,
            params=dict(call.params) if call.params is not None else None,
            follow_redirects=False,
            timeout=httpx.Timeout(
                total_timeout, connect=min(CONNECT_TIMEOUT_SECONDS, total_timeout)
            ),
        ) as response:
            encoding = response.headers.get("content-encoding", "").strip().lower()
            if encoding not in ("", "identity"):
                raise TransportFailure(STATUS_BAD_GATEWAY, "compressed response refused")
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > limit:
                raise ResponseTooLarge()
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():  # no decoding: encoded answers are refused
                size += len(chunk)
                if size > limit:
                    raise ResponseTooLarge()
                if clock() > deadline:
                    raise TransportFailure(STATUS_TIMEOUT, "timed out")
                chunks.append(chunk)
            return VendorResponse(status=response.status_code, body=b"".join(chunks))
    except httpx.TimeoutException:
        raise TransportFailure(STATUS_TIMEOUT, "timed out") from None
    except httpx.HTTPError as exc:
        raise TransportFailure(STATUS_BAD_GATEWAY, type(exc).__name__) from None
    finally:
        _call_deadline.reset(budget)


_CONTROL = re.compile(r"\s+")


def strip_controls(text: str) -> str:
    """Drop control and format characters (bidi overrides, zero-width marks) and fold
    every run of whitespace into one space."""
    kept = "".join(
        " " if char in "\t\r\n" else char
        for char in text
        if char in "\t\r\n" or unicodedata.category(char) not in {"Cc", "Cf", "Cs", "Co"}
    )
    return _CONTROL.sub(" ", kept).strip()


def secret_forms(secret: str) -> set[str]:
    """Every spelling of `secret` that vendor text may carry: as sent, URL-encoded,
    JSON-escaped (vendor_message re-encodes lists with json.dumps; other encoders also
    write "/" as "\\/"), and base64, alone or as the user name of HTTP Basic auth."""
    escaped = json.dumps(secret)[1:-1]
    forms = {secret, quote(secret, safe=""), quote(secret), escaped, escaped.replace("/", "\\/")}
    for raw in (secret.encode(), f"{secret}:".encode()):
        for encoded in (base64.b64encode(raw).decode(), base64.urlsafe_b64encode(raw).decode()):
            forms.update({encoded, encoded.rstrip("=")})
    return forms


def scrub(text: str, secrets: Iterable[str], limit: int = MAX_ERROR_TEXT) -> str:
    """Vendor text made safe to log or print: no credential in any of its forms, no
    control characters, at most `limit` characters."""
    cleaned = text
    for secret in secrets:
        if len(secret) < 4:
            continue
        for form in sorted(secret_forms(secret), key=len, reverse=True):
            cleaned = cleaned.replace(form, "[redacted]")
    cleaned = strip_controls(cleaned[:SCRUB_WINDOW])
    return cleaned[:limit]


def vendor_message(response: VendorResponse) -> str:
    """The human-readable part of a vendor error body, whatever its envelope:
    `{"error": {"message"}}` (Google, Anthropic), `{"message"}` (Cursor), `{"detail"}`
    (Devin, OpenHands), or the raw text."""
    body = response.json_object()
    error = body.get("error")
    parts: list[str] = []
    if isinstance(error, dict):
        for name in ("status", "type", "message"):
            value = error.get(name)
            if isinstance(value, str):
                parts.append(value)
    elif isinstance(error, str):
        parts.append(error)
    for name in ("code", "title", "message", "detail", "error_code"):
        value = body.get(name)
        if isinstance(value, str):
            parts.append(value)
        elif name == "detail" and isinstance(value, list):
            # Whole, never cut: a cut could split a credential that scrub() then can't
            # recognise. scrub() shortens the text once every credential is replaced.
            parts.append(json.dumps(value))
    if body.get("errors") is not None:
        parts.append(json.dumps(body.get("errors")))
    return " ".join(parts) if parts else response.text()


SetupCheck = Callable[[VendorResponse, str], str | None]
RejectedCheck = Callable[[VendorResponse, str], bool]


def raise_for_status(
    response: VendorResponse,
    *,
    vendor: str,
    secrets: Iterable[str],
    setup_needed: SetupCheck | None = None,
    rejected_statuses: frozenset[int] = frozenset({401, 403}),
    rejected: RejectedCheck | None = None,
) -> None:
    """Map a vendor's non-2xx answer to an AdapterError; return quietly on 2xx.

    The key counts as rejected when the status is in `rejected_statuses` or
    `rejected(response, lowercased vendor text)` says so (Google answers a bad API key
    with a 400). `setup_needed(response, lowercased vendor text)` returns the plain
    sentence to show when the answer means "connect your repository first", or None.
    """
    if response.ok:
        return
    secret_list = tuple(secrets)
    raw = vendor_message(response)
    detail = scrub(raw, secret_list)
    lowered = raw.lower()
    if response.status in rejected_statuses or (
        rejected is not None and rejected(response, lowered)
    ):
        raise AdapterError(
            "credential_rejected",
            response.status,
            f"{vendor} didn't accept that key. Check it and try again.",
            detail,
        )
    if setup_needed is not None:
        sentence = setup_needed(response, lowered)
        if sentence is not None:
            raise AdapterError("rail_setup_needed", response.status, sentence, detail)
    raise AdapterError(
        "rail_failed",
        response.status,
        f"{vendor} didn't answer properly (error {response.status}).",
        detail,
    )


def send(
    client: httpx.Client,
    call: OutboundCall,
    *,
    vendor: str,
    secrets: Iterable[str],
) -> VendorResponse:
    """`bounded_send`, with a transport failure turned into `rail_failed`."""
    try:
        return bounded_send(client, call)
    except TransportFailure as exc:
        raise AdapterError(
            "rail_failed",
            exc.status,
            f"{vendor} didn't answer properly (error {exc.status}).",
            scrub(exc.reason, secrets),
        ) from None


def json_body(response: VendorResponse, *, vendor: str) -> dict[str, Any]:
    """The JSON object a 2xx answer to a read must carry (it may be empty); `rail_failed`
    when the body is not a JSON object at all."""
    try:
        parsed = response.json()
    except (ValueError, UnicodeDecodeError):
        parsed = None
    if not isinstance(parsed, dict):
        raise AdapterError(
            "rail_failed",
            STATUS_BAD_GATEWAY,
            f"{vendor} didn't answer properly (error {STATUS_BAD_GATEWAY}).",
            "the success response was not a JSON object",
        )
    return parsed


def started_body(response: VendorResponse) -> dict[str, Any]:
    """The JSON object in a vendor's 2xx answer to a start, or {} when there is none to
    read (not JSON, nested too deep, not an object). The vendor said the session started,
    so the start stands, just without a link: calling it a failure would have the
    contributor start a second session."""
    return response.json_object()


def https_url(value: object, *, host_suffixes: tuple[str, ...]) -> str | None:
    """`value` when it is an https URL on one of the vendor's own hosts, else None.

    A session link is shown to the contributor as a button; it must lead to the vendor,
    whatever the vendor's answer said. So the host is checked the way the browser will
    read it: a browser takes "\\" for "/" and drops tabs and newlines, so a link with a
    backslash, whitespace, a control or non-ASCII character, user info or a port other
    than 443 is refused, and so is one whose host a strict pattern and urlsplit don't
    both find.
    """
    if not isinstance(value, str) or len(value) > 2000:
        return None
    if not value.isascii() or not value.isprintable() or " " in value or "\\" in value:
        return None
    start = _HTTPS_START.match(value)
    if start is None:
        return None
    host = start.group("host").lower()
    parts = urlsplit(value)  # after the pattern matched, nothing in it can make this raise
    agreed = parts.hostname == host and parts.username is None and parts.port in (None, 443)
    if agreed and any(host == suffix or host.endswith("." + suffix) for suffix in host_suffixes):
        return value
    return None


def session_ref(value: object) -> str | None:
    """`value` when it is safe to store and later put back into a vendor URL path."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if isinstance(value, str) and SESSION_REF.fullmatch(value) and ".." not in value:
        return value
    return None


def log_failure(rail: StartRail, action: str, error: AdapterError) -> None:
    """One warning per failed vendor call: the code, the status and the scrubbed text."""
    logger.warning(
        "rail %s %s failed: %s (HTTP %s) %s", rail, action, error.code, error.status, error.detail
    )


class RailAdapter:
    """One start rail. Subclasses set the class attributes and implement `plan`,
    `start` and `check`; those that accept a follow-up message on a running session
    set `supports_notes` and implement `send_notes`."""

    rail: StartRail
    vendor: str
    supports_notes: bool = False

    def __init__(self, client: httpx.Client) -> None:
        self.client = client

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        """The calls `start` makes, in order, for a dry run. Nothing is sent."""
        raise NotImplementedError

    def start(self, request: AdapterRequest) -> AdapterResult:
        """Start a session on the contributor's account. Raises AdapterError."""
        raise NotImplementedError

    def check(self, request: AdapterRequest) -> CheckResult:
        """The cheapest signed-in read the vendor offers. Raises AdapterError."""
        raise NotImplementedError

    def send_notes(self, credential: RailCredential, ref: str, text: str) -> None:
        """Send `text` to the running session `ref`. Raises AdapterError."""
        raise AdapterError(
            "rail_failed",
            501,
            f"{self.vendor} doesn't take follow-up messages from FORGE.",
        )

    def call(
        self,
        call: OutboundCall,
        credential: RailCredential,
        *,
        setup_needed: SetupCheck | None = None,
        rejected_statuses: frozenset[int] = frozenset({401, 403}),
        rejected: RejectedCheck | None = None,
    ) -> VendorResponse:
        """Send `call` and raise the right AdapterError for anything but a 2xx."""
        response = send(self.client, call, vendor=self.vendor, secrets=credential.secrets())
        raise_for_status(
            response,
            vendor=self.vendor,
            secrets=credential.secrets(),
            setup_needed=setup_needed,
            rejected_statuses=rejected_statuses,
            rejected=rejected,
        )
        return response
