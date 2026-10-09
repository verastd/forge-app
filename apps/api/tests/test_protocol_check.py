"""tools/forge/protocol-check.py: Foreman's protocol gate (G0), run locally. The tool is
stdlib-only and lives outside the API, so it is loaded here by path and exercised against
throwaway git repositories: the scope grammar, the glob grammar shared with Foreman and
git, the protected-path grammar, every rule's verdict, the merge-base-wins manifest rule,
and the exit codes a contributor's agent reads."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOL = REPO_ROOT / "tools" / "forge" / "protocol-check.py"

MANIFEST = {
    "version": 1,
    "testGlobs": ["tests/**", "packages/*/src/**/*.test.ts"],
    "protectedPaths": [".github/", "CODEOWNERS", "packages/auth/"],
}

SCOPE = """# A task

```forge-scope
in:
- packages/lobby/src/**
- docs/adr/ADR-009-*.md
out:
- packages/lobby/src/registry.ts
```

DEPS: none new.
"""


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("protocol_check", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolve `from __future__` annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def run_git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.invalid",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.invalid",
    }
    done = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True, env=env
    )
    return done.stdout


def write(repo: Path, path: str, text: str) -> None:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


@pytest.fixture()
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A repository with a main branch holding the manifest, an existing test and an
    acceptance test, checked out on a task branch."""
    root = tmp_path / "repo"
    root.mkdir()
    run_git(root, "init", "-q", "-b", "main")
    write(root, ".github/forge-protocol.json", json.dumps(MANIFEST))
    write(root, "tests/acceptance/issue-7/test_it.py", "def test_it():\n    pass\n")
    write(root, "tests/e2e/old.spec.ts", "old\n")
    write(root, "packages/lobby/src/thing.ts", "export const a = 1;\n")
    write(root, "packages/lobby/src/thing.test.ts", "old test\n")
    write(root, "packages/auth/src/x.ts", "x\n")
    write(root, "README.md", "hi\n")
    run_git(root, "add", "-A")
    run_git(root, "commit", "-q", "-m", "base")
    run_git(root, "checkout", "-q", "-b", "task/7-do-the-thing")
    monkeypatch.chdir(root)
    yield root


def findings_by_rule(repo: Path, **kwargs: object) -> dict[str, tool.Finding]:
    base = tool.merge_base("main")
    rules = tool.load_rules(base)
    changes = tool.changes_since(base)
    scope = kwargs.get("scope")
    found = tool.evaluate(
        changes,
        rules,
        scope,  # type: ignore[arg-type]
        kwargs.get("scope_error"),  # type: ignore[arg-type]
        tool.current_branch(),
        kwargs.get("title"),  # type: ignore[arg-type]
        bool(kwargs.get("strict", False)),
    )
    return {finding.rule: finding for finding in found}


# --- the scope grammar ---------------------------------------------------------------------


def test_scope_block_parses_in_and_out() -> None:
    scope = tool.parse_scope(SCOPE)
    assert scope.include == ("packages/lobby/src/**", "docs/adr/ADR-009-*.md")
    assert scope.exclude == ("packages/lobby/src/registry.ts",)


def test_scope_block_without_out_is_fine_and_blank_lines_are_ignored() -> None:
    scope = tool.parse_scope("```forge-scope\n\nin:\n\n- a/**\n\n```\n")
    assert scope == tool.Scope(include=("a/**",), exclude=())


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("no block here", "no ```forge-scope block"),
        ("```forge-scope\nin:\n- a/**\n", "never closed"),
        ("```forge-scope\nout:\n- a/**\n```", "`in:` is missing or empty"),
        ("```forge-scope\nin:\n```", "`in:` is missing or empty"),
        ("```forge-scope\nin:\n- a/**\nin:\n- b\n```", "appears twice"),
        ("```forge-scope\n- a/**\n```", "unreadable line"),
        ("```forge-scope\nin:\n* a/**\n```", "unreadable line"),
        ("```forge-scope\nin:\n- a/{b,c}\n```", "read differently"),
        ("```forge-scope\nin:\n- a//b\n```", "read differently"),
        ("```forge-scope\nin:\n- a\n```\n```forge-scope\nin:\n- b\n```", "more than one"),
    ],
)
def test_malformed_scope_blocks_fail_closed(text: str, reason: str) -> None:
    with pytest.raises(ValueError, match=reason):
        tool.parse_scope(text)


# --- the glob grammar shared with Foreman and git ------------------------------------------


@pytest.mark.parametrize(
    ("glob", "path", "expected"),
    [
        ("tests/**", "tests/e2e/a.spec.ts", True),
        ("tests/**", "tests", False),
        ("tests/**", "testsx/a", False),
        ("packages/*/src/**/*.test.ts", "packages/lobby/src/a.test.ts", True),
        ("packages/*/src/**/*.test.ts", "packages/lobby/src/deep/er/a.test.ts", True),
        ("packages/*/src/**/*.test.ts", "packages/lobby/src/a.ts", False),
        ("packages/*/src/**/*.test.ts", "packages/a/b/src/a.test.ts", False),
        ("docs/adr/ADR-009-*.md", "docs/adr/ADR-009-shared-behaviours.md", True),
        ("docs/adr/ADR-009-*.md", "docs/adr/sub/ADR-009-x.md", False),
        ("a/?.ts", "a/b.ts", True),
        ("a/?.ts", "a/bc.ts", False),
        ("README.md", "README.md", True),
        ("README.md", "docs/README.md", False),
    ],
)
def test_globs_match_whole_paths_segment_by_segment(glob: str, path: str, expected: bool) -> None:
    pattern = tool.glob_pattern(glob)
    assert pattern is not None
    assert tool.matches(path, pattern) is expected


@pytest.mark.parametrize("glob", ["", "a/{b,c}", "[ab]/c", "!a", "#a", "a\\b", "a//b", "/a"])
def test_glob_syntax_the_detectors_could_disagree_on_is_unreadable(glob: str) -> None:
    assert tool.glob_pattern(glob) is None


def test_protected_paths_are_directory_prefixes_or_exact_paths() -> None:
    protected = (".github/", "CODEOWNERS", "packages/auth/")
    assert tool.is_protected(".github/workflows/x.yml", protected)
    assert tool.is_protected("CODEOWNERS", protected)
    assert tool.is_protected("packages/auth/src/x.ts", protected)
    assert not tool.is_protected("CODEOWNERS.md", protected)
    assert not tool.is_protected("packages/authx/y.ts", protected)
    assert not tool.is_protected("docs/.github/x", protected)


# --- the rules, against a real diff ----------------------------------------------------------


def test_a_clean_in_scope_change_passes_every_enforced_rule(repo: Path) -> None:
    write(repo, "packages/lobby/src/new.ts", "export const b = 2;\n")
    write(repo, "packages/lobby/src/new.test.ts", "new test\n")
    found = findings_by_rule(repo, scope=tool.parse_scope(SCOPE), title="[#7] Do the thing")
    assert {rule: f.verdict for rule, f in found.items()} == {
        "G0.0": "SKIP",
        "G0.1": "SKIP",
        "G0.3": "PASS",
        "G0.2": "PASS",
        "G0.4": "PASS",
        "G0.5": "PASS",
        "G0.6": "PASS",
        "G2.4": "PASS",
        "G1.4": "PASS",
        "P.3": "PASS",
        "P.8": "PASS",
    }
    assert tool.worst(list(found.values())) == 0


def test_uncommitted_changes_count_too(repo: Path) -> None:
    write(repo, "packages/auth/src/x.ts", "changed\n")
    found = findings_by_rule(repo)
    assert found["G0.5"].verdict == "FAIL"
    assert found["G0.5"].paths == ["packages/auth/src/x.ts"]


def test_scope_fencing_names_every_path_outside_in_or_inside_out(repo: Path) -> None:
    write(repo, "packages/lobby/src/registry.ts", "excluded\n")
    write(repo, "README.md", "outside\n")
    write(repo, "packages/lobby/src/ok.ts", "inside\n")
    found = findings_by_rule(repo, scope=tool.parse_scope(SCOPE))
    assert found["G0.2"].verdict == "FAIL"
    assert found["G0.2"].paths == ["README.md", "packages/lobby/src/registry.ts"]


def test_an_unreadable_scope_fails_g03_with_the_reason_and_skips_fencing(repo: Path) -> None:
    found = findings_by_rule(repo, scope_error="`in:` is missing or empty")
    assert found["G0.3"].verdict == "FAIL"
    assert "spec:invalid" in found["G0.3"].detail
    assert found["G0.2"].verdict == "SKIP"


def test_no_scope_given_skips_both_scope_rules(repo: Path) -> None:
    found = findings_by_rule(repo)
    assert found["G0.3"].verdict == "SKIP"
    assert found["G0.2"].verdict == "SKIP"


def test_acceptance_tests_are_the_spec_authors_whatever_the_change(repo: Path) -> None:
    write(repo, "tests/acceptance/issue-7/test_it.py", "def test_it():\n    assert 1\n")
    write(repo, "tests/acceptance/issue-99/test_new.py", "def test_new():\n    pass\n")
    found = findings_by_rule(repo)
    assert found["G0.6"].verdict == "FAIL"
    assert found["G0.6"].paths == [
        "tests/acceptance/issue-7/test_it.py",
        "tests/acceptance/issue-99/test_new.py",
    ]


def test_modifying_an_existing_test_flags_and_strict_makes_it_fail(repo: Path) -> None:
    write(repo, "tests/e2e/old.spec.ts", "changed\n")
    (repo / "packages/lobby/src/thing.test.ts").unlink()
    write(repo, "packages/lobby/src/fresh.test.ts", "added\n")
    found = findings_by_rule(repo)
    assert found["G2.4"].verdict == "FLAG"
    assert found["G2.4"].paths == ["packages/lobby/src/thing.test.ts", "tests/e2e/old.spec.ts"]
    assert tool.worst(list(found.values())) == 0
    assert findings_by_rule(repo, strict=True)["G2.4"].verdict == "FAIL"


def test_a_moved_test_counts_as_a_deletion(repo: Path) -> None:
    run_git(repo, "mv", "tests/e2e/old.spec.ts", "tests/e2e/renamed.spec.ts")
    found = findings_by_rule(repo)
    assert "tests/e2e/old.spec.ts" in found["G2.4"].paths


def test_lockfiles_flag_for_the_deps_approved_label(repo: Path) -> None:
    write(repo, "pnpm-lock.yaml", "lock\n")
    found = findings_by_rule(repo)
    assert found["G1.4"].verdict == "FLAG"
    assert "deps-approved" in found["G1.4"].detail


def test_size_caps_match_foremans(repo: Path) -> None:
    for index in range(tool.MAX_FILES):
        write(repo, f"packages/lobby/src/gen/{index}.ts", "x\n")
    found = findings_by_rule(repo)
    assert found["G0.4"].verdict == "FAIL"
    assert f"{tool.MAX_FILES} file(s)" in found["G0.4"].detail


def test_branch_and_title_formats(repo: Path) -> None:
    good = findings_by_rule(repo, title="[#7] Do the thing")
    assert good["P.3"].verdict == "PASS"
    assert good["P.8"].verdict == "PASS"
    run_git(repo, "checkout", "-q", "-b", "feature/whatever")
    bad = findings_by_rule(repo, title="Do the thing")
    assert bad["P.3"].verdict == "FLAG"
    assert bad["P.8"].verdict == "FAIL"


# --- the manifest: the merge-base's copy wins --------------------------------------------------


def test_the_manifest_at_the_merge_base_wins_over_the_working_tree(repo: Path) -> None:
    weakened = {**MANIFEST, "protectedPaths": []}
    write(repo, ".github/forge-protocol.json", json.dumps(weakened))
    write(repo, "packages/auth/src/x.ts", "changed\n")
    found = findings_by_rule(repo)
    assert found["G0.5"].verdict == "FAIL"
    assert ".github/forge-protocol.json" in found["G0.5"].paths
    assert "merge-base" in tool.load_rules(tool.merge_base("main")).source


def test_without_a_manifest_at_the_merge_base_the_working_tree_copy_is_used(
    repo: Path,
) -> None:
    run_git(repo, "checkout", "-q", "main")
    run_git(repo, "rm", "-q", ".github/forge-protocol.json")
    run_git(repo, "commit", "-q", "-m", "drop manifest")
    run_git(repo, "checkout", "-q", "-b", "task/8-x")
    write(repo, ".github/forge-protocol.json", json.dumps(MANIFEST))
    rules = tool.load_rules(tool.merge_base("main"))
    assert "working tree" in rules.source
    (repo / ".github/forge-protocol.json").unlink()
    with pytest.raises(tool.CannotEvaluate, match="no .github/forge-protocol.json"):
        tool.load_rules(tool.merge_base("main"))


@pytest.mark.parametrize(
    ("manifest", "reason"),
    [
        ("not json", "not valid JSON"),
        ("[]", "JSON object"),
        (json.dumps({**MANIFEST, "version": 2}), "version 2"),
        (json.dumps({**MANIFEST, "version": True}), "version True"),
        (json.dumps({**MANIFEST, "testGlobs": "tests/**"}), "testGlobs must be"),
        (json.dumps({**MANIFEST, "protectedPaths": [""]}), "protectedPaths must be"),
        (json.dumps({**MANIFEST, "testGlobs": ["a/{b}"]}), "not readable"),
    ],
)
def test_a_manifest_this_script_cannot_trust_is_never_a_pass(
    repo: Path, manifest: str, reason: str
) -> None:
    run_git(repo, "checkout", "-q", "main")
    write(repo, ".github/forge-protocol.json", manifest)
    run_git(repo, "commit", "-q", "-am", "bad manifest")
    run_git(repo, "checkout", "-q", "-b", "task/9-y")
    with pytest.raises(tool.CannotEvaluate, match=reason):
        tool.load_rules(tool.merge_base("main"))


def test_an_unknown_base_cannot_be_evaluated(repo: Path) -> None:
    with pytest.raises(tool.CannotEvaluate, match="not a known ref"):
        tool.merge_base("origin/nowhere")


# --- the command line ---------------------------------------------------------------------------


def run_tool(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), "--base", "main", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_exit_codes_and_report(repo: Path) -> None:
    write(repo, "packages/lobby/src/new.ts", "x\n")
    # Outside the repository: inside it, the issue text would itself be an out-of-scope file.
    scope = repo.parent / "issue.md"
    scope.write_text(SCOPE, encoding="utf-8")
    ok = run_tool(repo, "--scope", str(scope), "--title", "[#7] Do the thing")
    assert ok.returncode == 0, ok.stderr
    assert "rules from .github/forge-protocol.json at merge-base" in ok.stdout
    assert "PASS G0.2" in ok.stdout
    assert ok.stdout.rstrip().endswith("nothing here Foreman would close or flag.")

    write(repo, "CODEOWNERS", "* @someone\n")
    failed = run_tool(repo, "--scope", str(scope))
    assert failed.returncode == 1
    assert "FAIL G0.5" in failed.stdout
    assert "Foreman would close this pull request at G0" in failed.stdout

    as_json = run_tool(repo, "--json")
    assert as_json.returncode == 1
    report = json.loads(as_json.stdout)
    assert report["ok"] is False
    assert {f["rule"] for f in report["findings"]} >= {"G0.2", "G0.5", "G2.4"}


def test_cli_reads_the_scope_from_stdin_and_reports_an_unreadable_one(repo: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(TOOL), "--base", "main", "--scope", "-"],
        cwd=repo,
        input="```forge-scope\nout:\n- a\n```\n",
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 1
    assert "FAIL G0.3" in done.stdout
    assert "spec:invalid" in done.stdout


def test_cli_cannot_evaluate_is_exit_2_not_a_pass(repo: Path) -> None:
    done = run_tool(repo, "--base", "origin/nowhere")
    assert done.returncode == 2
    assert "cannot evaluate" in done.stderr
    as_json = run_tool(repo, "--base", "origin/nowhere", "--json")
    assert as_json.returncode == 2
    assert json.loads(as_json.stdout)["ok"] is False
