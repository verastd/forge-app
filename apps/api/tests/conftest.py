"""Shared fixtures. Every test gets its own lease store and its own empty state database,
so nothing leaks between tests, and no test reaches Anthropic (`house_offline`)."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services import house, identity, state
from forge_api.services.bridge import LeaseStore, get_lease_store

#: As long as the real FORGE_API_ASSERTION_SECRET must be (32+ chars). Tests only.
TEST_ASSERTION_SECRET = "forge-tests-only-api-assertion-secret-0123456789"
USER_SUB, USER_LOGIN = "1001", "octo-contributor"
ADMIN_SUB, ADMIN_LOGIN = "1002", "octo-operator"

#: `auth_headers(sub, login, **mint_assertion_kwargs)` -> {"Authorization": "Bearer ..."}
AuthHeaders = Callable[..., dict[str, str]]


@pytest.fixture(autouse=True)
def state_db_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    """Every test gets its own state database file, empty until something opens it, and
    never the developer's var/forge-state.db. The file lives in pytest's tmp_path, so
    `get_state_db()` creates it (with every registered schema) on first use."""
    path = tmp_path / "forge-state.db"
    monkeypatch.setenv(state.PATH_ENV, str(path))
    state.reset_state_db()
    yield path
    state.reset_state_db()


def _no_client() -> Any:
    raise AssertionError("A test asked for the real Anthropic client: give it a fake one.")


@pytest.fixture(autouse=True)
def house_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test reaches Anthropic, whatever the developer's environment holds: the house's
    key and settings start unset (so the house is off until a test turns it on), and its
    client factory fails the test unless the test gives it a fake (tests/house_helpers.py).
    The app starts with no house worker (FORGE_HOUSE_WORKER off): the real one, on the
    real clock, would race the tests' own beats."""
    for name in (
        house.KEY_ENV,
        house.MODEL_ENV,
        house.EFFORT_ENV,
        house.DAILY_LIMIT_ENV,
        house.ROOT_ENV,
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(house.WORKER_ENV, "off")
    monkeypatch.setattr(house, "client_factory", _no_client)


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
