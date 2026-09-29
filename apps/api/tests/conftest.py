"""Shared fixtures. Every test gets its own lease store, so nothing leaks between tests."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services import identity
from forge_api.services.bridge import LeaseStore, get_lease_store

#: As long as the real FORGE_API_ASSERTION_SECRET must be (32+ chars). Tests only.
TEST_ASSERTION_SECRET = "forge-tests-only-api-assertion-secret-0123456789"
USER_SUB, USER_LOGIN = "1001", "octo-contributor"
ADMIN_SUB, ADMIN_LOGIN = "1002", "octo-operator"

#: `auth_headers(sub, login, **mint_assertion_kwargs)` -> {"Authorization": "Bearer ..."}
AuthHeaders = Callable[..., dict[str, str]]


class FakeClock:
    """Injectable clock: the Bridge's simulated progression is a function of time."""

    def __init__(self, start: datetime) -> None:
        self.moment = start

    def __call__(self) -> datetime:
        return self.moment

    def advance(self, seconds: float) -> None:
        self.moment += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(datetime(2026, 8, 10, 9, 0, 0, tzinfo=UTC))


@pytest.fixture
def store(clock: FakeClock) -> LeaseStore:
    return LeaseStore(now_fn=clock)


@pytest.fixture
def client(store: LeaseStore) -> Iterator[TestClient]:
    app.dependency_overrides[get_lease_store] = lambda: store
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def assertion_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    """FORGE_API_ASSERTION_SECRET for this test; returned for minting by hand."""
    monkeypatch.setenv(identity.SECRET_ENV, TEST_ASSERTION_SECRET)
    return TEST_ASSERTION_SECRET


@pytest.fixture
def auth_headers(assertion_secret: str) -> AuthHeaders:
    """Request headers carrying a fresh assertion, minted as the web BFF does."""

    def make(sub: str = USER_SUB, login: str = USER_LOGIN, **kwargs: Any) -> dict[str, str]:
        token = identity.mint_assertion(sub, login, secret=assertion_secret, **kwargs)
        return {"Authorization": f"Bearer {token}"}

    return make


@pytest.fixture
def user_headers(auth_headers: AuthHeaders) -> dict[str, str]:
    """A signed-in contributor who is not on the admin allowlist."""
    return auth_headers(USER_SUB, USER_LOGIN)


@pytest.fixture
def admin_headers(auth_headers: AuthHeaders, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """A signed-in operator: their GitHub user id is on FORGE_ADMIN_IDS."""
    monkeypatch.setenv(identity.ADMIN_IDS_ENV, ADMIN_SUB)
    return auth_headers(ADMIN_SUB, ADMIN_LOGIN)
