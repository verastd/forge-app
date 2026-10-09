#!/usr/bin/env python3
"""protocol-check.py — run Foreman's protocol gate (G0) on your own branch, before you push.

    tools/forge/protocol-check.py [--base origin/main] [--scope ISSUE.md] [--title TITLE]
                                  [--strict] [--json]

Foreman is the GitHub App that closes a pull request at G0 and records strikes. Its
source is not in this repository, so until now the only way to learn what it would say
about a diff was to open the pull request. This script applies the same published rules to
the diff between your working tree and the merge-base with `--base`, names the rule and
the manifest version behind every verdict, and exits non-zero on anything Foreman would
close. It reads nothing but git and `.github/forge-protocol.json`; python3 stdlib only,
like the sibling gates.

What it checks, and what Foreman calls it:

  G0.0  bot author          SKIP   only Foreman knows the agent-rail allowlist
  G0.1  claim linkage       SKIP   only Foreman holds the leases
  G0.2  scope fencing       FAIL   a changed path outside the task's `in:` globs, or inside
                                   its `out:` globs (`--scope` gives the issue text)
  G0.3  scope block         FAIL   the `forge-scope` block missing or malformed: Foreman
                                   closes the PR with no strike and labels the task
                                   `spec:invalid`
  G0.4  diff size           FAIL   300 or more files, or more than 20,000 changed lines
  G0.5  protected paths     FAIL   any change under the manifest's `protectedPaths`
  G0.6  acceptance tests    FAIL   anything created, changed or removed under
                                   tests/acceptance/ (the spec author's, never yours)
  G2.4  tests modified      FLAG   an existing test under `testGlobs` modified or deleted;
                                   `--strict` makes it a failure, as the Bridge's Send for
                                   review does
  G1.4  dependencies        FLAG   a lockfile or manifest changed: the PR needs
                                   `deps-approved` from the core team
  P.3   branch name         FLAG   not `task/<issue>-<slug>`
  P.8   title               FAIL   `--title` given and not `[#<issue>] <goal>`

Exit status: 0 when nothing fails (flags are allowed), 1 when any rule fails, 2 when the
check could not be evaluated (no git, no manifest, a manifest this version cannot read).
An unreadable rule set is never a pass.

The manifest is read AS OF THE MERGE-BASE when it exists there, the way
test-mod-detector.sh reads it, so a diff cannot weaken the rules it is judged by; the
working-tree copy is used only when the merge-base has none.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

MANIFEST = ".github/forge-protocol.json"
MANIFEST_VERSION = 1
MAX_FILES = 300
MAX_CHANGED_LINES = 20_000
ACCEPTANCE_DIR = "tests/acceptance/"
LOCKFILES = ("pnpm-lock.yaml", "apps/api/uv.lock", "package.json", "apps/api/pyproject.toml")
BRANCH = re.compile(r"^task/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$")
TITLE = re.compile(r"^\[#[1-9][0-9]*\] \S.*$")
SCOPE_FENCE = re.compile(r"^```forge-scope[ \t]*$")
FENCE_END = re.compile(r"^```[ \t]*$")
SCOPE_ITEM = re.compile(r"^- (\S+)$")
#: Glob syntax minimatch (Foreman) and git's `:(glob)` pathspecs read alike: `*` and `?`
#: within one segment, `**` as a whole segment. Anything else the two could read differently.
UNSUPPORTED_GLOB = re.compile(r"[\[\]{}()\\]|^[!#]")

Verdict = str  # PASS | FAIL | FLAG | SKIP


@dataclass(frozen=True)
class Change:
    path: str
    status: str  # A, M, D (and anything else git prints; treated as a modification)
    additions: int
    deletions: int


@dataclass(frozen=True)
class Scope:
    include: tuple[str, ...]
    exclude: tuple[str, ...]


@dataclass(frozen=True)
class Rules:
    test_globs: tuple[str, ...]
    protected_paths: tuple[str, ...]
    source: str


@dataclass
class Finding:
    rule: str
    name: str
    verdict: Verdict
    detail: str
    paths: list[str] = field(default_factory=list)


class CannotEvaluate(Exception):
    """The check could not be run; exit 2, never a pass."""


# --- globs, as Foreman and git read them ------------------------------------------------


def glob_pattern(glob: str) -> re.Pattern[str] | None:
    """A glob as a regular expression over a whole repository path, or None when it uses
    syntax the detectors could disagree on. Same grammar as apps/api's copies.glob_pattern."""
    if not glob or UNSUPPORTED_GLOB.search(glob):
        return None
    segments = glob.split("/")
    if "" in segments:
        return None
    regex = ""
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if segment == "**":
            regex += ".*" if last else "(?:[^/]+/)*"
            continue
        regex += "".join(
            "[^/]*" if char == "*" else "[^/]" if char == "?" else re.escape(char)
            for char in segment
        )
        if not last:
            regex += "/"
    return re.compile(regex)


def matches(path: str, pattern: re.Pattern[str]) -> bool:
    return pattern.fullmatch(path) is not None


def is_protected(path: str, protected: tuple[str, ...]) -> bool:
    """Foreman's protectedPaths grammar: an entry ending in `/` is a directory prefix,
    anything else an exact path. Case matters."""
    return any(
        path.startswith(entry) if entry.endswith("/") else path == entry for entry in protected
    )


# --- the scope block ---------------------------------------------------------------------


def parse_scope(text: str) -> Scope:
    """The one `forge-scope` block in an issue's text. The grammar is exact: `in:` and
    `out:` headers, `- <glob>` items, blank lines. Anything else is malformed, and a
    malformed block fails closed (G0.3). Raises ValueError with the reason."""
    lines = text.splitlines()
    starts = [index for index, line in enumerate(lines) if SCOPE_FENCE.match(line)]
    if not starts:
        raise ValueError("no ```forge-scope block")
    if len(starts) > 1:
        raise ValueError("more than one ```forge-scope block")
    body: list[str] = []
    closed = False
    for line in lines[starts[0] + 1 :]:
        if FENCE_END.match(line):
            closed = True
            break
        body.append(line)
    if not closed:
        raise ValueError("the ```forge-scope block is never closed")
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw in body:
        line = raw.rstrip()
        if not line.strip():
            continue
        if line in ("in:", "out:"):
            if line[:-1] in sections:
                raise ValueError(f"`{line}` appears twice")
            current = line[:-1]
            sections[current] = []
            continue
        item = SCOPE_ITEM.match(line)
        if item is None or current is None:
            raise ValueError(f"unreadable line in the block: {line!r}")
        glob = item.group(1)
        if glob_pattern(glob) is None:
            raise ValueError(f"glob syntax Foreman and git could read differently: {glob!r}")
        sections[current].append(glob)
    include = tuple(sections.get("in", ()))
    if not include:
        raise ValueError("`in:` is missing or empty")
    return Scope(include=include, exclude=tuple(sections.get("out", ())))


# --- git ---------------------------------------------------------------------------------


def git(*args: str, check: bool = True) -> str:
    try:
        done = subprocess.run(
            ["git", *args], capture_output=True, text=True, encoding="utf-8", check=False
        )
    except FileNotFoundError as exc:
        raise CannotEvaluate("git is not installed") from exc
    if check and done.returncode != 0:
        raise CannotEvaluate(f"git {' '.join(args)}: {done.stderr.strip() or 'failed'}")
    return done.stdout


def merge_base(base: str) -> str:
    if not git("rev-parse", "--verify", "--quiet", base, check=False).strip():
        raise CannotEvaluate(
            f"{base!r} is not a known ref: fetch it first (git fetch origin main) or pass --base"
        )
    found = git("merge-base", base, "HEAD", check=False).strip()
    if not found:
        raise CannotEvaluate(f"no merge-base between {base!r} and HEAD")
    return found


def load_rules(base_sha: str) -> Rules:
    """The manifest at the merge-base when it exists there (the base wins, so a diff cannot
    weaken its own rules), else the working-tree copy, else no check at all."""
    exists = subprocess.run(
        ["git", "cat-file", "-e", f"{base_sha}:{MANIFEST}"], capture_output=True, check=False
    )
    if exists.returncode == 0:
        raw = git("show", f"{base_sha}:{MANIFEST}")
        source = f"{MANIFEST} at merge-base {base_sha[:7]}"
    elif Path(MANIFEST).is_file():
        raw = Path(MANIFEST).read_text(encoding="utf-8")
        source = f"{MANIFEST} in the working tree (none at the merge-base)"
    else:
        raise CannotEvaluate(f"no {MANIFEST} at the merge-base or in the working tree")
    try:
        doc = json.loads(raw)
    except ValueError as exc:
        raise CannotEvaluate(f"{source} is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise CannotEvaluate(f"{source} must hold a JSON object")
    version = doc.get("version")
    if isinstance(version, bool) or version != MANIFEST_VERSION:
        raise CannotEvaluate(
            f"{source} declares version {version!r}; this script speaks version "
            f"{MANIFEST_VERSION} only, so it is out of date"
        )
    lists: dict[str, tuple[str, ...]] = {}
    for key in ("testGlobs", "protectedPaths"):
        value = doc.get(key)
        if not isinstance(value, list) or not all(
            isinstance(item, str) and item.strip() and "\n" not in item for item in value
        ):
            raise CannotEvaluate(f"{source}: {key} must be a list of non-empty strings")
        lists[key] = tuple(value)
    for glob in lists["testGlobs"]:
        if glob_pattern(glob) is None:
            raise CannotEvaluate(f"{source}: testGlobs entry {glob!r} is not readable")
    return Rules(
        test_globs=lists["testGlobs"],
        protected_paths=lists["protectedPaths"],
        source=f"{source}, version {MANIFEST_VERSION}",
    )


def changes_since(base_sha: str) -> list[Change]:
    """Every path the working tree changes against the merge-base, untracked files
    included, with its status and line counts. Renames are split (`--no-renames`), so a
    moved test is a deletion."""
    statuses: dict[str, str] = {}
    for line in git("diff", "--name-status", "--no-renames", base_sha).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            statuses[parts[-1]] = parts[0][:1]
    counts: dict[str, tuple[int, int]] = {}
    for line in git("diff", "--numstat", "--no-renames", base_sha).splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            added, removed = parts[0], parts[1]
            counts[parts[-1]] = (
                int(added) if added.isdigit() else 0,
                int(removed) if removed.isdigit() else 0,
            )
    # Untracked files are part of what a push would carry once added, and a contributor
    # runs this before committing as often as after: count them as additions.
    for line in git("ls-files", "--others", "--exclude-standard").splitlines():
        path = line.strip()
        if path and path not in statuses:
            statuses[path] = "A"
            try:
                with open(path, "rb") as handle:
                    counts[path] = (sum(1 for _ in handle), 0)
            except OSError:
                counts[path] = (0, 0)
    paths = sorted(set(statuses) | set(counts))
    return [
        Change(
            path=path,
            status=statuses.get(path, "M"),
            additions=counts.get(path, (0, 0))[0],
            deletions=counts.get(path, (0, 0))[1],
        )
        for path in paths
    ]


def current_branch() -> str | None:
    name = git("rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    return name if name and name != "HEAD" else None


def acceptance_dirs_at(base_sha: str) -> set[str]:
    out = git("ls-tree", "-d", "--name-only", base_sha, ACCEPTANCE_DIR, check=False)
    return {line.strip().rstrip("/") + "/" for line in out.splitlines() if line.strip()}


# --- the rules ---------------------------------------------------------------------------


def evaluate(
    changes: list[Change],
    rules: Rules,
    scope: Scope | None,
    scope_error: str | None,
    branch: str | None,
    title: str | None,
    strict: bool,
) -> list[Finding]:
    findings: list[Finding] = []
    paths = [change.path for change in changes]

    findings.append(
        Finding("G0.0", "bot author", "SKIP", "only Foreman knows the agent-rail allowlist")
    )
    findings.append(Finding("G0.1", "claim linkage", "SKIP", "only Foreman holds the leases"))

    if scope_error is not None:
        findings.append(
            Finding(
                "G0.3",
                "scope block",
                "FAIL",
                f"the forge-scope block is unreadable ({scope_error}): Foreman closes the "
                "PR with no strike and labels the task spec:invalid. Comment "
                "`@forge-foreman spec-gap` on the issue.",
            )
        )
        findings.append(Finding("G0.2", "scope fencing", "SKIP", "no readable scope to fence"))
    elif scope is None:
        findings.append(
            Finding("G0.3", "scope block", "SKIP", "pass --scope <issue text> to check it")
        )
        findings.append(
            Finding("G0.2", "scope fencing", "SKIP", "pass --scope <issue text> to check it")
        )
    else:
        findings.append(
            Finding(
                "G0.3",
                "scope block",
                "PASS",
                f"{len(scope.include)} in, {len(scope.exclude)} out",
            )
        )
        includes = [glob_pattern(glob) for glob in scope.include]
        excludes = [glob_pattern(glob) for glob in scope.exclude]
        outside = [
            path
            for path in paths
            if not any(p is not None and matches(path, p) for p in includes)
            or any(p is not None and matches(path, p) for p in excludes)
        ]
        findings.append(
            Finding(
                "G0.2",
                "scope fencing",
                "FAIL" if outside else "PASS",
                (
                    f"{len(outside)} changed path(s) outside the task's scope"
                    if outside
                    else "every changed path is inside the task's `in:` globs"
                ),
                outside,
            )
        )

    lines = sum(change.additions + change.deletions for change in changes)
    too_big = len(changes) >= MAX_FILES or lines > MAX_CHANGED_LINES
    findings.append(
        Finding(
            "G0.4",
            "diff size",
            "FAIL" if too_big else "PASS",
            f"{len(changes)} file(s), {lines} changed line(s) "
            f"(limits: under {MAX_FILES} files, at most {MAX_CHANGED_LINES} lines)",
        )
    )

    protected = [path for path in paths if is_protected(path, rules.protected_paths)]
    findings.append(
        Finding(
            "G0.5",
            "protected paths",
            "FAIL" if protected else "PASS",
            (
                f"{len(protected)} protected path(s) changed: core-team only"
                if protected
                else "no protected path changed"
            ),
            protected,
        )
    )

    acceptance = [path for path in paths if path.startswith(ACCEPTANCE_DIR)]
    findings.append(
        Finding(
            "G0.6",
            "acceptance tests",
            "FAIL" if acceptance else "PASS",
            (
                "tests/acceptance/ is the spec author's: never create, change or remove "
                "anything there"
                if acceptance
                else "nothing under tests/acceptance/ touched"
            ),
            acceptance,
        )
    )

    test_patterns = [p for p in (glob_pattern(glob) for glob in rules.test_globs) if p]
    tests_touched = [
        change.path
        for change in changes
        if change.status != "A" and any(matches(change.path, p) for p in test_patterns)
    ]
    findings.append(
        Finding(
            "G2.4",
            "tests modified",
            ("FAIL" if strict else "FLAG") if tests_touched else "PASS",
            (
                "existing test(s) modified or deleted: the Gauntlet flags the PR for extra "
                "human scrutiny, and the Bridge's Send for review refuses it"
                if tests_touched
                else "no existing test modified or deleted (new tests are welcome)"
            ),
            tests_touched,
        )
    )

    deps = [path for path in paths if path in LOCKFILES]
    findings.append(
        Finding(
            "G1.4",
            "dependencies",
            "FLAG" if deps else "PASS",
            (
                "a dependency manifest or lockfile changed: the PR needs the `deps-approved` "
                "label, which only the core team applies, and the issue must name the "
                "dependency"
                if deps
                else "no dependency manifest or lockfile changed"
            ),
            deps,
        )
    )

    if branch is None:
        findings.append(Finding("P.3", "branch name", "SKIP", "detached HEAD"))
    else:
        ok = BRANCH.match(branch) is not None
        findings.append(
            Finding(
                "P.3",
                "branch name",
                "PASS" if ok else "FLAG",
                f"{branch!r}" + ("" if ok else " is not task/<issue>-<slug>"),
            )
        )

    if title is None:
        findings.append(Finding("P.8", "title", "SKIP", "pass --title to check it"))
    else:
        ok = TITLE.match(title) is not None
        findings.append(
            Finding(
                "P.8",
                "title",
                "PASS" if ok else "FAIL",
                f"{title!r}" + ("" if ok else " is not `[#<issue>] <goal>`"),
            )
        )
    return findings


def worst(findings: list[Finding]) -> int:
    return 1 if any(finding.verdict == "FAIL" for finding in findings) else 0


# --- the report --------------------------------------------------------------------------


def render(findings: list[Finding], rules: Rules, base_sha: str, base: str) -> str:
    width = max(len(f.name) for f in findings)
    out = [
        f"protocol-check: diff of the working tree against merge-base {base_sha[:7]} ({base})",
        f"protocol-check: rules from {rules.source}",
        "",
    ]
    for finding in findings:
        out.append(
            f"  {finding.verdict:<4} {finding.rule:<5} {finding.name:<{width}}  {finding.detail}"
        )
        for path in finding.paths[:20]:
            out.append(f"             - {path}")
        if len(finding.paths) > 20:
            out.append(f"             … and {len(finding.paths) - 20} more")
    status = worst(findings)
    flags = sum(1 for f in findings if f.verdict == "FLAG")
    out.append("")
    if status:
        out.append("protocol-check: FAIL — Foreman would close this pull request at G0.")
    elif flags:
        out.append(f"protocol-check: OK with {flags} flag(s) a human will look at.")
    else:
        out.append("protocol-check: OK — nothing here Foreman would close or flag.")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="protocol-check",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--base", default="origin/main", help="the ref to diff against")
    parser.add_argument(
        "--scope",
        metavar="FILE",
        help="a file holding the issue's text (its ```forge-scope block); `-` for stdin",
    )
    parser.add_argument(
        "--title", help="the pull request title to check against `[#<issue>] <goal>`"
    )
    parser.add_argument("--strict", action="store_true", help="a modified existing test fails")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)

    try:
        base_sha = merge_base(args.base)
        rules = load_rules(base_sha)
        changes = changes_since(base_sha)
        scope: Scope | None = None
        scope_error: str | None = None
        if args.scope is not None:
            text = sys.stdin.read() if args.scope == "-" else Path(args.scope).read_text("utf-8")
            try:
                scope = parse_scope(text)
            except ValueError as exc:
                scope_error = str(exc)
        findings = evaluate(
            changes, rules, scope, scope_error, current_branch(), args.title, args.strict
        )
    except CannotEvaluate as exc:
        message = f"protocol-check: cannot evaluate: {exc}"
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(message, file=sys.stderr)
        return 2

    status = worst(findings)
    if args.json:
        print(
            json.dumps(
                {
                    "ok": status == 0,
                    "base": base_sha,
                    "rules": rules.source,
                    "findings": [finding.__dict__ for finding in findings],
                },
                indent=2,
            )
        )
    else:
        print(render(findings, rules, base_sha, args.base))
    return status


if __name__ == "__main__":
    sys.exit(main())
