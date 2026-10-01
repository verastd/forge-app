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


def compile_brief(task: BriefTask, criteria: Sequence[str], login: str | None) -> str:
    """The brief for `task`, personalized for `login` when it is a valid GitHub login.

    An invalid login is treated as no login. The "Done when" block is left out when
    there are no criteria. No trailing newline.
    """
    branch = branch_name(task.id, task.title)
    if is_valid_login(login):
        fork = f"your fork, {login}/{_FORK_NAME}"
        head = f"{login}:{branch}"
    else:
        fork = f"your fork of {UPSTREAM_REPO}"
        head = f"your fork's {branch} branch"

    sections = [f"FORGE task #{task.id}: {task.title}", f"Why: {task.civilianSummary}"]
    if criteria:
        sections.append("Done when:\n" + "\n".join(f"- {item}" for item in criteria))
    # The pull request title is AGENTS.md rule 8's `[#<issue>] <goal>`.
    sections.append(
        "Rules:\n"
        "- Read AGENTS.md at the repo root before you start.\n"
        f"- Work in {fork}, on the branch {branch}. Create it from main if it doesn't exist.\n"
        "- Don't change .github/, the acceptance tests, or anything outside this task.\n"
        "- Run make lint and make test before you push.\n"
        f"- When it's ready, open a pull request from {head} to {UPSTREAM_REPO} main, "
        f'titled "[#{task.id}] {task.title}", with "Closes #{task.id}" in the description.'
    )
    sections.append(_CONNECTOR_LINE)
    sections.append(f"Task: {task.url}")
    return "\n\n".join(sections)
