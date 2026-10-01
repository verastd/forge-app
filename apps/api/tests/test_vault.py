"""Saved agent keys (services/vault.py): sealed per user and rail, hints only on the way
out, and switched off cleanly when FORGE_VAULT_KEY is missing or malformed."""

import base64
import logging
from datetime import UTC, datetime

import pytest

from forge_api.services import vault as vault_service
from forge_api.services.rail_adapters.base import RailCredential
from forge_api.services.state import StateDB, get_state_db
from forge_api.services.vault import Vault, hint_for, master_key

from .bridge_helpers import (
    DEVIN_KEY,
    DEVIN_ORG,
    JULES_KEY,
    OTHER_VAULT_MASTER,
    ROUTINE_TOKEN,
    ROUTINE_URL,
    TEST_VAULT_MASTER,
    vault_key,
)

NOW = datetime(2026, 8, 10, 9, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _cold_cache() -> None:
    vault_service._decode_master.cache_clear()


@pytest.fixture
def db() -> StateDB:
    return get_state_db()


def make(db: StateDB, master: bytes | None = TEST_VAULT_MASTER) -> Vault:
    return Vault(db, master, now_fn=lambda: NOW)


def test_a_saved_credential_round_trips(db: StateDB) -> None:
    vault = make(db)
    saved = vault.save("1001", "devin", RailCredential(key=DEVIN_KEY, org_id=DEVIN_ORG))
    assert saved is not None
    assert (saved.rail, saved.hint, saved.savedAt) == ("devin", "…tial", "2026-08-10T09:00:00Z")
    loaded = vault.load("1001", "devin")
    assert loaded == RailCredential(key=DEVIN_KEY, org_id=DEVIN_ORG)
    routine = RailCredential(key=ROUTINE_TOKEN, routine_url=ROUTINE_URL)
    vault.save("1001", "claude-routine", routine)
    assert vault.load("1001", "claude-routine") == routine


def test_nothing_readable_is_stored(db: StateDB) -> None:
    make(db).save("1001", "jules", RailCredential(key=JULES_KEY))
    row = db.query_one("SELECT * FROM vault_credentials")
    assert row is not None
    assert JULES_KEY.encode() not in row["ciphertext"]
    assert JULES_KEY not in repr(row)
    assert len(row["nonce"]) == 12
    assert row["hint"] == "…tial"


def test_every_save_uses_a_fresh_nonce(db: StateDB) -> None:
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    first = db.query_one("SELECT nonce, ciphertext FROM vault_credentials")
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    second = db.query_one("SELECT nonce, ciphertext FROM vault_credentials")
    assert first is not None and second is not None
    assert first["nonce"] != second["nonce"]
    assert first["ciphertext"] != second["ciphertext"]
    assert len(db.query_all("SELECT * FROM vault_credentials")) == 1  # replaced, not added


def test_a_row_moved_to_another_user_or_rail_does_not_open(
    db: StateDB, caplog: pytest.LogCaptureFixture
) -> None:
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    db.execute("UPDATE vault_credentials SET sub = '1003'")
    with caplog.at_level(logging.WARNING):
        assert vault.load("1003", "jules") is None
    db.execute("UPDATE vault_credentials SET sub = '1001', rail = 'cursor'")
    assert vault.load("1001", "cursor") is None
    assert JULES_KEY not in caplog.text


def test_tampering_or_another_master_key_does_not_open(db: StateDB) -> None:
    make(db).save("1001", "jules", RailCredential(key=JULES_KEY))
    assert make(db, OTHER_VAULT_MASTER).load("1001", "jules") is None
    row = db.query_one("SELECT ciphertext FROM vault_credentials")
    assert row is not None
    flipped = bytes([row["ciphertext"][0] ^ 1]) + row["ciphertext"][1:]
    db.execute("UPDATE vault_credentials SET ciphertext = ?", (flipped,))
    assert make(db).load("1001", "jules") is None


def test_users_never_see_each_others_keys(db: StateDB) -> None:
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    assert vault.load("1003", "jules") is None
    assert vault.list_saved("1003") == []
    assert vault.saved_rails("1001") == {"jules"}


def test_copilot_and_open_rails_are_never_saved(db: StateDB) -> None:
    vault = make(db)
    assert vault.save("1001", "copilot", RailCredential(key=JULES_KEY)) is None
    assert vault.save("1001", "claude-code", RailCredential(key=JULES_KEY)) is None  # type: ignore[arg-type]
    assert db.query_all("SELECT * FROM vault_credentials") == []
    assert vault.load("1001", "copilot") is None


def test_list_is_in_rail_order_with_last_use(db: StateDB) -> None:
    vault = make(db)
    vault.save("1001", "claude-routine", RailCredential(key=ROUTINE_TOKEN, routine_url=ROUTINE_URL))
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    vault.mark_used("1001", "jules")
    listed = vault.list_saved("1001")
    assert [saved.rail for saved in listed] == ["jules", "claude-routine"]
    assert listed[0].lastUsedAt == "2026-08-10T09:00:00Z"
    assert listed[1].lastUsedAt is None
    assert vault.delete("1001", "jules") is True
    assert vault.delete("1001", "jules") is False
    assert [saved.rail for saved in vault.list_saved("1001")] == ["claude-routine"]


def test_hints_never_give_away_a_short_key() -> None:
    assert hint_for("test-only-abcdef") == "…cdef"
    assert hint_for("short-key") == "…"


@pytest.mark.parametrize(
    ("raw", "valid"),
    [
        (None, False),
        ("", False),
        ("   ", False),
        ("not base64 at all!", False),
        (base64.b64encode(b"sixteen-byte-key").decode(), False),
        (base64.b64encode(TEST_VAULT_MASTER + b"x").decode(), False),
        (vault_key(), True),
        (f"  {vault_key()}\n", True),
    ],
)
def test_master_key_must_be_32_bytes_of_base64(raw: str | None, valid: bool) -> None:
    env = {} if raw is None else {"FORGE_VAULT_KEY": raw}
    assert (master_key(env) == TEST_VAULT_MASTER) is valid


def test_a_bad_master_key_warns_once_without_its_value(caplog: pytest.LogCaptureFixture) -> None:
    raw = base64.b64encode(b"test-only-wrong-length").decode()
    with caplog.at_level(logging.WARNING):
        assert master_key({"FORGE_VAULT_KEY": raw}) is None
        assert master_key({"FORGE_VAULT_KEY": raw}) is None
    assert len(caplog.records) == 1
    assert raw not in caplog.text


def test_an_off_vault_saves_and_shows_nothing(db: StateDB, monkeypatch: pytest.MonkeyPatch) -> None:
    make(db).save("1001", "jules", RailCredential(key=JULES_KEY))
    monkeypatch.delenv("FORGE_VAULT_KEY", raising=False)
    off = Vault.from_env(db)
    assert off.enabled is False
    assert off.save("1001", "cursor", RailCredential(key=JULES_KEY)) is None
    assert off.load("1001", "jules") is None
    assert off.list_saved("1001") == [] and off.saved_rails("1001") == set()
    assert off.delete("1001", "jules") is True  # removing still works
    monkeypatch.setenv("FORGE_VAULT_KEY", vault_key())
    assert Vault.from_env(db).enabled is True


def test_a_payload_without_a_key_is_ignored(db: StateDB) -> None:
    vault = make(db)
    sealed = vault._aead("1001").encrypt(b"\x00" * 12, b'{"orgId": "x"}', b"1001:devin")
    db.execute(
        "INSERT INTO vault_credentials (sub, rail, nonce, ciphertext, hint, saved_at) "
        "VALUES ('1001', 'devin', ?, ?, '…', 'now')",
        (b"\x00" * 12, sealed),
    )
    assert vault.load("1001", "devin") is None
    with pytest.raises(RuntimeError):
        make(db, None)._aead("1001")
