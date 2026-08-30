"""CSV export of the full history (Task Spec issue #1 — the PRD's worked example).

Stdlib `csv` only, per the task's DEPS policy. Rows are yielded in batches so the
response starts streaming immediately and the 10k-row export stays well under the
3-second acceptance budget.
"""

import csv
import io
from collections.abc import Iterator

from forge_api.models import EXPORT_COLUMNS
from forge_api.services.history import all_rows

EXPORT_FILENAME = "history.csv"
CONTENT_DISPOSITION = f'attachment; filename="{EXPORT_FILENAME}"'

_BATCH_SIZE = 1_000


def iter_csv(batch_size: int = _BATCH_SIZE) -> Iterator[str]:
    """Yield the CSV export: header row first, then every history row."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(EXPORT_COLUMNS)

    for index, row in enumerate(all_rows(), start=1):
        writer.writerow([row.ts, row.type, row.amount])
        if index % batch_size == 0:
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    tail = buffer.getvalue()
    if tail:
        yield tail
