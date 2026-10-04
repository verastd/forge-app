"""Saved agent keys (services/vault.py): sealed per user and rail, hints only on the way
out, switched off cleanly when FORGE_VAULT_KEY is missing or malformed, still listed and
removable while it is, dead rows deleted where they are found, and no sealed copy left
in the database files once a key is removed or replaced."""

import base64
import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from forge_api.services import vault as vault_service
from forge_api.services.rail_adapters.base import RailCredential
from forge_api.services.state import StateDB, get_state_db
from forge_api.services.vault import Vault, hint_for, master_key

from .bridge_helpers import (
    CURSOR_KEY,
    DEVIN_KEY,
    DEVIN_ORG,
    JULES_KEY,
    OTHER_VAULT_MASTER,
    ROUTINE_TOKEN,
    ROUTINE_URL,
    TEST_VAULT_MASTER,
    BridgeEnv,
    install_bridge,
    vault_key,
)
from .conftest import FakeClock

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


def rows(db: StateDB) -> list[tuple[str, str]]:
    return [
        (row["sub"], row["rail"])
        for row in db.query_all("SELECT sub, rail FROM vault_credentials ORDER BY sub, rail")
    ]


def test_a_row_moved_to_another_user_or_rail_does_not_open(
    db: StateDB, caplog: pytest.LogCaptureFixture
) -> None:
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    db.execute("UPDATE vault_credentials SET sub = '1003'")
    with caplog.at_level(logging.WARNING):
        assert vault.load("1003", "jules") is None
    assert vault.list_saved("1003") == [] and vault.saved_rails("1003") == set()
    db.execute("UPDATE vault_credentials SET sub = '1001', rail = 'cursor'")
    assert vault.load("1001", "cursor") is None
    assert vault.list_saved("1001") == [] and vault.saved_rails("1001") == set()
    assert rows(db) == [("1001", "cursor")]  # no read deletes it
    assert JULES_KEY not in caplog.text


def test_tampering_or_another_master_key_does_not_open(db: StateDB) -> None:
    make(db).save("1001", "jules", RailCredential(key=JULES_KEY))
    assert make(db, OTHER_VAULT_MASTER).load("1001", "jules") is None
    row = db.query_one("SELECT ciphertext FROM vault_credentials")
    assert row is not None
    flipped = bytes([row["ciphertext"][0] ^ 1]) + row["ciphertext"][1:]
    db.execute("UPDATE vault_credentials SET ciphertext = ?", (flipped,))
    assert make(db).load("1001", "jules") is None
    assert make(db).list_saved("1001") == []
    assert rows(db) == [("1001", "jules")]


@pytest.mark.parametrize("reader", ["load", "saved_rails", "list_saved"])
def test_a_key_sealed_under_another_master_key_reads_as_not_saved_and_is_kept(
    db: StateDB, reader: str, caplog: pytest.LogCaptureFixture
) -> None:
    """CR-5: once FORGE_VAULT_KEY changed, every saved key still read "saved" (and offered
    a one-click start that always failed) though it never opened. Now it reads as not
    saved everywhere. No read deletes it: a FORGE_VAULT_KEY set wrong by mistake loses
    nothing, and with the right key back every key opens again."""
    make(db).save("1001", "jules", RailCredential(key=JULES_KEY))
    make(db).save("1001", "cursor", RailCredential(key=CURSOR_KEY))
    rotated = make(db, OTHER_VAULT_MASTER)
    rotated.save("1001", "devin", RailCredential(key=DEVIN_KEY, org_id=DEVIN_ORG))  # opens
    with caplog.at_level(logging.WARNING):
        if reader == "load":
            assert rotated.load("1001", "jules") is None
            assert rotated.load("1001", "cursor") is None
        elif reader == "saved_rails":
            assert rotated.saved_rails("1001") == {"devin"}
        else:
            assert [saved.rail for saved in rotated.list_saved("1001")] == ["devin"]
    assert rows(db) == [("1001", "cursor"), ("1001", "devin"), ("1001", "jules")]
    assert JULES_KEY not in caplog.text and CURSOR_KEY not in caplog.text
    assert make(db).load("1001", "jules") == RailCredential(key=JULES_KEY)  # key restored


def test_a_key_that_no_longer_opens_goes_only_when_replaced_or_removed(db: StateDB) -> None:
    make(db, OTHER_VAULT_MASTER).save("1001", "jules", RailCredential(key=JULES_KEY))
    make(db, OTHER_VAULT_MASTER).save("1001", "cursor", RailCredential(key=CURSOR_KEY))
    old = db.query_one("SELECT ciphertext FROM vault_credentials WHERE rail = 'jules'")
    assert old is not None
    vault = make(db)
    assert vault.list_saved("1001") == []  # neither opens under this master key
    replacement = RailCredential(key="test-only-jules-saved-again")
    vault.save("1001", "jules", replacement)  # saving a new key for the rail replaces it
    assert vault.load("1001", "jules") == replacement
    assert bytes(old["ciphertext"]) not in files_of(db)
    assert Vault(db, None).delete("1001", "cursor") is True  # Remove needs no master key
    assert rows(db) == [("1001", "jules")]
    assert [saved.rail for saved in vault.list_saved("1001")] == ["jules"]


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


def test_an_off_vault_saves_and_opens_nothing_but_still_lists_and_removes(
    db: StateDB, monkeypatch: pytest.MonkeyPatch
) -> None:
    """web M1: with FORGE_VAULT_KEY unset, /me said there were no saved keys while their
    sealed rows stayed stored, and nothing could remove them. Listing (hints only) and
    deleting need no master key; opening and saving do."""
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    vault.save("1001", "claude-routine", RailCredential(key=ROUTINE_TOKEN, routine_url=ROUTINE_URL))
    vault.mark_used("1001", "jules")
    monkeypatch.delenv("FORGE_VAULT_KEY", raising=False)
    off = Vault.from_env(db)
    assert off.enabled is False
    assert off.save("1001", "cursor", RailCredential(key=JULES_KEY)) is None
    assert off.load("1001", "jules") is None
    assert off.saved_rails("1001") == set()  # FORGE can't use them now
    listed = off.list_saved("1001")
    assert [(saved.rail, saved.hint, saved.lastUsedAt) for saved in listed] == [
        ("jules", "…tial", "2026-08-10T09:00:00Z"),
        ("claude-routine", "…tial", None),
    ]
    assert rows(db) == [("1001", "claude-routine"), ("1001", "jules")]  # nothing deleted
    assert off.delete("1001", "jules") is True  # removing still works
    assert [saved.rail for saved in Vault(db, None).list_saved("1001")] == ["claude-routine"]
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
    assert vault.list_saved("1001") == [] and rows(db) == [("1001", "devin")]  # unsaved, kept
    with pytest.raises(RuntimeError):
        make(db, None)._aead("1001")


def files_of(db: StateDB) -> bytes:
    """The database file and its write-ahead log, as a backup or a disk snapshot has them."""
    return b"".join(
        path.read_bytes() for path in (db.path, Path(f"{db.path}-wal")) if path.exists()
    )


def test_a_removed_or_replaced_key_leaves_no_sealed_copy_on_disk(db: StateDB) -> None:
    """CR-8: right after removal the sealed row was still in the -wal file, where anyone
    with a copy of the files and FORGE_VAULT_KEY could open it."""
    vault = make(db)
    vault.save("1001", "jules", RailCredential(key=JULES_KEY))
    first = db.query_one("SELECT ciphertext FROM vault_credentials")
    assert first is not None and bytes(first["ciphertext"]) in files_of(db)
    vault.save("1001", "jules", RailCredential(key="test-only-jules-replacement"))
    second = db.query_one("SELECT ciphertext FROM vault_credentials")
    assert second is not None
    assert bytes(first["ciphertext"]) not in files_of(db)  # replaced: the old copy is gone
    assert vault.delete("1001", "jules") is True
    assert bytes(second["ciphertext"]) not in files_of(db)  # removed: gone too
    assert db.query_one("PRAGMA secure_delete") == {"secure_delete": 1}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> BridgeEnv:
    return install_bridge(monkeypatch, clock)


def start_jules(client: TestClient, headers: dict[str, str], **extra: object) -> dict[str, object]:
    response = client.post(
        "/api/bridge/dispatch", json={"taskId": 1, "rail": "jules", **extra}, headers=headers
    )
    body: dict[str, object] = response.json()
    body["status"] = response.status_code
    return body


def test_through_the_bridge_a_rotated_master_key_reads_as_no_key_saved(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    """The review's probe P4 (CR-5), inverted: the key reads as not saved on /rails, on
    /me/keys and to a one-click start, survives every one of those reads, and goes only
    when the person saves a new key for the rail or removes it."""
    env.vault_on()
    env.start_rails("jules")
    assert client.post("/api/bridge/claim", json={"taskId": 1}, headers=user_headers).is_success
    saved = start_jules(client, user_headers, credential={"key": JULES_KEY}, saveCredential=True)
    assert saved["credentialSaved"] is True
    env.vault_on(OTHER_VAULT_MASTER)  # FORGE_VAULT_KEY changes, on purpose or by mistake
    rails = client.get("/api/bridge/rails", headers=user_headers).json()["rails"]
    assert next(rail for rail in rails if rail["id"] == "jules")["savedCredential"] is False
    keys = client.get("/api/bridge/me/keys", headers=user_headers).json()
    assert keys == {"credentials": [], "vault": True}
    assert client.get("/api/bridge/status/1", headers=user_headers).is_success
    env.clock.advance(600)  # a later one-click start, not a repeat of the first
    again = start_jules(client, user_headers)
    assert (again["status"], again["error"]) == (400, "credential_required")
    assert rows(get_state_db()) == [("1001", "jules")]  # no read deleted it
    env.clock.advance(600)
    replaced = start_jules(
        client, user_headers, credential={"key": "test-only-jules-new-key"}, saveCredential=True
    )
    assert replaced["credentialSaved"] is True
    listed = client.get("/api/bridge/me/keys", headers=user_headers).json()["credentials"]
    assert [(key["rail"], key["hint"]) for key in listed] == [("jules", "…-key")]
    removed = client.delete("/api/bridge/me/keys/jules", headers=user_headers)
    assert removed.json() == {"credentials": [], "vault": True}
    assert rows(get_state_db()) == []


def test_through_the_bridge_keys_are_listed_and_removed_with_the_vault_off(
    client: TestClient, env: BridgeEnv, user_headers: dict[str, str]
) -> None:
    """web M1 and the review's probe P9 (CR-8), inverted: with FORGE_VAULT_KEY unset,
    /me/keys lists the saved key, and removing it leaves no sealed copy on disk."""
    env.vault_on()
    env.start_rails("jules")
    assert client.post("/api/bridge/claim", json={"taskId": 1}, headers=user_headers).is_success
    start_jules(client, user_headers, credential={"key": JULES_KEY}, saveCredential=True)
    sealed = get_state_db().query_one("SELECT ciphertext FROM vault_credentials")
    assert sealed is not None
    env.monkeypatch.delenv("FORGE_VAULT_KEY")
    listed = client.get("/api/bridge/me/keys", headers=user_headers).json()
    assert [(key["rail"], key["hint"]) for key in listed["credentials"]] == [("jules", "…tial")]
    assert listed["vault"] is False
    removed = client.delete("/api/bridge/me/keys/jules", headers=user_headers)
    assert removed.json() == {"credentials": [], "vault": False}
    assert bytes(sealed["ciphertext"]) not in files_of(get_state_db())
