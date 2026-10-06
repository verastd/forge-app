"""The brief: the one text every rail hands to a contributor's agent (contract §4).

Open-rail links, start-rail API calls, the connector's `get_task`, the `prompt_url`
endpoint and the hidden copy fallback all send exactly this text. It is byte-identical
to `compileBrief` in packages/shared/src/brief.ts; both sides are held to
tests/fixtures/brief-golden.json, so change them together or not at all.
"""

import re
from collections.abc import Sequence
from typing import Protocol, TypeGuard

#: The repository every contribution lands in. Forks keep its name: <login>/forge-app.
UPSTREAM_REPO = "verastd/forge-app"
_FORK_NAME = UPSTREAM_REPO.split("/", 1)[1]

#: A GitHub login. fullmatch, never `$`: `$` also matches just before a trailing newline.
_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")
#: A GitHub repository name (the part after `owner/`). `.` and `..` are refused apart.
_REPO_NAME = re.compile(r"[A-Za-z0-9._-]{1,100}")

_CONNECTOR_LINE = (
    "If you have the FORGE tools (the FORGE connector), call claim_task first, "
    "report_progress as you go, get_check_results when checks fail, and submit_task "
    "with the pull request link."
)


class BriefTask(Protocol):
    """What the brief reads from a task. TaskCard and the Bridge's task records fit."""

    @property
    def id(self) -> int: ...

    @property
    def title(self) -> str: ...

    @property
    def civilianSummary(self) -> str: ...

    @property
    def url(self) -> str: ...


def is_valid_login(login: object) -> TypeGuard[str]:
    """True for a string shaped like a GitHub login; anything else is no login at all."""
    return isinstance(login, str) and _LOGIN.fullmatch(login) is not None


def is_valid_copy(full_name: object) -> TypeGuard[str]:
    """True for a string shaped like a repository's full name, `owner/name`: a GitHub login,
    one slash, a repository name. What FORGE accepts as the contributor's copy; anything
    else is no copy."""
    if not isinstance(full_name, str) or "/" not in full_name:
        return False
    owner, name = full_name.split("/", 1)
    return (
        is_valid_login(owner) and _REPO_NAME.fullmatch(name) is not None and name not in (".", "..")
    )


def work_repo(login: str | None, copy: str | None = None) -> str | None:
    """The repository the agent works in: the copy's full name when it is a valid one, else
    `<login>/forge-app` for a valid login, else None. What the start rails name."""
    if is_valid_copy(copy):
        return copy
    return f"{login}/{_FORK_NAME}" if is_valid_login(login) else None


def slugify(text: str, max_length: int = 48) -> str:
    """Lowercase, runs of anything but a-z/0-9 collapsed to one dash, cut back to a
    whole word when longer than `max_length`. The pre-v2 Bridge's rule, unchanged."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > max_length:
        slug = slug[:max_length].rsplit("-", 1)[0]
    return slug.strip("-")


def branch_name(task_id: int, title: str) -> str:
    """The one branch the agent is allowed to touch (PRD I.2, Dispatch row)."""
    return f"task/{task_id}-{slugify(title)}"


def compile_brief(
    task: BriefTask, criteria: Sequence[str], login: str | None, copy: str | None = None
) -> str:
    """The brief for `task`, personalized for `login` when it is a valid GitHub login, and
    for the contributor's copy (`owner/name`) when `copy` is a valid full name: then the
    agent works in the copy, on the branch FORGE made there, and the person sends the work
    for review from the task page.

    An invalid login is treated as no login, an invalid copy as no copy. The "Done when"
    block is left out when there are no criteria. No trailing newline.
    """
    branch = branch_name(task.id, task.title)

    sections = [f"FORGE task #{task.id}: {task.title}", f"Why: {task.civilianSummary}"]
    if criteria:
        sections.append("Done when:\n" + "\n".join(f"- {item}" for item in criteria))
    # The pull request title is AGENTS.md rule 8's `[#<issue>] <goal>`. Inside its quotes
    # a `"` in the title becomes `'`, so the title can't close the quote early.
    quoted_title = task.title.replace('"', "'")
    titled = f'titled "[#{task.id}] {quoted_title}", with "Closes #{task.id}" in the description.'
    if is_valid_copy(copy):
        owner = copy.split("/", 1)[0]
        work = (
            f"- Work in your copy, {copy} (a fork of {UPSTREAM_REPO}), on the branch {branch}. "
            f"FORGE made that branch from the latest main; if it's missing, create it from "
            f"{UPSTREAM_REPO}'s main. Push your commits to it.\n"
        )
        finish = (
            "- When it's done, tell FORGE (report_progress, if you have the FORGE tools): the "
            "person sends it for review from the task page. If you can open pull requests "
            f"yourself, you may open one instead, from {owner}:{branch} to {UPSTREAM_REPO} main, "
            + titled
        )
    else:
        if is_valid_login(login):
            yours = f"your copy, {login}/{_FORK_NAME} (a fork of {UPSTREAM_REPO})"
            head = f"{login}:{branch}"
        else:
            yours = f"your copy of {UPSTREAM_REPO} (a fork of it)"
            head = f"your copy's {branch} branch"
        work = (
            f"- Work in {yours}, on the branch {branch}. Create it from main if it doesn't exist.\n"
            "- No copy yet? Ask the person to press Get started on the task page first: FORGE "
            f"makes one. If you can fork repositories, you may fork {UPSTREAM_REPO} yourself.\n"
        )
        finish = (
            f"- When it's ready, open a pull request from {head} to {UPSTREAM_REPO} main, " + titled
        )
    sections.append(
        "Rules:\n"
        "- Read AGENTS.md at the repo root before you start.\n"
        + work
        + "- Don't edit or delete existing tests (add new test files instead). Don't change "
        ".github/, AGENTS.md, CLAUDE.md, the files listed under protectedPaths in "
        ".github/forge-protocol.json, or anything outside this task.\n"
        "- Run make lint and make test before you push.\n" + finish
    )
    sections.append(_CONNECTOR_LINE)
    sections.append(f"Task: {task.url}")
    return "\n\n".join(sections)
