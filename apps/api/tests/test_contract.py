"""Cross-boundary drift guard (PRD Appendix H.1).

`packages/shared` declares every optional field with zod `.optional()`, which accepts
a missing key and *rejects* an explicit null. So no response body may contain a JSON
null anywhere — otherwise `Schema.parse(await res.json())` throws in apps/web.
"""

from typing import Any

from fastapi.testclient import TestClient


def _has_null(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, dict):
        return any(_has_null(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_null(item) for item in value)
    return False


def test_no_response_body_contains_a_json_null(client: TestClient) -> None:
    client.post("/api/bridge/claim", json={"taskId": 1})
    payloads = [
        client.get("/api/health").json(),
        client.get("/api/history?limit=200").json(),
        client.get("/api/flags").json(),
        client.get("/api/bridge/tasks").json(),
        client.post("/api/bridge/dispatch", json={"taskId": 1, "rail": "copilot"}).json(),
        client.post("/api/bridge/dispatch", json={"taskId": 1, "rail": "codex"}).json(),
        client.get("/api/bridge/status/1").json(),
        client.post("/api/bridge/feedback/1").json(),
        client.get("/api/bridge/profile").json(),
    ]
    for payload in payloads:
        assert not _has_null(payload), payload


def test_required_fields_are_always_present(client: TestClient) -> None:
    card = client.get("/api/bridge/tasks").json()["tasks"][0]
    assert set(card) >= {
        "id",
        "title",
        "civilianSummary",
        "size",
        "rewardClass",
        "tierFloor",
        "status",
        "url",
        "labels",
    }
    item = client.get("/api/history?limit=1").json()["items"][0]
    assert set(item) >= {"id", "ts", "type", "amount"}
