import pytest
from fastapi.testclient import TestClient

from forge_api.main import DEFAULT_CORS_ORIGINS, allowed_origins


def test_health_reports_ok_and_version(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.1.0"}


@pytest.mark.parametrize("origin", ["http://localhost:3000", "http://localhost:3100"])
def test_cors_allows_the_dev_and_playwright_origins(client: TestClient, origin: str) -> None:
    """3000 is `next dev`, 3100 is the Playwright web server — both must pass CORS."""
    response = client.get("/api/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_cors_origins_are_configurable_via_env() -> None:
    assert allowed_origins({}) == DEFAULT_CORS_ORIGINS.split(",")
    assert allowed_origins({"FORGE_CORS_ORIGINS": ""}) == DEFAULT_CORS_ORIGINS.split(",")
    assert allowed_origins({"FORGE_CORS_ORIGINS": "https://forge.example"}) == [
        "https://forge.example"
    ]
    assert allowed_origins({"FORGE_CORS_ORIGINS": " https://a.example , https://b.example ,"}) == [
        "https://a.example",
        "https://b.example",
    ]
