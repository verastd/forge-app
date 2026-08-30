#!/usr/bin/env python3
"""Gauntlet G2.2 engine: coverage of the lines this PR actually changed.

Invoked by tools/forge/coverage-gate.sh, which owns the CLI contract and the
best-effort fetch of the base ref. Stdlib only, on purpose: this runs in the
unprivileged Gauntlet job before any Python dependency of the PR is trusted.

The gate is deliberately fail-CLOSED. If a repo root has changed source lines
but its coverage report is absent, that is a hard failure, not a skip: a
contribution that disables its own coverage reporting must not pass G2.2. The
same applies one level down — a file the report LISTS but measures nothing in
counts every changed line as uncovered, because "no measurable lines" in a real
source file means measurement was switched off, not that the code is data.

Fail-closed cuts both ways, so it must not fire on files the repo itself has
decided not to measure: see UNMEASURED below.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

# Enforced roots and where each one's coverage report lands. `kind` selects
# both the report parser and the "is this an enforced source file" predicate
# below. Roots absent from this table are EXEMPT — apps/web has no test
# runner yet, and tools/, .github/, docs/, config/, contracts/ and tests/ are
# not product code. Add a root here the moment it grows a test suite.
ROOTS: tuple[tuple[str, str, str], ...] = (
    ("packages/shared", "js", "packages/shared/coverage/coverage-final.json"),
    ("packages/flags", "js", "packages/flags/coverage/coverage-final.json"),
    ("packages/contracts-client", "js", "packages/contracts-client/coverage/coverage-final.json"),
    ("apps/api", "py", "apps/api/coverage.xml"),
)

# Paths each root's coverage RUNNER drops from measurement, so this gate must
# drop them too. A file the runner never reports but the gate enforces is an
# UNSATISFIABLE gate: @vitest/coverage-v8 filters excluded files out even when a
# test executes them, so no test the contributor can write will ever cover it,
# and the only escape is editing the runner config — which is itself watched as
# a test change. The contributor would be charged 0% for a decision the repo
# made.
#
# EMPTY TODAY: no enforced root excludes any of its own source from coverage.
# Add an entry here ONLY alongside one, and keep it CANONICAL — identical to
# that root's `coverage.exclude` (for a JS root, the `exclude:` list in its
# vitest.config.ts; for apps/api, `[tool.coverage.run] omit`). Same
# duplicated-list hazard as TEST_GLOBS / TEST_PATHS: sync them by hand.
# A trailing "/" means "this directory and everything under it".
UNMEASURED: dict[str, tuple[str, ...]] = {}

HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


class GateError(Exception):
    """Operator error (bad ref, unreadable report) — exit 2, not a gate failure."""


@dataclass
class FileResult:
    path: str
    root: str
    covered: int = 0
    uncovered: int = 0
    skipped: int = 0  # changed lines with no executable statement (comments, blanks)
    missing_from_report: bool = False
    #: report listed the file but measured nothing in it — suspected tampering
    unmeasured: bool = False

    @property
    def enforced(self) -> int:
        return self.covered + self.uncovered


@dataclass
class RootResult:
    root: str
    report: str
    files: list[FileResult] = field(default_factory=list)
    report_missing: bool = False


def git(repo_root: str, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", repo_root, *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise GateError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def repo_root() -> str:
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        raise GateError("not inside a git work tree")
    return os.path.realpath(proc.stdout.strip())


def resolve_diff_base(root: str, base_ref: str) -> str:
    """merge-base(base, HEAD), falling back to base itself.

    Same fallback the sibling gates use: a shallow CI checkout may not share
    history with the base ref, and a direct diff is still better than no gate.
    """
    proc = subprocess.run(
        ["git", "-C", root, "merge-base", base_ref, "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    print(
        f"coverage-gate: could not compute a merge-base against '{base_ref}' — "
        f"falling back to a direct diff against '{base_ref}'.",
        file=sys.stderr,
    )
    return base_ref


def changed_lines(root: str, diff_base: str) -> dict[str, set[int]]:
    """Added/modified line numbers per file, merge-base..working tree.

    -U0 makes every hunk header's +range exactly the added/modified lines, so
    no per-line counting is needed. Pure-deletion hunks have length 0 and drop
    out; deleted files contribute nothing; renames report the new path.
    """
    out = git(
        root,
        "-c",
        "core.quotePath=false",
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        diff_base,
        "--",
    )
    result: dict[str, set[int]] = {}
    current: str | None = None
    in_header = False
    for line in out.splitlines():
        # `+++` is only honoured between a `diff --git` header and the first
        # hunk, so added content that happens to look like diff syntax cannot
        # redirect the parser to another file.
        if line.startswith("diff --git "):
            current, in_header = None, True
            continue
        if in_header and line.startswith("+++ "):
            target = line[4:]
            if target == "/dev/null":
                current = None
            else:
                current = target[2:] if target.startswith("b/") else target
            in_header = False
            continue
        if current is None or not line.startswith("@@"):
            continue
        match = HUNK_RE.match(line)
        if match is None:
            continue
        start = int(match.group(1))
        count = 1 if match.group(2) is None else int(match.group(2))
        if count:
            result.setdefault(current, set()).update(range(start, start + count))
    return result


def is_enforced_source(path: str, root: str, kind: str) -> bool:
    """Product source inside `root` whose coverage the gate measures."""
    for skip in UNMEASURED.get(root, ()):
        if path == skip or (skip.endswith("/") and path.startswith(skip)):
            return False
    if kind == "js":
        prefix = f"{root}/src/"
        return path.startswith(prefix) and path.endswith(".ts") and not path.endswith(".test.ts")
    prefix = f"{root}/src/forge_api/"
    return path.startswith(prefix) and path.endswith(".py")


def load_istanbul(report_path: str, root: str) -> dict[str, dict[int, bool]]:
    """istanbul/v8 JSON -> {repo-relative path: {line: covered}}.

    A line is covered when ANY statement spanning it ran; it is uncovered when
    every spanning statement has count 0. Lines no statement spans (imports of
    types, comments, blanks, closing braces) are absent from the map and are
    never counted against the contributor.
    """
    with open(report_path, encoding="utf-8") as handle:
        data = json.load(handle)
    files: dict[str, dict[int, bool]] = {}
    for key, entry in data.items():
        raw = entry.get("path") or key
        if not os.path.isabs(raw):
            raw = os.path.join(root, raw)
        rel = os.path.relpath(os.path.realpath(raw), root)
        if rel.startswith(".."):
            continue
        lines = files.setdefault(rel.replace(os.sep, "/"), {})
        statements = entry.get("statementMap") or {}
        counts = entry.get("s") or {}
        for sid, span in statements.items():
            start = (span.get("start") or {}).get("line")
            if start is None:
                continue
            end = (span.get("end") or {}).get("line") or start
            hit = int(counts.get(sid, 0) or 0) > 0
            for line in range(int(start), int(end) + 1):
                lines[line] = lines.get(line, False) or hit
    return files


def load_cobertura(report_path: str, root: str) -> dict[str, dict[int, bool]]:
    """Cobertura XML -> {repo-relative path: {line: covered}}.

    pytest-cov writes <source> as an absolute directory (apps/api) and each
    <class filename> relative to it, so the two must be rejoined before the
    path can be compared with git's repo-relative output.

    report_path is never attacker-controlled: it is built in check_root() by
    joining a hardcoded ROOTS entry with that root's hardcoded report name.
    No CLI flag or env var reaches it, and the file it names was written
    minutes earlier by this same CI job's `make test-coverage` run. That is
    why the stdlib parser is kept here rather than adding a defusedxml
    dependency to a stdlib-only script (see the module docstring).
    """
    # nosemgrep: python.lang.security.use-defused-xml-parse.use-defused-xml-parse
    tree = ET.parse(report_path)
    xml_root = tree.getroot()
    sources = [s.text.strip() for s in xml_root.iter("source") if s.text and s.text.strip()]
    if not sources:
        sources = [root]
    files: dict[str, dict[int, bool]] = {}
    for cls in xml_root.iter("class"):
        filename = cls.get("filename")
        if not filename:
            continue
        rel: str | None = None
        for source in sources:
            candidate = os.path.realpath(os.path.join(source, filename))
            attempt = os.path.relpath(candidate, root)
            if not attempt.startswith(".."):
                rel = attempt
                break
        if rel is None:
            rel = filename
        lines = files.setdefault(rel.replace(os.sep, "/"), {})
        for line in cls.iter("line"):
            number = line.get("number")
            if number is None:
                continue
            hit = int(line.get("hits") or 0) > 0
            key = int(number)
            lines[key] = lines.get(key, False) or hit
    return files


def evaluate(root: str, diff: dict[str, set[int]]) -> tuple[list[RootResult], list[str]]:
    exempt: list[str] = []
    assigned: dict[str, list[str]] = {}
    for path in sorted(diff):
        for root_name, kind, _report in ROOTS:
            if path == root_name or path.startswith(f"{root_name}/"):
                if is_enforced_source(path, root_name, kind):
                    assigned.setdefault(root_name, []).append(path)
                else:
                    exempt.append(path)
                break
        else:
            exempt.append(path)

    results: list[RootResult] = []
    for root_name, kind, report in ROOTS:
        paths = assigned.get(root_name)
        if not paths:
            continue
        report_path = os.path.join(root, report)
        result = RootResult(root=root_name, report=report)
        if not os.path.isfile(report_path):
            result.report_missing = True
            results.append(result)
            continue
        try:
            load = load_istanbul if kind == "js" else load_cobertura
            coverage = load(report_path, root)
        except (OSError, ValueError, ET.ParseError) as exc:
            raise GateError(f"could not parse {report}: {exc}") from exc
        for path in paths:
            entry = FileResult(path=path, root=root_name)
            lines = coverage.get(path)
            if not lines:
                # ABSENT, or PRESENT WITH AN EMPTY LINE MAP — the same thing.
                #
                # Reports are generated with coverage.all=true, so a source file
                # missing from one was excluded from measurement entirely. A file
                # the report DOES list but for which it reports no measurable
                # line is the same exclusion wearing a disguise: four lines of
                # `[tool.coverage.report] exclude_lines = ["."]` in a PR-editable
                # config emptied every <lines/> element while the files stayed
                # listed, and every changed line then fell through to `skipped`
                # ("non-executable") and the gate passed at 100% of nothing.
                #
                # A real source file always has at least one statement, so this
                # is only reachable when measurement was switched off. Fail
                # closed: every changed line counts as uncovered.
                entry.missing_from_report = True
                entry.unmeasured = lines is not None
                entry.uncovered = len(diff[path])
            else:
                for line in sorted(diff[path]):
                    if line not in lines:
                        entry.skipped += 1
                    elif lines[line]:
                        entry.covered += 1
                    else:
                        entry.uncovered += 1
            result.files.append(entry)
        results.append(result)
    return results, exempt


def fmt_threshold(value: float) -> str:
    return f"{value:g}"


def report(results: list[RootResult], exempt: list[str], threshold: float, base: str) -> int:
    print(f"coverage-gate: changed-line coverage vs {base} (floor {fmt_threshold(threshold)}%)")

    missing = [r for r in results if r.report_missing]
    for result in missing:
        print(
            f"gauntlet: FAIL G2.2 — coverage report missing for {result.root} "
            f"(expected {result.report}; run `make test-coverage`)"
        )

    covered = 0
    total = 0
    for result in results:
        if result.report_missing:
            continue
        print(f"  {result.root}  [{result.report}]")
        for entry in result.files:
            covered += entry.covered
            total += entry.enforced
            pct = 100.0 * entry.covered / entry.enforced if entry.enforced else 100.0
            note = ""
            if entry.unmeasured:
                note = (
                    "  (file REPORTED BUT UNMEASURED — zero measurable lines; "
                    "suspected coverage-config tampering, all changed lines counted uncovered)"
                )
            elif entry.missing_from_report:
                note = "  (file absent from coverage report — all changed lines counted uncovered)"
            elif entry.skipped:
                note = f"  ({entry.skipped} non-executable changed lines ignored)"
            print(
                f"    {entry.path}: {entry.covered}/{entry.enforced} "
                f"changed lines {pct:.1f}%{note}"
            )

    if exempt:
        print(f"  EXEMPT (outside enforced roots): {len(exempt)} file(s)")
        for path in exempt:
            print(f"    {path}")

    if missing:
        return 1

    if total == 0:
        print("coverage-gate: no enforced changed lines — nothing to enforce. OK.")
        return 0

    pct = 100.0 * covered / total
    print(f"coverage-gate: {covered} of {total} enforced changed lines covered ({pct:.1f}%)")
    if pct + 1e-9 < threshold:
        print(
            f"gauntlet: FAIL G2.2 — changed-line coverage {pct:.1f}% is below the "
            f"{fmt_threshold(threshold)}% floor ({covered} of {total} changed lines covered)"
        )
        return 1
    print("coverage-gate: OK.")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--changed-lines", dest="threshold", required=True, type=float)
    parser.add_argument("--base", dest="base", default="origin/main")
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return 2

    try:
        root = repo_root()
        diff_base = resolve_diff_base(root, args.base)
        diff = changed_lines(root, diff_base)
        results, exempt = evaluate(root, diff)
    except GateError as exc:
        print(f"coverage-gate: {exc}", file=sys.stderr)
        return 2

    return report(results, exempt, args.threshold, args.base)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
