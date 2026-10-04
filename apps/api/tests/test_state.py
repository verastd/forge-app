"""The state database (contract §7): schema registration, transactions, threads, and
where the file lives. The autouse `state_db_path` fixture in conftest.py gives every test
its own empty file; tests that register schemas use a private registry."""

import sqlite3
import stat
import threading
from pathlib import Path

import pytest

from forge_api.services import state

NOTES = ("CREATE TABLE IF NOT EXISTS test_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",)


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> dict[str, tuple[str, ...]]:
    """A private, empty schema registry: the real one keeps what the app registered."""
    private: dict[str, tuple[str, ...]] = {}
    monkeypatch.setattr(state, "_schemas", private)
    return private


@pytest.fixture
def db(registry: dict[str, tuple[str, ...]]) -> state.StateDB:
    state.register_schema("test_notes", NOTES)
    return state.get_state_db()


def _tables(db: state.StateDB) -> set[str]:
    rows = db.query_all("SELECT name FROM sqlite_master WHERE type = 'table'")
    return {row["name"] for row in rows}


# --- schema registration -----------------------------------------------------------


def test_registering_the_same_schema_twice_is_a_no_op(
    registry: dict[str, tuple[str, ...]],
) -> None:
    state.register_schema("test_notes", NOTES)
    state.register_schema("test_notes", list(NOTES))  # a re-import: same statements
    assert state.registered_schemas() == {"test_notes": NOTES}
    db = state.get_state_db()
    assert state.get_state_db() is db
    assert "test_notes" in _tables(db)


def test_applying_a_schema_again_to_an_existing_file_is_harmless(db: state.StateDB) -> None:
    db.execute("INSERT INTO test_notes (body) VALUES ('kept')")
    state.reset_state_db()  # a process restart: the file stays, the schema runs again
    again = state.get_state_db()
    assert again is not db
    assert again.query_all("SELECT body FROM test_notes") == [{"body": "kept"}]


def test_the_same_name_with_other_statements_raises(registry: dict[str, tuple[str, ...]]) -> None:
    state.register_schema("test_notes", NOTES)
    with pytest.raises(ValueError, match="already registered"):
        state.register_schema(
            "test_notes", ["CREATE TABLE IF NOT EXISTS test_notes (id INTEGER PRIMARY KEY)"]
        )
    assert state.registered_schemas() == {"test_notes": NOTES}


@pytest.mark.parametrize(
    "statement",
    [
        "CREATE TABLE test_notes (id INTEGER)",  # fails on the second start
        "DROP TABLE IF EXISTS test_notes",
        "INSERT INTO test_notes (body) VALUES ('x')",
        "-- a comment first\nCREATE TABLE IF NOT EXISTS test_notes (id INTEGER)",
    ],
)
def test_only_create_if_not_exists_statements_are_accepted(
    registry: dict[str, tuple[str, ...]], statement: str
) -> None:
    with pytest.raises(ValueError, match="IF NOT EXISTS"):
        state.register_schema("test_notes", [statement])
    assert registry == {}


def test_index_trigger_and_view_statements_are_accepted(
    registry: dict[str, tuple[str, ...]],
) -> None:
    state.register_schema(
        "test_notes",
        [
            *NOTES,
            "  create unique index if not exists test_notes_body ON test_notes (body)  ",
            "CREATE VIEW IF NOT EXISTS test_bodies AS SELECT body FROM test_notes",
            "CREATE TRIGGER IF NOT EXISTS test_notes_trim AFTER INSERT ON test_notes "
            "BEGIN UPDATE test_notes SET body = trim(body) WHERE id = new.id; END",
        ],
    )
    db = state.get_state_db()
    db.execute("INSERT INTO test_notes (body) VALUES ('  padded  ')")
    assert db.query_all("SELECT body FROM test_bodies") == [{"body": "padded"}]
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO test_notes (body) VALUES ('padded')")


@pytest.mark.parametrize("name", ["", "Bridge", "1bridge", "bridge-v2", "x" * 64])
def test_a_bad_schema_name_is_refused(registry: dict[str, tuple[str, ...]], name: str) -> None:
    with pytest.raises(ValueError, match="schema name"):
        state.register_schema(name, NOTES)


def test_an_empty_schema_or_a_bare_string_is_refused(
    registry: dict[str, tuple[str, ...]],
) -> None:
    with pytest.raises(ValueError, match="no statements"):
        state.register_schema("test_notes", [])
    with pytest.raises(TypeError, match="sequence"):
        state.register_schema("test_notes", NOTES[0])


def test_a_schema_registered_after_the_database_opened_is_applied_next_time(
    db: state.StateDB,
) -> None:
    assert "test_later" not in _tables(db)
    state.register_schema("test_later", ["CREATE TABLE IF NOT EXISTS test_later (id INTEGER)"])
    assert state.get_state_db() is db
    assert "test_later" in _tables(db)


def test_a_schema_that_fails_to_apply_leaves_nothing_behind(
    registry: dict[str, tuple[str, ...]],
) -> None:
    state.register_schema(
        "test_broken",
        [
            "CREATE TABLE IF NOT EXISTS test_half (id INTEGER)",
            "CREATE TABLE IF NOT EXISTS test_broken (",  # a syntax error
        ],
    )
    with pytest.raises(sqlite3.OperationalError):
        state.get_state_db()
    db = state.StateDB(state.state_db_path())
    try:
        assert "test_half" not in _tables(db)
    finally:
        db.close()


def test_the_app_starts_with_an_empty_database_per_test(state_db_path: Path) -> None:
    # The autouse fixture: a fresh path in this test's tmp dir, nothing opened yet.
    assert state.state_db_path() == state_db_path.resolve()
    assert not state_db_path.exists()
    db = state.get_state_db()
    assert state_db_path.exists()
    assert db.query_all("SELECT * FROM sqlite_master WHERE name LIKE 'test_%'") == []


# --- reads and writes ----------------------------------------------------------------


def test_execute_reports_the_rowcount_and_the_new_rowid(db: state.StateDB) -> None:
    first = db.execute("INSERT INTO test_notes (body) VALUES (?)", ("one",))
    second = db.execute("INSERT INTO test_notes (body) VALUES (:body)", {"body": "two"})
    assert (first.rowcount, first.lastrowid) == (1, 1)
    assert (second.rowcount, second.lastrowid) == (1, 2)
    updated = db.execute("UPDATE test_notes SET body = upper(body)")
    assert updated.rowcount == 2


def test_queries_return_plain_dicts(db: state.StateDB) -> None:
    assert db.query_one("SELECT * FROM test_notes") is None
    assert db.query_all("SELECT * FROM test_notes") == []
    db.execute("INSERT INTO test_notes (body) VALUES ('one'), ('two')")
    assert db.query_one("SELECT id, body FROM test_notes ORDER BY id") == {"id": 1, "body": "one"}
    assert db.query_all("SELECT body FROM test_notes WHERE id > ?", (0,)) == [
        {"body": "one"},
        {"body": "two"},
    ]


def test_the_connection_uses_wal_and_enforces_foreign_keys(
    registry: dict[str, tuple[str, ...]],
) -> None:
    state.register_schema(
        "test_fk",
        [
            "CREATE TABLE IF NOT EXISTS test_parent (id INTEGER PRIMARY KEY)",
            "CREATE TABLE IF NOT EXISTS test_child "
            "(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES test_parent (id))",
        ],
    )
    db = state.get_state_db()
    assert db.query_one("PRAGMA journal_mode") == {"journal_mode": "wal"}
    assert db.query_one("PRAGMA foreign_keys") == {"foreign_keys": 1}
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute("INSERT INTO test_child (parent_id) VALUES (42)")


def test_secure_delete_is_on_even_where_sqlite_leaves_it_off(
    registry: dict[str, tuple[str, ...]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """CR-8: whether deleted rows are overwritten depends on how SQLite was built (this
    one does it by default, many don't), so FORGE switches it on itself."""
    connect = sqlite3.connect

    def a_build_that_keeps_deleted_content(*args: object, **kwargs: object) -> sqlite3.Connection:
        connection = connect(*args, **kwargs)  # type: ignore[arg-type]
        connection.execute("PRAGMA secure_delete=OFF")
        return connection

    monkeypatch.setattr(state.sqlite3, "connect", a_build_that_keeps_deleted_content)
    db = state.get_state_db()
    assert db.query_one("PRAGMA secure_delete") == {"secure_delete": 1}


def _wal_size(db: state.StateDB) -> int:
    wal = Path(f"{db.path}-wal")
    return wal.stat().st_size if wal.exists() else 0


def test_a_checkpoint_empties_the_write_ahead_log(db: state.StateDB) -> None:
    """CR-8: what was deleted or overwritten stays in the -wal file until a checkpoint
    copies it out and the log is emptied."""
    db.execute("INSERT INTO test_notes (body) VALUES ('test-only-sealed-row')")
    db.execute("DELETE FROM test_notes")
    assert b"test-only-sealed-row" in Path(f"{db.path}-wal").read_bytes()
    db.checkpoint()
    assert _wal_size(db) == 0
    assert b"test-only-sealed-row" not in Path(db.path).read_bytes()


def test_a_checkpoint_asked_for_in_a_transaction_runs_when_it_commits(
    db: state.StateDB,
) -> None:
    # SQLite refuses a checkpoint inside a transaction ("database table is locked").
    with db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('kept')")
        with db.transaction():
            db.checkpoint()
        assert _wal_size(db) > 0  # not yet
    assert _wal_size(db) == 0
    with pytest.raises(RuntimeError), db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('undone')")
        db.checkpoint()
        raise RuntimeError("the block failed")
    assert db._checkpoint_due is False  # nothing it was asked for was kept
    assert db.query_all("SELECT body FROM test_notes") == [{"body": "kept"}]


# --- transactions --------------------------------------------------------------------


def test_a_transaction_commits_when_the_block_ends(db: state.StateDB) -> None:
    with db.transaction() as tx:
        assert tx is db
        tx.execute("INSERT INTO test_notes (body) VALUES ('one')")
        tx.execute("INSERT INTO test_notes (body) VALUES ('two')")
    assert len(db.query_all("SELECT * FROM test_notes")) == 2


def test_a_transaction_rolls_back_when_the_block_raises(db: state.StateDB) -> None:
    with pytest.raises(RuntimeError, match="boom"), db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('lost')")
        raise RuntimeError("boom")
    assert db.query_all("SELECT * FROM test_notes") == []
    db.execute("INSERT INTO test_notes (body) VALUES ('after')")  # no transaction left open
    assert db.query_all("SELECT body FROM test_notes") == [{"body": "after"}]


def test_an_inner_failure_undoes_only_the_inner_block(db: state.StateDB) -> None:
    with db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('outer one')")
        with pytest.raises(ValueError), db.transaction():
            db.execute("INSERT INTO test_notes (body) VALUES ('inner')")
            raise ValueError("inner")
        with db.transaction():
            db.execute("INSERT INTO test_notes (body) VALUES ('inner kept')")
        db.execute("INSERT INTO test_notes (body) VALUES ('outer two')")
    bodies = [row["body"] for row in db.query_all("SELECT body FROM test_notes ORDER BY id")]
    assert bodies == ["outer one", "inner kept", "outer two"]


def test_an_outer_failure_undoes_the_inner_blocks_too(db: state.StateDB) -> None:
    with pytest.raises(KeyError), db.transaction():
        with db.transaction():
            db.execute("INSERT INTO test_notes (body) VALUES ('inner')")
        raise KeyError("outer")
    assert db.query_all("SELECT * FROM test_notes") == []


def test_a_failed_commit_is_rolled_back(registry: dict[str, tuple[str, ...]]) -> None:
    # A deferred foreign key is only checked at COMMIT, so the COMMIT itself fails.
    state.register_schema(
        "test_deferred",
        [
            "CREATE TABLE IF NOT EXISTS test_parent (id INTEGER PRIMARY KEY)",
            "CREATE TABLE IF NOT EXISTS test_child (id INTEGER PRIMARY KEY, parent_id INTEGER "
            "REFERENCES test_parent (id) DEFERRABLE INITIALLY DEFERRED)",
        ],
    )
    db = state.get_state_db()
    with pytest.raises(sqlite3.IntegrityError), db.transaction():
        db.execute("INSERT INTO test_child (parent_id) VALUES (7)")
    assert db.query_all("SELECT * FROM test_child") == []
    with db.transaction():  # nothing was left open
        db.execute("INSERT INTO test_parent (id) VALUES (7)")
        db.execute("INSERT INTO test_child (parent_id) VALUES (7)")
    assert db.query_one("SELECT parent_id FROM test_child") == {"parent_id": 7}


def test_a_transaction_sqlite_already_rolled_back_is_not_rolled_back_twice(
    db: state.StateDB,
) -> None:
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS test_notes_body ON test_notes (body)")
    with pytest.raises(sqlite3.IntegrityError), db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('first')")
        with db.transaction():
            # OR ROLLBACK makes SQLite end the whole transaction on its own.
            db.execute("INSERT OR ROLLBACK INTO test_notes (body) VALUES ('first')")
    assert db.query_all("SELECT * FROM test_notes") == []


# --- threads -------------------------------------------------------------------------


def test_concurrent_writes_from_threads_do_not_corrupt(
    registry: dict[str, tuple[str, ...]],
) -> None:
    state.register_schema(
        "test_counter",
        [
            "CREATE TABLE IF NOT EXISTS test_counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS test_log (id INTEGER PRIMARY KEY, worker INTEGER)",
        ],
    )
    db = state.get_state_db()
    db.execute("INSERT INTO test_counter (id, n) VALUES (1, 0)")
    workers, rounds = 8, 40
    errors: list[BaseException] = []
    start = threading.Barrier(workers)

    def work(worker: int) -> None:
        try:
            start.wait()
            for _ in range(rounds):
                with db.transaction():  # a read-modify-write that must not interleave
                    row = db.query_one("SELECT n FROM test_counter WHERE id = 1")
                    assert row is not None
                    db.execute("UPDATE test_counter SET n = ? WHERE id = 1", (row["n"] + 1,))
                    db.execute("INSERT INTO test_log (worker) VALUES (?)", (worker,))
                db.execute("INSERT INTO test_log (worker) VALUES (?)", (-worker,))
        except BaseException as exc:  # surfaced below; a thread can't fail the test itself
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(worker,)) for worker in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert errors == []
    assert db.query_one("SELECT n FROM test_counter WHERE id = 1") == {"n": workers * rounds}
    assert db.query_one("SELECT count(*) AS c FROM test_log") == {"c": 2 * workers * rounds}
    assert db.query_one("PRAGMA integrity_check") == {"integrity_check": "ok"}


def test_another_thread_waits_for_an_open_transaction(db: state.StateDB) -> None:
    inside = threading.Event()
    seen: list[str] = []

    def reader() -> None:
        inside.wait(timeout=10)
        seen.extend(row["body"] for row in db.query_all("SELECT body FROM test_notes"))

    thread = threading.Thread(target=reader)
    thread.start()
    with db.transaction():
        db.execute("INSERT INTO test_notes (body) VALUES ('first')")
        inside.set()
        thread.join(timeout=0.2)  # the reader is blocked on the lock, not reading half
        assert thread.is_alive()
        db.execute("INSERT INTO test_notes (body) VALUES ('second')")
    thread.join(timeout=10)
    assert seen == ["first", "second"]


# --- where the file lives ------------------------------------------------------------


def test_the_default_path_is_var_under_the_repo_and_created_on_demand(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, registry: dict[str, tuple[str, ...]]
) -> None:
    monkeypatch.delenv(state.PATH_ENV)
    monkeypatch.setattr(state, "_find_repo_root", lambda start=None: tmp_path)
    expected = tmp_path / "var" / "forge-state.db"
    assert state.state_db_path() == expected.resolve()
    assert not (tmp_path / "var").exists()
    db = state.get_state_db()
    assert db.path == expected.resolve()
    assert expected.is_file()


def test_the_repo_root_is_found_by_walking_up() -> None:
    root = state._find_repo_root()
    assert root is not None and (root / "pnpm-workspace.yaml").is_file()
    assert (root / "apps" / "api" / "src" / "forge_api" / "services" / "state.py").is_file()
    assert state.default_state_db_path() == root / "var" / "forge-state.db"
    assert state._find_repo_root(Path("/")) is None


def test_outside_a_checkout_the_default_is_var_under_the_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(state, "_find_repo_root", lambda start=None: None)
    monkeypatch.chdir(tmp_path)
    assert state.default_state_db_path() == tmp_path / "var" / "forge-state.db"


def test_the_env_path_is_used_and_missing_folders_are_created(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, registry: dict[str, tuple[str, ...]]
) -> None:
    target = tmp_path / "deep" / "er" / "state.db"
    monkeypatch.setenv(state.PATH_ENV, str(target))
    assert state.get_state_db().path == target.resolve()
    assert target.is_file()
    mode = stat.S_IMODE(target.stat().st_mode)
    assert mode & 0o077 == 0, oct(mode)  # owner-only: token hashes and sealed keys live here


def test_a_new_path_reopens_and_the_old_handle_is_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, db: state.StateDB
) -> None:
    monkeypatch.setenv(state.PATH_ENV, str(tmp_path / "other.db"))
    other = state.get_state_db()
    assert other is not db and other.path == (tmp_path / "other.db").resolve()
    assert "test_notes" in _tables(other)  # every registered schema, on the new file too
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        db.execute("SELECT 1")


def test_reset_closes_and_forgets_and_close_is_idempotent(db: state.StateDB) -> None:
    state.reset_state_db()
    with pytest.raises(sqlite3.ProgrammingError):
        db.query_one("SELECT 1")
    db.close()  # already closed: a no-op
    assert state.get_state_db() is not db
