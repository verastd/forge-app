"""GitHub Copilot cloud agent: start an agent task in the contributor's fork.

Coded against, read 2026-10-01:
- https://docs.github.com/en/rest/agent-tasks/agent-tasks ("Start a task", public preview)
- https://github.blog/changelog/2026-06-04-agent-tasks-rest-api-now-available-for-copilot-pro-pro-and-max/

Call: POST https://api.github.com/agents/repos/{owner}/{repo}/tasks with
`Authorization: Bearer <token>`, `Accept: application/vnd.github+json` and
`X-GitHub-Api-Version: 2026-03-10`; body {prompt, base_ref, create_pull_request}
(`model`, `custom_agent` and `head_ref` are left out: `.github/agents/forge.agent.md`
only exists in forks made after it landed, and the task branch may not exist yet).
201 -> {id, url, html_url, name, state: queued|in_progress|..., artifacts, ...}.
400 bad JSON, 401 authentication required, 403 insufficient permissions, 404, 422
validation failed. `--check` lists the fork's tasks (GET .../tasks?per_page=1).

The token is the one-time GitHub user token the web app gets from FORGE's GitHub App
(`credential.key`). The reference lists GitHub App user tokens and fine-grained personal
tokens (never installation tokens) with the "Agent tasks" repository permission; the
changelog opens the API to Copilot Pro, Pro+ and Max and also names classic personal
tokens and OAuth tokens. The Bridge never saves the token. A 403 or 404 means "not set
up" (no Copilot plan with the cloud agent, FORGE's app not installed on the fork, or no
fork), not a bad token (contract §5).

Not proven live (docs/live-tests.md, test 1): that the endpoint works on a fork with
FORGE's App user token (fork support is undocumented), whether the App can be given the
"Agent tasks" permission, which branch Copilot pushes to, and where the pull request
opens.
"""

from urllib.parse import quote

from forge_api.services.rail_adapters.base import (
    FORK_REPO_NAME,
    AdapterRequest,
    AdapterResult,
    CheckResult,
    OutboundCall,
    RailAdapter,
    RailCredential,
    SetupCheck,
    VendorResponse,
    https_url,
    json_body,
    session_ref,
)

API_URL = "https://api.github.com"
API_VERSION = "2026-03-10"
BASE_REF = "main"


def _headers(credential: RailCredential) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {credential.key}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "Content-Type": "application/json",
    }


def _tasks_url(login: str) -> str:
    return f"{API_URL}/agents/repos/{quote(login, safe='')}/{FORK_REPO_NAME}/tasks"


def _setup_sentence(fork: str) -> str:
    return (
        f"GitHub didn't let FORGE start Copilot on {fork}. You need a Copilot plan with the "
        "cloud agent (Pro, Pro+, Max, Business or Enterprise), a fork of forge-app, and "
        "FORGE's GitHub app installed on that fork."
    )


class CopilotAdapter(RailAdapter):
    rail = "copilot"
    vendor = "GitHub"

    def _task_call(self, request: AdapterRequest) -> OutboundCall:
        return OutboundCall(
            method="POST",
            url=_tasks_url(request.login),
            headers=_headers(request.credential),
            body={
                "prompt": request.brief,
                "base_ref": BASE_REF,
                "create_pull_request": True,
            },
            secret_headers=frozenset({"Authorization"}),
            purpose="Start a Copilot cloud agent task in the fork.",
        )

    def plan(self, request: AdapterRequest) -> list[OutboundCall]:
        return [self._task_call(request)]

    def _setup_needed(self, request: AdapterRequest) -> SetupCheck:
        def setup_needed(response: VendorResponse, text: str) -> str | None:
            if response.status in (403, 404):
                return _setup_sentence(request.fork)
            return None

        return setup_needed

    def start(self, request: AdapterRequest) -> AdapterResult:
        response = self.call(
            self._task_call(request),
            request.credential,
            setup_needed=self._setup_needed(request),
            rejected_statuses=frozenset({401}),
        )
        body = json_body(response, vendor=self.vendor)
        return AdapterResult(
            session_url=https_url(body.get("html_url"), host_suffixes=("github.com",)),
            session_ref=session_ref(body.get("id")),
        )

    def check(self, request: AdapterRequest) -> CheckResult:
        self.call(
            OutboundCall(
                method="GET",
                url=_tasks_url(request.login),
                headers=_headers(request.credential),
                params={"per_page": "1"},
                secret_headers=frozenset({"Authorization"}),
                purpose="List the fork's Copilot tasks (a read that needs the same access).",
            ),
            request.credential,
            setup_needed=self._setup_needed(request),
            rejected_statuses=frozenset({401}),
        )
        return CheckResult(
            ok=True,
            summary=f"GitHub accepted the token and Copilot's task list for {request.fork} reads.",
        )
