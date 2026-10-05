"""FORGE's own log lines (Phase 6 review, D2 and L6): under uvicorn, whose logging
configuration leaves every logger but its own at WARNING with no handler, FORGE's INFO
lines (the house's request ids and token counts, its daily-limit refusals) reach stderr,
once each, through one handler; Anthropic's SDK and its HTTP client stay at WARNING,
since at DEBUG they print whole requests, prompts included."""

import logging
import os
import subprocess
import sys
import textwrap
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from forge_api import main

API = Path(main.__file__).resolve().parents[2]


@contextmanager
def bare_root() -> Iterator[None]:
    """The root logger as uvicorn leaves it, with no handler, for a moment: pytest's own
    capture handler is taken off and put back in place."""
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        yield
    finally:
        root.handlers[:] = saved


def handlers() -> list[logging.Handler]:
    forge = logging.getLogger(main.FORGE_LOGGER)
    return [handler for handler in forge.handlers if isinstance(handler, main.StderrHandler)]


def test_forges_info_lines_reach_stderr_once(capsys: pytest.CaptureFixture[str]) -> None:
    main.configure_logging()
    main.configure_logging()  # however often it runs: one handler
    assert len(handlers()) == 1
    with bare_root():
        logging.getLogger("forge_api.services.house").info(
            "The house's %s call: request %s.", "pick", "req_1"
        )
        logging.getLogger("forge_api.services.bridge").debug("never shown")
        logging.getLogger("elsewhere").info("not FORGE's")
    assert capsys.readouterr().err == (
        "INFO: forge_api.services.house: The house's pick call: request req_1.\n"
    )


def test_nothing_is_printed_twice_when_the_root_logger_prints(
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """A log configuration of the operator's own (or the tests' capture) prints everything
    from the root logger: FORGE's handler then stays quiet."""
    main.configure_logging()
    with caplog.at_level(logging.INFO):
        logging.getLogger("forge_api.services.house").info("one line")
    assert caplog.text.count("one line") == 1
    assert capsys.readouterr().err == ""


def test_a_line_that_cant_be_written_is_reported_not_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reported: list[logging.LogRecord] = []

    class Broken:
        def write(self, text: str) -> int:
            raise OSError("stderr is gone")

    main.configure_logging()
    [handler] = handlers()
    monkeypatch.setattr(handler, "handleError", reported.append)
    monkeypatch.setattr(sys, "stderr", Broken())
    with bare_root():
        logging.getLogger("forge_api.services.house").warning("a warning")
    assert [record.getMessage() for record in reported] == ["a warning"]


def test_the_sdks_loggers_stay_at_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """L6: at DEBUG, Anthropic's SDK logs each request's options (the prompt, members' text
    included) and its HTTP client the headers. ANTHROPIC_LOG=debug sets them so."""
    for name in main.QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)
    main.configure_logging()
    assert main.QUIET_LOGGERS == ("anthropic", "httpx2", "httpcore2")
    for name in main.QUIET_LOGGERS:
        assert logging.getLogger(name).level == logging.WARNING
        assert not logging.getLogger(f"{name}.child").isEnabledFor(logging.INFO)
    assert logging.getLogger(main.FORGE_LOGGER).level == logging.INFO


SCRIPT = textwrap.dedent(
    """
    import logging, logging.config
    import uvicorn.config
    logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)
    import forge_api.main
    logging.getLogger("forge_api.services.house").info("house info line")
    logging.getLogger("forge_api.services.house").warning("house warning line")
    logging.getLogger("forge_api.services.proposals").debug("debug line")
    logging.getLogger("anthropic._base_client").debug("Request options: the prompt")
    logging.getLogger("httpcore2.http11").debug("send_request_headers.started")
    logging.getLogger("uvicorn.error").info("Started server process")
    """
)


def under_uvicorn(tmp_path: Path, **extra: str) -> list[str]:
    """Run SCRIPT as the box would: uvicorn configures logging (its LOGGING_CONFIG), then
    the app is imported. A separate interpreter, with no socket; stderr's lines."""
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("ANTHROPIC", "FORGE_HOUSE"))
    }
    environment.update(FORGE_STATE_DB_PATH=str(tmp_path / "state.db"), **extra)
    ran = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        capture_output=True,
        cwd=API,
        env=environment,
        text=True,
        timeout=120,
        check=False,
    )
    assert ran.returncode == 0, ran.stderr
    return ran.stderr.splitlines()


def test_under_uvicorns_own_logging_configuration(tmp_path: Path) -> None:
    """D2: FORGE's INFO lines reach stderr (journald on the box), once each."""
    lines = under_uvicorn(tmp_path)
    assert lines.count("INFO: forge_api.services.house: house info line") == 1
    assert lines.count("WARNING: forge_api.services.house: house warning line") == 1
    assert sum("house" in line for line in lines) == 2
    assert not [line for line in lines if "debug line" in line or "the prompt" in line]
    assert any("Started server process" in line for line in lines)


def test_anthropic_log_set_to_debug_prints_no_request(tmp_path: Path) -> None:
    """L6: ANTHROPIC_LOG=debug gives the root logger a handler and the SDK's loggers
    DEBUG; FORGE holds them at WARNING, so no request (prompt, headers) is printed, and its
    own lines still come once."""
    lines = under_uvicorn(tmp_path, ANTHROPIC_LOG="debug")
    assert sum("house info line" in line for line in lines) == 1
    assert sum("house warning line" in line for line in lines) == 1
    assert not [line for line in lines if "the prompt" in line or "send_request" in line]
