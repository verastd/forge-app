"""Sync the local SQLite data set to the GCS buckets (infra/terraform).

Layout::

    <raw bucket>/actions/YYYY/MM/DD/actions.jsonl      raw Hyperion actions, one per line
    <processed bucket>/properties/properties.parquet   (JSONL when pyarrow is absent)
    <processed bucket>/daily_stats/YYYY-MM-DD.json     per-day roll-up
    <checkpoint bucket>/scraper_state.json             what has been synced (resume point)

GCS is optional. Without credentials `GcsSyncManager.sync` reports "not configured"
and leaves the data in local SQLite — it never raises. Setting `UPLAND_LOCAL_STORE`
mirrors the same layout into a local directory instead (dev and tests).
"""

import asyncio
import json
import logging
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from forge_api.models import GcsStatus, GcsSyncResult
from forge_api.services.upland.action_codes import SALE_ACTIONS
from forge_api.services.upland.db import _db

logger = logging.getLogger(__name__)

ENV_RAW_BUCKET = "UPLAND_RAW_BUCKET"
ENV_PROCESSED_BUCKET = "UPLAND_PROCESSED_BUCKET"
ENV_CHECKPOINT_BUCKET = "UPLAND_CHECKPOINT_BUCKET"
ENV_GCS_ENABLED = "UPLAND_GCS_ENABLED"
ENV_LOCAL_STORE = "UPLAND_LOCAL_STORE"
ENV_GOOGLE_CREDENTIALS = "GOOGLE_APPLICATION_CREDENTIALS"

CHECKPOINT_BLOB = "scraper_state.json"
PROPERTY_COLUMNS = (
    "property_id",
    "address",
    "city",
    "first_seen_block",
    "first_seen_timestamp",
    "mint_price_upx",
    "last_sale_price_upx",
    "last_sale_timestamp",
    "total_sales",
    "total_listings",
)


def raw_bucket() -> str:
    return os.environ.get(ENV_RAW_BUCKET, "upland-data-raw")


def processed_bucket() -> str:
    return os.environ.get(ENV_PROCESSED_BUCKET, "upland-data-processed")


def checkpoint_bucket() -> str:
    return os.environ.get(ENV_CHECKPOINT_BUCKET, "upland-data-checkpoints")


class BlobStore(Protocol):
    """The three blob operations sync needs. Blocking — call from a worker thread."""

    def upload_file(self, bucket: str, name: str, path: Path) -> None: ...

    def upload_text(self, bucket: str, name: str, text: str) -> None: ...

    def read_text(self, bucket: str, name: str) -> str | None: ...


class GcsStore:
    def __init__(self) -> None:
        # google-cloud-storage ships no py.typed marker, so mypy --strict
        # cannot analyze it; the Protocol above is the typed boundary.
        from google.cloud import storage  # type: ignore[import-untyped]

        self._client = storage.Client()

    def upload_file(self, bucket: str, name: str, path: Path) -> None:
        self._client.bucket(bucket).blob(name).upload_from_filename(str(path))

    def upload_text(self, bucket: str, name: str, text: str) -> None:
        self._client.bucket(bucket).blob(name).upload_from_string(
            text, content_type="application/json"
        )

    def read_text(self, bucket: str, name: str) -> str | None:
        blob = self._client.bucket(bucket).blob(name)
        return str(blob.download_as_text()) if blob.exists() else None


class LocalStore:
    """Same layout as GCS, rooted at a directory: ``<root>/<bucket>/<name>``."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def _path(self, bucket: str, name: str) -> Path:
        path = self._root / bucket / name
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def upload_file(self, bucket: str, name: str, path: Path) -> None:
        self._path(bucket, name).write_bytes(path.read_bytes())

    def upload_text(self, bucket: str, name: str, text: str) -> None:
        self._path(bucket, name).write_text(text, encoding="utf-8")

    def read_text(self, bucket: str, name: str) -> str | None:
        path = self._path(bucket, name)
        return path.read_text(encoding="utf-8") if path.exists() else None


def gcs_configured() -> bool:
    """True when a GCS credential source was explicitly provided (key file or workload identity)."""
    return bool(os.environ.get(ENV_GOOGLE_CREDENTIALS)) or os.environ.get(ENV_GCS_ENABLED) == "1"


def get_store() -> BlobStore | None:
    """The configured blob store, or None to stay local-only."""
    local = os.environ.get(ENV_LOCAL_STORE)
    if local:
        return LocalStore(Path(local))
    if gcs_configured():
        return GcsStore()
    return None


def _day_blob(day: str) -> str:
    year, month, dom = day.split("-")
    return f"actions/{year}/{month}/{dom}/actions.jsonl"


async def _export_day(day: str, target: Path) -> int:
    """Stream one UTC day of raw actions into `target` as JSONL. Returns the row count."""
    count = 0
    async with _db() as db:
        cursor = await db.execute(
            "SELECT raw_json FROM actions WHERE DATE(timestamp) = ? ORDER BY global_sequence",
            (day,),
        )
        with target.open("w", encoding="utf-8") as handle:
            async for row in cursor:
                handle.write(row["raw_json"] + "\n")
                count += 1
        await cursor.close()
    return count


async def _daily_stats(day: str) -> dict[str, Any]:
    marks = ",".join("?" for _ in SALE_ACTIONS)
    async with _db() as db:
        cursor = await db.execute(
            "SELECT category, COUNT(*) AS c FROM actions WHERE DATE(timestamp) = ? "
            "GROUP BY category",
            (day,),
        )
        by_category = {row["category"]: row["c"] for row in await cursor.fetchall()}
        await cursor.close()
        cursor = await db.execute(
            f"SELECT COUNT(*) AS c, COALESCE(SUM(price_upx), 0) AS v FROM actions "
            f"WHERE DATE(timestamp) = ? AND action_name IN ({marks}) AND price_upx IS NOT NULL",
            (day, *SALE_ACTIONS),
        )
        sales = await cursor.fetchone()
        await cursor.close()
    return {
        "date": day,
        "totalActions": sum(by_category.values()),
        "byCategory": by_category,
        "salesCount": sales["c"] if sales else 0,
        "salesVolumeUpx": sales["v"] if sales else 0.0,
    }


async def _load_properties() -> list[dict[str, Any]]:
    async with _db() as db:
        cursor = await db.execute(f"SELECT {', '.join(PROPERTY_COLUMNS)} FROM properties")
        rows = [dict(row) for row in await cursor.fetchall()]
        await cursor.close()
    return rows


def _properties_payload(rows: list[dict[str, Any]], scratch: Path) -> tuple[str, Path]:
    """Write `rows` to `scratch` as parquet when pyarrow is installed, else JSONL."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        target = scratch / "properties.jsonl"
        target.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        return "properties/properties.jsonl", target
    target = scratch / "properties.parquet"
    pq.write_table(pa.Table.from_pylist(rows), target)
    return "properties/properties.parquet", target


def _read_checkpoint(store: BlobStore) -> dict[str, Any]:
    raw = store.read_text(checkpoint_bucket(), CHECKPOINT_BLOB)
    if not raw:
        return {"days": {}}
    try:
        state = json.loads(raw)
    except ValueError:
        logger.warning("ignoring unreadable %s; re-syncing everything", CHECKPOINT_BLOB)
        return {"days": {}}
    if isinstance(state, dict) and isinstance(state.get("days"), dict):
        return state
    return {"days": {}}


async def sync_to_store(store: BlobStore) -> GcsSyncResult:
    """Upload every day whose row count changed since the last checkpoint, plus properties.

    Failures are collected per file so one bad upload does not abandon the rest.
    """
    uploaded: list[str] = []
    errors: list[str] = []
    state = await asyncio.to_thread(_read_checkpoint, store)
    synced_days: dict[str, int] = dict(state["days"])

    async with _db() as db:
        cursor = await db.execute(
            "SELECT DATE(timestamp) AS day, COUNT(*) AS c FROM actions GROUP BY day ORDER BY day"
        )
        days = [(row["day"], row["c"]) for row in await cursor.fetchall()]
        await cursor.close()

    with tempfile.TemporaryDirectory() as scratch_dir:
        scratch = Path(scratch_dir)
        for day, expected in days:
            if synced_days.get(day) == expected:
                continue
            try:
                target = scratch / f"{day}.jsonl"
                count = await _export_day(day, target)
                blob = _day_blob(day)
                await asyncio.to_thread(store.upload_file, raw_bucket(), blob, target)
                uploaded.append(f"{raw_bucket()}/{blob}")
                stats_blob = f"daily_stats/{day}.json"
                await asyncio.to_thread(
                    store.upload_text,
                    processed_bucket(),
                    stats_blob,
                    json.dumps(await _daily_stats(day)),
                )
                uploaded.append(f"{processed_bucket()}/{stats_blob}")
                synced_days[day] = count
            except Exception as exc:  # per-file isolation; reported, not raised
                logger.exception("sync of %s failed", day)
                errors.append(f"{day}: {exc}")

        try:
            blob, path = _properties_payload(await _load_properties(), scratch)
            await asyncio.to_thread(store.upload_file, processed_bucket(), blob, path)
            uploaded.append(f"{processed_bucket()}/{blob}")
        except Exception as exc:
            logger.exception("property sync failed")
            errors.append(f"properties: {exc}")

    try:
        checkpoint = {"days": synced_days, "updatedAt": datetime.now(UTC).isoformat()}
        await asyncio.to_thread(
            store.upload_text, checkpoint_bucket(), CHECKPOINT_BLOB, json.dumps(checkpoint)
        )
        uploaded.append(f"{checkpoint_bucket()}/{CHECKPOINT_BLOB}")
    except Exception as exc:
        logger.exception("checkpoint write failed")
        errors.append(f"checkpoint: {exc}")

    return GcsSyncResult(synced=not errors, uploadedFiles=uploaded, errors=errors)


class GcsSyncManager:
    """Serialises syncs and remembers the last result for `/gcs/status`."""

    def __init__(self) -> None:
        self.running = False
        self.last_result: GcsSyncResult | None = None

    def status(self) -> GcsStatus:
        configured = gcs_configured() or bool(os.environ.get(ENV_LOCAL_STORE))
        return GcsStatus(configured=configured, running=self.running, lastResult=self.last_result)

    async def sync(self) -> GcsSyncResult:
        if self.running:
            return GcsSyncResult(synced=False, uploadedFiles=[], errors=["sync already running"])
        self.running = True
        try:
            try:
                store = get_store()
            except Exception as exc:  # e.g. credentials file unreadable
                result = GcsSyncResult(
                    synced=False, uploadedFiles=[], errors=[f"gcs client: {exc}"]
                )
            else:
                if store is None:
                    result = GcsSyncResult(
                        synced=False,
                        uploadedFiles=[],
                        errors=["GCS not configured; data remains in local SQLite only"],
                    )
                else:
                    result = await sync_to_store(store)
            self.last_result = result
            return result
        finally:
            self.running = False


_sync_manager = GcsSyncManager()


def get_sync_manager() -> GcsSyncManager:
    """FastAPI dependency; tests override it."""
    return _sync_manager
