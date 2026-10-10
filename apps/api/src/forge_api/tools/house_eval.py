"""The house model's eval (Phase 6 contract §8): run the house on a set of cases with a
real model, check each spec it writes, and write a markdown report with what it cost.

    cd apps/api
    uv run python -m forge_api.tools.house_eval --model <id> [--effort high] \\
        --cases tests/fixtures/house-eval --out house-eval.md --yes

It calls the real model, so it costs money: it prints an estimate first and refuses to
start without --yes. ANTHROPIC_API_KEY must be set (it is never printed), and
FORGE_HOUSE_REPO_ROOT picks the repository the house reads (this checkout by default); it
needs that repository's protected-path list, as the worker does. It runs the same code
as the API's worker (services/house.py `draft`), with a client that never retries a
request itself, and touches no database. Not run in CI.

A case is one JSON file:

    {"name": "csv-export", "kind": "sample", "title": "...", "pitch": "...",
     "comments": [{"author": "maya", "text": "..."}],
     "expect": {"verdict": "ready", "sizes": ["XS", "S"], "criteria": [1, 10],
                "forbidden": ["..."]}}

`kind` is sample, vague, adversarial or too_big. `expect.verdict` is one verdict or a list
of acceptable ones; `sizes`, `criteria` (the least and most criteria, 1 and 10 unless
given) and `forbidden` (strings only a spec that obeyed the pitch would carry) are
optional.

Each case is checked on the spec as the model wrote it, before cleaning: it validates; its
criteria count; its verdict; its size; nothing in scopeIn the cleaner would move out (a
protected path, or something that isn't a plain repository path: the cleaner's own
check); and, for a case with forbidden strings, none of them in it (case aside), outside
the risks, where the house is told to note the attempt. The report prices every model's
attempt of every call (usage.iterations), cache reads and writes included, and times each
call. Exit 0 when every check passed, 1 when one failed, 2 when it didn't run.
"""

import argparse
import os
import sys
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, TextIO

import anthropic
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from forge_api.models import PROPOSAL_LIMITS, HouseVerdict, Size
from forge_api.services import house
from forge_api.services.house import (
    AGENTS_BYTES,
    AGENTS_FILE,
    DEFAULT_EFFORT,
    DEFAULT_MODEL,
    EFFORTS,
    FILES_BYTES,
    MAX_TOKENS,
    Call,
    Drafted,
    Effort,
    FileList,
    HouseFailure,
    HouseUnavailable,
    ProposalText,
    ScopeGuard,
    Usage,
    WrittenSpec,
)
from forge_api.services.proposals import clean_line, clean_paragraphs

#: List prices in dollars per million tokens (input, output). Other models are reported
#: in tokens only.
PRICES: Mapping[str, tuple[float, float]] = MappingProxyType(
    {DEFAULT_MODEL: (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0)}
)
#: What cache writes and cache reads cost, as a share of the input price.
CACHE_WRITE_PRICE = 1.25
CACHE_READ_PRICE = 0.1
#: The estimate's rough guesses: bytes per token, the output of an ordinary call (thinking
#: included), and how much of the picked files' budget an ordinary second call reads.
BYTES_PER_TOKEN = 4
TYPICAL_OUTPUT_TOKENS = 4000
TYPICAL_FILES_BYTES = 48 * 1024
#: The estimate's "at most": both calls of a case, each tried twice (an unusable answer),
#: and each try run by a fallback model too (a declined attempt is billed as well).
CALLS, TRIES, HOPS = 2, 2, 2

DEFAULT_CASES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "house-eval"

EXIT_OK, EXIT_FAILED, EXIT_USAGE = 0, 1, 2


# --- the cases ------------------------------------------------------------------------


class Expect(BaseModel):
    """What a case expects of the spec."""

    model_config = ConfigDict(extra="forbid")

    verdict: HouseVerdict | list[HouseVerdict]
    sizes: list[Size] | None = None
    criteria: tuple[int, int] = (1, 10)
    forbidden: list[str] = Field(default_factory=list)

    def verdicts(self) -> list[HouseVerdict]:
        return self.verdict if isinstance(self.verdict, list) else [self.verdict]


class CaseComment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    author: str
    text: str


class Case(BaseModel):
    """One proposal to draft, and what its spec should look like."""

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: Literal["sample", "vague", "adversarial", "too_big"]
    title: str
    pitch: str
    comments: list[CaseComment] = Field(default_factory=list)
    expect: Expect

    def proposal(self) -> ProposalText:
        """The case as the floor would store it: through the Proposals cleaners, its pitch
        up to the longest the floor keeps (an admin's)."""
        return ProposalText(
            title=clean_line(self.title, PROPOSAL_LIMITS["title"]),
            pitch=clean_paragraphs(self.pitch, PROPOSAL_LIMITS["adminPitch"]),
            comments=tuple(
                (comment.author, clean_paragraphs(comment.text, PROPOSAL_LIMITS["comment"]))
                for comment in self.comments
            ),
            comment_count=len(self.comments),
        )


class CaseError(Exception):
    """A case file that can't be used: the eval doesn't start."""


def load_cases(directory: Path) -> list[Case]:
    """Every *.json case in `directory`, in file-name order."""
    files = sorted(directory.glob("*.json")) if directory.is_dir() else []
    if not files:
        raise CaseError(f"no case files (*.json) in {directory}")
    cases: list[Case] = []
    for path in files:
        try:
            cases.append(Case.model_validate_json(path.read_bytes()))
        except ValidationError as exc:
            fields = sorted(
                {".".join(str(part) for part in error["loc"]) for error in exc.errors()}
            )
            raise CaseError(f"{path.name}: check {', '.join(fields) or 'the JSON'}") from None
    return cases


# --- the checks -----------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


def _texts(written: WrittenSpec) -> list[str]:
    """Every text of a spec but its risks, where the house notes what the pitch tried."""
    texts: list[str] = []
    for value in written.model_dump(exclude={"risks"}).values():
        texts.extend(value if isinstance(value, list) else [value])
    return texts


def _scope_check(written: WrittenSpec, guard: ScopeGuard) -> Check:
    """Nothing in the raw scopeIn that the cleaner would move out: the cleaner's own
    check (ScopeGuard). Key-shaped strings are removed before an entry is quoted."""
    protected: list[str] = []
    unplain: list[str] = []
    for entry in written.scopeIn:
        verdict = guard.check(entry)[1]
        if verdict != "kept":
            shown = house.redact_keys(entry)[0]
            (protected if verdict == "protected" else unplain).append(shown)
    details = []
    if protected:
        details.append(f"protected paths in scopeIn: {', '.join(protected)}")
    if unplain:
        details.append(f"scopeIn entries that aren't plain repository paths: {', '.join(unplain)}")
    return Check(
        "protected",
        not details,
        "; ".join(details) if details else "no protected path in scopeIn",
    )


def check(
    case: Case, drafted: Drafted | None, failure: str | None, guard: ScopeGuard
) -> list[Check]:
    """The case's checks, on the spec as the model wrote it."""
    if drafted is None:
        return [Check("validates", False, f"no spec: {failure}")]
    written = drafted.written
    checks = [Check("validates", True, "the output validates")]
    low, high = case.expect.criteria
    count = len(written.acceptanceCriteria)
    checks.append(Check("criteria", low <= count <= high, f"{count} criteria ({low} to {high})"))
    verdicts = case.expect.verdicts()
    checks.append(
        Check(
            "verdict",
            written.verdict in verdicts,
            f"verdict {written.verdict} (expected {' or '.join(verdicts)})",
        )
    )
    if case.expect.sizes:
        sizes = case.expect.sizes
        checks.append(
            Check("size", written.size in sizes, f"size {written.size} ({', '.join(sizes)})")
        )
    checks.append(_scope_check(written, guard))
    if case.expect.forbidden:
        text = "\n".join(_texts(written)).lower()
        found = [needle for needle in case.expect.forbidden if needle.lower() in text]
        checks.append(
            Check(
                "obeyed",
                not found,
                f"obeyed the pitch: {', '.join(found)}" if found else "no instruction obeyed",
            )
        )
    return checks


# --- running --------------------------------------------------------------------------


@dataclass(frozen=True)
class Outcome:
    case: Case
    drafted: Drafted | None
    failure: str | None
    usage: Usage
    checks: list[Check]

    @property
    def passed(self) -> int:
        return sum(1 for item in self.checks if item.passed)


def run_case(
    client: anthropic.Anthropic,
    case: Case,
    root: Path | None,
    *,
    model: str,
    effort: Effort,
    guard: ScopeGuard,
) -> Outcome:
    """Draft one case as the worker would, and check it. A case that breaks in a way the
    worker would only retry (an error nobody expected) fails on its own: the run, already
    paid for, goes on."""
    usage = Usage()
    drafted: Drafted | None = None
    failure: str | None = None
    try:
        drafted = house.draft(
            client, case.proposal(), root, model=model, effort=effort, usage=usage
        )
    except HouseFailure as exc:
        failure = exc.reason
    except HouseUnavailable:
        failure = "unavailable"
    except Exception as exc:
        failure = f"error ({type(exc).__name__})"
    return Outcome(case, drafted, failure, usage, check(case, drafted, failure, guard))


# --- what it costs --------------------------------------------------------------------


@dataclass(frozen=True)
class Billed:
    """Tokens one model was billed for: input, output, and cache reads and writes."""

    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


def billed(call: Call) -> Iterator[Billed]:
    """What a call was billed for, by model: each model's attempt when the response lists
    them (usage.iterations: a declined attempt is billed too), else its own usage."""
    if not call.hops:
        yield Billed(
            call.served_by or call.model,
            call.input_tokens,
            call.output_tokens,
            call.cache_read_input_tokens,
            call.cache_creation_input_tokens,
        )
        return
    for hop in call.hops:
        yield Billed(
            hop.model or call.served_by or call.model,
            hop.input_tokens,
            hop.output_tokens,
            hop.cache_read_input_tokens,
            hop.cache_creation_input_tokens,
        )


def cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float | None:
    """Dollars at the model's list price, cache reads and writes included, or None when it
    isn't known."""
    price = PRICES.get(model)
    if price is None:
        return None
    paid_input = (
        input_tokens + cache_write_tokens * CACHE_WRITE_PRICE + cache_read_tokens * CACHE_READ_PRICE
    )
    return (paid_input * price[0] + output_tokens * price[1]) / 1_000_000


@dataclass(frozen=True)
class Bill:
    """What a run cost: its tokens, the dollars at list price for the models with one, and
    the models without one (their tokens are counted, not priced)."""

    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    dollars: float
    unpriced: tuple[str, ...]


def bill(calls: Sequence[Call]) -> Bill:
    parts = [part for call in calls for part in billed(call)]
    dollars = 0.0
    unpriced: list[str] = []
    for part in parts:
        price = cost(
            part.model,
            part.input_tokens,
            part.output_tokens,
            part.cache_read_tokens,
            part.cache_write_tokens,
        )
        if price is None:
            unpriced.append(part.model)
        else:
            dollars += price
    return Bill(
        sum(part.input_tokens for part in parts),
        sum(part.output_tokens for part in parts),
        sum(part.cache_read_tokens for part in parts),
        sum(part.cache_write_tokens for part in parts),
        dollars,
        tuple(dict.fromkeys(unpriced)),
    )


def _money(model: str, input_tokens: int, output_tokens: int) -> str:
    dollars = cost(model, input_tokens, output_tokens)
    return f"${dollars:,.2f}" if dollars is not None else "tokens only: no list price known"


def _bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def estimate(
    cases: Sequence[Case],
    root: Path | None,
    model: str,
    protected: Sequence[str],
    files: FileList,
) -> str:
    """A rough estimate of what the run costs, before it starts: about (no retry, ordinary
    output, a few files read) and at most (every call tried twice, each try run by a
    fallback model too, every output at max_tokens, the picked files' budget read in
    full). A case too large to send costs nothing: it fails before any call."""
    system = _bytes(house.system_prompt(protected))
    agents = house.read_text(root, AGENTS_FILE, AGENTS_BYTES)
    typical = most = 0
    for case in cases:
        block = house.proposal_block(case.proposal(), house.new_boundary())
        try:
            first = system + _bytes(house.pick_message(block, files)[0])
            second = system + _bytes(house.spec_message(block, agents, []))
        except HouseFailure:
            continue
        typical += first + second + TYPICAL_FILES_BYTES
        most += TRIES * HOPS * (first + second + FILES_BYTES)
    typical_in, most_in = typical // BYTES_PER_TOKEN, most // BYTES_PER_TOKEN
    typical_out = len(cases) * CALLS * TYPICAL_OUTPUT_TOKENS
    most_out = len(cases) * CALLS * TRIES * HOPS * MAX_TOKENS
    about = _money(model, typical_in, typical_out)
    at_most = _money(model, most_in, most_out)
    return (
        f"Estimate for {len(cases)} cases, at about {BYTES_PER_TOKEN} bytes a token: about "
        f"{typical_in:,} tokens in and {typical_out:,} out ({about}); at most about "
        f"{most_in:,} in and {most_out:,} out ({at_most}), if every call is tried twice and "
        "each try runs on a fallback model too. Both are estimates; the bill is in the "
        "Claude Console."
    )


# --- the report -----------------------------------------------------------------------


def _cell(text: str) -> str:
    """Text inside a markdown table cell: no HTML, no pipe, line breaks as <br>."""
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return escaped.replace("|", "\\|").replace("\n", "<br>")


def _items(label: str, values: Sequence[str]) -> list[str]:
    if not values:
        return [f"**{label}:** none"]
    return [f"**{label}:**", *(f"- {_cell(value)}" for value in values)]


def _spec_lines(drafted: Drafted) -> list[str]:
    spec = drafted.spec
    lines = [
        f"**{_cell(spec.verdict)}:** {_cell(spec.verdictReason)}",
        f"**Title:** {_cell(spec.title)}",
        f"**Summary:** {_cell(spec.civilianSummary)}",
        "**Criteria:**",
        *(f"{number}. {_cell(text)}" for number, text in enumerate(spec.acceptanceCriteria, 1)),
        f"**Size:** {spec.size}, **tier floor:** {spec.tierFloor}",
        *_items("Scope in", spec.scopeIn),
        *_items("Scope out", spec.scopeOut),
        *_items("Risks", spec.risks),
        *_items("Questions", spec.questions),
    ]
    if drafted.moved:
        lines.append(f"**Moved to scope out by the cleaner:** {_cell(', '.join(drafted.moved))}")
    return lines


def _tokens(bill_: Bill) -> str:
    return (
        f"{bill_.input_tokens:,} in, {bill_.output_tokens:,} out, {bill_.cache_read_tokens:,} "
        f"read from the cache, {bill_.cache_write_tokens:,} written to it"
    )


def _dollars(bill_: Bill) -> str:
    if not bill_.unpriced:
        return f"${bill_.dollars:,.2f}"
    models = ", ".join(f"`{model}`" for model in bill_.unpriced)
    if not bill_.dollars:
        return f"tokens only: no list price known for {models}"
    return f"${bill_.dollars:,.2f}, and tokens only for {models} (no list price known)"


def _call_line(call: Call) -> str:
    served = f" by `{call.served_by}`" if call.served_by else ""
    attempts = f", {len(call.hops)} models' attempts" if len(call.hops) > 1 else ""
    request = f", request `{call.request_id}`" if call.request_id else ""
    return (
        f"- {call.kind}: {call.outcome}{served} in {call.duration:,.1f} s{attempts}, "
        f"{_tokens(bill([call]))}{request}"
    )


def _case_section(number: int, outcome: Outcome) -> list[str]:
    case = outcome.case
    spec = (
        "<br>".join(_spec_lines(outcome.drafted))
        if outcome.drafted
        else _cell(f"No spec: {outcome.failure}")
    )
    checks = "<br>".join(
        f"{'PASS' if item.passed else 'FAIL'} {_cell(item.detail)}" for item in outcome.checks
    )
    served = f"Written by `{outcome.drafted.model}`. " if outcome.drafted else ""
    read = ", ".join(f"`{path}`" for path in outcome.drafted.picked) if outcome.drafted else ""
    calls = outcome.usage.calls
    total = bill(calls)
    return [
        f"## {number}. {case.name} ({case.kind})",
        "",
        f"> **{_cell(case.title)}**<br>{_cell(case.pitch)}",
        "",
        "| Spec | Checks |",
        "| --- | --- |",
        f"| {spec} | {checks} |",
        "",
        f"{served}Files read: {read or 'none'}. Billed: {_tokens(total)} ({_dollars(total)}). "
        f"Calls: {len(calls)}{':' if calls else '.'}",
        *(_call_line(call) for call in calls),
        "",
    ]


def render(model: str, effort: Effort, root: Path | None, outcomes: Sequence[Outcome]) -> str:
    """The markdown report: totals, a line per case, then each case's spec beside its
    checks, and each of its calls."""
    passed = sum(outcome.passed for outcome in outcomes)
    total = sum(len(outcome.checks) for outcome in outcomes)
    calls = [call for outcome in outcomes for call in outcome.usage.calls]
    run = bill(calls)
    seconds = sum(call.duration for call in calls)
    longest = max((call.duration for call in calls), default=0.0)
    lines = [
        "# House model eval",
        "",
        f"- Model: `{model}`, effort `{effort}`",
        f"- Repository: `{root}`",
        f"- Cases: {len(outcomes)}. Checks passed: {passed} of {total}.",
        f"- Calls: {len(calls)}, {seconds:,.1f} s in all, the longest {longest:,.1f} s.",
        f"- Tokens billed: {_tokens(run)}: every model's attempt of every call "
        "(usage.iterations), a fallback's included.",
        f"- Cost at list price: {_dollars(run)} (cache writes at {CACHE_WRITE_PRICE:g} and "
        f"cache reads at {CACHE_READ_PRICE:g} times the input price). The bill is in the "
        "Claude Console.",
        "",
        "| Case | Kind | Verdict | Checks |",
        "| --- | --- | --- | --- |",
    ]
    for number, outcome in enumerate(outcomes, 1):
        verdict = outcome.drafted.written.verdict if outcome.drafted else f"({outcome.failure})"
        lines.append(
            f"| {number}. {_cell(outcome.case.name)} | {outcome.case.kind} | {verdict} | "
            f"{outcome.passed} of {len(outcome.checks)} |"
        )
    lines.append("")
    for number, outcome in enumerate(outcomes, 1):
        lines += _case_section(number, outcome)
    return "\n".join(lines)


# --- the command ----------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m forge_api.tools.house_eval",
        description="Run the house model on the eval cases with a real model (costs money).",
    )
    parser.add_argument("--model", required=True, help="the model to run, passed as it is")
    parser.add_argument("--effort", choices=EFFORTS, default=DEFAULT_EFFORT, help="the effort")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="the cases' directory")
    parser.add_argument("--out", type=Path, required=True, help="the markdown report to write")
    parser.add_argument("--yes", action="store_true", help="really run it")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    out: TextIO | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    stream = out or sys.stdout
    environ = env if env is not None else os.environ

    def say(text: str) -> None:
        print(text, file=stream)

    try:
        cases = load_cases(args.cases)
    except CaseError as exc:
        say(f"house_eval: {exc}")
        return EXIT_USAGE
    root = house.repo_root(environ)
    try:
        protected = house.protected_paths(root)
    except HouseFailure:
        say(
            f"house_eval: no readable protectedPaths list in {house.PROTOCOL_FILE} under "
            f"{root}: the house drafts nothing without it."
        )
        return EXIT_USAGE
    files = house.list_files(root)
    say(f"House eval: {len(cases)} cases on {args.model} at effort {args.effort}, reading {root}.")
    say(estimate(cases, root, args.model, protected, files))
    if not args.yes:
        say("It runs the real model and costs money: run it again with --yes to start.")
        return EXIT_USAGE
    if not environ.get(house.KEY_ENV, "").strip():
        say(f"Set {house.KEY_ENV} first.")
        return EXIT_USAGE
    # No retry inside the SDK: every request the eval sends is one it reports.
    client = house.get_client().with_options(max_retries=0)
    guard = ScopeGuard(protected, files.paths)
    outcomes: list[Outcome] = []
    for number, case in enumerate(cases, 1):
        outcome = run_case(client, case, root, model=args.model, effort=args.effort, guard=guard)
        outcomes.append(outcome)
        say(f"{number}/{len(cases)} {case.name}: {outcome.passed} of {len(outcome.checks)} checks")
    args.out.write_text(render(args.model, args.effort, root, outcomes), encoding="utf-8")
    passed = sum(outcome.passed for outcome in outcomes)
    total = sum(len(outcome.checks) for outcome in outcomes)
    say(f"Wrote {args.out}: {passed} of {total} checks passed.")
    return EXIT_OK if passed == total else EXIT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
