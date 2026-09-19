"""Flag layering (config/flags.json < FORGE_FLAGS_PATH < FORGE_FLAGS_JSON,
defaults all False) and the fail-closed kill path for a present-but-invalid
source. See forge_api.services.flags for the full contract."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from forge_api.services import flags as flags_service


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(flags_service.ENV_JSON, raising=False)
    monkeypatch.delenv(flags_service.ENV_PATH, raising=False)


def test_defaults_come_from_the_repo_config_walk_up() -> None:
    found = flags_service.find_config_file()
    assert found is not None and found.name == "flags.json"
    assert flags_service.get_flags().model_dump() == json.loads(found.read_text())


def test_env_path_file_overrides_repo_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    override = tmp_path / "flags.json"
    override.write_text(json.dumps({"csv_export": False}), encoding="utf-8")
    monkeypatch.setenv(flags_service.ENV_PATH, str(override))
    flags = flags_service.get_flags()
    assert flags.csv_export is False
    # Partial config merges over the defaults instead of blanking them.
    assert flags.contribute_bridge is True


def test_env_json_wins_over_env_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    override = tmp_path / "flags.json"
    override.write_text(json.dumps({"csv_export": False, "contribute_bridge": False}), "utf-8")
    monkeypatch.setenv(flags_service.ENV_PATH, str(override))
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"csv_export": True}))
    flags = flags_service.get_flags()
    assert flags.csv_export is True
    assert flags.contribute_bridge is False


def test_malformed_sources_never_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, "{not json")
    monkeypatch.setenv(flags_service.ENV_PATH, "/nonexistent/flags.json")
    assert flags_service.get_flags().model_dump() == flags_service.DEFAULT_FLAGS


def test_all_flags_false_when_no_source_is_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No repo config, no env overrides: DEFAULT_FLAGS all being False is what
    # makes an unconfigured deploy come up with every kill switch off.
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: None)
    assert flags_service.get_flags().model_dump() == {
        "csv_export": False,
        "contribute_bridge": False,
        "upland_data": False,
    }


def test_layering_order_is_file_then_path_then_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo_config = tmp_path / "repo-flags.json"
    repo_config.write_text(json.dumps({"csv_export": True, "contribute_bridge": True}))
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: repo_config)

    path_override = tmp_path / "path-flags.json"
    path_override.write_text(json.dumps({"csv_export": False}))  # contribute_bridge untouched
    monkeypatch.setenv(flags_service.ENV_PATH, str(path_override))

    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps({"csv_export": True}))  # untouched too

    flags = flags_service.get_flags()
    # csv_export: True (repo config) -> False (path) -> True (json): last layer wins.
    # contribute_bridge: never restated after the repo config layer, so it survives.
    assert flags.csv_export is True
    assert flags.contribute_bridge is True


def test_env_json_bad_json_fails_closed_even_over_a_valid_earlier_layer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo_config = tmp_path / "repo-flags.json"
    repo_config.write_text(json.dumps({"csv_export": True, "contribute_bridge": True}))
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: repo_config)
    monkeypatch.setenv(flags_service.ENV_JSON, "{not valid json")

    assert flags_service.get_flags().model_dump() == {
        "csv_export": False,
        "contribute_bridge": False,
        "upland_data": False,
    }


def test_env_path_missing_file_fails_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(flags_service.ENV_PATH, str(tmp_path / "does-not-exist.json"))
    assert flags_service.get_flags().model_dump() == {
        "csv_export": False,
        "contribute_bridge": False,
        "upland_data": False,
    }


def test_known_flag_non_boolean_fails_closed_even_with_a_valid_sibling_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo_config = tmp_path / "repo-flags.json"
    repo_config.write_text(json.dumps({"csv_export": True, "contribute_bridge": True}))
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: repo_config)
    # contribute_bridge is validly True here — it must NOT survive the kill switch.
    monkeypatch.setenv(
        flags_service.ENV_JSON, json.dumps({"csv_export": "nope", "contribute_bridge": True})
    )

    assert flags_service.get_flags().model_dump() == {
        "csv_export": False,
        "contribute_bridge": False,
        "upland_data": False,
    }


@pytest.mark.parametrize("payload", [[1, 2, 3], "hello", 42])
def test_non_object_top_level_fails_closed(
    monkeypatch: pytest.MonkeyPatch, payload: object
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, json.dumps(payload))
    assert flags_service.get_flags().model_dump() == {
        "csv_export": False,
        "contribute_bridge": False,
        "upland_data": False,
    }


def test_unknown_keys_are_ignored_not_treated_as_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(flags_service, "find_config_file", lambda start=None: None)
    monkeypatch.setenv(
        flags_service.ENV_JSON,
        json.dumps({"csv_export": True, "some_future_flag": True, "another_unknown": "x"}),
    )

    flags = flags_service.get_flags()
    assert flags.csv_export is True
    assert flags.contribute_bridge is False  # default — never touched by a valid layer


def test_logs_a_warning_once_when_failing_closed(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv(flags_service.ENV_JSON, "{not valid json")
    with caplog.at_level("WARNING", logger="forge_api.services.flags"):
        flags_service.get_flags()
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert flags_service.ENV_JSON in warnings[0].message


def test_is_enabled_is_false_for_an_unknown_flag_name() -> None:
    assert flags_service.is_enabled("some_flag_that_does_not_exist") is False


def test_flags_endpoint_returns_both_flags(client: TestClient) -> None:
    payload = client.get("/api/flags").json()
    assert set(payload) == {"csv_export", "contribute_bridge", "upland_data"}
    assert all(isinstance(value, bool) for value in payload.values())
