"""Members signed in with Google: the API takes their assertion, keys them `go:<id>`, lets
them use the routes that make sense without a GitHub account (the lobby, the Data app,
notifications, proposals), and refuses everything else with 403 `github_required`, the
default for any route that hasn't opted in. A Google member is never an admin."""

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from forge_api.services import identity
from forge_api.services import members as members_service
from forge_api.services.state import get_state_db

from .conftest import AuthHeaders

GOOGLE_SUB = "google:109876543210987654321"
GOOGLE_LOGIN = "g.jane-doe"
SECRET = "assertion-secret-for-google-tests-0123456789"


@pytest.fixture(autouse=True)
def lobby_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv(
        "FORGE_FLAGS_JSON",
        json.dumps({"apps_lobby": True, "lobby_avatars": True, "github_signin": True}),
    )
    yield


@pytest.fixture
def google_headers(auth_headers: AuthHeaders) -> dict[str, str]:
    return auth_headers(GOOGLE_SUB, GOOGLE_LOGIN)


def test_a_google_assertion_verifies_and_is_keyed_go() -> None:
    token = identity.mint_assertion(GOOGLE_SUB, GOOGLE_LOGIN, secret=SECRET)
    who = identity.verify_assertion(token, secret=SECRET)
    assert who == identity.Identity(sub=GOOGLE_SUB, login=GOOGLE_LOGIN)
    assert who.github is False
    assert who.member_id == "go:109876543210987654321"
    github = identity.Identity(sub="583231", login="octocat")
    assert github.github is True and github.member_id == "gh:583231"


@pytest.mark.parametrize(
    ("sub", "login"),
    [
        (GOOGLE_SUB, "octocat"),  # a Google sub with a GitHub login
        ("583231", GOOGLE_LOGIN),  # a GitHub id with a Google handle
        ("google:abc", GOOGLE_LOGIN),
        (GOOGLE_SUB, "g.Jane"),
        ("google:", GOOGLE_LOGIN),
    ],
)
def test_the_two_shapes_never_mix(sub: str, login: str) -> None:
    with pytest.raises(ValueError):
        identity.mint_assertion(sub, login, secret=SECRET)
    forged = identity.jwt.encode(
        {"iss": "forge-web", "aud": "forge-api", "sub": sub, "login": login, "iat": 1, "exp": 61},
        SECRET.encode(),
        algorithm="HS256",
    )
    with pytest.raises(identity.InvalidAssertion):
        identity.verify_assertion(forged, secret=SECRET, now=30)


def test_github_only_routes_refuse_a_google_member_and_say_why(
    client: TestClient, google_headers: dict[str, str]
) -> None:
    response = client.post("/api/bridge/claim", json={"taskId": 1}, headers=google_headers)
    assert response.status_code == 403
    assert response.json() == {"error": "github_required"}


def test_a_bad_assertion_is_still_401_not_403(client: TestClient) -> None:
    response = client.post(
        "/api/bridge/claim", json={"taskId": 1}, headers={"Authorization": "Bearer nonsense"}
    )
    assert response.status_code == 401


def test_a_google_member_is_never_an_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, "109876543210987654321")
    assert identity.is_admin(identity.Identity(sub=GOOGLE_SUB, login=GOOGLE_LOGIN)) is False


def test_a_google_member_says_hello_and_is_recorded(
    client: TestClient, google_headers: dict[str, str]
) -> None:
    assert client.post("/api/members/hello", headers=google_headers).status_code == 204
    subs = [member.sub for member in members_service.all_members(get_state_db())]
    assert GOOGLE_SUB in subs


def test_the_lobby_knows_a_google_member_as_go(
    client: TestClient, google_headers: dict[str, str]
) -> None:
    bricks = client.get("/api/lobby/bricks/me", headers=google_headers)
    assert bricks.status_code == 200
    assert bricks.json()["memberId"] == "go:109876543210987654321"
    assert bricks.json()["canStandIn"] is False
    avatars = client.get("/api/avatars/me", headers=google_headers)
    assert avatars.status_code == 200 and avatars.json() == {"canEdit": False}


def test_a_google_member_reads_their_notifications(
    client: TestClient, google_headers: dict[str, str]
) -> None:
    assert client.get("/api/notifications", headers=google_headers).status_code == 200


def test_the_avatar_editor_lists_a_google_member_as_go(
    client: TestClient,
    google_headers: dict[str, str],
    admin_headers: dict[str, str],
) -> None:
    client.post("/api/members/hello", headers=google_headers)
    members = client.get("/api/avatars/members", headers=admin_headers).json()["members"]
    assert {"memberId": "go:109876543210987654321", "login": GOOGLE_LOGIN} in members
    painted = client.put(
        "/api/avatars/members/go:109876543210987654321",
        headers=admin_headers,
        json={
            "colors": {"shell": "#e8e4da", "trim": "#3a7bd5", "accent": "#ffc23d", "eye": "#5ee7ff"}
        },
    )
    assert painted.status_code == 200
