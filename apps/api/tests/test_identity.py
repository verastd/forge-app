"""API identity (services/identity): the web tier's HS256 assertion, the 401/403 gates, and
their order on the /api/upland routers: upland_data (404) -> identity (401) -> admin (403).

Unit tests pin `now`; HTTP tests mint against the real clock, as the BFF does.
"""

import base64
import hashlib
import hmac
import json
import logging
import re
import time
from collections.abc import Callable
from typing import Any

import jwt
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from jwt.warnings import InsecureKeyLengthWarning

from forge_api.main import app
from forge_api.models import GcsStatus, GcsSyncResult, ScrapeRequest, ScrapeStatus
from forge_api.routers import upland_scrape
from forge_api.services import flags as flags_service
from forge_api.services import identity
from forge_api.services.identity import (
    Identity,
    InvalidAssertion,
    mint_assertion,
    verify_assertion,
)
from forge_api.services.upland.scraper import get_scrape_manager
from forge_api.services.upland.storage import get_sync_manager

AuthHeaders = Callable[..., dict[str, str]]

#: 64+ characters, so the HS384/HS512 forgeries below sign without pyjwt's short-key warning.
SECRET = "unit-test-assertion-secret-" + "0123456789abcdef" * 3
NOW = 1_790_000_000
SUB, LOGIN = "583231", "octocat"
USER_SUB, USER_LOGIN = "1001", "octo-contributor"
ADMIN_SUB, ADMIN_LOGIN = "1002", "octo-operator"
HEADER = {"alg": "HS256", "typ": "JWT"}
DROP = object()  # claims(x=DROP) leaves the claim out

PROBE = "/api/upland/codes"  # a read route that touches neither the database nor the chain
UNAUTHENTICATED = {"error": "unauthenticated"}
ADMIN_ONLY = {"error": "admin_only"}
UPLAND_DISABLED = {"error": "upland-disabled"}

SCRAPE_CONTROLS = [
    ("POST", "/api/upland/scrape"),
    ("GET", "/api/upland/scrape/status"),
    ("POST", "/api/upland/scrape/cancel"),
    ("POST", "/api/upland/gcs/sync"),
    ("GET", "/api/upland/gcs/status"),
]
#: Every /api/upland operation the app serves, whichever router registered it. Read from
#: the OpenAPI view: FastAPI no longer copies included routes onto `app.routes`.
UPLAND_ROUTES = sorted(
    (method.upper(), re.sub(r"\{[^}]*\}", "x", path))
    for path, operations in app.openapi()["paths"].items()
    if path.startswith("/api/upland/")
    for method in operations
)


def claims(**overrides: Any) -> dict[str, Any]:
    """A valid claim set at NOW, with overrides applied."""
    base: dict[str, Any] = {
        "iss": "forge-web",
        "aud": "forge-api",
        "sub": SUB,
        "login": LOGIN,
        "iat": NOW,
        "exp": NOW + 60,
    }
    base.update(overrides)
    return {name: value for name, value in base.items() if value is not DROP}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign(payload: Any, header: dict[str, Any] | None = None, *, key: str = SECRET) -> str:
    """A compact JWS built by hand and HMAC-SHA256 signed with `key`, whatever the header
    claims: a forger can say things pyjwt's encoder refuses to."""
    parts = (HEADER if header is None else header, payload)
    signing_input = ".".join(b64url(json.dumps(part).encode()) for part in parts)
    signature = hmac.new(key.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


def assert_rejected(token: str, *, secret: str = SECRET, now: int = NOW) -> None:
    with pytest.raises(InvalidAssertion):
        verify_assertion(token, secret=secret, now=now)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def token_of(headers: dict[str, str]) -> str:
    return headers["Authorization"].removeprefix("Bearer ")


def set_flags(monkeypatch: pytest.MonkeyPatch, *, upland_data: bool, github_signin: bool) -> None:
    flags = {"upland_data": upland_data, "github_signin": github_signin}
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps(flags))


@pytest.fixture(autouse=True)
def _gates_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both flags on, whatever config/flags.json says; tests close them explicitly."""
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)
    set_flags(monkeypatch, upland_data=True, github_signin=True)


@pytest.fixture(autouse=True)
def _cold_admin_cache() -> None:
    """The parsed admin allowlist is cached per value (to warn once); start each test cold."""
    identity._parse_admin_ids.cache_clear()


class FakeScraper:
    """Stands in for ScrapeManager: answers without touching Hyperion."""

    status = ScrapeStatus(running=False, phase="idle")

    async def start(self, request: ScrapeRequest) -> ScrapeStatus:
        return ScrapeStatus(running=True, phase="starting")

    async def cancel(self) -> ScrapeStatus:
        return ScrapeStatus(running=False, phase="cancelled")


class FakeSync:
    """Stands in for GcsSyncManager: answers without touching GCS."""

    def status(self) -> GcsStatus:
        return GcsStatus(configured=False, running=False)

    async def sync(self) -> GcsSyncResult:
        return GcsSyncResult(synced=False, uploadedFiles=[], errors=[])


@pytest.fixture
def controls(client: TestClient) -> TestClient:
    """`client`, with scrape and GCS managers that reach no network. `client` clears them."""
    app.dependency_overrides[get_scrape_manager] = FakeScraper
    app.dependency_overrides[get_sync_manager] = FakeSync
    return client


# --- verify_assertion: what verifies --------------------------------------------------


def test_a_valid_assertion_verifies() -> None:
    assert verify_assertion(sign(claims()), secret=SECRET, now=NOW) == Identity(SUB, LOGIN)


def test_typ_is_optional_but_must_be_jwt_when_present() -> None:
    assert verify_assertion(sign(claims(), {"alg": "HS256"}), secret=SECRET, now=NOW).sub == SUB
    for typ in ("at+jwt", "jwt", "", None, 1):
        assert_rejected(sign(claims(), {"alg": "HS256", "typ": typ}))


def test_the_clock_defaults_to_now() -> None:
    assert verify_assertion(mint_assertion(SUB, LOGIN, secret=SECRET), secret=SECRET).sub == SUB
    stale = mint_assertion(SUB, LOGIN, secret=SECRET, now=int(time.time()) - 3600)
    with pytest.raises(InvalidAssertion):
        verify_assertion(stale, secret=SECRET)


# --- verify_assertion: algorithms -----------------------------------------------------


@pytest.mark.parametrize("alg", ["none", "None", "NONE"])
def test_alg_none_is_rejected(alg: str) -> None:
    header = {"alg": alg, "typ": "JWT"}
    unsigned = sign(claims(), header).rsplit(".", 1)[0] + "."
    assert_rejected(unsigned)
    assert_rejected(sign(claims(), header))  # even carrying a genuine HMAC


@pytest.mark.parametrize("algorithm", ["HS384", "HS512"])
def test_other_hmac_algorithms_are_rejected_even_with_the_right_secret(algorithm: str) -> None:
    token = jwt.encode(claims(), SECRET.encode(), algorithm=algorithm)
    assert jwt.PyJWS().decode(token, SECRET.encode(), algorithms=[algorithm])  # genuine
    assert_rejected(token)


def test_rs256_with_a_real_key_is_rejected() -> None:
    rsa = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.rsa")
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(claims(), private_key, algorithm="RS256")
    assert jwt.PyJWS().decode(token, private_key.public_key(), algorithms=["RS256"])  # genuine
    assert_rejected(token)


@pytest.mark.parametrize("alg", ["RS256", "ES256", "PS256", "EdDSA", "hs256", "HS256 ", ""])
def test_a_header_naming_any_other_alg_is_rejected(alg: str) -> None:
    # Hand-built, so this runs without `cryptography`: the HMAC is genuine, the alg is not.
    assert_rejected(sign(claims(), {"alg": alg, "typ": "JWT"}))


def test_a_header_without_alg_is_rejected() -> None:
    assert_rejected(sign(claims(), {"typ": "JWT"}))


# --- verify_assertion: claims ---------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"iss": "forge-evil"},
        {"iss": "FORGE-WEB"},
        {"iss": 7},
        {"aud": "forge-web"},
        {"aud": "forge-api "},
        {"aud": ["forge-api"]},
        {"aud": ["forge-api", "elsewhere"]},
    ],
    ids=repr,
)
def test_wrong_issuer_or_audience_is_rejected(overrides: dict[str, Any]) -> None:
    assert_rejected(sign(claims(**overrides)))


@pytest.mark.parametrize("claim", ["iss", "aud", "sub", "login", "iat", "exp"])
def test_each_claim_is_required(claim: str) -> None:
    assert_rejected(sign(claims(**{claim: DROP})))
    assert_rejected(sign(claims(**{claim: None})))


def test_expiry_is_exclusive() -> None:
    assert_rejected(sign(claims(iat=NOW - 60, exp=NOW)))  # exp == now
    assert verify_assertion(sign(claims(iat=NOW - 59, exp=NOW + 1)), secret=SECRET, now=NOW)


def test_iat_may_run_at_most_30_seconds_ahead() -> None:
    assert verify_assertion(sign(claims(iat=NOW + 30, exp=NOW + 90)), secret=SECRET, now=NOW)
    assert_rejected(sign(claims(iat=NOW + 31, exp=NOW + 91)))


@pytest.mark.parametrize(
    ("iat", "exp", "valid"),
    [
        (NOW, NOW + 120, True),
        (NOW, NOW + 121, False),
        (NOW + 10, NOW + 10, False),  # zero lifetime
        (NOW + 20, NOW + 10, False),  # exp before iat
    ],
)
def test_lifetime_is_at_most_120_seconds(iat: int, exp: int, valid: bool) -> None:
    token = sign(claims(iat=iat, exp=exp))
    if valid:
        assert verify_assertion(token, secret=SECRET, now=NOW) == Identity(SUB, LOGIN)
    else:
        assert_rejected(token)


@pytest.mark.parametrize(
    "overrides",
    [{"iat": float(NOW)}, {"exp": float(NOW + 60)}, {"iat": str(NOW)}, {"exp": str(NOW + 60)}],
    ids=repr,
)
def test_iat_and_exp_must_be_integers(overrides: dict[str, Any]) -> None:
    assert_rejected(sign(claims(**overrides)))


def test_bool_time_claims_are_not_integers() -> None:
    # At now=0 a bool passes every numeric check (False == 0, True == 1) if it counts as int.
    assert verify_assertion(sign(claims(iat=0, exp=60)), secret=SECRET, now=0).sub == SUB
    assert_rejected(sign(claims(iat=False, exp=60)), now=0)
    assert_rejected(sign(claims(iat=0, exp=True)), now=0)


def test_nbf_when_present_is_checked_against_now() -> None:
    assert verify_assertion(sign(claims(nbf=NOW + 30)), secret=SECRET, now=NOW)
    for nbf in (NOW + 31, float(NOW), None, True):
        assert_rejected(sign(claims(nbf=nbf)))


@pytest.mark.parametrize(
    "sub",
    ["demo", "0123", "0", "1" * 21, "", "12a", "-1", "+1", " 1", "1\n", "１２", 583231, True],
    ids=repr,
)
def test_sub_must_be_a_github_numeric_id(sub: object) -> None:
    assert_rejected(sign(claims(sub=sub)))


@pytest.mark.parametrize("sub", ["1", "583231", "9" * 20])
def test_sub_accepts_github_numeric_ids(sub: str) -> None:
    assert verify_assertion(sign(claims(sub=sub)), secret=SECRET, now=NOW).sub == sub


@pytest.mark.parametrize(
    "login",
    ["-x", "a_b", "a" * 40, "", "a b", "a.b", "é", "octocat\n", 42, True],
    ids=repr,
)
def test_login_must_be_a_github_login(login: object) -> None:
    assert_rejected(sign(claims(login=login)))


@pytest.mark.parametrize("login", ["a", "a" * 39, "Octo-Cat", "x-", "a--b", "0"])
def test_login_accepts_github_logins(login: str) -> None:
    assert verify_assertion(sign(claims(login=login)), secret=SECRET, now=NOW).login == login


# --- verify_assertion: signatures and secrets -----------------------------------------


def test_a_tampered_token_is_rejected() -> None:
    header, payload, signature = sign(claims()).split(".")
    flipped = ("B" if signature[0] == "A" else "A") + signature[1:]
    assert_rejected(f"{header}.{payload}.{flipped}")
    impostor = b64url(json.dumps(claims(login="someone-else")).encode())
    assert_rejected(f"{header}.{impostor}.{signature}")


def test_a_token_signed_with_another_secret_is_rejected() -> None:
    assert_rejected(sign(claims(), key="another-secret-that-is-long-enough-0123456789"))


def test_a_short_secret_never_verifies_even_its_own_tokens() -> None:
    short = "s" * 31
    token = sign(claims(), key=short)
    with pytest.warns(InsecureKeyLengthWarning):  # pyjwt alone would accept it
        jwt.decode(
            token,
            short.encode(),
            algorithms=["HS256"],
            audience="forge-api",
            issuer="forge-web",
            options={"verify_exp": False, "verify_iat": False},
        )
    assert_rejected(token, secret=short)
    exactly = "s" * 32
    assert verify_assertion(sign(claims(), key=exactly), secret=exactly, now=NOW).sub == SUB


def test_an_unset_secret_never_verifies() -> None:
    assert_rejected(sign(claims(), key=""), secret="")
    assert_rejected(sign(claims()), secret="")


@pytest.mark.parametrize(
    "token",
    [
        "",
        "not-a-jwt",
        "a.b",
        "a.b.c",
        "é.é.é",
        sign(claims()) + ".extra",
        sign(["not", "an", "object"]),
        f"{b64url(b'[]')}.{b64url(json.dumps(claims()).encode())}.",
        f"{b64url(json.dumps(HEADER).encode())}.{b64url(b'{not json')}.",
    ],
    ids=repr,
)
def test_garbage_is_rejected(token: str) -> None:
    assert_rejected(token)


# --- mint_assertion -------------------------------------------------------------------


def test_mint_assertion_matches_the_web_contract() -> None:
    token = mint_assertion(SUB, LOGIN, secret=SECRET, now=NOW)
    assert jwt.get_unverified_header(token) == HEADER
    assert jwt.decode(token, options={"verify_signature": False}) == {
        "iss": "forge-web",
        "aud": "forge-api",
        "sub": SUB,
        "login": LOGIN,
        "iat": NOW,
        "exp": NOW + 60,
    }
    assert verify_assertion(token, secret=SECRET, now=NOW) == Identity(SUB, LOGIN)


def test_mint_assertion_ttl_bounds_the_lifetime() -> None:
    longest = mint_assertion(SUB, LOGIN, secret=SECRET, ttl=120, now=NOW)
    assert verify_assertion(longest, secret=SECRET, now=NOW + 119).login == LOGIN
    assert_rejected(longest, now=NOW + 120)
    shortest = mint_assertion(SUB, LOGIN, secret=SECRET, ttl=1, now=NOW)
    assert verify_assertion(shortest, secret=SECRET, now=NOW).login == LOGIN


@pytest.mark.parametrize(
    "overrides",
    [
        {"secret": "s" * 31},
        {"secret": ""},
        {"sub": "demo"},
        {"sub": "0123"},
        {"sub": "1" * 21},
        {"login": "-x"},
        {"login": "a_b"},
        {"login": "a" * 40},
        {"ttl": 0},
        {"ttl": 121},
        {"ttl": -1},
        {"ttl": True},
        {"ttl": 1.5},
        {"now": float(NOW)},
        {"now": True},
    ],
    ids=repr,
)
def test_mint_assertion_refuses_what_verification_would_reject(overrides: dict[str, Any]) -> None:
    kwargs: dict[str, Any] = {"sub": SUB, "login": LOGIN, "secret": SECRET, "now": NOW}
    kwargs.update(overrides)
    with pytest.raises(ValueError):
        mint_assertion(**kwargs)


# --- require_identity (HTTP) ----------------------------------------------------------


def test_a_signed_in_user_reaches_read_routes(
    client: TestClient, auth_headers: AuthHeaders
) -> None:
    assert client.get(PROBE, headers=auth_headers()).status_code == 200


def test_no_authorization_header_is_401(client: TestClient, assertion_secret: str) -> None:
    response = client.get(PROBE)
    assert response.status_code == 401
    assert response.json() == UNAUTHENTICATED
    assert response.headers["www-authenticate"] == "Bearer"


def test_a_403_carries_no_bearer_challenge(
    client: TestClient, auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The challenge belongs to 401 only: a known non-admin is not asked to re-authenticate.
    monkeypatch.delenv(identity.ADMIN_IDS_ENV, raising=False)
    response = client.get("/api/upland/scrape/status", headers=auth_headers())
    assert response.status_code == 403
    assert "www-authenticate" not in response.headers


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "bEaReR"])
def test_the_bearer_scheme_is_case_insensitive(
    client: TestClient, auth_headers: AuthHeaders, scheme: str
) -> None:
    token = token_of(auth_headers())
    assert client.get(PROBE, headers={"Authorization": f"{scheme} {token}"}).status_code == 200


@pytest.mark.parametrize(
    "template",
    [
        "",
        "{token}",
        "Bearer",
        "Bearer ",
        "Bearer  {token}",
        "Bearer\t{token}",
        "Bearer {token} {token}",
        "Bearer:{token}",
        "Basic {token}",
        "Token {token}",
    ],
    ids=repr,
)
def test_anything_but_bearer_space_token_is_401(
    client: TestClient, auth_headers: AuthHeaders, template: str
) -> None:
    value = template.format(token=token_of(auth_headers()))
    response = client.get(PROBE, headers={"Authorization": value})
    assert response.status_code == 401
    assert response.json() == UNAUTHENTICATED


def test_github_signin_off_is_401_even_for_a_valid_admin(
    controls: TestClient, auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, ADMIN_SUB)
    admin = auth_headers(ADMIN_SUB, ADMIN_LOGIN)
    set_flags(monkeypatch, upland_data=True, github_signin=False)
    assert controls.get(PROBE, headers=admin).json() == UNAUTHENTICATED
    assert controls.get("/api/upland/gcs/status", headers=admin).json() == UNAUTHENTICATED
    set_flags(monkeypatch, upland_data=True, github_signin=True)  # read per request
    assert controls.get(PROBE, headers=admin).status_code == 200


def test_an_expired_assertion_is_401(client: TestClient, auth_headers: AuthHeaders) -> None:
    stale = auth_headers(now=int(time.time()) - 600)
    assert client.get(PROBE, headers=stale).json() == UNAUTHENTICATED


@pytest.mark.parametrize("unset", ["missing", "empty"])
def test_an_unset_secret_is_401(
    client: TestClient, auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch, unset: str
) -> None:
    headers = auth_headers()  # minted with the web's secret, which the API then lacks
    if unset == "missing":
        monkeypatch.delenv(identity.SECRET_ENV)
    else:
        monkeypatch.setenv(identity.SECRET_ENV, "")
    assert client.get(PROBE, headers=headers).json() == UNAUTHENTICATED


def test_a_short_secret_in_the_environment_is_401(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    short = "s" * 31
    monkeypatch.setenv(identity.SECRET_ENV, short)
    now = int(time.time())
    token = sign(claims(iat=now, exp=now + 60), key=short)
    assert client.get(PROBE, headers=bearer(token)).json() == UNAUTHENTICATED


def test_rejections_log_the_reason_never_the_token(
    client: TestClient, auth_headers: AuthHeaders, caplog: pytest.LogCaptureFixture
) -> None:
    stale = auth_headers(now=int(time.time()) - 600)
    with caplog.at_level(logging.DEBUG, logger=identity.__name__):
        assert client.get(PROBE, headers=stale).status_code == 401
    assert "expired" in caplog.text
    assert token_of(stale).split(".")[-1] not in caplog.text  # not even the signature


# --- require_admin --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, set()),
        ("", set()),
        (" , ,, ", set()),
        ("1002", {"1002"}),
        (" 1002 , ,583231,, 1 ", {"1002", "583231", "1"}),
        ("9" * 20, {"9" * 20}),
    ],
)
def test_admin_ids_parsing(raw: str | None, expected: set[str]) -> None:
    env = {} if raw is None else {identity.ADMIN_IDS_ENV: raw}
    assert identity.admin_ids(env) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "octo-operator",  # a login, not an id
        "1002,octo-operator",  # one bad entry among good ones
        "0",
        "01002",
        "1" * 21,
        "-1002",
        "+1002",
        "1002.0",
        "1002 1003",  # a missing comma
        "1002;1003",
        "\uff11\uff10\uff10\uff12",  # full-width digits
    ],
    ids=repr,
)
def test_an_invalid_entry_empties_the_list_with_one_warning(
    raw: str, caplog: pytest.LogCaptureFixture
) -> None:
    env = {identity.ADMIN_IDS_ENV: raw}
    with caplog.at_level(logging.WARNING, logger=identity.__name__):
        assert identity.admin_ids(env) == frozenset()
        assert identity.admin_ids(env) == frozenset()  # asked again: still nobody, no new warning
    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "FORGE_ADMIN_IDS" in warnings[0].getMessage()


def test_a_valid_list_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger=identity.__name__):
        assert identity.admin_ids({identity.ADMIN_IDS_ENV: " 1002 ,583231"}) == {"1002", "583231"}
    assert caplog.records == []


@pytest.mark.parametrize(
    ("allowlist", "login"),
    [
        ("1002", "octo-operator"),
        (" , 583231 ,, 1002 ,", "octo-operator"),
        # A renamed account keeps its id, and with it the admin role.
        ("1002", "renamed-operator"),
    ],
)
def test_allowlisted_ids_are_admins_whatever_their_login(
    controls: TestClient,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    allowlist: str,
    login: str,
) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, allowlist)
    response = controls.get("/api/upland/scrape/status", headers=auth_headers(ADMIN_SUB, login))
    assert response.status_code == 200


@pytest.mark.parametrize(
    "allowlist",
    [None, "", " , ", "1001", "10020", "100", "583231,1", "octo-operator", "1002,octo-operator"],
)
def test_everyone_else_is_403(
    controls: TestClient,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    allowlist: str | None,
) -> None:
    if allowlist is None:
        monkeypatch.delenv(identity.ADMIN_IDS_ENV, raising=False)
    else:
        monkeypatch.setenv(identity.ADMIN_IDS_ENV, allowlist)
    would_be_admin = auth_headers(ADMIN_SUB, ADMIN_LOGIN)
    response = controls.get("/api/upland/scrape/status", headers=would_be_admin)
    assert response.status_code == 403
    assert response.json() == ADMIN_ONLY


def test_an_admins_login_under_another_id_is_not_admin(
    controls: TestClient, auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Whoever registers a renamed admin's old login gets a new id, and no admin role.
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, ADMIN_SUB)
    impostor = auth_headers("1003", ADMIN_LOGIN)
    response = controls.get("/api/upland/scrape/status", headers=impostor)
    assert response.status_code == 403
    assert response.json() == ADMIN_ONLY


def test_an_invalid_list_locks_out_a_listed_admin_and_warns_once(
    controls: TestClient,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, f"{ADMIN_SUB},{ADMIN_LOGIN}")
    admin = auth_headers(ADMIN_SUB, ADMIN_LOGIN)
    with caplog.at_level(logging.WARNING, logger=identity.__name__):
        for _ in range(3):
            assert controls.get("/api/upland/scrape/status", headers=admin).json() == ADMIN_ONLY
    assert len([record for record in caplog.records if record.levelno == logging.WARNING]) == 1


def test_admins_can_read_too(
    client: TestClient, auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, ADMIN_SUB)
    assert client.get(PROBE, headers=auth_headers(ADMIN_SUB, ADMIN_LOGIN)).status_code == 200


# --- gate order on the routers --------------------------------------------------------


def test_scrape_controls_lists_every_route_upland_scrape_serves() -> None:
    served = {
        (method, route.path)
        for route in upland_scrape.router.routes
        if isinstance(route, APIRoute)
        for method in route.methods
    }
    assert served == set(SCRAPE_CONTROLS)


def test_the_route_sweep_sees_both_routers() -> None:
    # An empty sweep would only skip the parametrized tests below, never fail them.
    assert set(SCRAPE_CONTROLS) < set(UPLAND_ROUTES)
    assert ("GET", PROBE) in UPLAND_ROUTES


@pytest.mark.parametrize(("method", "path"), UPLAND_ROUTES)
def test_every_upland_route_is_404_before_401_while_upland_data_is_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, method: str, path: str
) -> None:
    set_flags(monkeypatch, upland_data=False, github_signin=True)
    response = client.request(method, path)  # no assertion at all
    assert response.status_code == 404
    assert response.json() == UPLAND_DISABLED


@pytest.mark.parametrize(("method", "path"), UPLAND_ROUTES)
def test_every_upland_route_is_401_without_an_assertion(
    client: TestClient, assertion_secret: str, method: str, path: str
) -> None:
    response = client.request(method, path)
    assert response.status_code == 401
    assert response.json() == UNAUTHENTICATED


@pytest.mark.parametrize(("method", "path"), SCRAPE_CONTROLS)
def test_scrape_controls_gate_404_then_401_then_403(
    controls: TestClient,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, ADMIN_SUB)
    admin = auth_headers(ADMIN_SUB, ADMIN_LOGIN)
    user = auth_headers(USER_SUB, USER_LOGIN)
    body = {"days": 1} if path == "/api/upland/scrape" else None

    def call(headers: dict[str, str] | None = None) -> tuple[int, Any]:
        response = controls.request(method, path, headers=headers, json=body)
        return response.status_code, response.json()

    set_flags(monkeypatch, upland_data=False, github_signin=False)
    assert call() == (404, UPLAND_DISABLED)
    assert call(admin) == (404, UPLAND_DISABLED)
    set_flags(monkeypatch, upland_data=True, github_signin=True)
    assert call() == (401, UNAUTHENTICATED)
    assert call(user) == (403, ADMIN_ONLY)
    assert call(admin)[0] == 200


def test_the_scrape_body_is_not_validated_before_the_gates(
    client: TestClient, user_headers: dict[str, str]
) -> None:
    # A schema error is a 422 only for an admin; nobody else learns the body's shape.
    assert client.post("/api/upland/scrape", json={"days": 0}).json() == UNAUTHENTICATED
    invalid = client.post("/api/upland/scrape", json={"days": 0}, headers=user_headers)
    assert invalid.json() == ADMIN_ONLY
