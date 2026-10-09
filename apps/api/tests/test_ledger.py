"""The Upland Ledger gateway, /api/ledger/* (routers/ledger.py, services/ledger/).

No network: the ledger is an httpx MockTransport injected through the router's
`get_ledger_client` dependency, and every test asserts what it was (or was not) sent.
"""

import asyncio
import json
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.routers.ledger import get_ledger_client
from forge_api.services import flags as flags_service
from forge_api.services.errors import ApiError
from forge_api.services.ledger import allowlist, gateway

TRX = "ab" * 32
Handler = Callable[[httpx.Request], Any]


class FakeLedger:
    """Answers as the ledger and keeps every request it was sent."""

    def __init__(self) -> None:
        self.seen: list[httpx.Request] = []
        self.handler: Handler = lambda request: httpx.Response(200, json={"ok": True})

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        self.seen.append(request)
        answer = self.handler(request)
        if asyncio.iscoroutine(answer):
            answer = await answer
        assert isinstance(answer, httpx.Response)
        return answer


@pytest.fixture(autouse=True)
def flags_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"upland_ledger": True}))
    monkeypatch.delenv(gateway.URL_ENV, raising=False)


@pytest.fixture
def ledger() -> FakeLedger:
    return FakeLedger()


@pytest.fixture
def http(ledger: FakeLedger, user_headers: dict[str, str]) -> Iterator[TestClient]:
    async def client() -> Any:
        async with gateway.make_client(httpx.MockTransport(ledger)) as fake:
            yield fake

    app.dependency_overrides[get_ledger_client] = client
    with TestClient(app, headers=user_headers) as test_client:
        yield test_client
    app.dependency_overrides.clear()


# ---------------------------------------------------------------- the gates


def test_flag_off_is_404_ledger_disabled_before_identity(
    monkeypatch: pytest.MonkeyPatch, ledger: FakeLedger
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"upland_ledger": False}))
    with TestClient(app) as anonymous:
        response = anonymous.get("/api/ledger/status")
    assert response.status_code == 404
    assert response.json() == {"error": "ledger-disabled"}
    assert ledger.seen == []


def test_flag_missing_from_every_source_is_off(
    monkeypatch: pytest.MonkeyPatch, http: TestClient, ledger: FakeLedger
) -> None:
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: None)
    monkeypatch.delenv(flags_service.ENV_JSON)
    response = http.get("/api/ledger/status")
    assert response.status_code == 404
    assert response.json() == {"error": "ledger-disabled"}
    assert ledger.seen == []


def test_no_identity_is_401_and_the_ledger_is_never_called(ledger: FakeLedger) -> None:
    app.dependency_overrides[get_ledger_client] = lambda: pytest.fail("no client without identity")
    try:
        with TestClient(app) as anonymous:
            for response in (
                anonymous.get("/api/ledger/status"),
                anonymous.get("/api/ledger/status", headers={"Authorization": "Bearer nope"}),
                anonymous.post("/api/ledger/analytics/query", json={}),
            ):
                assert response.status_code == 401
                assert response.json()["error"] == "unauthenticated"
    finally:
        app.dependency_overrides.clear()
    assert ledger.seen == []


# ---------------------------------------------------------------- the allowlist


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "status"),
        ("GET", "accounts"),
        ("GET", "accounts/playuplandme"),
        ("GET", "accounts/a.b.c/actions"),
        ("GET", "actions"),
        ("GET", "actions/123456789"),
        ("GET", "analytics/accounts/top"),
        ("GET", "analytics/overview"),
        ("GET", "contracts/playuplandme/actions"),
        ("GET", "properties/81369886458957"),
        ("GET", "properties/81369886458957/history"),
        ("GET", f"transactions/{TRX}"),
        ("GET", "market/upx-usd"),
        ("GET", "signals"),
        ("POST", "analytics/query"),
    ],
)
def test_the_allowlist_has(method: str, path: str) -> None:
    assert allowlist.match(method, path) is not None


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ""),
        ("GET", "health"),
        ("GET", "metrics"),
        ("GET", "../health"),
        ("GET", "../metrics"),
        ("GET", "status/"),
        ("GET", "/status"),
        ("GET", "status//x"),
        ("GET", "accounts/.."),
        ("GET", "accounts/./actions"),
        ("GET", "accounts/../actions"),
        ("GET", "accounts/Upper"),
        ("GET", "accounts/toolongaccount1"),
        ("GET", "accounts/abc%2Factions"),
        ("GET", "accounts/abc\\actions"),
        ("GET", "actions/12a"),
        ("GET", "actions/" + "1" * 21),
        ("GET", "properties/-1"),
        ("GET", "transactions/" + "ab" * 31),
        ("GET", "transactions/" + "zz" * 32),
        ("GET", "analytics/query"),
        ("POST", "status"),
        ("PUT", "analytics/query"),
        ("DELETE", "accounts"),
        ("GET", "admin"),
        ("GET", "x" * 300),
    ],
)
def test_the_allowlist_refuses(method: str, path: str) -> None:
    assert allowlist.match(method, path) is None


def test_every_allowlisted_get_reaches_the_ledger_under_v1(
    http: TestClient, ledger: FakeLedger
) -> None:
    examples = {
        "{account}": "playuplandme",
        "{contract}": "playuplandme",
        "{globalSequence}": "42",
        "{propertyId}": "7",
        "{trxId}": TRX,
    }
    for route in allowlist.ROUTES:
        if route.method != "GET":
            continue
        path = "/".join(examples.get(segment, segment) for segment in route.segments)
        response = http.get(f"/api/ledger/{path}")
        assert response.status_code == 200, path
        assert ledger.seen[-1].url.path == f"/v1/{path}"
    assert len(ledger.seen) == sum(route.method == "GET" for route in allowlist.ROUTES)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/ledger/health"),
        ("GET", "/api/ledger/metrics"),
        ("GET", "/api/ledger/v1/status"),
        ("GET", "/api/ledger/admin/whatever"),
        ("GET", "/api/ledger/accounts/NotAName"),
        ("GET", "/api/ledger/accounts/abc%2Factions"),
        ("GET", "/api/ledger/accounts/%2e%2e/actions"),
        ("GET", "/api/ledger/%2e%2e/health"),
        ("GET", "/api/ledger/actions/12a"),
        ("GET", "/api/ledger/transactions/123"),
        ("GET", "/api/ledger/status/"),
        ("GET", "/api/ledger/"),
        ("POST", "/api/ledger/status"),
        ("PUT", "/api/ledger/analytics/query"),
        ("DELETE", "/api/ledger/accounts"),
        ("PATCH", "/api/ledger/accounts"),
    ],
)
def test_off_the_allowlist_is_404_and_the_ledger_is_never_called(
    http: TestClient, ledger: FakeLedger, method: str, path: str
) -> None:
    response = http.request(
        method, path, content=b"{}", headers={"content-type": "application/json"}
    )
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}
    assert response.headers["cache-control"] == "private, no-store"
    assert ledger.seen == []


def raw_get(raw_path: bytes, headers: dict[str, str]) -> int:
    """GET `raw_path` straight through the ASGI app, unnormalised, the way a hostile client
    can send it (an HTTP client would remove the dot segments first). Returns the status."""
    statuses: list[int] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            statuses.append(message["status"])

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": raw_path.decode(),
        "raw_path": raw_path,
        "root_path": "",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 1),
        "server": ("testserver", 80),
    }
    asyncio.run(app(scope, receive, send))  # type: ignore[arg-type]
    return statuses[0]


def test_dot_segments_never_reach_the_ledger(
    http: TestClient, ledger: FakeLedger, user_headers: dict[str, str]
) -> None:
    for raw in (b"/api/ledger/accounts/../health", b"/api/ledger/./status", b"/api/ledger/../x"):
        assert raw_get(raw, user_headers) == 404
    assert ledger.seen == []


# ---------------------------------------------------------------- passthrough


def test_status_body_and_query_pass_through_and_nothing_else_does(
    http: TestClient, ledger: FakeLedger
) -> None:
    ledger.handler = lambda request: httpx.Response(
        400,
        json={"error": "bad_request", "message": "limit must be at most 1000"},
        headers={"set-cookie": "planted=1", "x-upstream": "1", "cache-control": "public"},
    )
    response = http.get(
        "/api/ledger/actions?limit=5000&contract=playuplandme&after=2026-01-01T00:00:00Z",
        headers={"cookie": "forge_session=secret", "x-forwarded-for": "6.6.6.6"},
    )
    assert response.status_code == 400
    assert response.json() == {"error": "bad_request", "message": "limit must be at most 1000"}
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-type"] == "application/json"
    assert "set-cookie" not in response.headers
    assert "x-upstream" not in response.headers

    (sent,) = ledger.seen
    assert sent.method == "GET"
    assert str(sent.url) == (
        "http://127.0.0.1:3000/v1/actions"
        "?limit=5000&contract=playuplandme&after=2026-01-01T00:00:00Z"
    )
    assert sent.headers["accept"] == "application/json"
    for header in ("authorization", "cookie", "x-forwarded-for", "content-type"):
        assert header not in sent.headers
    assert sent.content == b""


def test_the_query_string_is_forwarded_byte_for_byte(http: TestClient, ledger: FakeLedger) -> None:
    http.get("/api/ledger/search?q=111%20VENICE%20BLVD&chain=mainnet")
    assert ledger.seen[0].url.query == b"q=111%20VENICE%20BLVD&chain=mainnet"


def test_a_404_from_the_ledger_passes_through(http: TestClient, ledger: FakeLedger) -> None:
    ledger.handler = lambda request: httpx.Response(404, json={"error": "not_found"})
    response = http.get("/api/ledger/properties/1")
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_ledger_url_comes_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, http: TestClient, ledger: FakeLedger
) -> None:
    monkeypatch.setenv(gateway.URL_ENV, "https://ledger.internal:8443/base/")
    assert http.get("/api/ledger/status").status_code == 200
    assert str(ledger.seen[0].url) == "https://ledger.internal:8443/base/v1/status"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://127.0.0.1:3000",
        "127.0.0.1:3000",
        "http://",
        "http://user:pw@127.0.0.1:3000",
        "http://127.0.0.1:3000?x=1",
        "http://127.0.0.1:3000#x",
        "http://127.0.0.1:notaport",
    ],
)
def test_a_bad_ledger_url_is_503_and_nothing_is_sent(
    monkeypatch: pytest.MonkeyPatch, http: TestClient, ledger: FakeLedger, url: str
) -> None:
    monkeypatch.setenv(gateway.URL_ENV, url)
    response = http.get("/api/ledger/status")
    assert response.status_code == 503
    assert response.json() == {"error": "ledger_not_configured"}
    assert ledger.seen == []


def test_base_url_defaults_to_loopback() -> None:
    assert gateway.base_url({}) == "http://127.0.0.1:3000"
    assert gateway.base_url({gateway.URL_ENV: "  "}) == "http://127.0.0.1:3000"
    assert gateway.base_url({gateway.URL_ENV: "http://10.0.0.2:3000/"}) == "http://10.0.0.2:3000"


def test_a_long_query_is_414_and_never_sent(http: TestClient, ledger: FakeLedger) -> None:
    response = http.get("/api/ledger/actions?q=" + "a" * gateway.MAX_QUERY_BYTES)
    assert response.status_code == 414
    assert response.json() == {"error": "query_too_long"}
    assert ledger.seen == []
    assert (
        http.get("/api/ledger/actions?q=" + "a" * (gateway.MAX_QUERY_BYTES - 2)).status_code == 200
    )


# ---------------------------------------------------------------- the analytics query


def test_post_query_forwards_the_json_body(http: TestClient, ledger: FakeLedger) -> None:
    spec = {"metric": "count", "groupBy": ["action"], "chain": "mainnet"}
    ledger.handler = lambda request: httpx.Response(
        200, json={"rows": [], "echo": request.content.decode()}
    )
    response = http.post(
        "/api/ledger/analytics/query",
        content=json.dumps(spec),
        headers={"content-type": "application/json; charset=utf-8", "cookie": "a=b"},
    )
    assert response.status_code == 200
    assert json.loads(response.json()["echo"]) == spec
    (sent,) = ledger.seen
    assert sent.method == "POST"
    assert sent.url.path == "/v1/analytics/query"
    assert sent.headers["content-type"] == "application/json"
    assert "cookie" not in sent.headers
    assert "authorization" not in sent.headers


def test_post_body_over_16_kib_is_413_and_never_sent(http: TestClient, ledger: FakeLedger) -> None:
    big = json.dumps({"pad": "x" * gateway.MAX_BODY_BYTES})
    response = http.post(
        "/api/ledger/analytics/query", content=big, headers={"content-type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json() == {"error": "too_large"}
    assert ledger.seen == []


def test_post_body_at_the_cap_is_forwarded(http: TestClient, ledger: FakeLedger) -> None:
    body = b'"' + b"x" * (gateway.MAX_BODY_BYTES - 2) + b'"'
    response = http.post(
        "/api/ledger/analytics/query", content=body, headers={"content-type": "application/json"}
    )
    assert response.status_code == 200
    assert ledger.seen[0].content == body


def test_post_that_is_not_json_is_415(http: TestClient, ledger: FakeLedger) -> None:
    for headers in ({"content-type": "text/plain"}, {}):
        response = http.post("/api/ledger/analytics/query", content=b"{}", headers=headers)
        assert response.status_code == 415
        assert response.json() == {"error": "unsupported_media_type"}
    assert ledger.seen == []


# ---------------------------------------------------------------- failures


def test_a_timeout_is_504(http: TestClient, ledger: FakeLedger) -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    ledger.handler = hang
    response = http.get("/api/ledger/analytics/overview")
    assert response.status_code == 504
    assert response.json() == {"error": "ledger_timeout"}
    assert response.headers["cache-control"] == "private, no-store"


def test_the_total_deadline_is_504(
    monkeypatch: pytest.MonkeyPatch, http: TestClient, ledger: FakeLedger
) -> None:
    monkeypatch.setattr(gateway, "TOTAL_TIMEOUT_SECONDS", 0.05)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(2)
        return httpx.Response(200, json={})

    ledger.handler = slow
    response = http.get("/api/ledger/analytics/overview")
    assert response.status_code == 504
    assert response.json() == {"error": "ledger_timeout"}


def test_a_connect_timeout_is_504(http: TestClient, ledger: FakeLedger) -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("no syn-ack", request=request)

    ledger.handler = hang
    assert http.get("/api/ledger/status").status_code == 504


def test_unreachable_is_502(http: TestClient, ledger: FakeLedger) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    ledger.handler = refuse
    response = http.get("/api/ledger/status")
    assert response.status_code == 502
    assert response.json() == {"error": "ledger_unavailable"}


def test_an_oversize_answer_is_502(
    monkeypatch: pytest.MonkeyPatch, http: TestClient, ledger: FakeLedger
) -> None:
    monkeypatch.setattr(gateway, "MAX_RESPONSE_BYTES", 1024)
    # Declared too big, and streamed too big with no length declared.
    ledger.handler = lambda request: httpx.Response(200, json={"pad": "x" * 2048})
    response = http.get("/api/ledger/actions")
    assert response.status_code == 502
    assert response.json() == {"error": "ledger_response_too_large"}

    async def chunks() -> Any:
        for _ in range(4):
            yield b" " * 512

    ledger.handler = lambda request: httpx.Response(
        200, content=chunks(), headers={"content-type": "application/json"}
    )
    response = http.get("/api/ledger/actions")
    assert response.status_code == 502
    assert response.json() == {"error": "ledger_response_too_large"}


def test_an_answer_that_is_not_json_is_502(http: TestClient, ledger: FakeLedger) -> None:
    ledger.handler = lambda request: httpx.Response(
        200, text="<script>alert(1)</script>", headers={"content-type": "text/html"}
    )
    response = http.get("/api/ledger/status")
    assert response.status_code == 502
    assert response.json() == {"error": "ledger_bad_response"}


def test_a_redirect_is_not_followed(http: TestClient, ledger: FakeLedger) -> None:
    ledger.handler = lambda request: httpx.Response(302, headers={"location": "http://evil/"})
    response = http.get("/api/ledger/status", follow_redirects=False)
    assert response.status_code == 302
    assert "location" not in response.headers
    assert len(ledger.seen) == 1


def test_the_real_client_dependency_is_closed_after_use() -> None:
    async def run() -> httpx.AsyncClient:
        from forge_api.routers.ledger import get_ledger_client as real

        dependency = real()
        client = await anext(dependency)
        with pytest.raises(StopAsyncIteration):
            await anext(dependency)
        return client

    assert asyncio.run(run()).is_closed


def test_forward_checks_the_allowlist_itself() -> None:
    async def run() -> None:
        async with gateway.make_client(httpx.MockTransport(lambda r: pytest.fail("sent"))) as c:
            await gateway.forward(c, method="GET", path="health", query=b"")

    with pytest.raises(ApiError) as raised:
        asyncio.run(run())
    assert raised.value.status_code == 404
