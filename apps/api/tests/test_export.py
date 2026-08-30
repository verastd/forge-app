"""Export endpoint contract (Task Spec issue #1 — full coverage lives in tests/acceptance)."""

import json

import pytest
from fastapi.testclient import TestClient

from forge_api.models import EXPORT_COLUMNS
from forge_api.services import flags as flags_service


def test_export_streams_csv_with_attachment_headers(client: TestClient) -> None:
    response = client.get("/api/export")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="history.csv"'
    assert response.text.splitlines()[0] == ",".join(EXPORT_COLUMNS)


def test_export_is_403_when_the_flag_is_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"csv_export": False}))
    response = client.get("/api/export")
    assert response.status_code == 403
    assert response.json() == {"error": "flag_disabled", "flag": "csv_export"}
