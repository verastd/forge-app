"""Saved agent keys (contract §7): what lets "Start it for me" be one click next time.

`FORGE_VAULT_KEY` is the base64 of 32 random bytes (`openssl rand -base64 32`). When it
is unset or malformed the vault is off: nothing is saved and nothing saved is opened, and
dispatch still works with a key pasted for that one start. Saved keys are still listed
(hints only) and can still be removed, so their owners can always see and delete them.
A key that no longer opens (FORGE_VAULT_KEY changed) counts as not saved everywhere, but
no read ever deletes it: a FORGE_VAULT_KEY set wrong by mistake must not destroy anyone's
keys. It stays stored until its owner saves a new key for that rail, which replaces it,
or removes it. Deleting or replacing a key also clears the database's write-ahead log, so
the old sealed copy doesn't linger there.

Each credential ({key, orgId?, routineUrl?}) is sealed with AES-256-GCM under a per-user
key, HKDF-SHA256(master, info="forge-vault:v1:<sub>"), with a fresh random 96-bit nonce
per write and "<sub>:<rail>" as associated data, so a row copied to another user or rail
no longer opens. Rows live in the state database (`vault_credentials`); clients only ever
see a hint (the key's last 4 characters) and the times. Copilot's one-time GitHub token
is never saved.
"""

import base64
import binascii
import functools
import json
import logging
import os
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from forge_api.models import START_RAILS, SavedCredential, StartRail
from forge_api.services.rail_adapters.base import RailCredential
from forge_api.services.state import StateDB, register_schema

KEY_ENV = "FORGE_VAULT_KEY"
KEY_BYTES = 32
NONCE_BYTES = 12
INFO_PREFIX = "forge-vault:v1:"
#: Rails whose credential may be saved. Copilot's token is one-time and never stored.
SAVABLE_RAILS: frozenset[StartRail] = frozenset(
    {"jules", "cursor", "devin", "openhands", "claude-routine"}
)
#: Keys shorter than this get no hint at all: four characters would be too much of them.
MIN_HINT_SOURCE = 12

logger = logging.getLogger(__name__)

register_schema(
    "vault",
    [
        """CREATE TABLE IF NOT EXISTS vault_credentials (
            sub TEXT NOT NULL,
            rail TEXT NOT NULL,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            hint TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            last_used_at TEXT,
            PRIMARY KEY (sub, rail)
        )""",
    ],
)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def master_key(env: Mapping[str, str] | None = None) -> bytes | None:
    """The 32-byte master key from FORGE_VAULT_KEY, or None when unset or malformed."""
    raw = (env if env is not None else os.environ).get(KEY_ENV, "").strip()
    return _decode_master(raw) if raw else None


@functools.lru_cache(maxsize=4)
def _decode_master(raw: str) -> bytes | None:
    # Cached per value, so a bad setting logs its warning once. Never logs the value.
    try:
        key = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        logger.warning("%s is not valid base64; saved keys are switched off", KEY_ENV)
        return None
    if len(key) != KEY_BYTES:
        logger.warning(
            "%s must decode to %d bytes; saved keys are switched off", KEY_ENV, KEY_BYTES
        )
        return None
    return key


def hint_for(key: str) -> str:
    """What a client may see of a saved key: "…" and its last 4 characters."""
    return "…" + key[-4:] if len(key) >= MIN_HINT_SOURCE else "…"


class Vault:
    """The saved credentials of every user, sealed per user. `enabled` is False when the
    master key is missing: then nothing is saved or opened, but `list_saved` still shows
    the hints and `delete` still removes a row. A row that doesn't open under the current
    master key counts as not saved; only `save` (replacing it) and `delete` remove it."""

    def __init__(
        self,
        db: StateDB,
        key: bytes | None,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._db = db
        self._master = key
        self._now = now_fn or (lambda: datetime.now(UTC))

    @classmethod
    def from_env(cls, db: StateDB, now_fn: Callable[[], datetime] | None = None) -> "Vault":
        return cls(db, master_key(), now_fn)

    @property
    def enabled(self) -> bool:
        return self._master is not None

    def _aead(self, sub: str) -> AESGCM:
        if self._master is None:
            raise RuntimeError("the vault is off")
        derived = HKDF(
            algorithm=hashes.SHA256(),
            length=KEY_BYTES,
            salt=None,
            info=f"{INFO_PREFIX}{sub}".encode(),
        ).derive(self._master)
        return AESGCM(derived)

    @staticmethod
    def _aad(sub: str, rail: str) -> bytes:
        return f"{sub}:{rail}".encode()

    def save(self, sub: str, rail: StartRail, credential: RailCredential) -> SavedCredential | None:
        """Seal and store `credential` for (sub, rail), replacing any earlier one.
        Returns None, saving nothing, when the vault is off or the rail never saves."""
        if not self.enabled or rail not in SAVABLE_RAILS:
            return None
        payload: dict[str, str] = {"key": credential.key}
        if credential.org_id is not None:
            payload["orgId"] = credential.org_id
        if credential.routine_url is not None:
            payload["routineUrl"] = credential.routine_url
        nonce = os.urandom(NONCE_BYTES)
        sealed = self._aead(sub).encrypt(nonce, json.dumps(payload).encode(), self._aad(sub, rail))
        saved_at = _iso(self._now())
        hint = hint_for(credential.key)
        self._db.execute(
            "INSERT INTO vault_credentials (sub, rail, nonce, ciphertext, hint, saved_at, "
            "last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL) "
            "ON CONFLICT (sub, rail) DO UPDATE SET nonce = excluded.nonce, "
            "ciphertext = excluded.ciphertext, hint = excluded.hint, "
            "saved_at = excluded.saved_at, last_used_at = NULL",
            (sub, rail, nonce, sealed, hint, saved_at),
        )
        self._db.checkpoint()  # a key this replaced must not linger in the log
        return SavedCredential(rail=rail, hint=hint, savedAt=saved_at)

    def _open(self, sub: str, rail: str, row: Mapping[str, Any]) -> RailCredential | None:
        """The credential sealed in `row`, or None when the row no longer opens (another
        master key, or tampering) or holds no key."""
        try:
            plain = self._aead(sub).decrypt(row["nonce"], row["ciphertext"], self._aad(sub, rail))
            payload = json.loads(plain.decode())
        except (InvalidTag, ValueError, UnicodeDecodeError, TypeError):
            return None
        key = payload.get("key") if isinstance(payload, dict) else None
        if not isinstance(key, str) or not key:
            return None
        org = payload.get("orgId")
        url = payload.get("routineUrl")
        return RailCredential(
            key=key,
            org_id=org if isinstance(org, str) else None,
            routine_url=url if isinstance(url, str) else None,
        )

    def load(self, sub: str, rail: StartRail) -> RailCredential | None:
        """The saved credential, or None when there is none, the vault is off, or the row
        no longer opens (another master key, or tampering). Such a row is kept, as on
        every read, and reads as none."""
        if not self.enabled or rail not in SAVABLE_RAILS:
            return None
        row = self._db.query_one(
            "SELECT nonce, ciphertext FROM vault_credentials WHERE sub = ? AND rail = ?",
            (sub, rail),
        )
        if row is None:
            return None
        credential = self._open(sub, rail, row)
        if credential is None:
            logger.warning("a saved %s credential could not be opened; ignoring it", rail)
        return credential

    def mark_used(self, sub: str, rail: StartRail) -> None:
        self._db.execute(
            "UPDATE vault_credentials SET last_used_at = ? WHERE sub = ? AND rail = ?",
            (_iso(self._now()), sub, rail),
        )

    def delete(self, sub: str, rail: str) -> bool:
        """Remove the saved credential for (sub, rail); the master key isn't needed. True
        when one was there."""
        result = self._db.execute(
            "DELETE FROM vault_credentials WHERE sub = ? AND rail = ?", (sub, rail)
        )
        if result.rowcount > 0:
            self._db.checkpoint()  # nor may the removed key linger in the log
        return result.rowcount > 0

    def _rows(self, sub: str) -> list[dict[str, Any]]:
        """The caller's rows on rails that save. With the vault on, only rows that still
        open; the others are skipped, never deleted on a read."""
        rows = [
            row
            for row in self._db.query_all(
                "SELECT rail, nonce, ciphertext, hint, saved_at, last_used_at "
                "FROM vault_credentials WHERE sub = ?",
                (sub,),
            )
            if row["rail"] in SAVABLE_RAILS
        ]
        if not self.enabled:
            return rows
        return [row for row in rows if self._open(sub, row["rail"], row) is not None]

    def saved_rails(self, sub: str) -> set[str]:
        """The rails with a saved credential FORGE can use: none while the vault is off."""
        if not self.enabled:
            return set()
        return {str(row["rail"]) for row in self._rows(sub)}

    def list_saved(self, sub: str) -> list[SavedCredential]:
        """The caller's saved credentials, hints only, in the registry's rail order. While
        the vault is off they are listed all the same: FORGE can't use them then, but
        their owner can still see and remove them."""
        order: dict[str, int] = {rail: index for index, rail in enumerate(START_RAILS)}
        listed = [
            SavedCredential(
                rail=row["rail"],
                hint=row["hint"],
                savedAt=row["saved_at"],
                lastUsedAt=row["last_used_at"],
            )
            for row in self._rows(sub)
        ]
        return sorted(listed, key=lambda saved: order.get(saved.rail, len(order)))
