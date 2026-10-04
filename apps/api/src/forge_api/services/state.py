"""FORGE's own state: one SQLite file for everything the API must remember (contract §7).

Leases and task events (`bridge_*` tables), saved keys (`vault_*`) and OAuth clients,
grants and tokens (`oauth_*`) all live in the file at `FORGE_STATE_DB_PATH`, default
`<repo>/var/forge-state.db` (created on demand; `var/` is gitignored). Production must
point it at storage that survives a restart.

Each module owns its tables and registers them at import time:

    register_schema("bridge", [
        "CREATE TABLE IF NOT EXISTS bridge_leases (task_id INTEGER PRIMARY KEY, ...)",
    ])

`get_state_db()` (a FastAPI dependency) opens the file once per process and applies every
registered schema once. Statements run on every start, so each must be a
`CREATE ... IF NOT EXISTS`; `register_schema` refuses anything else.

One connection, shared by every thread behind one re-entrant lock: each call holds the
lock for its statement, and `transaction()` holds it from BEGIN to COMMIT, so another
thread's statements never land inside someone else's transaction.
"""

import os
import re
import sqlite3
import threading
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PATH_ENV = "FORGE_STATE_DB_PATH"
DEFAULT_RELATIVE_PATH = Path("var") / "forge-state.db"
#: How long a statement waits for another process's write lock before failing.
BUSY_TIMEOUT_SECONDS = 5.0

#: Positional (`?`) or named (`:name`) parameters, as sqlite3 takes them.
Params = Sequence[Any] | Mapping[str, Any]

_SCHEMA_NAME = re.compile(r"[a-z][a-z0-9_]{0,62}")
_IDEMPOTENT_CREATE = re.compile(
    r"CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+IF\s+NOT\s+EXISTS\s",
    re.IGNORECASE,
)

_registry_lock = threading.Lock()
_schemas: dict[str, tuple[str, ...]] = {}


def register_schema(name: str, statements: Sequence[str]) -> None:
    """Register `statements` as the tables of module `name` (e.g. "bridge", "oauth").

    Registering the same name with the same statements again is a no-op (a re-import);
    the same name with different statements raises ValueError, as does a statement that
    is not `CREATE [UNIQUE] TABLE|INDEX|TRIGGER|VIEW IF NOT EXISTS ...`. If the database
    is already open, the next `get_state_db()` applies the new schema.
    """
    if not _SCHEMA_NAME.fullmatch(name):
        raise ValueError(f"schema name must be lowercase letters, digits and _: {name!r}")
    if isinstance(statements, str):
        raise TypeError("statements must be a sequence of SQL strings, not one string")
    normalized = tuple(statement.strip() for statement in statements)
    if not normalized:
        raise ValueError(f"schema {name!r} has no statements")
    for statement in normalized:
        if not _IDEMPOTENT_CREATE.match(statement):
            raise ValueError(
                f"schema {name!r}: statements run on every start, so each must be "
                f"CREATE ... IF NOT EXISTS: {statement[:60]!r}"
            )
    with _registry_lock:
        existing = _schemas.get(name)
        if existing is not None and existing != normalized:
            raise ValueError(f"schema {name!r} is already registered with other statements")
        _schemas[name] = normalized


def registered_schemas() -> dict[str, tuple[str, ...]]:
    """A snapshot of every registered schema, in registration order."""
    with _registry_lock:
        return dict(_schemas)


@dataclass(frozen=True)
class WriteResult:
    """What a write statement did: rows changed, and the rowid an INSERT created."""

    rowcount: int
    lastrowid: int | None


def _dict_row(cursor: sqlite3.Cursor, row: tuple[Any, ...]) -> dict[str, Any]:
    return {column[0]: value for column, value in zip(cursor.description, row, strict=True)}


class StateDB:
    """A thread-safe wrapper around one SQLite connection (WAL, foreign keys and secure
    delete on)."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.path.exists():
            # Owner-only from the first byte: the file holds token hashes and sealed keys,
            # and SQLite gives its -wal/-shm files the same mode as the database file.
            os.close(os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600))
        self._lock = threading.RLock()
        # isolation_level=None: sqlite3 never opens a transaction on its own; a statement
        # outside `transaction()` commits by itself, and `transaction()` says BEGIN.
        self._conn = sqlite3.connect(
            self.path,
            timeout=BUSY_TIMEOUT_SECONDS,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = _dict_row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        # Deleted content is overwritten with zeros, not only unlinked: some SQLite builds
        # do that by default, others don't, and a removed key must not linger in the file.
        self._conn.execute("PRAGMA secure_delete=ON")
        self._depth = 0  # transaction nesting; only touched while holding the lock
        self._checkpoint_due = False  # checkpoint() was asked for inside a transaction
        self._applied: set[str] = set()
        self._closed = False

    def execute(self, sql: str, params: Params = ()) -> WriteResult:
        """Run one statement (a write, usually). Outside `transaction()` it commits at once."""
        with self._lock:
            self._check_open()
            cursor = self._conn.execute(sql, params)
            try:
                return WriteResult(rowcount=cursor.rowcount, lastrowid=cursor.lastrowid)
            finally:
                cursor.close()

    def executemany(self, sql: str, rows: Iterable[Params]) -> WriteResult:
        """Run one statement once per parameter set in `rows`, in one call (a fan-out).
        Outside `transaction()` each run commits at once; inside one, all or nothing."""
        with self._lock:
            self._check_open()
            cursor = self._conn.executemany(sql, rows)
            try:
                return WriteResult(rowcount=cursor.rowcount, lastrowid=None)
            finally:
                cursor.close()

    def query_one(self, sql: str, params: Params = ()) -> dict[str, Any] | None:
        """The first row as {column: value}, or None when there is none."""
        with self._lock:
            self._check_open()
            cursor = self._conn.execute(sql, params)
            try:
                row: dict[str, Any] | None = cursor.fetchone()
                return row
            finally:
                cursor.close()

    def query_all(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        """Every row as {column: value}."""
        with self._lock:
            self._check_open()
            cursor = self._conn.execute(sql, params)
            try:
                rows: list[dict[str, Any]] = cursor.fetchall()
                return rows
            finally:
                cursor.close()

    @contextmanager
    def transaction(self) -> Iterator["StateDB"]:
        """All or nothing: commits when the block ends, rolls back (and re-raises) when it
        raises. Holds the lock throughout. Nests: an inner block is a savepoint, so its
        failure undoes only its own work if the outer block catches the exception."""
        with self._lock:
            self._check_open()
            depth = self._depth
            if depth == 0:
                # IMMEDIATE takes the write lock now, not at the first write, so two
                # processes can't both read and then deadlock upgrading to write.
                self._conn.execute("BEGIN IMMEDIATE")
            else:
                self._conn.execute(f"SAVEPOINT forge_sp_{depth}")
            self._depth = depth + 1
            try:
                yield self
            except BaseException:
                self._depth = depth
                self._rollback(depth)
                if depth == 0:
                    self._checkpoint_due = False  # nothing it was asked for was kept
                raise
            self._depth = depth
            if depth > 0:
                self._conn.execute(f"RELEASE forge_sp_{depth}")
                return
            try:
                self._conn.execute("COMMIT")
            except BaseException:
                self._rollback(0)
                self._checkpoint_due = False
                raise
            if self._checkpoint_due:
                self._truncate_wal()

    def checkpoint(self) -> None:
        """Copy the write-ahead log into the database file and empty it, so content just
        deleted or overwritten (a removed key) lingers in neither file. SQLite refuses
        this inside a transaction, so there it runs once the outermost one commits."""
        with self._lock:
            self._check_open()
            if self._depth > 0:
                self._checkpoint_due = True
                return
            self._truncate_wal()

    def _truncate_wal(self) -> None:
        self._checkpoint_due = False
        self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").close()

    def apply_schemas(self, schemas: Mapping[str, Sequence[str]] | None = None) -> None:
        """Apply each schema not yet applied on this connection, one transaction per
        schema. Defaults to every registered schema."""
        pending = registered_schemas() if schemas is None else dict(schemas)
        with self._lock:
            for name, statements in pending.items():
                if name in self._applied:
                    continue
                with self.transaction():
                    for statement in statements:
                        self._conn.execute(statement)
                self._applied.add(name)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                self._conn.close()

    def _rollback(self, depth: int) -> None:
        # SQLite may already have rolled the whole transaction back on its own (a full
        # disk, for one); then there is nothing left to undo.
        if not self._conn.in_transaction:
            return
        if depth == 0:
            self._conn.execute("ROLLBACK")
        else:
            self._conn.execute(f"ROLLBACK TO forge_sp_{depth}")
            self._conn.execute(f"RELEASE forge_sp_{depth}")

    def _check_open(self) -> None:
        if self._closed:
            raise sqlite3.ProgrammingError("the state database is closed")


def _find_repo_root(start: Path | None = None) -> Path | None:
    """The nearest directory above this file holding pnpm-workspace.yaml (the repo root)."""
    here = (start or Path(__file__)).resolve()
    for parent in here.parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return parent
    return None


def default_state_db_path() -> Path:
    """`<repo>/var/forge-state.db`; `./var/forge-state.db` outside a checkout."""
    root = _find_repo_root()
    return (root if root is not None else Path.cwd()) / DEFAULT_RELATIVE_PATH


def state_db_path() -> Path:
    """FORGE_STATE_DB_PATH when set (resolved on every call), else the default."""
    raw = os.environ.get(PATH_ENV, "").strip()
    return (Path(raw).expanduser() if raw else default_state_db_path()).resolve()


_db_lock = threading.Lock()
_db: StateDB | None = None


def get_state_db() -> StateDB:
    """FastAPI dependency: the process's StateDB, opened on first use (and reopened if
    FORGE_STATE_DB_PATH now names another file), with every registered schema applied."""
    global _db
    path = state_db_path()
    with _db_lock:
        if _db is None or _db.path != path:
            if _db is not None:
                _db.close()
            _db = StateDB(path)
        db = _db
    db.apply_schemas()
    return db


def reset_state_db() -> None:
    """Close and forget the cached StateDB. Tests call this between tests; the schema
    registry is kept, so the next `get_state_db()` starts from an empty, ready file."""
    global _db
    with _db_lock:
        if _db is not None:
            _db.close()
        _db = None
