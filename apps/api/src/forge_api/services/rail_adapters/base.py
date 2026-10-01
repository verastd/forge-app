"""What every start-rail adapter shares: the request and result shapes, the one error
type, and the outbound HTTP rules (contract §2 and §5 `/dispatch`).

An adapter turns one `AdapterRequest` (the brief, the branch, the contributor's fork and
key) into the vendor's "start a session" call and maps the answer back. The rules every
outbound call follows, here and in services/github_reads.py:

- The `httpx.Client` is injected (tests pass one built on `httpx.MockTransport`), and a
  redirect is never followed: a vendor answering 3xx is a failure, not a hop elsewhere
  with the key attached.
- 5 s to connect and 20 s for the whole call, body included; at most 1 MB of response
  is read.
- A vendor 401/403 is `credential_rejected` (the Bridge deletes a saved credential that
  was rejected); "your repository isn't connected" is `rail_setup_needed` with one plain
  sentence telling the contributor what to connect; anything else is `rail_failed` with
  the HTTP status.
- Vendor error text is only ever logged or printed after `scrub()`: control characters
  removed, every credential value replaced, cut to 200 characters.
"""

import json
import logging
import re
import time
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import quote

import httpx

from forge_api.models import StartRail

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 5.0
TOTAL_TIMEOUT_SECONDS = 20.0
MAX_RESPONSE_BYTES = 1_000_000
MAX_ERROR_TEXT = 200
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

    @property
    def fork(self) -> str:
        """`<login>/forge-app`."""
        return f"{self.login}/{FORK_REPO_NAME}"

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


@dataclass(frozen=True)
class VendorResponse:
    """A vendor's answer, read in full (it is at most MAX_RESPONSE_BYTES)."""

    status: int
    body: bytes

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        """The parsed body. Raises ValueError when it is not JSON."""
        return json.loads(self.body.decode("utf-8"))

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

    Never follows a redirect, whatever the client was built with. Raises
    TransportFailure (504 for a timeout, 502 for anything else) instead of returning a
    response that was cut off.
    """
    deadline = clock() + total_timeout
    try:
        with client.stream(
            call.method,
            call.url,
            headers=dict(call.headers),
            json=dict(call.body) if call.body is not None else None,
            params=dict(call.params) if call.params is not None else None,
            follow_redirects=False,
        ) as response:
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > limit:
                raise TransportFailure(STATUS_BAD_GATEWAY, "response too large")
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > limit:
                    raise TransportFailure(STATUS_BAD_GATEWAY, "response too large")
                if clock() > deadline:
                    raise TransportFailure(STATUS_TIMEOUT, "timed out")
                chunks.append(chunk)
            return VendorResponse(status=response.status_code, body=b"".join(chunks))
    except httpx.TimeoutException:
        raise TransportFailure(STATUS_TIMEOUT, "timed out") from None
    except httpx.HTTPError as exc:
        raise TransportFailure(STATUS_BAD_GATEWAY, type(exc).__name__) from None


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


def scrub(text: str, secrets: Iterable[str], limit: int = MAX_ERROR_TEXT) -> str:
    """Vendor text made safe to log or print: no credential, no control characters,
    at most `limit` characters."""
    cleaned = text
    for secret in secrets:
        if len(secret) < 4:
            continue
        for form in {secret, quote(secret, safe=""), quote(secret)}:
            cleaned = cleaned.replace(form, "[redacted]")
    cleaned = strip_controls(cleaned)
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
            parts.append(json.dumps(value)[:400])
    if body.get("errors") is not None:
        parts.append(json.dumps(body.get("errors"))[:400])
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
    """The JSON object a 2xx answer must carry (it may be empty); `rail_failed` when the
    body is not a JSON object at all."""
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


def https_url(value: object, *, host_suffixes: tuple[str, ...]) -> str | None:
    """`value` when it is an https URL on one of the vendor's own hosts, else None.

    A session link is shown to the contributor as a button; it must lead to the vendor,
    whatever the vendor's answer said.
    """
    if not isinstance(value, str) or len(value) > 2000:
        return None
    try:
        url = httpx.URL(value)
    except (httpx.InvalidURL, TypeError, ValueError):
        return None
    if url.scheme != "https" or not url.host:
        return None
    host = url.host.lower()
    if any(host == suffix or host.endswith("." + suffix) for suffix in host_suffixes):
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
