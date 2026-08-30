"""Shared fixtures. Every test gets its own lease store, so nothing leaks between tests."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from forge_api.main import app
from forge_api.services.bridge import LeaseStore, get_lease_store


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
